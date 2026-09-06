import assert from "node:assert/strict";
import test from "node:test";
import { executeReviewProof, type InlineProofIO } from "../dashboard/review-proof-execution.ts";
import { proofFixture, replaceProofEvidence, digest } from "./helpers/command-proof-fixtures.ts";
import { readReviewProofZip } from "../dashboard/review-proof-zip.ts";

async function fixture(web = false) {
  let f = proofFixture("d".repeat(64), web ? "web-ui-chat-proof" : "telegram-bot-e2e-proof");
  const planSha256 = "f".repeat(64);
  const files = await readReviewProofZip(f.evidenceArchive);
  const changed = new Map(
    [...files].map(([path, bytes]) => [
      path,
      Buffer.from(
        JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), plan_sha256: planSha256 }),
      ),
    ]),
  );
  if (web) {
    changed.set(
      "final-reply.png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]),
    );
    changed.set(
      "observer.json",
      Buffer.from(
        JSON.stringify({
          schema: "mantis.web-ui-observer.v1",
          inventory: ["chat-send.json", "final-reply.json", "final-reply.png"].map((path) => ({
            path,
            sha256: digest(changed.get(path)!),
          })),
        }),
      ),
    );
  }
  f = replaceProofEvidence(f, changed);
  const pull = { ...f.live.pull, base: { ...f.live.pull.base, repo: f.live.repository } };
  const updates: unknown[] = [];
  const io: InlineProofIO = {
    record: {
      requestId: f.claim.requestId,
      scenario: f.claim.scenario,
      proofPlan: {},
      planSha256,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      state: "pending",
      runId: "300",
      producer: {
        workflowSha: f.claim.workflowSha,
        harnessSha: f.claim.harnessSha,
        workflowPath: f.claim.workflowPath,
        workflowRef: "main",
        repositoryId: "123",
        bodySha256: f.claim.bodySha256,
        baseSha: f.claim.baseSha,
        targetBranch: "main",
      },
    },
    target: {
      repository: f.claim.repository,
      pullRequest: 42,
      headSha: f.claim.headSha,
      targetBranch: "main",
    },
    dispatch: false,
    github: async (path) => {
      if (path.endsWith("/pulls/42")) return pull;
      if (path.endsWith("/actions/runs/300")) return f.run;
      if (path.endsWith("/jobs?per_page=100")) return f.jobs;
      if (path.endsWith("/artifacts?per_page=100"))
        return { total_count: 2, artifacts: [f.receiptArtifact, f.evidenceArtifact] };
      throw new Error("unexpected API " + path);
    },
    artifact: async (id) => (id === "400" ? f.evidenceArchive : f.receiptArchive),
    update: async (value) => {
      updates.push(value);
      return { ok: true, record: { ...io.record, ...value } };
    },
  };
  return { io, f, updates, pull };
}

test("inline executor verifies real receipt ZIP and returns observations, never a pass verdict", async () => {
  const { io } = await fixture();
  const result = await executeReviewProof(io);
  assert.equal(result.state, "completed");
  assert.equal((result.result as any).assertion, "reviewer_must_evaluate");
  assert.equal(Object.keys((result.result as any).observations).length, 3);
});

for (const dispatch of [true, false]) {
  for (const fault of ["terminal", "missing", "different", "expired"]) {
    test(`inline executor fences ${dispatch ? "preparation" : "completion"} acknowledgement (${fault})`, async () => {
      const { io } = await fixture();
      io.dispatch = dispatch;
      if (dispatch) io.record.state = "dispatch_claimed";
      const original = io.github;
      let dispatches = 0;
      io.github = async (path, body) => {
        if (path.endsWith("/commits/main")) return { sha: "e".repeat(40) };
        if (body) {
          dispatches++;
          return { workflow_run_id: 300 };
        }
        return original(path);
      };
      io.update = async (patch) => {
        if (fault === "expired") io.record.expiresAt = Date.now() - 1;
        return {
          ok: true,
          ...(fault === "missing"
            ? {}
            : {
                record: {
                  ...io.record,
                  ...patch,
                  ...(fault === "terminal" ? { state: "inconclusive" } : {}),
                  ...(fault === "different" ? { requestId: "0".repeat(64) } : {}),
                },
              }),
        };
      };
      const result = await executeReviewProof(io);
      assert.equal(result.state, "inconclusive");
      assert.equal(result.result, undefined);
      assert.equal(dispatches, 0);
    });
  }
}

test("inline Web UI verifies fixed recipe JSON, observer manifest and screenshot metadata", async () => {
  const { io } = await fixture(true);
  const result = await executeReviewProof(io);
  assert.equal(result.state, "completed");
  assert.equal((result.result as any).observations["final-reply.png"].mediaType, "image/png");
  assert.match((result.result as any).limits.at(-1), /Fixed browser/);
});

test("inline executor rejects stale target and modified archive", async () => {
  const stale = await fixture();
  stale.pull.head.sha = "0".repeat(40);
  assert.equal((await executeReviewProof(stale.io)).state, "inconclusive");
  const modified = await fixture();
  modified.f.receiptArtifact.digest = "sha256:" + "0".repeat(64);
  assert.equal((await executeReviewProof(modified.io)).reason, "untrusted_receipt_archive");
});

test("cached completed proof rechecks PR head and producer rerun before delivery", async () => {
  const valid = await fixture();
  valid.io.record.state = "completed";
  valid.io.record.result = { observations: "previously verified" };
  assert.equal((await executeReviewProof(valid.io)).state, "completed");
  valid.pull.head.sha = "0".repeat(40);
  assert.equal((await executeReviewProof(valid.io)).state, "inconclusive");
  const rerun = await fixture();
  rerun.io.record.state = "completed";
  rerun.io.record.result = { observations: "previously verified" };
  rerun.f.run.run_attempt = 2;
  assert.equal((await executeReviewProof(rerun.io)).reason, "untrusted_producer_run");
});

test("inline executor never retries uncertain dispatch and prepares trusted pins first", async () => {
  const { io, updates } = await fixture();
  io.dispatch = true;
  io.record.state = "dispatch_claimed";
  delete io.record.producer;
  delete io.record.runId;
  const original = io.github;
  let dispatches = 0;
  let dispatchedBody: unknown;
  let preparedOperation: unknown;
  io.github = async (path, body) => {
    if (path.endsWith("/commits/main")) return { sha: "e".repeat(40) };
    if (body) {
      dispatches++;
      dispatchedBody = body;
      preparedOperation = (updates[0] as any).operation;
      throw new Error("lost response");
    }
    return original(path);
  };
  assert.equal((await executeReviewProof(io)).reason, "dispatch_outcome_unknown_no_retry");
  assert.equal(dispatches, 1);
  assert.deepEqual(Object.keys(dispatchedBody as object).sort(), ["inputs", "ref"]);
  assert.equal(preparedOperation, "prepared");
  io.dispatch = false;
  await executeReviewProof(io);
  assert.equal(dispatches, 1);
});

for (const web of [false, true]) {
  test(`inline ${web ? "Web UI" : "Telegram"} dispatch uses a workflow filename`, async () => {
    const { io, f } = await fixture(web);
    io.dispatch = true;
    io.record.state = "dispatch_claimed";
    delete io.record.producer;
    delete io.record.runId;
    const original = io.github;
    let dispatchedPath: string | undefined;
    io.github = async (path, body) => {
      if (path.endsWith("/commits/main")) return { sha: "e".repeat(40) };
      if (body) {
        dispatchedPath = path;
        return { id: 300 };
      }
      return original(path);
    };
    await executeReviewProof(io);
    assert.equal(
      dispatchedPath,
      `repos/${f.claim.repository}/actions/workflows/${f.claim.workflowPath.split("/").at(-1)}/dispatches`,
    );
  });
}
