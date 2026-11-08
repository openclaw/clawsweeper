import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExactReviewReviewLoopStore } from "../dashboard/exact-review-review-loop.ts";
import { withExactReviewAdmissionHarness } from "./dashboard-worker-harness.ts";
import {
  decision,
  enqueue,
  harness,
  queueState,
  repo,
  reviewOnce,
  sourceDriftRequeue,
  type Harness,
} from "./exact-review-deferred-publication-fixture.ts";

// Matches the live issue below, so every parked row has an unchanged source.
const SOURCE_UPDATED_AT = "2026-09-29T00:00:00Z";

async function driveToSourceDriftLoop(h: Harness, number: number) {
  await enqueue(
    h,
    `opened-${number}`,
    decision(number, "opened", { sourceUpdatedAt: SOURCE_UPDATED_AT }),
  );
  let claimed = await reviewOnce(h, number);
  for (let generation = 1; generation <= 3; generation += 1) {
    await enqueue(h, `drift:${number}:${generation}`, sourceDriftRequeue(claimed));
    claimed = await reviewOnce(h, number);
  }
  await enqueue(h, `drift:${number}:4`, sourceDriftRequeue(claimed));
}

/** Park an item with a given reason, as the Worker records it. */
async function parkAs(h: Harness, number: number, reason: string) {
  await driveToSourceDriftLoop(h, number);
  const state = await queueState(h);
  const item = state.items[`${repo}#${number}`]!;
  item.parkedReason = reason;
  if (reason === "review_retry_exhausted") item.parkedRecoveryAttempts = 3;
  await h.storage.put("exact-review-queue", state);
}

function runOperator(queueUrl: string, output: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/exact-review-dead-letter-operator.mjs",
        "--action",
        "reconcile-parked",
        "--execute",
        "--force-unchanged",
        "--max-targets",
        "10",
        "--max-recoveries",
        "2",
        "--output",
        output,
      ],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: queueUrl,
          CLAWSWEEPER_WEBHOOK_SECRET: "e2e-secret",
          GITHUB_API_URL: queueUrl,
          EXACT_REVIEW_TARGET_TOKEN_MODE: "actions",
          GH_TOKEN: "e2e-token",
          GITHUB_TOKEN: "e2e-token",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("forced parked recovery spends its cap on budgets, not unchanged policy holds", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    await parkAs(h, 97801, "maintainer_request_required");
    await parkAs(h, 97802, "review_retry_exhausted");
    await driveToSourceDriftLoop(h, 97803);
    const before = await queueState(h);
    assert.equal(before.items[`${repo}#97803`]?.parkedReason, "source_drift_loop");

    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const url = request.url ?? "";
      response.setHeader("content-type", "application/json");
      if (url === "/api/exact-review-queue") {
        response.end(JSON.stringify({ pressure: { status: "idle", active: 0, capacity: 128 } }));
        return;
      }
      const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url);
      if (issue) {
        response.end(
          JSON.stringify({
            node_id: `I_${issue[1]}`,
            state: "open",
            number: Number(issue[1]),
            title: "t",
            body: "b",
            locked: false,
            labels: [],
            updated_at: SOURCE_UPDATED_AT,
            repository_url: `https://api.github.com/repos/${repo}`,
          }),
        );
        return;
      }
      // Signature checks belong to the Worker edge; the queue owns the decision.
      const path = url.replace(/^\/internal\/exact-review/, "");
      const forwarded = await h.queue.fetch(
        new Request(`https://queue${path}`, {
          method: "POST",
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.statusCode = forwarded.status;
      response.end(await forwarded.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "parked-operator-e2e-"));
    try {
      const { port } = server.address() as AddressInfo;
      const run = await runOperator(`http://127.0.0.1:${port}`, join(directory, "out.json"));
      assert.equal(run.code, 0, run.stderr);
      const summary = JSON.parse(run.stdout);
      process.stdout.write(
        `operator summary: ${JSON.stringify({
          inspected: summary.inspected_targets,
          recovered: summary.recovered_targets,
          skip_reasons: summary.skip_reasons,
        })}\n`,
      );
      const after = await queueState(h);
      const states = Object.fromEntries(
        [97801, 97802, 97803].map((n) => [
          n,
          `${after.items[`${repo}#${n}`]?.state}/${after.items[`${repo}#${n}`]?.parkedReason ?? "-"}`,
        ]),
      );
      process.stdout.write(`queue after: ${JSON.stringify(states)}\n`);
      assert.equal(summary.recovered_targets, 2);
      // The unchanged hold is skipped on its own merits, not by the cap.
      assert.deepEqual(summary.skip_reasons, { unchanged_review_identity: 1 });
      assert.deepEqual(states, {
        97801: "parked/maintainer_request_required",
        97802: "pending/-",
        97803: "pending/-",
      });
      assert.equal(
        new ExactReviewReviewLoopStore(h.storage).sourceDriftLoopSync(`${repo}#97803`, Date.now()),
        null,
        "operator recovery restarts the source-drift loop budget",
      );
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
