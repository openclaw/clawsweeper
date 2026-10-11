import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalPullRequestClusterForTest,
  emptyReviewedPrActivityCursor,
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  withMockCodexProof,
  withMockGh,
} from "../../../test/helpers.ts";

const output = resolve(process.argv[2]);
const revision = process.argv[3];
const ownedWriteLag = process.argv[4] === "owned-write-lag";
mkdirSync(output, { recursive: true });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const number = ownedWriteLag ? 142693 : 158915;
const title = "Provider route fallback";
const t0 = "2026-05-01T00:00:00Z";
const t1 = "2026-05-01T01:00:00Z";
const t2 = "2026-05-01T02:00:00Z";
// Keep managed labels in sync so no apply-owned write can mask the pre-apply ack.
const labels = ["rating: 🌊 off-meta tidepool"];
const results = [];
const scenarios = ownedWriteLag
  ? ["owned-write-lag", "owned-write-lag-human-comment"]
  : ["acknowledgement-only", "same-second-title", "human-comment-after-proof"];
for (const scenario of scenarios) {
  const root = join(output, scenario);
  const items = join(root, "items");
  mkdirSync(items, { recursive: true });
  mkdirSync(join(root, "plans"));
  const proofLog = join(root, "proof.log");
  const commandLog = join(root, "requests.raw.jsonl");
  const reportPath = join(root, "apply-report.json");
  const synced = reportWithSyncedReviewComment(
    lowSignalCloseReport({
      number,
      title,
      labels: JSON.stringify(labels),
      item_updated_at: t0,
      reviewed_at: t0,
      item_source_revision: hash({ title, body: "Stale PR body.", labels: [], comments: [] }),
      review_timeline_revision: hash([]),
      review_activity_cursor: emptyReviewedPrActivityCursor,
      pull_head_sha: "head-sha",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
      root_cause_cluster: canonicalPullRequestClusterForTest(
        "https://github.com/openclaw/openclaw/pull/400",
      ),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    ),
    number,
    "duplicate_or_superseded",
  );
  writeFileSync(join(items, `${number}.md`), synced.report);
  writeFileSync(join(root, "review-snapshot.md"), synced.report);
  const comments = [
    {
      id: 9000 + number,
      created_at: t0,
      updated_at: t0,
      user: { login: "clawsweeper[bot]" },
      body: ownedWriteLag ? `Previous durable review content.\n${synced.comment}` : synced.comment,
    },
    {
      id: 5846759305,
      created_at: t0,
      updated_at: t1,
      user: { login: "clawsweeper[bot]" },
      body: `<!-- clawsweeper-pr-ack:opened item=${number} -->\nClawSweeper picked this up.\n<!-- clawsweeper-review-progress:start -->\n### ClawSweeper review complete\n<!-- clawsweeper-review-progress:end -->`,
    },
  ];
  let mock = promotionGhMock({
    number,
    title,
    comment: synced.comment,
    comments,
    labels,
    itemUpdatedAt: t1,
    commandLogPath: commandLog,
    itemUpdatedAtAfterProofLogPath: proofLog,
    linkedPulls: {
      400: {
        number: 400,
        title: "Provider cleanup",
        html_url: "https://github.com/openclaw/openclaw/pull/400",
        state: "closed",
        merged_at: "2026-05-02T00:00:00Z",
        body: "Includes the fallback route behavior from PR 158915.",
        comments: [],
        labels: [],
      },
    },
  });
  const responseLog = join(root, "service-responses.jsonl");
  mock = mock.replace(
    "const rawArgs = process.argv.slice(2);",
    `
    const rawArgs = process.argv.slice(2);
    const originalLog = console.log;
    console.log = (...values) => {
      if (rawArgs.some(value => new RegExp("/(?:issues|pulls)/${number}(?:[/?]|$)|/issues/comments/").test(value))) {
        appendFileSync(${JSON.stringify(responseLog)}, JSON.stringify({
          request: rawArgs,
          after_coverage_proof_started: existsSync(${JSON.stringify(proofLog)}),
          response: values.join(" ")
        }) + "\\n");
      }
      originalLog(...values);
    };
  `,
  );
  if (ownedWriteLag) {
    // GitHub returns the write's timestamp on the PATCH response before the item reflects it.
    // Only the first issue read after each durable write returns the old item timestamp.
    mock = mock.replace("const liveUpdatedAt =", "let liveUpdatedAt =");
    mock = mock.replace(
      "const issueCommentCount = ",
      `
      if (existsSync(commentStatePath)) {
        liveUpdatedAt = ${JSON.stringify(t2)};
        if (path === "repos/openclaw/openclaw/issues/" + number) {
          const lagPath = join(__dirname, "..", "post-write-item-reads");
          const reads = existsSync(lagPath) ? Number(readFileSync(lagPath, "utf8")) : 0;
          writeFileSync(lagPath, String(reads + 1));
          if (reads === 0) liveUpdatedAt = ${JSON.stringify(t1)};
        }
      }
      const issueCommentCount = `,
    );
  }
  if (scenario === "owned-write-lag-human-comment") {
    mock = mock.replace(
      "const liveComments = () => {",
      `
      const liveComments = () => {
        const lagPath = join(__dirname, "..", "post-write-item-reads");
        if (existsSync(lagPath) && Number(readFileSync(lagPath, "utf8")) >= 2) {
          comments.push({id: 999999, user: {login: "contributor"}, body: "Please keep this PR open.",
            created_at: new Date(Date.now() + 1000).toISOString(),
            updated_at: new Date(Date.now() + 1000).toISOString()});
        }
    `,
    );
  }
  // Change the service response only after the real coverage-proof process runs.
  // No product function or freshness result is replaced.
  if (scenario === "same-second-title") {
    mock = mock.replace(
      `const title = ${JSON.stringify(title)};`,
      `const title = existsSync(${JSON.stringify(proofLog)}) ? "Contributor changed the title" : ${JSON.stringify(title)};`,
    );
  }
  if (scenario === "human-comment-after-proof") {
    mock = mock.replace(
      "const liveComments = () => {",
      `const liveComments = () => {\n if (existsSync(${JSON.stringify(proofLog)})) comments.push({id: 999999, user: {login: "contributor"}, body: "Please keep this PR open.", created_at: new Date(Date.now() + 1000).toISOString(), updated_at: new Date(Date.now() + 1000).toISOString()});`,
    );
  }
  let execution;
  withMockGh(root, mock, () =>
    withMockCodexProof(
      root,
      {
        type: "decision",
        decision: "covered",
        reason: "The merged canonical PR includes the provider fallback.",
        invocationLogPath: proofLog,
      },
      () => {
        execution = spawnSync(
          process.execPath,
          [
            "dist/clawsweeper.js",
            "apply-decisions",
            "--target-repo",
            "openclaw/openclaw",
            "--items-dir",
            items,
            "--closed-dir",
            join(root, "closed"),
            "--plans-dir",
            join(root, "plans"),
            "--report-path",
            reportPath,
            "--limit",
            "1",
            "--processed-limit",
            ownedWriteLag ? "3" : "1",
            "--close-delay-ms",
            "0",
            "--apply-kind",
            "all",
            "--skip-dashboard",
            "--item-number",
            String(number),
          ],
          { encoding: "utf8" },
        );
      },
    ),
  );
  const sanitize = (text: string) =>
    text.replaceAll(root, `<fixture>/${scenario}`).replaceAll(process.cwd(), "<checkout>");
  writeFileSync(join(root, "stdout.log"), sanitize(execution!.stdout));
  writeFileSync(join(root, "stderr.log"), sanitize(execution!.stderr));
  writeFileSync(responseLog, sanitize(readFileSync(responseLog, "utf8")));
  writeFileSync(reportPath, sanitize(readFileSync(reportPath, "utf8")));
  const requests = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const args = JSON.parse(line) as string[];
      const normalized = args[0] === "--repo" ? args.slice(2) : args;
      const methodIndex = normalized.indexOf("--method");
      const path =
        normalized[0] === "api"
          ? normalized.find((arg, index) => index > 0 && !arg.startsWith("-"))
          : normalized.slice(0, 3).join(" ");
      return {
        method:
          methodIndex >= 0 ? normalized[methodIndex + 1] : normalized[0] === "api" ? "GET" : "CLI",
        path,
        args: normalized.map(sanitize),
      };
    });
  writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2) + "\n");
  const closeWrites = requests.filter((r) => r.path === "pr close " + number).length;
  const durableWrites = requests.filter(
    (r) =>
      ["POST", "PATCH", "PUT"].includes(r.method) &&
      /\/issues\/(comments\/\d+|\d+\/comments)$/.test(r.path ?? ""),
  ).length;
  const apply = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = {
    revision,
    scenario,
    exit_code: execution!.status,
    action_taken: apply.at(-1)?.action,
    reason: apply.at(-1)?.reason,
    drift_log: execution!.stderr.includes("[apply] post-proof drift"),
    close_writes: closeWrites,
    durable_writes: durableWrites,
    coverage_proof_ran: existsSync(proofLog),
    trace: `docs/proof/post-proof-accepted-baseline/${ownedWriteLag ? "owned-write-lag/" : ""}artifacts/${revision}/${scenario}/requests.json`,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  assert.equal(execution!.status, 0);
  assert.equal(result.coverage_proof_ran, true);
  assert.equal(
    requests.filter((request) => request.path?.startsWith("issue edit ")).length,
    0,
    "managed labels must not create a separate apply-owned receipt",
  );
  if (ownedWriteLag) {
    assert.ok(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.path === `repos/openclaw/openclaw/issues/comments/${9000 + number}`,
      ),
      "the shipped path must patch the existing durable review",
    );
    const responses = readFileSync(responseLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const writeIndex = responses.findIndex((entry) => entry.request.includes("PATCH"));
    const itemReads = responses
      .slice(writeIndex + 1)
      .filter((entry) => entry.request.includes(`repos/openclaw/openclaw/issues/${number}`))
      .map((entry) => JSON.parse(entry.response));
    assert.equal(itemReads[0]?.updated_at, t1, "the receipt's first item read must lag");
    assert.ok(
      itemReads.slice(1).some((item) => item.updated_at === t2),
      "later item reads must reflect the write",
    );
  }
  if (
    (scenario === "acknowledgement-only" || scenario === "owned-write-lag") &&
    revision === "candidate"
  ) {
    assert.equal(result.action_taken, "closed");
    assert.equal(result.drift_log, false);
    assert.ok(closeWrites > 0);
    assert.ok(durableWrites > 0);
  } else {
    assert.equal(result.action_taken, "skipped_changed_since_review");
    if (scenario !== "owned-write-lag-human-comment") {
      assert.equal(result.reason, "updated_at changed");
      assert.equal(result.drift_log, true);
    }
    assert.equal(closeWrites, 0);
    if (ownedWriteLag) assert.ok(durableWrites >= 1);
    else assert.equal(durableWrites, 0);
  }
}
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
