import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commitPreparedStateBatch,
  StateMutationConflictError,
} from "../../dist/repair/state-publication-batch.js";
import { prepareStateMutationPlan } from "../../dist/repair/state-publication-mutation.js";
import type { PreparedStateMutationPlan } from "../../dist/repair/state-publication-mutation.js";

type RepositoryFixture = {
  root: string;
  origin: string;
  work: string;
};

test("bounded batches publish 1, 2, 4, 8, and 32 item tuples in one state commit", () => {
  const proof: Array<Record<string, unknown>> = [];
  for (const size of [1, 2, 4, 8, 32]) {
    const fixture = createRepositoryFixture();
    const beforeCount = Number(git(fixture.origin, "rev-list", "--count", "state").trim());
    const plans = Array.from({ length: size }, (_, index) => {
      const item = index + 1;
      const itemPath = `records/openclaw-openclaw/items/${item}.md`;
      return withStateEnvironment(fixture.work, () =>
        prepareStateMutationPlan({
          identity: { itemKey: `openclaw/openclaw#${item}`, revision: 1, claimGeneration: 1 },
          operations: [{ path: itemPath, expectedOid: null, content: `item ${item}\n` }],
        }),
      );
    });

    const result = withStateEnvironment(fixture.work, () =>
      commitPreparedStateBatch({ batchId: `proof-${size}`, plans }),
    );

    assert.equal(result.outcome, "committed");
    assert.equal(
      Number(git(fixture.origin, "rev-list", "--count", "state").trim()),
      beforeCount + 1,
    );
    assert.equal(result.itemCount, size);
    assert.equal(result.pathCount, size);
    assert.ok(result.git.processes > 0);
    assert.ok(result.leaseHoldMs >= 0);
    for (let item = 1; item <= size; item += 1) {
      assert.equal(
        git(fixture.origin, "show", `state:records/openclaw-openclaw/items/${item}.md`),
        `item ${item}\n`,
      );
    }
    assert.match(
      git(fixture.origin, "log", "-1", "--format=%B", "state"),
      new RegExp(`ClawSweeper-Batch-ID: proof-${size}`),
    );
    proof.push({
      size,
      outcome: result.outcome,
      commitSha: result.commitSha,
      durationMs: result.git.durationMs,
      leaseHoldMs: result.leaseHoldMs,
      gitProcesses: result.git.processes,
      gitActions: result.git.actions,
    });
  }
  console.log(`STATE_BATCH_PROOF ${JSON.stringify(proof)}`);
});

test("latest remote sibling changes survive preparation and batch publication", () => {
  const fixture = createRepositoryFixture();
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#42", revision: 1, claimGeneration: 1 },
      operations: [
        { path: "records/openclaw-openclaw/items/42.md", expectedOid: null, content: "item 42\n" },
      ],
    }),
  );
  publishSibling(fixture, "results/unrelated.json", '{"writer":"ordinary"}\n');

  withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "sibling-preservation", plans: [plan] }),
  );

  assert.equal(
    git(fixture.origin, "show", "state:results/unrelated.json"),
    '{"writer":"ordinary"}\n',
  );
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/42.md"),
    "item 42\n",
  );
});

test("filesystem-path remotes publish without constructing an invalid tracking ref", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 22);

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "filesystem-remote",
      plans: [plan],
      remote: fixture.origin,
    }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/22.md"),
    "item 22\n",
  );
});

test("batch commits use the ClawSweeper identity without repository or global Git config", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 24);
  git(fixture.work, "config", "--unset-all", "user.name");
  git(fixture.work, "config", "--unset-all", "user.email");

  const result = withProcessEnv(
    {
      CLAWSWEEPER_GIT_USER_NAME: "",
      CLAWSWEEPER_GIT_USER_EMAIL: "",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    },
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "explicit-git-identity",
          plans: [plan],
        }),
      ),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(
    git(fixture.origin, "log", "-1", "--format=%an%n%ae%n%cn%n%ce", "state").trim(),
    [
      "clawsweeper",
      "274271284+clawsweeper[bot]@users.noreply.github.com",
      "clawsweeper",
      "274271284+clawsweeper[bot]@users.noreply.github.com",
    ].join("\n"),
  );
});

test("GitHub multi-ref commit_refs rejection falls back to fenced single-ref pushes", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 25);
  installMultiRefCommitRefsFailure(fixture.origin);

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "github-commit-refs-fallback",
      plans: [plan],
    }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/25.md"),
    "item 25\n",
  );
  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update("github-commit-refs-fallback")
    .digest("hex")}`;
  assert.equal(
    git(fixture.origin, "rev-parse", "state").trim(),
    git(fixture.origin, "rev-parse", receiptRef).trim(),
  );
});

test("commit_refs recovery retries transient receipt and lease renewal rejections", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 30);
  const batchId = "github-single-ref-retries";
  const rejectedMarkers = installMultiRefAndFirstSingleRefCommitRefsFailures(
    fixture.origin,
    batchId,
  );

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId,
      plans: [plan],
    }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(fs.existsSync(rejectedMarkers.receipt), true);
  assert.equal(fs.existsSync(rejectedMarkers.renewal), true);
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/30.md"),
    "item 30\n",
  );
  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update(batchId)
    .digest("hex")}`;
  assert.equal(
    git(fixture.origin, "rev-parse", "state").trim(),
    git(fixture.origin, "rev-parse", receiptRef).trim(),
  );
});

test("commit_refs recovery retries a transient state branch push rejection", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 31);
  const batchId = "github-state-branch-single-ref-retry";
  const rejected = installMultiRefAndStateBranchCommitRefsFailure(fixture.origin);

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId,
      plans: [plan],
    }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(fs.existsSync(rejected.statePush), true);
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/31.md"),
    "item 31\n",
  );
  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update(batchId)
    .digest("hex")}`;
  assert.equal(
    git(fixture.origin, "rev-parse", "state").trim(),
    git(fixture.origin, "rev-parse", receiptRef).trim(),
  );
});

test("a receipt created after lookup cannot be overwritten", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 29);
  const batchId = "concurrent-receipt";
  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update(batchId)
    .digest("hex")}`;
  const stateBefore = git(fixture.origin, "rev-parse", "state").trim();
  const tree = git(fixture.origin, "rev-parse", "state^{tree}").trim();
  const foreignReceipt = git(
    fixture.work,
    "commit-tree",
    tree,
    "-p",
    stateBefore,
    "-m",
    "foreign receipt",
  ).trim();

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId,
          plans: [plan],
          hooks: {
            beforePush: () => {
              git(fixture.work, "push", "origin", `${foreignReceipt}:${receiptRef}`);
            },
          },
        }),
      ),
    /receipt .* changed before branch publication/,
  );

  assert.equal(git(fixture.origin, "rev-parse", receiptRef).trim(), foreignReceipt);
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), stateBefore);
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/29.md", true),
    "",
  );
});

test("a prepared receipt resumes the same batch without a blind second state commit", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 26);
  const before = git(fixture.origin, "rev-list", "--count", "state").trim();
  installMultiRefAndFirstStateFailure(fixture.origin);

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "github-single-ref-resume",
          plans: [plan],
        }),
      ),
    /simulated state push failure/,
  );

  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update("github-single-ref-resume")
    .digest("hex")}`;
  assert.notEqual(git(fixture.origin, "rev-parse", receiptRef, true), "");
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/26.md", true),
    "",
  );

  const recovered = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "github-single-ref-resume",
      plans: [plan],
    }),
  );

  assert.equal(recovered.outcome, "committed");
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/26.md"),
    "item 26\n",
  );
  assert.equal(
    git(fixture.origin, "rev-list", "--count", "state").trim(),
    String(Number(before) + 1),
  );
  assert.equal(
    git(fixture.origin, "rev-parse", "state").trim(),
    git(fixture.origin, "rev-parse", receiptRef).trim(),
  );
});

test("a prepared receipt resumes from a fresh shallow state checkout", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 28);
  installMultiRefAndFirstStateFailure(fixture.origin);

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "github-single-ref-shallow-resume",
          plans: [plan],
        }),
      ),
    /simulated state push failure/,
  );

  const shallow = path.join(fixture.root, "shallow-retry");
  git(fixture.root, "clone", "--depth=1", "--branch", "state", `file://${fixture.origin}`, shallow);
  configureUser(shallow);
  const transferredBlob = path.join(fixture.root, "transferred-item-28.md");
  fs.writeFileSync(transferredBlob, "item 28\n");
  assert.equal(
    git(shallow, "hash-object", "-w", transferredBlob).trim(),
    plan.operations[0]?.targetOid,
  );

  const recovered = withStateEnvironment(shallow, () =>
    commitPreparedStateBatch({
      batchId: "github-single-ref-shallow-resume",
      plans: [plan],
    }),
  );

  assert.equal(recovered.outcome, "committed");
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/28.md"),
    "item 28\n",
  );
});

test("a prepared receipt fails closed when state advances before retry", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 27);
  installMultiRefAndFirstStateFailure(fixture.origin);

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "github-single-ref-drift",
          plans: [plan],
        }),
      ),
    /simulated state push failure/,
  );

  publishSibling(fixture, "results/intervening.json", '{"writer":"ordinary"}\n');

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "github-single-ref-drift",
          plans: [plan],
        }),
      ),
    (error: unknown) =>
      error instanceof StateMutationConflictError &&
      /prepared receipt.*state advanced/i.test(error.message),
  );
  assert.equal(
    git(fixture.origin, "show", "state:results/intervening.json"),
    '{"writer":"ordinary"}\n',
  );
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/27.md", true),
    "",
  );
});

test("mutation plans reject oversized individual and aggregate path metadata", () => {
  const fixture = createRepositoryFixture();
  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        prepareStateMutationPlan({
          identity: { itemKey: "openclaw/openclaw#23", revision: 1, claimGeneration: 1 },
          operations: [{ path: `records/${"x".repeat(1024)}`, expectedOid: null, content: "x" }],
        }),
      ),
    /path exceeds 1024 bytes/,
  );

  const existingOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  const plans: PreparedStateMutationPlan[] = Array.from({ length: 8 }, (_, planIndex) => ({
    identity: {
      itemKey: `openclaw/openclaw#path-budget-${planIndex}`,
      revision: 1,
      claimGeneration: 1,
    },
    totalBytes: 512 * Buffer.byteLength("initial\n"),
    operations: Array.from({ length: 512 }, (_, operationIndex) => ({
      path: `records/${planIndex}/${operationIndex}-${"p".repeat(32)}.md`,
      expectedOid: null,
      targetOid: existingOid,
      mode: "100644" as const,
      bytes: Buffer.byteLength("initial\n"),
    })),
  }));
  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({ batchId: "aggregate-path-budget", plans }),
      ),
    /exceeds 131072 path bytes/,
  );
});

test("batch validation derives payload bytes from the referenced Git blobs", () => {
  const fixture = createRepositoryFixture();
  const prepared = newItemPlan(fixture, 24);
  const forged: PreparedStateMutationPlan = {
    ...prepared,
    totalBytes: 0,
    operations: prepared.operations.map((operation) => ({ ...operation, bytes: 0 })),
  };
  const before = git(fixture.origin, "rev-parse", "state").trim();

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({ batchId: "forged-byte-accounting", plans: [forged] }),
      ),
    /byte count does not match its Git blob/,
  );
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), before);
  assert.equal(
    git(fixture.origin, "show-ref", "refs/heads/clawsweeper-publish-lease/state", true),
    "",
  );
});

test("incompatible same-path plans fail before acquiring a lease or pushing", () => {
  const fixture = createRepositoryFixture();
  const plans = withStateEnvironment(fixture.work, () => [
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#7", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/shared.md", expectedOid: null, content: "first\n" }],
    }),
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#8", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/shared.md", expectedOid: null, content: "second\n" }],
    }),
  ]);
  const before = git(fixture.origin, "rev-parse", "state").trim();

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({ batchId: "overlap", plans }),
      ),
    StateMutationConflictError,
  );
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), before);
  assert.equal(
    git(fixture.origin, "show-ref", "refs/heads/clawsweeper-publish-lease/state", true),
    "",
  );
});

test("a single poisoned item is quarantined without stranding the rest of the batch", () => {
  const fixture = createRepositoryFixture();
  const healthyBefore = newItemPlan(fixture, 50);
  const expectedOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  const poisoned = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#51", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid, content: "candidate\n" }],
    }),
  );
  const healthyAfter = newItemPlan(fixture, 52);
  publishSibling(fixture, "records/existing.md", "raced by another writer\n");

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "quarantine-single-item",
      plans: [healthyBefore, poisoned, healthyAfter],
    }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(result.itemCount, 2);
  assert.deepEqual(
    result.quarantinedItems.map((item) => item.itemKey),
    ["openclaw/openclaw#51"],
  );
  assert.match(result.quarantinedItems[0]?.reason ?? "", /changed after mutation preparation/);
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/50.md"),
    "item 50\n",
  );
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/52.md"),
    "item 52\n",
  );
  assert.equal(
    git(fixture.origin, "show", "state:records/existing.md"),
    "raced by another writer\n",
  );
});

test("a batch that quarantines an item down to one survivor is retry-idempotent", () => {
  const fixture = createRepositoryFixture();
  const healthy = newItemPlan(fixture, 60);
  const expectedOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  const poisoned = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#61", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid, content: "candidate\n" }],
    }),
  );
  publishSibling(fixture, "records/existing.md", "raced by another writer\n");

  const first = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "quarantine-retry",
      plans: [healthy, poisoned],
    }),
  );
  const retried = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({
      batchId: "quarantine-retry",
      plans: [healthy, poisoned],
    }),
  );

  assert.equal(first.outcome, "committed");
  assert.equal(retried.outcome, "already_committed");
  assert.equal(retried.commitSha, first.commitSha);
  assert.deepEqual(
    retried.quarantinedItems.map((item) => item.itemKey),
    ["openclaw/openclaw#61"],
  );
});

test("remote same-path drift is fenced before push", () => {
  const fixture = createRepositoryFixture();
  const expectedOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#9", revision: 2, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid, content: "candidate\n" }],
    }),
  );
  publishSibling(fixture, "records/existing.md", "newer remote\n");
  const before = git(fixture.origin, "rev-parse", "state").trim();

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "same-path-drift", plans: [plan] }),
  );
  assert.equal(result.outcome, "quarantined");
  assert.equal(result.commitSha, null);
  assert.equal(result.quarantinedItems.length, 1);
  assert.match(result.quarantinedItems[0].reason, /changed after mutation preparation/);
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), before);
  assert.equal(git(fixture.origin, "show", "state:records/existing.md"), "newer remote\n");
});

test("a crash before push leaves the remote state unchanged", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 11);
  const before = git(fixture.origin, "rev-parse", "state").trim();

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "crash-before-push",
          plans: [plan],
          hooks: {
            beforePush: () => {
              throw new Error("simulated process crash");
            },
          },
        }),
      ),
    /simulated process crash/,
  );
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), before);
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/11.md", true),
    "",
  );
});

test("a retry recovers push success after local acknowledgement failure by batch identity", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 12);
  let pushedCommit = "";
  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "ambiguous-ack",
          plans: [plan],
          hooks: {
            afterPush: (commit) => {
              pushedCommit = commit;
              throw new Error("ack lost");
            },
          },
        }),
      ),
    /ack lost/,
  );
  const countAfterPush = git(fixture.origin, "rev-list", "--count", "state").trim();

  const recovered = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "ambiguous-ack", plans: [plan] }),
  );

  assert.equal(recovered.outcome, "already_committed");
  assert.equal(recovered.commitSha, pushedCommit);
  assert.equal(git(fixture.origin, "rev-list", "--count", "state").trim(), countAfterPush);
});

test("a reused batch id cannot acknowledge a different mutation payload", () => {
  const fixture = createRepositoryFixture();
  const first = newItemPlan(fixture, 13);
  withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "payload-binding", plans: [first] }),
  );
  const second = newItemPlan(fixture, 14);

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({ batchId: "payload-binding", plans: [second] }),
      ),
    /already bound to a different mutation fingerprint/,
  );
  assert.equal(
    git(fixture.origin, "show", "state:records/openclaw-openclaw/items/14.md", true),
    "",
  );
});

test("batch receipt recovery deepens past 512 newer commits in a fresh shallow checkout", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 20);
  const committed = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "durable-receipt", plans: [plan] }),
  );
  const sibling = path.join(fixture.root, "receipt-history-writer");
  git(fixture.root, "clone", "--branch", "state", fixture.origin, sibling);
  configureUser(sibling);
  const tree = git(sibling, "rev-parse", "HEAD^{tree}").trim();
  let parent = git(sibling, "rev-parse", "HEAD").trim();
  // Only ancestry depth matters here. Plumbing commits avoid Git auto-maintenance
  // racing hundreds of disposable worktree/index updates on shared CI runners.
  for (let index = 0; index < 700; index += 1) {
    parent = git(
      sibling,
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `ordinary state commit ${index}`,
    ).trim();
  }
  git(sibling, "push", "origin", `${parent}:state`);

  const shallow = path.join(fixture.root, "receipt-history-shallow");
  git(fixture.root, "clone", "--depth=1", "--branch", "state", `file://${fixture.origin}`, shallow);
  configureUser(shallow);
  const recovered = withStateEnvironment(shallow, () =>
    commitPreparedStateBatch({ batchId: "durable-receipt", plans: [plan] }),
  );

  assert.equal(recovered.outcome, "already_committed");
  assert.equal(recovered.commitSha, committed.commitSha);
});

test("custom batch commit messages cannot inject recovery trailers", () => {
  const fixture = createRepositoryFixture();
  const plan = newItemPlan(fixture, 21);
  const before = git(fixture.origin, "rev-parse", "state").trim();

  assert.throws(
    () =>
      withStateEnvironment(fixture.work, () =>
        commitPreparedStateBatch({
          batchId: "message-injection",
          plans: [plan],
          message: "subject\n\nClawSweeper-Batch-ID: forged",
        }),
      ),
    /commit subjects must be single-line/,
  );
  assert.equal(git(fixture.origin, "rev-parse", "state").trim(), before);
});

test("literal Git path names cannot bypass the remote compare-and-swap fence", () => {
  const fixture = createRepositoryFixture();
  const literalPath = "records/[ab].md";
  fs.writeFileSync(path.join(fixture.work, literalPath), "remote literal\n");
  git(fixture.work, "add", literalPath);
  git(fixture.work, "commit", "-m", "add literal pathspec-shaped record");
  git(fixture.work, "push", "origin", "HEAD:state");
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#17", revision: 1, claimGeneration: 1 },
      operations: [{ path: literalPath, expectedOid: null, content: "candidate\n" }],
    }),
  );

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "literal-path-fence", plans: [plan] }),
  );
  assert.equal(result.outcome, "quarantined");
  assert.equal(result.quarantinedItems.length, 1);
  assert.match(result.quarantinedItems[0].reason, /changed after mutation preparation/);
  assert.equal(git(fixture.origin, "show", `state:${literalPath}`), "remote literal\n");
});

test("semantically identical identity property order produces the same recovery fingerprint", () => {
  const fixture = createRepositoryFixture();
  const first = newItemPlan(fixture, 18);
  const committed = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "canonical-identity", plans: [first] }),
  );
  const reordered = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { claimGeneration: 1, revision: 1, itemKey: "openclaw/openclaw#18" },
      operations: [
        {
          path: "records/openclaw-openclaw/items/18.md",
          expectedOid: null,
          content: "item 18\n",
        },
      ],
    }),
  );

  const recovered = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "canonical-identity", plans: [reordered] }),
  );

  assert.equal(recovered.outcome, "already_committed");
  assert.equal(recovered.fingerprint, committed.fingerprint);
});

test("batch fingerprints do not depend on locale-aware string ordering", () => {
  const fixture = createRepositoryFixture();
  const plans = withStateEnvironment(fixture.work, () => [
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#ä", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/ä.md", expectedOid: null, content: "umlaut\n" }],
    }),
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#z", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/z.md", expectedOid: null, content: "zed\n" }],
    }),
  ]);
  const canonical = [...plans]
    .sort((left, right) => (left.identity.itemKey < right.identity.itemKey ? -1 : 1))
    .map((plan) => ({
      identity: {
        itemKey: plan.identity.itemKey,
        revision: plan.identity.revision,
        claimGeneration: plan.identity.claimGeneration,
      },
      operations: plan.operations.map(
        ({ path: operationPath, expectedOid, targetOid, mode, bytes }) => ({
          path: operationPath,
          expectedOid,
          targetOid,
          mode,
          bytes,
        }),
      ),
    }));
  const expected = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "locale-independent-fingerprint", plans }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(result.fingerprint, expected);
});

test("materialization compares and corrects the executable bit as well as blob content", () => {
  const fixture = createRepositoryFixture();
  git(fixture.work, "update-index", "--chmod=+x", "records/existing.md");
  git(fixture.work, "commit", "-m", "make existing record executable");
  git(fixture.work, "push", "origin", "HEAD:state");
  const expectedOid = git(fixture.work, "rev-parse", "HEAD:records/existing.md").trim();
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#15", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid, content: "initial\n" }],
    }),
  );

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "mode-correction", plans: [plan] }),
  );

  assert.equal(result.outcome, "committed");
  assert.match(git(fixture.origin, "ls-tree", "state", "records/existing.md"), /^100644 blob /);
});

test("deletion index records use the SHA-256 repository object width", () => {
  const fixture = createRepositoryFixture("sha256");
  const expectedOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  assert.equal(expectedOid.length, 64);
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#16", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid, delete: true }],
    }),
  );

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "sha256-deletion", plans: [plan] }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(git(fixture.origin, "show", "state:records/existing.md", true), "");
});

test("an absent deletion target writes one durable binding marker and then recovers", () => {
  const fixture = createRepositoryFixture();
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#19", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/already-absent.md", expectedOid: null, delete: true }],
    }),
  );
  const beforeCommit = git(fixture.origin, "rev-parse", "state").trim();
  const beforeTree = git(fixture.origin, "rev-parse", "state^{tree}").trim();

  const committed = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "absent-deletion", plans: [plan] }),
  );
  const recovered = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "absent-deletion", plans: [plan] }),
  );

  assert.equal(committed.outcome, "committed");
  assert.notEqual(committed.commitSha, beforeCommit);
  assert.equal(git(fixture.origin, "rev-parse", "state^{tree}").trim(), beforeTree);
  assert.equal(recovered.outcome, "already_committed");
  assert.equal(recovered.commitSha, committed.commitSha);
});

test("batch size one durably binds already-materialized content with one marker commit", () => {
  const fixture = createRepositoryFixture();
  const existingOid = git(fixture.work, "rev-parse", "state:records/existing.md").trim();
  const plan = withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: "openclaw/openclaw#1", revision: 1, claimGeneration: 1 },
      operations: [{ path: "records/existing.md", expectedOid: null, content: "initial\n" }],
    }),
  );
  assert.equal(plan.operations[0]?.targetOid, existingOid);

  const result = withStateEnvironment(fixture.work, () =>
    commitPreparedStateBatch({ batchId: "single-idempotent", plans: [plan] }),
  );

  assert.equal(result.outcome, "committed");
  assert.equal(result.commitSha, git(fixture.origin, "rev-parse", "state").trim());
});

function newItemPlan(fixture: RepositoryFixture, item: number) {
  return withStateEnvironment(fixture.work, () =>
    prepareStateMutationPlan({
      identity: { itemKey: `openclaw/openclaw#${item}`, revision: 1, claimGeneration: 1 },
      operations: [
        {
          path: `records/openclaw-openclaw/items/${item}.md`,
          expectedOid: null,
          content: `item ${item}\n`,
        },
      ],
    }),
  );
}

function createRepositoryFixture(objectFormat: "sha1" | "sha256" = "sha1"): RepositoryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-batch-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "--bare", `--object-format=${objectFormat}`, origin);
  git(root, "clone", origin, work);
  configureUser(work);
  fs.mkdirSync(path.join(work, "records"), { recursive: true });
  fs.writeFileSync(path.join(work, "records", "existing.md"), "initial\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "initial state");
  git(work, "push", "origin", "HEAD:state");
  git(work, "fetch", "origin", "state:state");
  return { root, origin, work };
}

function publishSibling(fixture: RepositoryFixture, file: string, content: string): void {
  const sibling = path.join(fixture.root, `sibling-${Math.random().toString(16).slice(2)}`);
  git(fixture.root, "clone", "--branch", "state", fixture.origin, sibling);
  configureUser(sibling);
  fs.mkdirSync(path.dirname(path.join(sibling, file)), { recursive: true });
  fs.writeFileSync(path.join(sibling, file), content);
  git(sibling, "add", ".");
  git(sibling, "commit", "-m", "ordinary sibling update");
  git(sibling, "push", "origin", "HEAD:state");
}

function installMultiRefCommitRefsFailure(origin: string): void {
  const hook = path.join(origin, "hooks", "pre-receive");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "count=0",
      "while read -r old_oid new_oid ref_name; do",
      "  count=$((count + 1))",
      "done",
      'if [ "$count" -ge 2 ]; then',
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
}

function installMultiRefAndFirstSingleRefCommitRefsFailures(
  origin: string,
  batchId: string,
): { receipt: string; renewal: string } {
  const hook = path.join(origin, "hooks", "pre-receive");
  const rejectedReceiptMarker = path.join(origin, "hooks", "rejected-receipt-once");
  const rejectedRenewalMarker = path.join(origin, "hooks", "rejected-lease-renewal-once");
  const receiptRef = `refs/heads/clawsweeper-state-batches/${createHash("sha256")
    .update(batchId)
    .digest("hex")}`;
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "count=0",
      'only_old_oid=""',
      'only_new_oid=""',
      'only_ref=""',
      "while read -r old_oid new_oid ref_name; do",
      "  count=$((count + 1))",
      '  only_old_oid="$old_oid"',
      '  only_new_oid="$new_oid"',
      '  only_ref="$ref_name"',
      "done",
      'if [ "$count" -ge 2 ]; then',
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      `if [ "$only_ref" = "${receiptRef}" ] && [ ! -f '${rejectedReceiptMarker}' ]; then`,
      `  touch '${rejectedReceiptMarker}'`,
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      'case "$only_old_oid" in',
      "  *[!0]*) old_oid_is_zero=0 ;;",
      "  *) old_oid_is_zero=1 ;;",
      "esac",
      'case "$only_new_oid" in',
      "  *[!0]*) new_oid_is_zero=0 ;;",
      "  *) new_oid_is_zero=1 ;;",
      "esac",
      'if [ "$only_ref" = "refs/heads/clawsweeper-publish-lease/state" ] &&',
      '   [ "$old_oid_is_zero" -eq 0 ] && [ "$new_oid_is_zero" -eq 0 ]; then',
      `  if ! git --git-dir='${origin}' show-ref --verify --quiet '${receiptRef}'; then`,
      '    echo "lease renewal occurred before receipt publication" >&2',
      "    exit 1",
      "  fi",
      `  if [ ! -f '${rejectedRenewalMarker}' ]; then`,
      `    touch '${rejectedRenewalMarker}'`,
      '    echo "fatal error in commit_refs" >&2',
      "    exit 1",
      "  fi",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
  return { receipt: rejectedReceiptMarker, renewal: rejectedRenewalMarker };
}

function installMultiRefAndFirstStateFailure(origin: string): void {
  const hook = path.join(origin, "hooks", "pre-receive");
  const rejectedStateMarker = path.join(origin, "hooks", "rejected-state-once");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "count=0",
      'only_ref=""',
      "while read -r old_oid new_oid ref_name; do",
      "  count=$((count + 1))",
      '  only_ref="$ref_name"',
      "done",
      'if [ "$count" -ge 2 ]; then',
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      `if [ "$only_ref" = "refs/heads/state" ] && [ ! -f '${rejectedStateMarker}' ]; then`,
      `  touch '${rejectedStateMarker}'`,
      '  echo "simulated state push failure" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
}

function installMultiRefAndStateBranchCommitRefsFailure(origin: string): { statePush: string } {
  const hook = path.join(origin, "hooks", "pre-receive");
  const rejectedStateMarker = path.join(origin, "hooks", "rejected-state-branch-commit-refs-once");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "count=0",
      'only_ref=""',
      "while read -r old_oid new_oid ref_name; do",
      "  count=$((count + 1))",
      '  only_ref="$ref_name"',
      "done",
      'if [ "$count" -ge 2 ]; then',
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      `if [ "$only_ref" = "refs/heads/state" ] && [ ! -f '${rejectedStateMarker}' ]; then`,
      `  touch '${rejectedStateMarker}'`,
      '  echo "fatal error in commit_refs" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
  return { statePush: rejectedStateMarker };
}

function configureUser(root: string): void {
  git(root, "config", "user.name", "ClawSweeper Test");
  git(root, "config", "user.email", "clawsweeper@example.com");
}

function withStateEnvironment<T>(work: string, operation: () => T): T {
  const previousDir = process.env.CLAWSWEEPER_STATE_DIR;
  const previousBranch = process.env.CLAWSWEEPER_PUBLISH_BRANCH;
  process.env.CLAWSWEEPER_STATE_DIR = work;
  process.env.CLAWSWEEPER_PUBLISH_BRANCH = "state";
  try {
    return operation();
  } finally {
    if (previousDir === undefined) delete process.env.CLAWSWEEPER_STATE_DIR;
    else process.env.CLAWSWEEPER_STATE_DIR = previousDir;
    if (previousBranch === undefined) delete process.env.CLAWSWEEPER_PUBLISH_BRANCH;
    else process.env.CLAWSWEEPER_PUBLISH_BRANCH = previousBranch;
  }
}

function withProcessEnv<T>(values: Record<string, string | undefined>, operation: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function git(root: string, ...args: Array<string | boolean>): string {
  const allowFailure = args.at(-1) === true;
  if (allowFailure) args.pop();
  try {
    return execFileSync("git", args as string[], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}
