import assert from "node:assert/strict";
import YAML from "yaml";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareDirectPublicationPayload } from "../../dist/repair/exact-review-direct-publication.js";

const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "oversized-policy-proof-"));
const source = process.cwd();
let workerd;
let workerLog = "";
const observations = [];
try {
  // Only initial runner ownership is supplied by the fixture. Publication,
  // canonical records, terminal receipts and completion use production code.
  await writeFile(
    join(scratch, "entry.ts"),
    `
import { ExactReviewQueue } from ${JSON.stringify(resolve("dashboard/exact-review-queue.ts"))};
import { ExactReviewLifecycleProjectionStore } from ${JSON.stringify(resolve("dashboard/exact-review-lifecycle.ts"))};
export class ProofQueue extends ExactReviewQueue {
  constructor(state, env) {
    super(state, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" });
    this.proofStorage = state.storage;
  }
  async alarm() {} // No workflow dispatch in this isolated publication fixture.
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/proof/")) {
      await super.fetch(new Request("https://queue/stats"));
      const body = await request.json();
      if (url.pathname === "/proof/lease") {
        const row = [...this.proofStorage.sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", body.key)][0];
        const item = JSON.parse(row.item_json);
        Object.assign(item, { state: "leased", leaseDecision: item.decision, leaseId: "proof-lease", leaseRevision: item.revision, leaseExpiresAt: Date.now() + 600000, claimedRunId: "123456", claimedRunAttempt: 1, claimGeneration: 1, claimProtocolVersion: 2 });
        this.proofStorage.sql.exec("UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?", JSON.stringify(item), body.key);
        return Response.json(item);
      }
      return Response.json({
        item: [...this.proofStorage.sql.exec("SELECT item_json FROM exact_review_queue_items WHERE item_key = ?", body.key)],
        plan: [...this.proofStorage.sql.exec("SELECT lifecycle_json FROM exact_review_direct_publication_plans WHERE fence_key = ?", body.key)],
        projection: [...this.proofStorage.sql.exec("SELECT projection_json FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ?", body.key)],
        bay: new ExactReviewLifecycleProjectionStore(this.proofStorage).readBaySnapshot(Date.now(), new Set(["openclaw/openclaw"])),
        alarm: await this.proofStorage.getAlarm(),
      });
    }
    return super.fetch(request);
  }
}
globalThis.fetch = async () => { throw new Error("proof forbids outbound network"); };
export default { fetch(request, env) { return env.QUEUE.getByName("proof").fetch(request); } };
`,
  );
  await writeFile(
    join(scratch, "wrangler.json"),
    JSON.stringify({
      name: "oversized-policy-proof",
      main: "entry.ts",
      compatibility_date: "2026-05-11",
      durable_objects: { bindings: [{ name: "QUEUE", class_name: "ProofQueue" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProofQueue"] }],
      vars: {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
      },
    }),
  );
  // Wrangler owns the ephemeral port until teardown; reserving then closing a
  // separate listener races Workerd's bind with other local sockets.
  let base = "";
  workerd = spawn(
    "corepack",
    [
      "pnpm",
      "dlx",
      "--allow-build",
      "esbuild",
      "--allow-build",
      "workerd",
      "wrangler@4.131.1",
      "dev",
      "--config",
      join(scratch, "wrangler.json"),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--persist-to",
      join(scratch, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [workerd.stdout, workerd.stderr])
    stream.on("data", (chunk) => {
      workerLog = (workerLog + chunk).slice(-16384);
    });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    base = workerLog.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
    ready =
      base !== "" &&
      (await fetch(`${base}/stats`)
        .then((r) => r.ok)
        .catch(() => false));
    if (ready || workerd.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.ok(ready, "Workerd must start");
  const post = async (path, value) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const payload = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
  await writeFile(
    join(scratch, "transport.mjs"),
    `
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://policy-proof.invalid") throw new Error("proof refused outbound network");
  return original(new Request(${JSON.stringify(base)} + url.pathname.replace("/internal/exact-review", ""), request));
};
`,
  );
  await writeFile(
    join(scratch, "github.mjs"),
    'throw new Error("policy refusal must not read or mutate GitHub");\n',
  );
  let number = 41;
  for (const lane of ["direct", "batch"])
    for (const reason of ["close_gate_disabled", "comments_only", "close_reason_disabled"]) {
      number++;
      const target = `openclaw/openclaw#${number}`;
      const work = join(scratch, `${lane}-${reason}`);
      const artifactDir = join(work, "artifacts/event");
      await mkdir(artifactDir, { recursive: true });
      const env = {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--import=${join(scratch, "transport.mjs")}`,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([join(scratch, "github.mjs")]),
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: String(number),
        CLAWSWEEPER_CODE_ROOT: source,
        EXACT_REVIEW_WORK_ROOT: work,
        EXACT_EVENT_PUBLICATION: "true",
        CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED: reason === "close_gate_disabled" ? "false" : "true",
        REVIEW_ONLY: reason === "comments_only" ? "true" : "false",
        CLOSE_REASONS: reason === "close_reason_disabled" ? "duplicate_or_superseded" : "all",
        EXACT_REVIEW_QUEUE_URL: "https://policy-proof.invalid",
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-policy-proof",
      };
      const admission = join(work, "admission.json");
      await writeFile(
        admission,
        JSON.stringify({
          repo: "openclaw/openclaw",
          observedAt: new Date().toISOString(),
          pull: {
            number,
            title: "Synthetic oversized proposal",
            body: "Synthetic policy proof",
            state: "open",
            locked: false,
            additions: 60000,
            deletions: 10,
            changed_files: 500,
            head: { sha: "b".repeat(40) },
            base: { ref: "main", sha: "a".repeat(40) },
            user: { login: "fixture-author" },
            author_association: "CONTRIBUTOR",
            draft: false,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            comments: 0,
            review_comments: 0,
            labels: [],
          },
        }),
      );
      await execute(
        process.execPath,
        [
          resolve("dist/clawsweeper.js"),
          "review",
          "--target-repo",
          env.TARGET_REPO,
          "--item-number",
          String(number),
          "--pr-admission-file",
          admission,
          "--artifact-dir",
          artifactDir,
          "--skip-start-comment",
        ],
        { env },
      );
      const producerDecision = {
        targetRepo: env.TARGET_REPO,
        targetBranch: "main",
        itemNumber: number,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "opened",
        supersedesInProgress: false,
      };
      let member;
      let batch;
      if (lane === "direct") {
        await post("/enqueue", { delivery_id: `proof-${number}`, decision: producerDecision });
        const owned = await post("/proof/lease", { key: target });
        member = {
          item_key: target,
          revision: owned.revision,
          claim_generation: owned.claimGeneration,
        };
      } else {
        await post("/enqueue", {
          delivery_id: `proof-${number}`,
          decision: {
            ...producerDecision,
            sourceAction: "exact_review_artifact_publish",
            publication: {
              artifactName: `exact-review-${number}-1`,
              producerRunId: String(number),
              producerRunAttempt: 1,
              sourceSha: "a".repeat(40),
              itemKey: target,
              protocolVersion: 2,
              leaseRevision: 1,
              claimGeneration: 1,
              liveProceeded: true,
              liveTerminalNoop: false,
              liveTerminalMissing: false,
              liveGuardedOpen: false,
              producerDecision,
            },
          },
        });
        const claim = await post("/publication-batches/claim", {
          claim_id: `proof-${number}`,
          lease_owner: "proof-worker",
          max_items: 1,
          runner_run_id: "123456",
          runner_run_attempt: 1,
          runner_started_at: new Date().toISOString(),
        });
        assert.equal(claim.claimed, true, JSON.stringify(claim));
        batch = claim.batch;
        member = batch.items[0];
      }
      const outcomePath = join(work, "outcome.json");
      Object.assign(env, {
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: outcomePath,
        EXACT_REVIEW_BATCH_ITEM_KEY: member.item_key,
        EXACT_REVIEW_BATCH_REVISION: String(member.revision),
        EXACT_REVIEW_BATCH_CLAIM_GENERATION: String(member.claim_generation),
      });
      const published = await execute(
        process.execPath,
        [resolve("dist/repair/publish-event-result.js")],
        { env },
      );
      assert.match(published.stdout, /intentional policy no-op/);
      const outcome = JSON.parse(await readFile(outcomePath, "utf8"));
      assert.equal(outcome.kind, "eligible");
      assert.equal(outcome.disposition.policyNoopExpected, true);
      for (const key of [
        "routableSyncExpected",
        "requeueLatestExpected",
        "terminalClosedExpected",
        "terminalMissingExpected",
      ])
        assert.equal(outcome.disposition[key], false);
      assert.equal(outcome.disposition.guardedOpenAction, null);
      const action = JSON.parse(
        await readFile(join(work, ".artifacts/event-apply-report.json"), "utf8"),
      )[0];
      assert.equal(action.oversizedClosePolicyDeferred, reason);
      assert.equal(action.commentMutationOccurred, undefined);
      if (lane === "direct") {
        const output = join(work, "direct.output");
        await execute(
          process.execPath,
          [resolve("dist/repair/exact-review-direct-publication.js")],
          {
            env: {
              ...env,
              EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
              EXACT_REVIEW_DIRECT_MUTATION_OUTPUT: outcomePath,
              EXACT_REVIEW_DIRECT_SOURCE_ACTION: "manual_explicit_review",
              EXACT_REVIEW_DIRECT_REVISION: String(member.revision),
              GITHUB_SHA: "a".repeat(40),
              GITHUB_OUTPUT: output,
            },
          },
        );
        assert.match(await readFile(output, "utf8"), /^accepted=true$/m);
      } else {
        const accepted = await post(
          "/publication-batch-results",
          prepareDirectPublicationPayload({ revision: member.revision, plan: outcome.plan }),
        );
        assert.equal(accepted.accepted, true);
      }
      const workflowPath =
        lane === "direct"
          ? ".github/workflows/sweep.yml"
          : ".github/workflows/exact-review-batch-publish.yml";
      const workflow = YAML.parse(await readFile(workflowPath, "utf8"));
      const step = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) =>
          lane === "direct"
            ? step.id === "finalize-direct-exact-review-lifecycle"
            : step.name === "Finalize healthy members under a fenced heartbeat",
        );
      const start =
        lane === "direct"
          ? 'if [ "${DIRECT_PUBLICATION_SUPERSEDED:-false}" != "true" ]; then'
          : 'if [ "$receipt_outcome" = "superseded" ]; then';
      const end =
        lane === "direct"
          ? 'if [ -n "$lifecycle_router_outcome" ]; then'
          : 'if [ -n "$lifecycle_router_outcome" ] || [ -n "$lifecycle_terminal" ]; then';
      const startIndex = step.run.indexOf(start);
      const endIndex = step.run.indexOf(end, startIndex);
      assert.ok(startIndex >= 0 && endIndex > startIndex);
      const classifier = step.run.slice(startIndex, endIndex);
      for (const sourceAction of [
        "opened",
        "manual_explicit_review",
        "failed_review_shard_recovery",
      ]) {
        const classified = await execute(
          "bash",
          [
            "-c",
            `set -euo pipefail
gh() { echo 'unexpected GitHub call' >&2; return 99; }
lifecycle_terminal=
lifecycle_router_outcome=
lifecycle_deferred_coverage=false
${classifier}
printf '%s|%s' "$lifecycle_terminal" "$lifecycle_router_outcome"`,
          ],
          {
            env: {
              PATH: process.env.PATH,
              DIRECT_OUTCOME: outcomePath,
              outcome_path: outcomePath,
              source_action: sourceAction,
              publication_policy:
                sourceAction === "manual_explicit_review" ? "record_comment_only" : "",
              outcome_kind: "eligible",
              receipt_outcome: "accepted",
            },
          },
        );
        assert.equal(
          classified.stdout,
          "policy_noop|",
          "actual workflow classifier must not route a policy no-op",
        );
      }
      await post("/lifecycle/terminal-disposition", {
        canonical_target_key: target,
        fence_key: member.item_key,
        revision: member.revision,
        kind: "policy_noop",
      });
      const completion =
        lane === "direct"
          ? await post("/complete", {
              lease_id: "proof-lease",
              item_key: member.item_key,
              lease_revision: member.revision,
              claim_generation: member.claim_generation,
              run_id: "123456",
              run_attempt: 1,
              outcome: "success",
              completion_kind: "published",
              reason_code: "publication_applied",
              lifecycle_terminal_disposition: "policy_noop",
            })
          : await post("/publication-batches/complete", {
              batch_id: batch.batch_id,
              lease_owner: "proof-worker",
              items: [{ ...member, terminal_outcome: "published" }],
            });
      assert.equal(completion.ok, true);
      const state = await post("/proof/state", { key: member.item_key });
      if (lane === "direct")
        assert.equal(JSON.parse(state.plan[0].lifecycle_json).kind, "policy_noop");
      assert.equal(state.item.length, 0, "completed immutable attempt must leave the queue");
      const projection = JSON.parse(state.projection[0].projection_json);
      assert.equal(projection.terminalDisposition.kind, "policy_noop");
      assert.equal(projection.routerReceipts.length, 0);
      assert.equal(projection.githubEffect, null, "Bay must not infer a delivered GitHub effect");
      const card = state.bay.sample.cards.find((card) => card.target.number === number);
      assert.equal(card.state, "policy_noop");
      assert.equal(card.lane, "terminal_attention");
      assert.equal(card.facts.github_effect_recorded, false);
      const canonical = await fetch(`${base}/records/openclaw-openclaw/items/${number}`).then((r) =>
        r.json(),
      );
      assert.match(canonical.content, /^decision: close$/m);
      assert.match(canonical.content, /^action_taken: proposed_close$/m);
      assert.match(canonical.content, /^oversized_pull_request: /m);
      observations.push({
        lane,
        reason,
        canonicalProposalRetained: true,
        terminal: "policy_noop",
        remainingQueueItems: state.item.length,
        githubWrites: 0,
        routerReceipts: 0,
      });
    }
  console.log(
    JSON.stringify({
      result: "passed",
      runtime: "local-workerd",
      node: process.version,
      observations,
      limits:
        "Synthetic admitted runner ownership and GitHub-denying transport; real compiled CLI, HTTP, SQLite, canonical publication and completion. Scheduler dispatch and production credentials are not exercised.",
    }),
  );
} catch (error) {
  console.error(workerLog.split(scratch).join("<proof-scratch>"));
  throw error;
} finally {
  if (workerd?.pid) {
    const signalGroup = (signal) => {
      try {
        process.kill(-workerd.pid, signal);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    signalGroup("SIGTERM");
    for (let attempt = 0; attempt < 100 && signalGroup(0); attempt++) {
      if (attempt === 50) signalGroup("SIGKILL");
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(signalGroup(0), false, "proof process group must stop");
  }
  await rm(scratch, { recursive: true, force: true });
}
