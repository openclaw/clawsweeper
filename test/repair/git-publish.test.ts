import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  captureStatePublishBaseline,
  commitMessageForPublishedPaths,
  hardResetToRemoteMain,
  publishMainCommit,
  refreshSourceAfterStatePublish,
  setTokenOrigin,
  STATE_PUBLISH_TIMING_DEFAULTS,
  stagePaths,
  uniqueNonEmpty,
} from "../../dist/repair/git-publish.js";
import {
  ACTION_EVENT_TYPES,
  actionAttemptId,
  actionEventKey,
  actionEventShardRelativePath,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
  createActionEvent,
  type ActionEventInput,
} from "../../dist/action-ledger.js";

for (const key of [
  "CLAWSWEEPER_STATE_DIR",
  "CLAWSWEEPER_PUBLISH_ROOT",
  "CLAWSWEEPER_PUBLISH_BRANCH",
  "CLAWSWEEPER_PUBLISH_LEASE",
  "CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS",
  "CLAWSWEEPER_PUBLISH_DEADLINE_MS",
  "CLAWSWEEPER_IMMUTABLE_PUBLISH_DEADLINE_MS",
  "CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS",
  "CLAWSWEEPER_PUBLISH_LEASE_TTL_MS",
  "CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS",
  "CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS",
  "CLAWSWEEPER_PUBLISH_STALE_RECOVERY_ATTEMPTS",
]) {
  delete process.env[key];
}
process.env.CLAWSWEEPER_PUBLISH_LEASE = "false";

function replayEquivalentActionShards() {
  const repository = "openclaw/clawsweeper";
  const sourceRevision = "a".repeat(40);
  const operationId = actionOperationId(repository, "review", {
    number: 1,
    sourceRevision,
  });
  const attemptId = actionAttemptId(operationId, { runId: "1", runAttempt: 1 });
  const input: ActionEventInput = {
    eventKey: actionEventKey("review.completed", {
      repository,
      number: 1,
      sourceRevision,
    }),
    operationId,
    attemptId,
    parentEventId: null,
    phaseSeq: 1,
    idempotencyKeySha256: actionIdempotencyKey({
      repository,
      number: 1,
      sourceRevision,
      action: "review",
    }),
    type: ACTION_EVENT_TYPES.reviewCompleted,
    producer: {
      repository,
      sha: sourceRevision,
      workflow: "sweep.yml",
      job: "review",
      runId: "1",
      runAttempt: 1,
      component: "review.test",
    },
    subject: {
      repository,
      kind: "pull_request",
      number: 1,
      sourceRevision,
    },
    action: {
      name: "review",
      status: "completed",
      reasonCode: "completed",
      retryable: false,
      mutation: false,
    },
    evidence: [],
  };
  const first = createActionEvent(input, {
    now: () => new Date("2026-07-14T20:00:00.000Z"),
  });
  const second = createActionEvent(input, {
    now: () => new Date("2026-07-14T20:00:01.000Z"),
  });
  const publishPath = actionEventShardRelativePath(
    {
      repository,
      sha: sourceRevision,
      producer: "review.test",
      workflow: "sweep.yml",
      job: "review",
      runId: "1",
      runAttempt: 1,
      partitionDate: "2026-07-14",
    },
    [first],
  ).replaceAll(path.sep, "/");
  return {
    publishPath,
    first: `${actionLedgerJson(first)}\n`,
    second: `${actionLedgerJson(second)}\n`,
  };
}

const STATE_PUBLISH_LEASE_REF = "refs/heads/clawsweeper-publish-lease/state";

test("default lease timing can recover a crashed owner within the workflow budget", () => {
  const timing = STATE_PUBLISH_TIMING_DEFAULTS;
  assert.ok(timing.leaseTtlMs <= timing.leaseProtocolMaxTtlMs);
  assert.ok(
    timing.acquisitionDeadlineMs >
      timing.leaseProtocolMaxTtlMs + timing.leaseMaxWaitMs + timing.commandTimeoutMs,
  );
  assert.ok(timing.operationDeadlineMs < timing.leaseTtlMs);
  assert.ok(timing.immutableLeasePriorityMaxMs < timing.operationDeadlineMs);
  assert.ok(
    timing.acquisitionDeadlineMs +
      timing.operationDeadlineMs +
      timing.commandTimeoutMs +
      timing.workflowMarginMs <=
      timing.workflowTimeoutMs,
  );
  assert.ok(
    timing.immutableOperationDeadlineMs + timing.commandTimeoutMs + timing.workflowMarginMs <=
      timing.workflowTimeoutMs,
  );
});

test("immutable coordination accepts only exact action ledger paths", () => {
  assert.throws(
    () =>
      publishMainCommit({
        message: "chore: reject mutable optimistic state",
        paths: ["results/latest.json"],
        coordination: "immutable",
      }),
    /only exact action ledger event and import-binding paths/,
  );
  assert.throws(
    () =>
      publishMainCommit({
        message: "chore: reject mutable optimistic strategy",
        paths: ["ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-1-review-a.jsonl"],
        coordination: "immutable",
        rebaseStrategy: "theirs",
      }),
    /requires the normal rebase strategy/,
  );
});

test("state publisher rejects a lease TTL above the protocol maximum", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-lease-protocol-"));
  const state = path.join(root, "state");
  const source = path.join(root, "source");
  fs.mkdirSync(state);
  fs.mkdirSync(source);

  assert.throws(
    () =>
      withEnv(
        leasedPublishEnv({
          CLAWSWEEPER_STATE_DIR: state,
          CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(
            STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolMaxTtlMs + 1,
          ),
        }),
        () =>
          withCwd(source, () =>
            publishMainCommit({
              message: "chore: reject oversized lease",
              paths: ["results/protocol.txt"],
            }),
          ),
      ),
    /exceeds protocol maximum/,
  );
});

test("uniqueNonEmpty trims, drops blanks, and deduplicates paths", () => {
  assert.deepEqual(uniqueNonEmpty([" jobs ", "", "results", "jobs", "results "]), [
    "jobs",
    "results",
  ]);
});

test("commitMessageForPublishedPaths skips CI for generated-only publishes", () => {
  assert.equal(
    commitMessageForPublishedPaths("chore: update sweep records", [
      "records",
      "results/sweep-status",
    ]),
    "chore: update sweep records\n\n[skip ci]",
  );
  assert.equal(
    commitMessageForPublishedPaths("chore: publish\n\n[skip ci]", ["results"]),
    "chore: publish\n\n[skip ci]",
  );
  assert.equal(
    commitMessageForPublishedPaths("fix: update scheduler", ["src/repair/git-publish.ts"]),
    "fix: update scheduler",
  );
  assert.equal(
    commitMessageForPublishedPaths("chore: append action ledger", [
      "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-1-review-a.jsonl",
    ]),
    "chore: append action ledger\n\n[skip ci]",
  );
});

test("stagePaths normalizes tracked deletion pathspecs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-stage-paths-"));
  const file = "records/openclaw-openclaw/items/42.md";
  run("git", ["init"], root);
  configureUser(root);
  write(path.join(root, file), "tracked\n");
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "initial"], root);
  fs.rmSync(path.join(root, file));

  withCwd(root, () => stagePaths(["./records/openclaw-openclaw/items/"]));

  assert.equal(run("git", ["diff", "--cached", "--name-only"], root), `${file}\n`);
});

test("publishMainCommit commits selected paths and restores volatile tracked files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  fs.mkdirSync(path.join(work, "results"));
  fs.mkdirSync(path.join(work, "docs"));
  fs.writeFileSync(path.join(work, "results", "initial.txt"), "initial\n");
  fs.writeFileSync(path.join(work, "docs", "volatile.txt"), "before\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  fs.writeFileSync(path.join(work, "results", "ledger.txt"), "ledger\n");
  fs.writeFileSync(path.join(work, "docs", "volatile.txt"), "after\n");
  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: publish ledger",
      paths: ["results"],
      restorePaths: ["docs/volatile.txt"],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(fs.readFileSync(path.join(work, "docs", "volatile.txt"), "utf8"), "before\n");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/ledger.txt"], root),
    "ledger\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:docs/volatile.txt"], root),
    "before\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "log", "-1", "--format=%B", "main"], root),
    "chore: publish ledger\n\n[skip ci]\n\n",
  );
});

test("publishMainCommit resolves apply record delete conflicts during rebase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "open old\n");
  write(path.join(work, "apply-report.json"), "[]\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "records/openclaw-openclaw/items/1.md"), "open remote\n");
  run("git", ["commit", "-am", "remote item update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  fs.rmSync(path.join(work, "records/openclaw-openclaw/items/1.md"));
  write(path.join(work, "records/openclaw-openclaw/closed/1.md"), "closed\n");
  write(path.join(work, "apply-report.json"), '[{"action":"closed"}]\n');

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: apply sweep decisions checkpoint 1",
      paths: ["records", "apply-report.json"],
      maxAttempts: 1,
      pushAttempts: 1,
      rebaseStrategy: "apply-records",
    }),
  );

  assert.equal(result, "committed");
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/1.md"], root),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/closed/1.md"], root),
    "closed\n",
  );
});

test("publishMainCommit preserves status and health across apply and theirs publish races", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "comment_sync", 1);
  const firstCloseHealth = sweepHealth("2026-07-09T20:02:00Z", "close", 2);
  const secondCloseHealth = sweepHealth("2026-07-09T20:04:00Z", "close", 3);

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:02:01Z", "Remote close one", firstCloseHealth, firstCloseHealth),
  );
  run("git", ["commit", "-am", "remote close health one"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:03:00Z", "Local event one", initialHealth, initialHealth),
  );
  assert.equal(
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish event status one",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "theirs",
      }),
    ),
    "committed",
  );
  const first = readOriginJson(origin, `main:${statusFile}`, root);
  assert.equal(first.state, "Local event one");
  assert.deepEqual(first.apply_health, firstCloseHealth);
  assert.deepEqual(first.last_close_apply_health, firstCloseHealth);

  run("git", ["pull", "--ff-only"], other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:04:01Z", "Remote close two", secondCloseHealth, secondCloseHealth),
  );
  run("git", ["commit", "-am", "remote close health two"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:05:00Z", "Local event two", firstCloseHealth, firstCloseHealth),
  );
  assert.equal(
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish event status two",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      }),
    ),
    "committed",
  );
  const second = readOriginJson(origin, `main:${statusFile}`, root);
  assert.equal(second.state, "Local event two");
  assert.deepEqual(second.apply_health, secondCloseHealth);
  assert.deepEqual(second.last_close_apply_health, secondCloseHealth);
});

test("publishMainCommit drops a status commit fully superseded by the remote", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "close", 1);
  const localHealth = sweepHealth("2026-07-09T20:02:00Z", "close", 2);
  const remoteHealth = sweepHealth("2026-07-09T20:03:00Z", "close", 3);

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:03:01Z", "Remote newest", remoteHealth, remoteHealth),
  );
  run("git", ["commit", "-am", "newer remote status"], other);
  run("git", ["push", "origin", "HEAD:main"], other);
  const remoteHead = run("git", ["--git-dir", origin, "rev-parse", "main"], root).trim();

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:02:01Z", "Local older", localHealth, localHealth),
  );
  assert.equal(
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish superseded status",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      }),
    ),
    "committed",
  );

  assert.equal(run("git", ["--git-dir", origin, "rev-parse", "main"], root).trim(), remoteHead);
  assert.equal(run("git", ["rev-parse", "HEAD"], work).trim(), remoteHead);
  const merged = readOriginJson(origin, `main:${statusFile}`, root);
  assert.equal(merged.state, "Remote newest");
  assert.deepEqual(merged.apply_health, remoteHealth);
});

test("publishMainCommit preserves latest health when a second race forces commit rebuild", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "comment_sync", 1);
  const firstCloseHealth = sweepHealth("2026-07-09T20:02:00Z", "close", 2);
  const secondCloseHealth = sweepHealth("2026-07-09T20:02:30Z", "close", 3);

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:02:01Z", "Remote close one", firstCloseHealth, firstCloseHealth),
  );
  run("git", ["commit", "-am", "remote close health one"], other);
  run("git", ["push", "origin", "HEAD:main"], other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:02:31Z", "Remote close two", secondCloseHealth, secondCloseHealth),
  );
  run("git", ["commit", "-am", "remote close health two"], other);
  installSecondPushRaceHook(work, other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:03:00Z", "Local event", initialHealth, initialHealth),
  );
  assert.equal(
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish event status",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      }),
    ),
    "committed",
  );

  const merged = readOriginJson(origin, `main:${statusFile}`, root);
  assert.equal(merged.state, "Local event");
  assert.deepEqual(merged.apply_health, secondCloseHealth);
  assert.deepEqual(merged.last_close_apply_health, secondCloseHealth);
});

test("publishMainCommit fails closed when a racing sweep status is malformed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "close", 1);

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, statusFile), "{broken\n");
  run("git", ["commit", "-am", "malformed remote status"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:02:00Z", "Local event", initialHealth, initialHealth),
  );
  assert.throws(
    () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: publish valid status",
          paths: [statusFile],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "apply-records",
        }),
      ),
    /malformed sweep status JSON/,
  );
  assert.equal(run("git", ["--git-dir", origin, "show", `main:${statusFile}`], root), "{broken\n");
});

test("broad reconciliation preserves the newer exact tuple and replays independent tuples", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const baseHealth = sweepHealth("2026-07-09T23:00:00Z", "comment_sync", 1);
  const remoteHealth = sweepHealth("2026-07-09T23:20:22Z", "close", 2);
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  for (const number of [100960, 100961, 100962, 100963]) {
    writeRecordTuple(state, {
      number,
      marker: `base ${number}`,
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
  }
  writeRecordTuple(state, {
    number: 100965,
    marker: "legacy per-kind paths base",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
    recordFile: "openclaw-openclaw-100965.md",
    planFile: "repair-openclaw-openclaw-100965.md",
  });
  writeRecordTuple(state, {
    number: 100966,
    marker: "plan deletion base",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  const strictPlanCleanupTuple = writeRecordTuple(state, {
    number: 100967,
    marker: "byte-identical primary plan cleanup",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  writeJson(
    path.join(state, statusFile),
    sweepStatus("2026-07-09T23:00:01Z", "Initial", baseHealth, baseHealth),
  );
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  fs.cpSync(path.join(state, "results"), path.join(work, "results"), { recursive: true });

  run("git", ["clone", origin, other], root);
  configureUser(other);
  const exactTuple = writeRecordTuple(other, {
    number: 100960,
    marker: "exact event 5731116d2efa",
    reviewedAt: "2026-07-09T23:19:10.353Z",
    itemUpdatedAt: "2026-07-09T23:10:43Z",
    extraFrontMatter: [
      "apply_checked_at: 2026-07-09T23:20:21.470Z",
      "review_comment_synced_at: 2026-07-09T23:20:21.464Z",
      "last_full_review_at: 2026-07-09T23:19:10.353Z",
    ],
  });
  writeRecordTuple(other, {
    number: 100962,
    marker: "remote close",
    reviewedAt: "2026-07-09T23:18:00.000Z",
    itemUpdatedAt: "2026-07-09T23:12:00Z",
    location: "closed",
    packet: false,
    plan: false,
    extraFrontMatter: ["reconciled_at: 2026-07-09T23:20:20.000Z"],
  });
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T23:20:23Z", "Exact event", remoteHealth, remoteHealth),
  );
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "exact event tuple and close"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  writeRecordTuple(work, {
    number: 100960,
    marker: "stale broad 150adb4adaaf",
    reviewedAt: "2026-07-09T23:13:13.035Z",
    itemUpdatedAt: "2026-07-09T23:06:04Z",
  });
  const independentTuple = writeRecordTuple(work, {
    number: 100961,
    marker: "independent broad tuple",
    reviewedAt: "2026-07-09T23:14:00.000Z",
    itemUpdatedAt: "2026-07-09T23:07:00Z",
  });
  writeRecordTuple(work, {
    number: 100962,
    marker: "stale broad reopen",
    reviewedAt: "2026-07-09T23:13:00.000Z",
    itemUpdatedAt: "2026-07-09T23:06:00Z",
  });
  const localClose = writeRecordTuple(work, {
    number: 100963,
    marker: "independent broad close",
    reviewedAt: "2026-07-09T23:15:00.000Z",
    itemUpdatedAt: "2026-07-09T23:08:00Z",
    location: "closed",
    packet: false,
    plan: false,
    extraFrontMatter: ["reconciled_at: 2026-07-09T23:15:30.000Z"],
  });
  const legacyTuple = writeRecordTuple(work, {
    number: 100965,
    marker: "legacy per-kind paths updated",
    reviewedAt: "2026-07-09T23:16:00.000Z",
    itemUpdatedAt: "2026-07-09T23:09:00Z",
    recordFile: "openclaw-openclaw-100965.md",
    planFile: "repair-openclaw-openclaw-100965.md",
  });
  const planDeletionTuple = writeRecordTuple(work, {
    number: 100966,
    marker: "open tuple without obsolete repair plan",
    reviewedAt: "2026-07-09T23:17:00.000Z",
    itemUpdatedAt: "2026-07-09T23:09:30Z",
    plan: false,
  });
  fs.rmSync(path.join(work, `${recordsRoot}/plans/100967.md`));
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T23:21:00Z", "Broad publish", baseHealth, baseHealth),
  );

  const results = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () => {
      const recordsResult = publishMainCommit({
        message: "chore: persist sweep reconciliation",
        paths: [recordsRoot],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "reconcile-records",
      });
      const statusResult = publishMainCommit({
        message: "chore: update sweep status",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "theirs",
      });
      return [recordsResult, statusResult];
    }),
  );

  assert.deepEqual(results, ["committed", "committed"]);
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100960.md`], root),
    exactTuple.primary,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/decision-packets/100960.json`],
      root,
    ),
    exactTuple.packet,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/plans/100960.md`], root),
    exactTuple.plan,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100961.md`], root),
    independentTuple.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100962.md`], root),
  );
  assert.match(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/closed/100962.md`], root),
    /remote close/,
  );
  for (const sidecar of ["plans/100962.md", "decision-packets/100962.json"]) {
    assert.throws(() =>
      run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/${sidecar}`], root),
    );
  }
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/closed/100963.md`], root),
    localClose.primary,
  );
  for (const sidecar of ["items/100963.md", "plans/100963.md", "decision-packets/100963.json"]) {
    assert.throws(() =>
      run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/${sidecar}`], root),
    );
  }
  assert.equal(
    fs.readFileSync(path.join(work, `${recordsRoot}/items/100960.md`), "utf8"),
    exactTuple.primary,
  );
  assert.equal(
    fs.readFileSync(path.join(work, `${recordsRoot}/decision-packets/100960.json`), "utf8"),
    exactTuple.packet,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/items/openclaw-openclaw-100965.md`],
      root,
    ),
    legacyTuple.primary,
  );
  assert.equal(
    run(
      "git",
      [
        "--git-dir",
        origin,
        "show",
        `state:${recordsRoot}/plans/repair-openclaw-openclaw-100965.md`,
      ],
      root,
    ),
    legacyTuple.plan,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100966.md`], root),
    planDeletionTuple.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/plans/100966.md`], root),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100967.md`], root),
    strictPlanCleanupTuple.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/plans/100967.md`], root),
  );
  const mergedStatus = readOriginJson(origin, `state:${statusFile}`, root);
  assert.equal(mergedStatus.state, "Broad publish");
  assert.deepEqual(mergedStatus.last_close_apply_health, remoteHealth);
});

test("broad reconciliation rejects stale hydrated state before its first push", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  const exactTuple = writeRecordTuple(state, {
    number: 100960,
    marker: "newer hydrated exact state",
    reviewedAt: "2026-07-09T23:19:10.353Z",
    itemUpdatedAt: "2026-07-09T23:10:43Z",
  });
  writeRecordTuple(state, {
    number: 100961,
    marker: "tuple intentionally deleted by broad reconcile",
    reviewedAt: "2026-07-09T23:18:10.353Z",
    itemUpdatedAt: "2026-07-09T23:09:43Z",
  });
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "newer state base"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  writeRecordTuple(work, {
    number: 100960,
    marker: "stale broad state",
    reviewedAt: "2026-07-09T23:13:13.035Z",
    itemUpdatedAt: "2026-07-09T23:06:04Z",
  });
  for (const relative of [
    "items/100961.md",
    "closed/100961.md",
    "plans/100961.md",
    "decision-packets/100961.json",
  ]) {
    fs.rmSync(path.join(work, recordsRoot, relative), { force: true });
  }

  assert.equal(
    withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: reconcile stale broad state",
          paths: [recordsRoot],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    ),
    "committed",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100960.md`], root),
    exactTuple.primary,
  );
  assert.equal(
    fs.readFileSync(path.join(work, `${recordsRoot}/items/100960.md`), "utf8"),
    exactTuple.primary,
  );
  for (const relative of [
    "items/100961.md",
    "closed/100961.md",
    "plans/100961.md",
    "decision-packets/100961.json",
  ]) {
    assert.throws(() =>
      run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/${relative}`], root),
    );
  }

  const other = path.join(root, "other");
  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeRecordTuple(other, {
    number: 100960,
    marker: "remote stale relative to merge base",
    reviewedAt: "2026-07-09T23:14:13.035Z",
    itemUpdatedAt: "2026-07-09T23:07:04Z",
  });
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "remote stale tuple"], other);
  run("git", ["push", "origin", "HEAD:state"], other);
  writeRecordTuple(work, {
    number: 100960,
    marker: "local even staler than merge base",
    reviewedAt: "2026-07-09T23:13:13.035Z",
    itemUpdatedAt: "2026-07-09T23:06:04Z",
  });
  assert.equal(
    withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: reject two stale branches",
          paths: [recordsRoot],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    ),
    "unchanged",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/100960.md`], root),
    exactTuple.primary,
  );
});

test("reconcile-records quarantines an ambiguous valid tuple without blocking independent repairs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  const baseAmbiguous = writeRecordTuple(work, {
    number: 41,
    marker: "base tuple",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  writeRecordTuple(work, {
    number: 42,
    marker: "older independent tuple",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  writeRecordTuple(work, {
    number: 41,
    marker: "same-vector ambiguous tuple",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  const independentRepair = writeRecordTuple(work, {
    number: 42,
    marker: "newer independent tuple",
    reviewedAt: "2026-07-09T23:02:00.000Z",
    itemUpdatedAt: "2026-07-09T23:01:00Z",
  });

  let result;
  const lines = captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: reconcile independent tuples",
        paths: ["records/openclaw-openclaw"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "reconcile-records",
      }),
    );
  });

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/41.md"], root),
    baseAmbiguous.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/42.md"], root),
    independentRepair.primary,
  );
  assert.equal(
    lines.some((line) =>
      line.includes("Deferring ambiguous reconciliation for openclaw-openclaw/41"),
    ),
    true,
  );
});

test("reconcile-records retries after a full push batch loses continuous state races", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeRecordTuple(work, {
    number: 41,
    marker: "base local tuple",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  const firstRemoteTuple = writeRecordTuple(other, {
    number: 42,
    marker: "first exact event race",
    reviewedAt: "2026-07-09T23:01:00.000Z",
    itemUpdatedAt: "2026-07-09T23:00:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "first exact event"], other);
  const firstRemoteCommit = run("git", ["rev-parse", "HEAD"], other).trim();
  const secondRemoteTuple = writeRecordTuple(other, {
    number: 43,
    marker: "second exact event race",
    reviewedAt: "2026-07-09T23:02:00.000Z",
    itemUpdatedAt: "2026-07-09T23:01:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "second exact event"], other);
  run("git", ["push", "origin", `${firstRemoteCommit}:main`], other);
  installSecondPushRaceHook(work, other);

  const localTuple = writeRecordTuple(work, {
    number: 41,
    marker: "broad reconciliation",
    reviewedAt: "2026-07-09T23:03:00.000Z",
    itemUpdatedAt: "2026-07-09T23:02:00Z",
  });
  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: publish broad reconciliation",
      paths: [recordsRoot],
      maxAttempts: 1,
      pushAttempts: 1,
      rebaseStrategy: "reconcile-records",
    }),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/41.md`], root),
    localTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/42.md`], root),
    firstRemoteTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/43.md`], root),
    secondRemoteTuple.primary,
  );
});

test("reconcile-records retries unchanged normalization through continuous state races", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  const baseTuple = writeRecordTuple(work, {
    number: 41,
    marker: "newer base tuple",
    reviewedAt: "2026-07-09T23:03:00.000Z",
    itemUpdatedAt: "2026-07-09T23:02:00Z",
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  const firstRemoteTuple = writeRecordTuple(other, {
    number: 42,
    marker: "first exact event race",
    reviewedAt: "2026-07-09T23:04:00.000Z",
    itemUpdatedAt: "2026-07-09T23:03:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "first exact event"], other);
  const firstRemoteCommit = run("git", ["rev-parse", "HEAD"], other).trim();
  const secondRemoteTuple = writeRecordTuple(other, {
    number: 43,
    marker: "second exact event race",
    reviewedAt: "2026-07-09T23:05:00.000Z",
    itemUpdatedAt: "2026-07-09T23:04:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "second exact event"], other);
  run("git", ["push", "origin", `${firstRemoteCommit}:main`], other);
  installSecondPushRaceHook(work, other);

  writeRecordTuple(work, {
    number: 41,
    marker: "stale broad reconciliation",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: discard stale broad reconciliation",
      paths: [recordsRoot],
      maxAttempts: 1,
      pushAttempts: 1,
      rebaseStrategy: "reconcile-records",
    }),
  );

  assert.equal(result, "unchanged");
  for (const [number, tuple] of [
    [41, baseTuple],
    [42, firstRemoteTuple],
    [43, secondRemoteTuple],
  ]) {
    assert.equal(
      run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/${number}.md`], root),
      tuple.primary,
    );
  }
});

test("reconcile-records rejects a malformed tuple before an uncontended push", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  const tuple = writeRecordTuple(work, {
    number: 42,
    marker: "valid base",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  fs.appendFileSync(path.join(work, "records/openclaw-openclaw/decision-packets/42.json"), " ");
  assert.throws(
    () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: publish malformed tuple",
          paths: ["records/openclaw-openclaw"],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    /decision packet digest mismatch/,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:records/openclaw-openclaw/decision-packets/42.json"],
      root,
    ),
    tuple.packet,
  );
});

test("reconcile-records fails closed on a concurrent tuple filename alias", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-alias-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeRecordTuple(work, {
    number: 42,
    marker: "base exact filename",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial state"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);
  run("git", ["clone", origin, other], root);
  configureUser(other);

  fs.rmSync(path.join(other, recordsRoot, "items/42.md"));
  fs.rmSync(path.join(other, recordsRoot, "plans/42.md"));
  const remoteAlias = writeRecordTuple(other, {
    number: 42,
    marker: "newer remote alias",
    reviewedAt: "2026-07-09T23:04:00.000Z",
    itemUpdatedAt: "2026-07-09T23:03:00Z",
    recordFile: "openclaw-openclaw-42.md",
    planFile: "repair-openclaw-openclaw-42.md",
  });
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "rename tuple to legacy alias"], other);
  installFirstPushRaceHook(work, other);
  writeRecordTuple(work, {
    number: 42,
    marker: "local exact update",
    reviewedAt: "2026-07-09T23:02:00.000Z",
    itemUpdatedAt: "2026-07-09T23:01:00Z",
  });

  const lines = [];
  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withCwd(work, () =>
            publishMainCommit({
              message: "chore: reconcile filename alias",
              paths: [recordsRoot],
              maxAttempts: 1,
              pushAttempts: 1,
              rebaseStrategy: "reconcile-records",
            }),
          ),
        lines,
      ),
    /ambiguous items filenames/,
  );
  assert.equal(
    lines.some((line) => line.includes("Git publish failure: phase=push")),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `main:${recordsRoot}/items/openclaw-openclaw-42.md`],
      root,
    ),
    remoteAlias.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/42.md`], root),
  );
});

test("reconcile-records fails closed when state and remote have no common base", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-unrelated-"));
  const origin = path.join(root, "origin.git");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  const baseTuple = writeRecordTuple(state, {
    number: 42,
    marker: "remote base",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "remote base"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  writeRecordTuple(work, {
    number: 42,
    marker: "candidate update",
    reviewedAt: "2026-07-09T23:02:00.000Z",
    itemUpdatedAt: "2026-07-09T23:01:00Z",
  });

  run("git", ["checkout", "--orphan", "unrelated"], state);
  run("git", ["read-tree", "--empty"], state);
  fs.rmSync(path.join(state, "records"), { force: true, recursive: true });
  fs.writeFileSync(path.join(state, "unrelated.txt"), "unrelated history\n");
  run("git", ["add", "-A"], state);
  run("git", ["commit", "-m", "unrelated local history"], state);

  const lines = [];
  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
            withCwd(work, () =>
              publishMainCommit({
                message: "chore: reject unrelated state",
                paths: [recordsRoot],
                maxAttempts: 1,
                pushAttempts: 1,
                rebaseStrategy: "reconcile-records",
              }),
            ),
          ),
        lines,
      ),
    /git command <redacted-args> exited 1/,
  );
  assert.equal(
    lines.some((line) => line.includes("Git publish failure: phase=prepare")),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/42.md`], root),
    baseTuple.primary,
  );
});

test("reconcile-records bounds git subprocesses for a 516-tuple publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-scale-"));
  const origin = path.join(root, "origin.git");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  const numbers = Array.from({ length: 516 }, (_, index) => 110_000 + index);
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  for (const number of numbers) {
    writeRecordTuple(state, {
      number,
      marker: `base ${number}`,
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
  }
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  for (const number of numbers) {
    writeRecordTuple(work, {
      number,
      marker: `closed ${number}`,
      reviewedAt: "2026-07-09T23:01:00.000Z",
      itemUpdatedAt: "2026-07-09T23:00:00Z",
      location: "closed",
      packet: false,
      plan: false,
      extraFrontMatter: ["reconciled_at: 2026-07-09T23:02:00.000Z"],
    });
  }
  run("git", ["clone", origin, other], root);
  configureUser(other);
  const remoteWinner = writeRecordTuple(other, {
    number: numbers.at(-1),
    marker: "newer remote tuple during checkpoint publish",
    reviewedAt: "2026-07-09T23:10:00.000Z",
    itemUpdatedAt: "2026-07-09T23:09:00Z",
  });
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "newer remote checkpoint tuple"], other);
  installCheckpointFailureHook(state, other, "state");
  const paths = numbers.flatMap((number) => [
    `${recordsRoot}/items/${number}.md`,
    `${recordsRoot}/closed/${number}.md`,
    `${recordsRoot}/plans/${number}.md`,
    `${recordsRoot}/decision-packets/${number}.json`,
  ]);

  const publish = () =>
    withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: publish 516 reconciled tuples",
          paths,
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    );
  const failedLines = [];
  assert.throws(
    () => captureConsoleLog(() => captureProcessWrites(publish), failedLines),
    /Failed to publish reconciliation checkpoint 3\/5/,
  );
  assert.equal(
    failedLines.some((line) => line.includes("Git publish failure: phase=checkpoint")),
    true,
  );
  assert.match(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/closed/${numbers[0]}.md`], root),
    new RegExp(`# closed ${numbers[0]}`),
  );
  assert.match(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/closed/${numbers[128]}.md`],
      root,
    ),
    new RegExp(`# closed ${numbers[128]}`),
  );
  assert.match(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/items/${numbers[256]}.md`],
      root,
    ),
    new RegExp(`# base ${numbers[256]}`),
  );
  run("git", ["fetch", "origin", "state"], other);
  run("git", ["rebase", "origin/state"], other);
  const divergentRemote = writeRecordTuple(other, {
    number: 130_000,
    marker: "divergent remote tuple before retry",
    reviewedAt: "2026-07-09T23:11:00.000Z",
    itemUpdatedAt: "2026-07-09T23:10:00Z",
  });
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "divergent remote tuple"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  let result;
  const lines = captureConsoleLog(() =>
    captureProcessWrites(() => {
      result = publish();
    }),
  );

  assert.equal(result, "committed");
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  assert.ok(metrics, "publish emits bounded git subprocess metrics");
  console.log(`516-tuple ${metrics}`);
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 192,
    `516-tuple checkpoint publish used ${processCount} git subprocesses; expected at most 192`,
  );
  assert.match(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/closed/${numbers[0]}.md`], root),
    new RegExp(`# closed ${numbers[0]}`),
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/${numbers[0]}.md`], root),
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/items/${numbers.at(-1)}.md`],
      root,
    ),
    remoteWinner.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/130000.md`], root),
    divergentRemote.primary,
  );
});

test("reconcile-records lands one local tuple through a disjoint remote update storm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-storm-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  const remoteNumbers = Array.from({ length: 300 }, (_, index) => 120_000 + index);
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeRecordTuple(work, {
    number: 42,
    marker: "local base",
    reviewedAt: "2026-07-09T23:00:00.000Z",
    itemUpdatedAt: "2026-07-09T22:59:00Z",
  });
  for (const number of remoteNumbers) {
    writeRecordTuple(work, {
      number,
      marker: `remote base ${number}`,
      reviewedAt: "2026-07-09T23:00:00.000Z",
      itemUpdatedAt: "2026-07-09T22:59:00Z",
    });
  }
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial state"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);
  run("git", ["clone", origin, other], root);
  configureUser(other);

  const remoteTuples = new Map();
  for (const number of remoteNumbers) {
    remoteTuples.set(
      number,
      writeRecordTuple(other, {
        number,
        marker: `remote update ${number}`,
        reviewedAt: "2026-07-09T23:02:00.000Z",
        itemUpdatedAt: "2026-07-09T23:01:00Z",
      }),
    );
  }
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "remote tuple update storm"], other);
  installFirstPushRaceHook(work, other);

  const localTuple = writeRecordTuple(work, {
    number: 42,
    marker: "local close through storm",
    reviewedAt: "2026-07-09T23:03:00.000Z",
    itemUpdatedAt: "2026-07-09T23:02:00Z",
    location: "closed",
    packet: false,
    plan: false,
    extraFrontMatter: ["reconciled_at: 2026-07-09T23:04:00.000Z"],
  });

  let result;
  const lines = captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: reconcile through remote storm",
        paths: [recordsRoot],
        maxAttempts: 1,
        pushAttempts: 2,
        rebaseStrategy: "reconcile-records",
      }),
    );
  });

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/closed/42.md`], root),
    localTuple.primary,
  );
  for (const number of [remoteNumbers[0], remoteNumbers.at(-1)]) {
    assert.equal(
      run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/${number}.md`], root),
      remoteTuples.get(number).primary,
    );
  }
  assert.equal(
    lines.some((line) => line === "Rebased reconciliation over disjoint remote tuple changes"),
    true,
  );
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  assert.ok(metrics, "storm publish emits metrics");
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 48,
    `storm publish used ${processCount} git subprocesses; expected at most 48`,
  );
});

test("publishMainCommit rebuilds generated state commits without deleting concurrent records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "comment_sync", 1);
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record old\n");
  write(path.join(work, "keep.txt"), "keep old\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:01:00Z", "Remote", initialHealth, initialHealth),
  );
  write(path.join(other, "records/openclaw-openclaw/items/1.md"), "record remote\n");
  write(path.join(other, "records/openclaw-openclaw/items/2.md"), "remote only\n");
  write(path.join(other, "keep.txt"), "keep remote\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote generated state update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:02:00Z", "Local", initialHealth, initialHealth),
  );
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record local\n");

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: update sweep records",
      paths: ["results/sweep-status", "records"],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(readOriginJson(origin, `main:${statusFile}`, root).state, "Local");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/1.md"], root),
    "record local\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:records/openclaw-openclaw/items/2.md"], root),
    "remote only\n",
  );
  assert.equal(run("git", ["--git-dir", origin, "show", "main:keep.txt"], root), "keep remote\n");
});

test("state publisher uses a detached empty-tree lease commit", async () => {
  const fixture = createStatePublishRemote("detached-lease");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  const releaseSignal = path.join(fixture.root, "release-publisher");
  const releaseObserved = path.join(fixture.root, "publisher-released");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/detached-lease.txt"), "published\n");
  installStatePushReleaseHook(state, releaseSignal, releaseObserved);

  const child = startPublishCli(
    source,
    state,
    "chore: publish through detached lease",
    leasedPublishEnv({
      CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
      CLAWSWEEPER_PUBLISH_DEADLINE_MS: "2000",
      CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
      CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "3000",
      CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
    }),
  );
  const childResult = waitForChild(child);
  let inspectionError;
  try {
    await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
    const commitAndParents = run(
      "git",
      ["--git-dir", fixture.origin, "rev-list", "--parents", "-n", "1", STATE_PUBLISH_LEASE_REF],
      fixture.root,
    )
      .trim()
      .split(/\s+/);
    assert.equal(commitAndParents.length, 1);
    assert.equal(
      run(
        "git",
        ["--git-dir", fixture.origin, "ls-tree", "-r", STATE_PUBLISH_LEASE_REF],
        fixture.root,
      ),
      "",
    );
  } catch (error) {
    inspectionError = error;
  } finally {
    write(releaseSignal, "release\n");
  }

  const completed = await childResult;
  if (inspectionError) throw inspectionError;
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(fs.existsSync(releaseObserved), true);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("state publishers serialize concurrent workflow commits through the remote lease", async () => {
  const fixture = createStatePublishRemote("concurrent");
  const firstState = path.join(fixture.root, "state-first");
  const secondState = path.join(fixture.root, "state-second");
  const firstSource = path.join(fixture.root, "source-first");
  const secondSource = path.join(fixture.root, "source-second");
  cloneState(fixture.origin, firstState);
  cloneState(fixture.origin, secondState);
  fs.mkdirSync(firstSource);
  fs.mkdirSync(secondSource);
  write(path.join(firstSource, "results/first.txt"), "first\n");
  write(path.join(secondSource, "results/second.txt"), "second\n");
  installStatePushSleepHook(firstState, 0.3);

  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "2000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "3000",
    CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "80",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
  });
  const startedAt = Date.now();
  const first = startPublishCli(firstSource, firstState, "chore: publish first", env);
  const firstResult = waitForChild(first);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const second = startPublishCli(secondSource, secondState, "chore: publish second", env);
  const [firstCompleted, secondCompleted] = await Promise.all([firstResult, waitForChild(second)]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(firstCompleted.status, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.status, 0, secondCompleted.stderr);
  assert.ok(
    elapsedMs >= 250 && elapsedMs < 3000,
    `leased concurrent publish completed in ${elapsedMs}ms`,
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/first.txt"], fixture.root),
    "first\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/second.txt"], fixture.root),
    "second\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
  for (const output of [firstCompleted.stdout, secondCompleted.stdout]) {
    const metrics = /Git publish metrics:[^\n]+/.exec(output)?.[0] ?? "";
    const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
    assert.ok(
      Number.isInteger(processCount) && processCount <= 40,
      `leased concurrent publish used ${processCount} git subprocesses`,
    );
    const remoteProbeCount = Number(/\bls-remote:(\d+)/.exec(metrics)?.[1]);
    assert.ok(
      Number.isInteger(remoteProbeCount) && remoteProbeCount <= 8,
      `leased concurrent publish used ${remoteProbeCount} remote lease probes`,
    );
  }
});

test("lease backoff outlives the former fixed retry window", async () => {
  const fixture = createStatePublishRemote("backoff-window");
  const firstState = path.join(fixture.root, "state-first");
  const secondState = path.join(fixture.root, "state-second");
  const firstSource = path.join(fixture.root, "source-first");
  const secondSource = path.join(fixture.root, "source-second");
  const releaseSignal = path.join(fixture.root, "release-first-publisher");
  const releaseObserved = path.join(fixture.root, "first-publisher-released");
  cloneState(fixture.origin, firstState);
  cloneState(fixture.origin, secondState);
  fs.mkdirSync(firstSource);
  fs.mkdirSync(secondSource);
  write(path.join(firstSource, "results/first.txt"), "first\n");
  write(path.join(secondSource, "results/second.txt"), "second\n");
  installStatePushReleaseHook(firstState, releaseSignal, releaseObserved);

  const waitMs = 100;
  const formerRetryWindowMs = waitMs * 4;
  const releaseDelayMs = formerRetryWindowMs + 150;
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "3000",
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "1000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "500",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "2000",
    CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "5",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: String(waitMs),
  });
  const first = startPublishCli(firstSource, firstState, "chore: publish first", env);
  const firstResult = waitForChild(first);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const startedAt = Date.now();
  const second = startPublishCli(secondSource, secondState, "chore: publish second", env);
  const secondResult = waitForChild(second);
  const observationError = await waitForChildOutput(second, "State publish lease busy owner=").then(
    () => null,
    (error) => error,
  );
  let survivalError = null;
  if (!observationError) {
    await delay(releaseDelayMs);
    try {
      assert.equal(second.exitCode, null, "publisher exhausted the former fixed retry window");
    } catch (error) {
      survivalError = error;
    }
  }
  write(releaseSignal, "release\n");
  let removalError = null;
  if (!observationError) {
    try {
      await waitForRemoteRefRemoval(fixture.origin, STATE_PUBLISH_LEASE_REF);
    } catch (error) {
      removalError = error;
    }
  }
  const [firstCompleted, secondCompleted] = await Promise.all([firstResult, secondResult]);
  const elapsedMs = Date.now() - startedAt;
  if (observationError) throw observationError;
  if (survivalError) throw survivalError;
  if (removalError) throw removalError;

  assert.equal(firstCompleted.status, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.status, 0, secondCompleted.stderr);
  assert.match(secondCompleted.stdout, /State publish lease busy/);
  assert.match(secondCompleted.stdout, /Acquired state publish lease/);
  assert.equal(fs.existsSync(releaseObserved), true);
  assert.ok(
    elapsedMs >= releaseDelayMs && elapsedMs < 2500,
    `scaled lease backoff completed in ${elapsedMs}ms`,
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/first.txt"], fixture.root),
    "first\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/second.txt"], fixture.root),
    "second\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
  const metrics = /Git publish metrics:[^\n]+/.exec(secondCompleted.stdout)?.[0] ?? "";
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 40,
    `scaled lease backoff used ${processCount} git subprocesses`,
  );
  const remoteProbeCount = Number(/\bls-remote:(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(remoteProbeCount) && remoteProbeCount <= 6,
    `scaled lease backoff used ${remoteProbeCount} remote lease probes`,
  );
});

test("state publisher atomically recovers an expired remote lease", () => {
  const fixture = createStatePublishRemote("stale");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/stale-recovery.txt"), "recovered\n");
  createRemoteLease(state, {
    owner: "00000000-0000-4000-8000-000000000001",
    issuedAt: "2025-12-31T23:59:59.000Z",
    expiresAt: "2026-01-01T00:00:00.000Z",
    ttlMs: 1000,
  });

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
        CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: recover stale lease",
            paths: ["results/stale-recovery.txt"],
          }),
        ),
    ),
  );

  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/stale-recovery.txt"],
      fixture.root,
    ),
    "recovered\n",
  );
  assert.equal(
    lines.some((line) => line.includes("stale_recovery=true")),
    true,
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("state publisher caps far-future remote lease expiry to the owner protocol TTL", () => {
  const fixture = createStatePublishRemote("far-future");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/far-future-recovery.txt"), "recovered\n");
  const issuedAtMs = Date.now();
  const ownerTtlMs = 800;
  createRemoteLease(state, {
    owner: "00000000-0000-4000-8000-000000000002",
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z",
    ttlMs: ownerTtlMs,
  });

  let result;
  const startedAtMs = Date.now();
  const lines = captureConsoleLog(() => {
    result = withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "2000",
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "600",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "250",
        CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(ownerTtlMs),
        CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "10",
        CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: recover far-future lease",
            paths: ["results/far-future-recovery.txt"],
          }),
        ),
    );
  });
  const elapsedMs = Date.now() - startedAtMs;
  assert.equal(result, "committed");
  assert.ok(
    elapsedMs >= ownerTtlMs / 2 && elapsedMs < 2000,
    `far-future lease recovered in ${elapsedMs}ms`,
  );
  assert.equal(
    lines.some((line) => line.includes("State publish lease busy")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("stale_recovery=true")),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/far-future-recovery.txt"],
      fixture.root,
    ),
    "recovered\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("shorter-TTL contender cannot replace a live longer-TTL owner", () => {
  const fixture = createStatePublishRemote("mixed-ttl");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/mixed-ttl.txt"), "must not publish\n");
  const issuedAtMs = Date.now();
  const ownerTtlMs = 1500;
  const ownerExpiresAtMs = issuedAtMs + ownerTtlMs;
  const ownerLeaseOid = createRemoteLease(state, {
    owner: "00000000-0000-4000-8000-000000000004",
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(ownerExpiresAtMs).toISOString(),
    ttlMs: ownerTtlMs,
  });
  const lines = [];
  const startedAtMs = Date.now();

  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withEnv(
            leasedPublishEnv({
              CLAWSWEEPER_STATE_DIR: state,
              CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "500",
              CLAWSWEEPER_PUBLISH_DEADLINE_MS: "100",
              CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "100",
              CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "200",
              CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "100",
              CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
            }),
            () =>
              withCwd(source, () =>
                publishMainCommit({
                  message: "chore: reject mixed TTL lease theft",
                  paths: ["results/mixed-ttl.txt"],
                }),
              ),
          ),
        lines,
      ),
    /deadline exceeded|timed out/,
  );
  const elapsedMs = Date.now() - startedAtMs;

  assert.ok(elapsedMs >= 400 && elapsedMs < 1200, `mixed-TTL wait completed in ${elapsedMs}ms`);
  assert.ok(Date.now() < ownerExpiresAtMs, "owner lease must still be live");
  assert.match(lines.join("\n"), /State publish lease busy/);
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "rev-parse", STATE_PUBLISH_LEASE_REF],
      fixture.root,
    ).trim(),
    ownerLeaseOid,
  );
  assert.throws(() =>
    run("git", ["--git-dir", fixture.origin, "show", "state:results/mixed-ttl.txt"], fixture.root),
  );
});

test("state publisher retries when the observed lease disappears before fetch", () => {
  const fixture = createStatePublishRemote("vanished-lease");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/vanished-lease.txt"), "published\n");
  createRemoteLease(state, {
    owner: "00000000-0000-4000-8000-000000000003",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ttlMs: 60_000,
  });
  const wrapper = installVanishingLeaseGitWrapper(fixture.root);

  const result = withEnv(
    leasedPublishEnv({
      CLAWSWEEPER_STATE_DIR: state,
      PATH: `${wrapper.bin}:${process.env.PATH ?? ""}`,
      REAL_GIT: wrapper.realGit,
      VANISHING_LEASE_MARKER: wrapper.marker,
      VANISHING_LEASE_ORIGIN: fixture.origin,
    }),
    () =>
      withCwd(source, () =>
        publishMainCommit({
          message: "chore: publish after lease release",
          paths: ["results/vanished-lease.txt"],
        }),
      ),
  );

  assert.equal(result, "committed");
  assert.equal(fs.existsSync(wrapper.marker), true);
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/vanished-lease.txt"],
      fixture.root,
    ),
    "published\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("crashed publisher leaves an expiring lease that a later workflow recovers", async () => {
  const fixture = createStatePublishRemote("crash");
  const crashedState = path.join(fixture.root, "state-crashed");
  const recoveredState = path.join(fixture.root, "state-recovered");
  const crashedSource = path.join(fixture.root, "source-crashed");
  const recoveredSource = path.join(fixture.root, "source-recovered");
  cloneState(fixture.origin, crashedState);
  cloneState(fixture.origin, recoveredState);
  fs.mkdirSync(crashedSource);
  fs.mkdirSync(recoveredSource);
  write(path.join(crashedSource, "results/crashed.txt"), "must not publish\n");
  write(path.join(recoveredSource, "results/recovered.txt"), "recovered\n");
  installStatePushSleepHook(crashedState, 30);
  const ttlMs = 800;
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "2000",
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "500",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "250",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(ttlMs),
    CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "12",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
  });

  const crashed = startPublishCli(
    crashedSource,
    crashedState,
    "chore: crash while publishing",
    env,
  );
  const crashedResult = waitForChild(crashed);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const remoteLeaseMessage = readRemoteLeaseMessage(fixture.origin);
  assert.match(
    remoteLeaseMessage,
    new RegExp(`^lease_protocol: ${STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolVersion}$`, "m"),
  );
  assert.match(remoteLeaseMessage, /^issued_at: .+$/m);
  assert.match(remoteLeaseMessage, new RegExp(`^ttl_ms: ${ttlMs}$`, "m"));
  const expiresAtMs = remoteLeaseExpiryMs(fixture.origin);
  process.kill(-crashed.pid, "SIGKILL");
  const crashedCompleted = await crashedResult;
  assert.equal(crashedCompleted.signal, "SIGKILL");
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);

  const recoveryStartedAtMs = Date.now();
  assert.ok(
    recoveryStartedAtMs < expiresAtMs,
    "recovery must start while the crashed lease is live",
  );
  const recovered = await waitForChild(
    startPublishCli(recoveredSource, recoveredState, "chore: recover crashed publisher", env),
  );
  const recoveryCompletedAtMs = Date.now();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.ok(
    recoveryCompletedAtMs >= expiresAtMs,
    "recovery must wait until the crashed lease expires",
  );
  assert.ok(
    recoveryCompletedAtMs - recoveryStartedAtMs < 2500,
    `crashed lease recovered in ${recoveryCompletedAtMs - recoveryStartedAtMs}ms`,
  );
  assert.match(recovered.stdout, /State publish lease busy/);
  assert.match(recovered.stdout, /stale_recovery=true/);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/recovered.txt"], fixture.root),
    "recovered\n",
  );
  assert.throws(() =>
    run("git", ["--git-dir", fixture.origin, "show", "state:results/crashed.txt"], fixture.root),
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("lease contention deadline bounds the waiting git process budget", () => {
  const fixture = createStatePublishRemote("deadline");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/deadline.txt"), "deadline\n");
  createRemoteLease(state, {
    owner: "00000000-0000-4000-8000-000000000002",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ttlMs: 60_000,
  });
  const lines = [];
  const startedAt = Date.now();

  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withEnv(
            leasedPublishEnv({
              CLAWSWEEPER_STATE_DIR: state,
              CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "100",
              CLAWSWEEPER_PUBLISH_DEADLINE_MS: "100",
              CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
              CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "100",
              CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "20",
            }),
            () =>
              withCwd(source, () =>
                publishMainCommit({
                  message: "chore: hit lease deadline",
                  paths: ["results/deadline.txt"],
                }),
              ),
          ),
        lines,
      ),
    /deadline exceeded|timed out/,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 80 && elapsedMs < 1000, `lease deadline completed in ${elapsedMs}ms`);
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 12,
    `deadline path used ${processCount} git subprocesses`,
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
});

test("state publisher bounds repeated unaccepted lease push timeouts", () => {
  const fixture = createStatePublishRemote("command-timeout");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/timeout.txt"), "timeout\n");
  installLeasePushSleepHook(state, 1);
  const startedAt = Date.now();

  assert.throws(
    () =>
      withEnv(
        leasedPublishEnv({
          CLAWSWEEPER_STATE_DIR: state,
          CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "300",
          CLAWSWEEPER_PUBLISH_DEADLINE_MS: "300",
          CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "50",
          CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
        }),
        () =>
          withCwd(source, () =>
            publishMainCommit({
              message: "chore: hit command timeout",
              paths: ["results/timeout.txt"],
            }),
          ),
      ),
    /deadline exceeded|timed out after \d+ms/,
  );
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("state publisher recovers an accepted lease acquisition after client timeout", () => {
  const fixture = createStatePublishRemote("accepted-lease-timeout");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/accepted-lease-timeout.txt"), "accepted\n");
  const hookMarker = installAcceptedLeasePushTimeoutHook(fixture.origin, 3);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1200",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: recover accepted lease timeout",
            paths: ["results/accepted-lease-timeout.txt"],
          }),
        ),
    ),
  );

  assert.equal(fs.existsSync(hookMarker), true);
  assert.equal(
    lines.some((line) => line.includes("lease push timed out") && line.includes("verifying")),
    true,
  );
  assert.equal(
    lines.some(
      (line) =>
        line.includes("Acquired state publish lease") && line.includes("timeout_recovered=true"),
    ),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/accepted-lease-timeout.txt"],
      fixture.root,
    ),
    "accepted\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("state publisher retries a lease acquisition timeout not accepted remotely", () => {
  const fixture = createStatePublishRemote("unaccepted-lease-timeout");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/unaccepted-lease-timeout.txt"), "retried\n");
  const hookMarker = installUnacceptedLeasePushTimeoutHook(state, 3);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1200",
        CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: retry unaccepted lease timeout",
            paths: ["results/unaccepted-lease-timeout.txt"],
          }),
        ),
    ),
  );

  assert.equal(fs.existsSync(hookMarker), true);
  assert.equal(
    lines.some((line) => line.includes("lease push timeout was not accepted")),
    true,
  );
  assert.equal(
    lines.some(
      (line) =>
        line.includes("Acquired state publish lease") && line.includes("timeout_recovered=false"),
    ),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/unaccepted-lease-timeout.txt"],
      fixture.root,
    ),
    "retried\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("leased publisher verifies an accepted branch push after the client times out", () => {
  const fixture = createStatePublishRemote("accepted-timeout");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, "results/accepted-timeout.txt"), "accepted\n");
  const hookMarker = installAcceptedStatePushTimeoutHook(fixture.origin, 3);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1200",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: verify accepted timed out push",
            paths: ["results/accepted-timeout.txt"],
          }),
        ),
    ),
  );

  assert.equal(fs.existsSync(hookMarker), true);
  assert.equal(
    lines.some((line) => line.includes("push timed out; verifying the expected remote state")),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", "state:results/accepted-timeout.txt"],
      fixture.root,
    ),
    "accepted\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("leased publisher adopts a path-equivalent remote race before source refresh", () => {
  const fixture = createStatePublishRemote("path-equivalent-race");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  const selectedPath = "results/shared.txt";
  const remoteOnlyPath = "results/remote-only.txt";
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  write(path.join(source, selectedPath), "same selected blob\n");
  write(path.join(other, selectedPath), "same selected blob\n");
  write(path.join(other, remoteOnlyPath), "unrelated remote state\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "publish matching blob and unrelated state"], other);
  installStateRaceHook(state, other);

  const lines = captureConsoleLog(() =>
    withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
      withCwd(source, () =>
        publishMainCommit({
          message: "chore: publish path-equivalent state",
          paths: [selectedPath],
        }),
      ),
    ),
  );

  assert.equal(
    lines.some((line) => line.includes("expected blobs are remote")),
    true,
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"], state),
    run("git", ["--git-dir", fixture.origin, "rev-parse", "state"], fixture.root),
  );
  assert.equal(
    fs.readFileSync(path.join(source, remoteOnlyPath), "utf8"),
    "unrelated remote state\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${selectedPath}`], fixture.root),
    "same selected blob\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${remoteOnlyPath}`], fixture.root),
    "unrelated remote state\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("leased publisher rebuilds after an unexpected state race", () => {
  const fixture = createStatePublishRemote("single-rebuild");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  write(path.join(other, "results/concurrent.txt"), "concurrent\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent state"], other);
  write(path.join(source, "results/local.txt"), "local\n");
  installStateRaceHook(state, other);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: rebuild leased publish",
            paths: ["results/local.txt"],
          }),
        ),
    ),
  );

  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/local.txt"], fixture.root),
    "local\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/concurrent.txt"], fixture.root),
    "concurrent\n",
  );
  assert.equal(
    Number(fs.readFileSync(path.join(state, ".git/hooks/state-push-count"), "utf8").trim()),
    2,
  );
  assert.equal(lines.filter((line) => line.includes("rebuilding attempt=1")).length, 1);
});

test("leased publisher converges after repeated unexpected state races", () => {
  const fixture = createStatePublishRemote("repeated-races");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  write(path.join(source, "results/local.txt"), "local\n");
  installRepeatedStateRaceHook(state, other, 4);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: converge leased publish",
            paths: ["results/local.txt"],
          }),
        ),
    ),
  );

  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/local.txt"], fixture.root),
    "local\n",
  );
  for (let race = 1; race <= 4; race += 1) {
    assert.equal(
      run(
        "git",
        ["--git-dir", fixture.origin, "show", `state:results/remote-race-${race}.txt`],
        fixture.root,
      ),
      `remote race ${race}\n`,
    );
  }
  assert.equal(
    Number(fs.readFileSync(path.join(state, ".git/hooks/state-push-count"), "utf8").trim()),
    5,
  );
  assert.equal(lines.filter((line) => line.includes("rebuilding attempt=")).length, 4);
});

test("leased reconciliation converges after repeated unexpected state races", () => {
  const fixture = createStatePublishRemote("repeated-reconciliation-races");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  const recordsRoot = "records/openclaw-openclaw";
  const tuplePaths = [
    `${recordsRoot}/items/1.md`,
    `${recordsRoot}/plans/1.md`,
    `${recordsRoot}/decision-packets/1.json`,
  ];
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  const localTuple = writeRecordTuple(source, {
    number: 1,
    marker: "local reconciliation",
    reviewedAt: "2026-07-14T20:00:00.000Z",
    itemUpdatedAt: "2026-07-14T19:59:00Z",
  });
  installRepeatedStateRaceHook(state, other, 2);

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: converge leased reconciliation",
            paths: tuplePaths,
            rebaseStrategy: "reconcile-records",
          }),
        ),
    ),
  );

  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${tuplePaths[0]}`], fixture.root),
    localTuple.primary,
  );
  for (let race = 1; race <= 2; race += 1) {
    assert.equal(
      run(
        "git",
        ["--git-dir", fixture.origin, "show", `state:results/remote-race-${race}.txt`],
        fixture.root,
      ),
      `remote race ${race}\n`,
    );
  }
  assert.equal(lines.filter((line) => line.includes("rebuilding attempt=")).length, 2);
});

test("leased apply-records rebuild preserves a concurrent remote close", () => {
  const fixture = createStatePublishRemote("apply-rebuild");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  const recordsRoot = "records/openclaw-openclaw";
  cloneState(fixture.origin, state);
  write(path.join(state, `${recordsRoot}/items/1.md`), "record one open\n");
  write(path.join(state, `${recordsRoot}/items/2.md`), "record two base\n");
  write(path.join(state, "apply-report.json"), "[]\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "seed apply records"], state);
  run("git", ["push", "origin", "HEAD:state"], state);

  cloneState(fixture.origin, other);
  fs.rmSync(path.join(other, `${recordsRoot}/items/1.md`));
  write(path.join(other, `${recordsRoot}/closed/1.md`), "record one closed remotely\n");
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "close record one remotely"], other);

  fs.mkdirSync(source);
  fs.cpSync(path.join(state, "records"), path.join(source, "records"), { recursive: true });
  fs.copyFileSync(path.join(state, "apply-report.json"), path.join(source, "apply-report.json"));
  write(path.join(source, `${recordsRoot}/items/2.md`), "record two local\n");
  write(path.join(source, "apply-report.json"), '[{"action":"updated"}]\n');
  installStateRaceHook(state, other);

  const result = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(source, () =>
      publishMainCommit({
        message: "chore: apply records through leased rebuild",
        paths: ["records", "apply-report.json"],
        rebaseStrategy: "apply-records",
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.throws(() =>
    run(
      "git",
      ["--git-dir", fixture.origin, "show", `state:${recordsRoot}/items/1.md`],
      fixture.root,
    ),
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", `state:${recordsRoot}/closed/1.md`],
      fixture.root,
    ),
    "record one closed remotely\n",
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", fixture.origin, "show", `state:${recordsRoot}/items/2.md`],
      fixture.root,
    ),
    "record two local\n",
  );
  assert.equal(
    Number(fs.readFileSync(path.join(state, ".git/hooks/state-push-count"), "utf8").trim()),
    2,
  );
});

test("leased publisher rebuilds when an accepted push is overwritten before verification", () => {
  const fixture = createStatePublishRemote("verify");
  const state = path.join(fixture.root, "state");
  const poison = path.join(fixture.root, "poison");
  const source = path.join(fixture.root, "source");
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, poison);
  fs.mkdirSync(source);
  write(path.join(poison, "results/verified.txt"), "poison\n");
  run("git", ["add", "."], poison);
  run("git", ["commit", "-m", "poison state"], poison);
  run("git", ["push", "origin", "HEAD:poison"], poison);
  installStatePoisonHook(fixture.origin);
  write(path.join(source, "results/verified.txt"), "expected\n");

  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: state,
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
      }),
      () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: verify remote blobs",
            paths: ["results/verified.txt"],
          }),
        ),
    ),
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/verified.txt"], fixture.root),
    "expected\n",
  );
  assert.equal(
    lines.some((line) => line.includes("superseded after an accepted push")),
    true,
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("failed leased publish refreshes advanced remote state before a later broad publish", () => {
  const fixture = createStatePublishRemote("failure-refresh");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  const remoteJob = "jobs/openclaw/closed/123.md";
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  write(path.join(other, remoteJob), "remote job\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "publish remote job"], other);
  run("git", ["push", "origin", "HEAD:state"], other);
  write(path.join(source, "results/local-checkpoint.txt"), "local\n");
  const rejectingHook = installStatePushRejectHook(fixture.origin);

  const startedAt = Date.now();
  const lines = captureConsoleLog(() =>
    assert.throws(
      () =>
        withEnv(
          leasedPublishEnv({
            CLAWSWEEPER_STATE_DIR: state,
            CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "3000",
            CLAWSWEEPER_PUBLISH_DEADLINE_MS: "300",
            CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "500",
            CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "1000",
          }),
          () =>
            withCwd(source, () =>
              publishMainCommit({
                message: "chore: fail narrow checkpoint",
                paths: ["results/local-checkpoint.txt"],
              }),
            ),
        ),
      /State publication deadline exceeded/,
    ),
  );
  assert.ok(Date.now() - startedAt < 3000);
  const metrics = lines.find((line) => line.includes("Git publish metrics:")) ?? "";
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(Number.isInteger(processCount) && processCount < 256, metrics);
  fs.rmSync(rejectingHook);

  assert.equal(fs.readFileSync(path.join(source, remoteJob), "utf8"), "remote job\n");
  assert.equal(fs.existsSync(path.join(source, "results/local-checkpoint.txt")), false);
  assert.equal(
    withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
      withCwd(source, () =>
        publishMainCommit({
          message: "chore: publish broad jobs after recovery",
          paths: ["jobs"],
        }),
      ),
    ),
    "unchanged",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${remoteJob}`], fixture.root),
    "remote job\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("publishMainCommit publishes generated paths to state branch when state root is configured", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, "results/initial.txt"), "initial\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "results/ledger.txt"), "ledger\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish state ledger",
        paths: ["results"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:results/ledger.txt"], root),
    "ledger\n",
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", "main:results/ledger.txt"], root));
});

test("leased normal publish refreshes remote generated state before a broad publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const checkpoint = "results/checkpoint.txt";
  const concurrentCursor = "results/apply-cursors/openclaw-openclaw.json";
  const concurrentJob = "jobs/openclaw/closed/123.md";
  const report = "apply-report.json";

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, checkpoint), "base\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "results"), path.join(work, "results"), { recursive: true });
  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, concurrentCursor), '{"cursor":"remote"}\n');
  write(path.join(other, concurrentJob), "remote job\n");
  write(path.join(other, report), '[{"report":"remote"}]\n');
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent generated state"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  write(path.join(work, checkpoint), "local\n");
  const results = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(work, () => {
      const first = publishMainCommit({
        message: "chore: publish narrow checkpoint",
        paths: [checkpoint],
        rebaseStrategy: "normal",
      });
      assert.equal(
        fs.readFileSync(path.join(work, concurrentCursor), "utf8"),
        '{"cursor":"remote"}\n',
      );
      assert.equal(fs.readFileSync(path.join(work, concurrentJob), "utf8"), "remote job\n");
      assert.equal(fs.readFileSync(path.join(work, report), "utf8"), '[{"report":"remote"}]\n');

      const second = publishMainCommit({
        message: "chore: publish broad generated state",
        paths: ["jobs", "results/apply-cursors", report],
        rebaseStrategy: "normal",
      });
      return [first, second];
    }),
  );

  assert.deepEqual(results, ["committed", "unchanged"]);
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${concurrentCursor}`], root),
    '{"cursor":"remote"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${concurrentJob}`], root),
    "remote job\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${report}`], root),
    '[{"report":"remote"}]\n',
  );
  assert.equal(remoteRefExists(origin, STATE_PUBLISH_LEASE_REF), false);
});

test("leased theirs publish refreshes merged health before the next status publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const statusFile = "results/sweep-status/openclaw-openclaw.json";
  const initialHealth = sweepHealth("2026-07-09T20:00:00Z", "comment_sync", 1);
  const closeHealth = sweepHealth("2026-07-09T20:02:00Z", "close", 2);

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  writeJson(
    path.join(state, statusFile),
    sweepStatus("2026-07-09T20:00:01Z", "Initial", initialHealth, initialHealth),
  );
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "results"), path.join(work, "results"), { recursive: true });
  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, statusFile),
    sweepStatus("2026-07-09T20:02:01Z", "Remote close", closeHealth, closeHealth),
  );
  run("git", ["commit", "-am", "remote close health"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  writeJson(
    path.join(work, statusFile),
    sweepStatus("2026-07-09T20:03:00Z", "Local checkpoint", initialHealth, initialHealth),
  );
  const results = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(work, () => {
      const first = publishMainCommit({
        message: "chore: publish checkpoint status",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "theirs",
      });
      const learned = JSON.parse(fs.readFileSync(path.join(work, statusFile), "utf8"));
      assert.equal(learned.state, "Local checkpoint");
      assert.deepEqual(learned.apply_health, closeHealth);
      assert.deepEqual(learned.last_close_apply_health, closeHealth);

      writeJson(path.join(work, statusFile), {
        ...learned,
        state: "Local final",
        detail: "Local final detail",
        updated_at: "2026-07-09T20:04:00Z",
      });
      const second = publishMainCommit({
        message: "chore: publish final status",
        paths: [statusFile],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "theirs",
      });
      return [first, second];
    }),
  );

  assert.deepEqual(results, ["committed", "committed"]);
  const published = readOriginJson(origin, `state:${statusFile}`, root);
  assert.equal(published.state, "Local final");
  assert.deepEqual(published.apply_health, closeHealth);
  assert.deepEqual(published.last_close_apply_health, closeHealth);
});

test("leased reconcile-records publish preserves a remote close before a broad publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  const itemTwo = `${recordsRoot}/items/2.md`;
  const closedTwo = `${recordsRoot}/closed/2.md`;
  const planTwo = `${recordsRoot}/plans/2.md`;
  const packetTwo = `${recordsRoot}/decision-packets/2.json`;
  const tupleOnePaths = [
    `${recordsRoot}/items/1.md`,
    `${recordsRoot}/plans/1.md`,
    `${recordsRoot}/decision-packets/1.json`,
  ];

  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  writeRecordTuple(state, {
    number: 1,
    marker: "record one base",
    reviewedAt: "2026-07-09T20:00:00.000Z",
    itemUpdatedAt: "2026-07-09T19:59:00Z",
  });
  writeRecordTuple(state, {
    number: 2,
    marker: "record two base",
    reviewedAt: "2026-07-09T20:00:00.000Z",
    itemUpdatedAt: "2026-07-09T19:59:00Z",
  });
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  run("git", ["clone", origin, other], root);
  configureUser(other);
  const remoteClose = writeRecordTuple(other, {
    number: 2,
    marker: "record two closed remotely",
    reviewedAt: "2026-07-09T20:02:00.000Z",
    itemUpdatedAt: "2026-07-09T20:01:00Z",
    location: "closed",
    packet: false,
    plan: false,
  });
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "close record two remotely"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  writeRecordTuple(work, {
    number: 1,
    marker: "record one checkpoint",
    reviewedAt: "2026-07-09T20:03:00.000Z",
    itemUpdatedAt: "2026-07-09T20:02:00Z",
  });
  const result = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(work, () => {
      const first = publishMainCommit({
        message: "chore: publish one record tuple",
        paths: tupleOnePaths,
        rebaseStrategy: "reconcile-records",
      });
      assert.equal(fs.existsSync(path.join(work, itemTwo)), false);
      assert.equal(fs.existsSync(path.join(work, planTwo)), false);
      assert.equal(fs.existsSync(path.join(work, packetTwo)), false);
      assert.equal(fs.readFileSync(path.join(work, closedTwo), "utf8"), remoteClose.primary);

      const localFinal = writeRecordTuple(work, {
        number: 1,
        marker: "record one final",
        reviewedAt: "2026-07-09T20:04:00.000Z",
        itemUpdatedAt: "2026-07-09T20:03:00Z",
      });
      const second = publishMainCommit({
        message: "chore: publish broad record snapshot",
        paths: [recordsRoot],
        rebaseStrategy: "reconcile-records",
      });
      return { localFinal, results: [first, second] };
    }),
  );

  assert.deepEqual(result.results, ["committed", "committed"]);
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${closedTwo}`], root),
    remoteClose.primary,
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${itemTwo}`], root));
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/1.md`], root),
    result.localFinal.primary,
  );
  assert.equal(remoteRefExists(origin, STATE_PUBLISH_LEASE_REF), false);
});

test("state refresh reconciles retried direct publisher resets before broad publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const itemRecord = "records/openclaw-openclaw/items/1.md";
  const closedRecord = "records/openclaw-openclaw/closed/1.md";
  const concurrentJob = "jobs/openclaw/closed/123.md";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, itemRecord), "record base\n");
  write(path.join(state, "jobs/openclaw/inbox/base.md"), "base job\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  fs.cpSync(path.join(state, "jobs"), path.join(work, "jobs"), { recursive: true });

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, concurrentJob), "concurrent closed job\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent job result"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () => {
      const baseline = captureStatePublishBaseline();
      hardResetToRemoteMain();
      assert.equal(fs.existsSync(path.join(work, concurrentJob)), false);
      // A failed event attempt can reset the state checkout without completing
      // its source refresh. Reuse the original baseline on the retry.
      hardResetToRemoteMain();
      refreshSourceAfterStatePublish([itemRecord, closedRecord], baseline);
      assert.equal(
        fs.readFileSync(path.join(work, concurrentJob), "utf8"),
        "concurrent closed job\n",
      );
      return publishMainCommit({
        message: "chore: publish event router ledger",
        paths: ["jobs"],
        maxAttempts: 1,
        pushAttempts: 1,
      });
    }),
  );

  assert.equal(result, "unchanged");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${concurrentJob}`], root),
    "concurrent closed job\n",
  );
});

test("leased apply-records publish refreshes source paths before broad publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const other = path.join(root, "other");
  const recordOne = "records/openclaw-openclaw/items/1.md";
  const recordTwo = "records/openclaw-openclaw/items/2.md";
  const recordThree = "records/openclaw-openclaw/items/3.md";
  const recordFour = "records/openclaw-openclaw/items/4.md";
  const closedFour = "records/openclaw-openclaw/closed/4.md";
  const planFour = "records/openclaw-openclaw/plans/4.md";
  const packetFour = "records/openclaw-openclaw/decision-packets/4.json";
  const recordFive = "records/openclaw-openclaw/items/5.md";
  const closedFive = "records/openclaw-openclaw/closed/5.md";
  const planFive = "records/openclaw-openclaw/plans/5.md";
  const packetFive = "records/openclaw-openclaw/decision-packets/5.json";
  const configPath = "config/new.json";
  const craftedPath = "results/..\\config\\new.json";
  const openclawCursor = "results/apply-cursors/openclaw-openclaw.json";
  const clawhubCursor = "results/apply-cursors/openclaw-clawhub.json";
  const sweepStatusPath = "results/sweep-status/openclaw-openclaw.json";
  const refreshHealth = sweepHealth("2026-07-09T20:00:00Z", "comment_sync", 1);
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, recordOne), "record one base\n");
  write(path.join(state, recordTwo), "record two base\n");
  write(path.join(state, recordThree), "record three base\n");
  write(path.join(state, recordFour), "record four base\n");
  write(path.join(state, planFour), "plan four base\n");
  write(path.join(state, packetFour), '{"decision":"base"}\n');
  write(path.join(state, openclawCursor), '{"cursor":"openclaw-base"}\n');
  write(path.join(state, clawhubCursor), '{"cursor":"clawhub-base"}\n');
  writeJson(
    path.join(state, sweepStatusPath),
    sweepStatus("2026-07-09T20:00:01Z", "Base", refreshHealth, refreshHealth),
  );
  write(path.join(state, "apply-report.json"), '[{"report":"base"}]\n');
  write(path.join(state, configPath), "config base\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);
  run("git", ["config", "core.autocrlf", "true"], state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  fs.cpSync(path.join(state, "results"), path.join(work, "results"), { recursive: true });
  fs.cpSync(path.join(state, "config"), path.join(work, "config"), { recursive: true });
  fs.cpSync(path.join(state, "apply-report.json"), path.join(work, "apply-report.json"));

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, recordTwo), "record two concurrent\n");
  write(path.join(other, recordThree), "record three concurrent\n");
  write(path.join(other, closedFour), fs.readFileSync(path.join(other, recordFour), "utf8"));
  fs.rmSync(path.join(other, recordFour));
  fs.rmSync(path.join(other, planFour));
  fs.rmSync(path.join(other, packetFour));
  write(path.join(other, closedFive), "record five closed concurrently\n");
  write(path.join(other, configPath), "config concurrent\n");
  write(path.join(other, craftedPath), "crafted generated path\n");
  write(path.join(other, clawhubCursor), '{"cursor":"clawhub-concurrent"}\n');
  write(path.join(other, "apply-report.json"), '[{"report":"concurrent"}]\n');
  run("git", ["add", "-A"], other);
  run("git", ["commit", "-m", "concurrent state update"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  write(path.join(work, recordTwo), "record two base\r\n");
  write(path.join(work, recordThree), "record three pending local\n");
  write(path.join(work, recordFour), "record four pending local\n");
  write(path.join(work, planFour), "plan four pending local\n");
  write(path.join(work, packetFour), '{"decision":"pending-local"}\n');
  write(path.join(work, recordFive), "record five pending local\n");
  write(path.join(work, planFive), "plan five pending local\n");
  write(path.join(work, packetFive), '{"decision":"pending-local"}\n');
  writeJson(
    path.join(work, sweepStatusPath),
    sweepStatus("2026-07-09T20:01:00Z", "Checkpoint", refreshHealth, refreshHealth),
  );
  const results = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(work, () => {
      const first = publishMainCommit({
        message: "chore: update checkpoint status",
        paths: ["results/sweep-status"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });

      assert.equal(
        fs.readFileSync(path.join(work, recordTwo), "utf8"),
        "record two concurrent\r\n",
      );
      assert.equal(
        fs.readFileSync(path.join(work, recordThree), "utf8"),
        "record three pending local\n",
      );
      assert.equal(
        fs.readFileSync(path.join(work, clawhubCursor), "utf8"),
        '{"cursor":"clawhub-concurrent"}\r\n',
      );
      assert.equal(
        fs.readFileSync(path.join(work, "apply-report.json"), "utf8"),
        '[{"report":"concurrent"}]\r\n',
      );
      assert.equal(fs.existsSync(path.join(work, recordFour)), false);
      assert.equal(fs.existsSync(path.join(work, planFour)), false);
      assert.equal(fs.existsSync(path.join(work, packetFour)), false);
      assert.equal(fs.readFileSync(path.join(work, closedFour), "utf8"), "record four base\r\n");
      assert.equal(fs.existsSync(path.join(work, recordFive)), false);
      assert.equal(fs.existsSync(path.join(work, planFive)), false);
      assert.equal(fs.existsSync(path.join(work, packetFive)), false);
      assert.equal(
        fs.readFileSync(path.join(work, closedFive), "utf8"),
        "record five closed concurrently\r\n",
      );
      assert.equal(fs.readFileSync(path.join(work, configPath), "utf8"), "config base\n");
      assert.equal(
        fs.readFileSync(path.join(work, craftedPath), "utf8"),
        "crafted generated path\r\n",
      );

      write(path.join(work, recordOne), "record one checkpoint\n");
      write(path.join(work, openclawCursor), '{"cursor":"openclaw-checkpoint"}\n');
      const second = publishMainCommit({
        message: "chore: apply checkpoint",
        paths: ["records", "results/apply-cursors", "apply-report.json"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });

      run("git", ["fetch", "origin", "state"], other);
      run("git", ["reset", "--hard", "origin/state"], other);
      write(path.join(other, recordTwo), "record two concurrent again\n");
      write(path.join(other, clawhubCursor), '{"cursor":"clawhub-concurrent-again"}\n');
      write(path.join(other, "apply-report.json"), '[{"report":"concurrent-again"}]\n');
      run("git", ["commit", "-am", "second concurrent state update"], other);
      run("git", ["push", "origin", "HEAD:state"], other);

      writeJson(
        path.join(work, sweepStatusPath),
        sweepStatus("2026-07-09T20:02:00Z", "Checkpoint again", refreshHealth, refreshHealth),
      );
      const third = publishMainCommit({
        message: "chore: update checkpoint status again",
        paths: ["results/sweep-status"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });
      assert.equal(
        fs.readFileSync(path.join(work, recordTwo), "utf8"),
        "record two concurrent again\r\n",
      );
      assert.equal(fs.existsSync(path.join(work, recordFour)), false);
      assert.equal(fs.existsSync(path.join(work, packetFour)), false);

      const fourth = publishMainCommit({
        message: "chore: apply checkpoint again",
        paths: ["records", "results/apply-cursors", "apply-report.json"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });

      run("git", ["fetch", "origin", "state"], other);
      run("git", ["reset", "--hard", "origin/state"], other);
      write(path.join(other, recordTwo), "record two concurrent before no-op\n");
      run("git", ["commit", "-am", "concurrent state update before no-op"], other);
      run("git", ["push", "origin", "HEAD:state"], other);

      const fifth = publishMainCommit({
        message: "chore: publish unchanged checkpoint status",
        paths: ["results/sweep-status"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });
      assert.equal(
        fs.readFileSync(path.join(work, recordTwo), "utf8"),
        "record two concurrent before no-op\r\n",
      );
      const sixth = publishMainCommit({
        message: "chore: apply unchanged checkpoint",
        paths: ["records", "results/apply-cursors", "apply-report.json"],
        maxAttempts: 1,
        pushAttempts: 1,
        rebaseStrategy: "apply-records",
      });
      return [first, second, third, fourth, fifth, sixth];
    }),
  );

  assert.deepEqual(results, [
    "committed",
    "committed",
    "committed",
    "unchanged",
    "unchanged",
    "unchanged",
  ]);
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordOne}`], root),
    "record one checkpoint\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordTwo}`], root),
    "record two concurrent before no-op\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordThree}`], root),
    "record three pending local\n",
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${recordFour}`], root));
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${planFour}`], root));
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${packetFour}`], root));
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${closedFour}`], root),
    "record four base\n",
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${recordFive}`], root));
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${planFive}`], root));
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${packetFive}`], root));
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${closedFive}`], root),
    "record five closed concurrently\n",
  );
  assert.equal(fs.readFileSync(path.join(work, configPath), "utf8"), "config base\n");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${openclawCursor}`], root),
    '{"cursor":"openclaw-checkpoint"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${clawhubCursor}`], root),
    '{"cursor":"clawhub-concurrent-again"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:apply-report.json"], root),
    '[{"report":"concurrent-again"}]\n',
  );
});

test("publishMainCommit deletes an exact missing decision packet from state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  const packet = "records/openclaw-openclaw/decision-packets/5.json";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, packet), '{"subject":{"state":"open"}}\n');
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);
  fs.mkdirSync(work);

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: remove stale decision packet",
        paths: [packet],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.throws(() => run("git", ["--git-dir", origin, "show", `state:${packet}`], root));
});

test("publishMainCommit preserves concurrent records from a newer state snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, "records/openclaw-openclaw/items/1.md"), "record old\n");
  write(path.join(state, "records/openclaw-openclaw/items/2.md"), "concurrent record\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record updated\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: update sweep records",
        paths: ["records/openclaw-openclaw"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/items/1.md"], root),
    "record updated\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/items/2.md"], root),
    "concurrent record\n",
  );
});

test("publishMainCommit preserves record moves while merging concurrent records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(path.join(state, "records/openclaw-openclaw/items/1.md"), "open\n");
  write(path.join(state, "records/openclaw-openclaw/items/2.md"), "concurrent record\n");
  write(path.join(state, "records/openclaw-openclaw/plans/1.md"), "plan\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "records/openclaw-openclaw/closed/1.md"), "closed\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: reconcile sweep records",
        paths: ["records/openclaw-openclaw"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/items/1.md"], root),
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/plans/1.md"], root),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/closed/1.md"], root),
    "closed\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:records/openclaw-openclaw/items/2.md"], root),
    "concurrent record\n",
  );
});

test("publishMainCommit preserves state-only queued jobs on broad jobs publishes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  write(
    path.join(state, "jobs/openclaw/inbox/automerge-openclaw-openclaw-75589.md"),
    "state automerge job\n",
  );
  write(
    path.join(state, "jobs/openclaw/inbox/self-heal-openclaw-openclaw-85116.md"),
    "state self-heal job\n",
  );
  write(path.join(state, "jobs/steipete/inbox/issue-steipete-oracle-241.md"), "state issue job\n");
  write(
    path.join(state, "jobs/openclaw/inbox/repair-pr-openclaw-clawsweeper-290.md"),
    "state repair-pr job\n",
  );
  write(path.join(state, "jobs/openclaw/inbox/ordinary.md"), "state ordinary job\n");
  run("git", ["add", "."], state);
  run("git", ["commit", "-m", "initial state"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], state);

  fs.mkdirSync(work);
  write(path.join(work, "jobs/openclaw/inbox/new.md"), "local job\n");

  const result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
    withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish jobs",
        paths: ["jobs"],
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run(
      "git",
      [
        "--git-dir",
        origin,
        "show",
        "state:jobs/openclaw/inbox/automerge-openclaw-openclaw-75589.md",
      ],
      root,
    ),
    "state automerge job\n",
  );
  assert.equal(
    run(
      "git",
      [
        "--git-dir",
        origin,
        "show",
        "state:jobs/openclaw/inbox/self-heal-openclaw-openclaw-85116.md",
      ],
      root,
    ),
    "state self-heal job\n",
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "state:jobs/steipete/inbox/issue-steipete-oracle-241.md"],
      root,
    ),
    "state issue job\n",
  );
  assert.equal(
    run(
      "git",
      [
        "--git-dir",
        origin,
        "show",
        "state:jobs/openclaw/inbox/repair-pr-openclaw-clawsweeper-290.md",
      ],
      root,
    ),
    "state repair-pr job\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:jobs/openclaw/inbox/new.md"], root),
    "local job\n",
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "state:jobs/openclaw/inbox/ordinary.md"], root),
  );
});

test("publish-main CLI accepts package-manager double dash separators", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "results/initial.txt"), "initial\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  write(path.join(work, "results/from-cli.txt"), "from cli\n");
  run(
    process.execPath,
    [
      path.resolve("dist/repair/publish-main.js"),
      "--",
      "--message",
      "chore: publish cli ledger",
      "--path",
      "results",
      "--rebase-strategy",
      "theirs",
      "--max-attempts",
      "1",
      "--push-attempts",
      "1",
    ],
    work,
  );

  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/from-cli.txt"], root),
    "from cli\n",
  );
});

test("immutable publisher treats identical paths as idempotent and rejects collisions", () => {
  const fixture = createStatePublishRemote("immutable-collision");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  const shard = replayEquivalentActionShards();
  const publishPath = shard.publishPath;
  cloneState(fixture.origin, state);
  write(path.join(state, publishPath), shard.first);
  run("git", ["add", publishPath], state);
  run("git", ["commit", "-m", "seed immutable event"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  fs.mkdirSync(source);
  write(path.join(source, publishPath), shard.first);

  const replay = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(source, () =>
      publishMainCommit({
        message: "chore: replay immutable event",
        paths: [publishPath],
        coordination: "immutable",
      }),
    ),
  );
  assert.equal(replay, "unchanged");
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);

  write(path.join(source, publishPath), shard.second);
  const equivalentReplay = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(source, () =>
      publishMainCommit({
        message: "chore: replay equivalent immutable event",
        paths: [publishPath],
        coordination: "immutable",
      }),
    ),
  );
  assert.equal(equivalentReplay, "unchanged");

  write(path.join(source, publishPath), "conflicting event\n");
  assert.throws(
    () =>
      withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
        withCwd(source, () =>
          publishMainCommit({
            message: "chore: reject immutable collision",
            paths: [publishPath],
            coordination: "immutable",
          }),
        ),
      ),
    /Immutable action ledger path conflict/,
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${publishPath}`], fixture.root),
    shard.first,
  );
});

test("immutable publisher adds only missing paths during a partial replay", () => {
  const fixture = createStatePublishRemote("immutable-partial-replay");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  const existingPath = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;
  const missingPath = `ledger/v1/import-bindings/events/${"b".repeat(64)}.json`;
  cloneState(fixture.origin, state);
  write(path.join(state, existingPath), '{"event":"existing"}\n');
  run("git", ["add", existingPath], state);
  run("git", ["commit", "-m", "seed immutable binding"], state);
  run("git", ["push", "origin", "HEAD:state"], state);
  fs.mkdirSync(source);
  write(path.join(source, existingPath), '{"event":"existing"}\n');
  write(path.join(source, missingPath), '{"event":"missing"}\n');

  const result = withEnv(leasedPublishEnv({ CLAWSWEEPER_STATE_DIR: state }), () =>
    withCwd(source, () =>
      publishMainCommit({
        message: "chore: partially replay immutable bindings",
        paths: [existingPath, missingPath],
        coordination: "immutable",
      }),
    ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${existingPath}`], fixture.root),
    '{"event":"existing"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${missingPath}`], fixture.root),
    '{"event":"missing"}\n',
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("immutable publisher verifies an accepted branch push after client timeout", () => {
  const fixture = createStatePublishRemote("immutable-accepted-timeout");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  const publishPath = `ledger/v1/import-bindings/events/${"c".repeat(64)}.json`;
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, publishPath), '{"event":"accepted"}\n');
  installAcceptedStatePushTimeoutHook(fixture.origin, 0.3);

  const result = withEnv(
    leasedPublishEnv({
      CLAWSWEEPER_STATE_DIR: state,
      CLAWSWEEPER_IMMUTABLE_PUBLISH_DEADLINE_MS: "3000",
      CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "100",
    }),
    () =>
      withCwd(source, () =>
        publishMainCommit({
          message: "chore: verify immutable accepted timeout",
          paths: [publishPath],
          coordination: "immutable",
        }),
      ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${publishPath}`], fixture.root),
    '{"event":"accepted"}\n',
  );
});

test("64 bursty immutable publishers converge in production-shaped cohorts", async () => {
  const fixture = createStatePublishRemote("immutable-concurrency");
  const publisherCount = 64;
  const cohortSize = 16;
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "10000",
  });
  const preparedPublishers = Array.from({ length: publisherCount }, (_, index) => {
    const state = path.join(fixture.root, `state-${index}`);
    const source = path.join(fixture.root, `source-${index}`);
    const publishPath = `ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-${index + 1}-review-${String(index).padStart(2, "0")}.jsonl`;
    cloneState(fixture.origin, state);
    fs.mkdirSync(source);
    write(path.join(source, publishPath), `event ${index}\n`);
    return { index, state, source, publishPath };
  });
  const publishers = [];
  for (let cohortStart = 0; cohortStart < publisherCount; cohortStart += cohortSize) {
    const cohort = preparedPublishers
      .slice(cohortStart, cohortStart + cohortSize)
      .map(({ index, state, source, publishPath }) => ({
        publishPath,
        child: startImmutablePublishProcess(
          source,
          state,
          `chore: append immutable event ${index}`,
          publishPath,
          env,
        ),
      }));
    publishers.push(...cohort);
    const completed = await Promise.all(cohort.map(({ child }) => waitForChild(child)));
    for (const result of completed) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
  }
  for (const [index, { publishPath }] of publishers.entries()) {
    assert.equal(
      run("git", ["--git-dir", fixture.origin, "show", `state:${publishPath}`], fixture.root),
      `event ${index}\n`,
    );
  }
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("immutable publisher survives more than the former 32-attempt race ceiling", () => {
  const fixture = createStatePublishRemote("immutable-mutable-storm");
  const state = path.join(fixture.root, "state");
  const other = path.join(fixture.root, "other");
  const source = path.join(fixture.root, "source");
  const publishPath = `ledger/v1/import-bindings/events/${"d".repeat(64)}.json`;
  cloneState(fixture.origin, state);
  cloneState(fixture.origin, other);
  fs.mkdirSync(source);
  write(path.join(source, publishPath), '{"event":"storm"}\n');
  const raceCount = 33;
  installRepeatedStateRaceHook(state, other, raceCount);

  const result = withEnv(
    leasedPublishEnv({
      CLAWSWEEPER_STATE_DIR: state,
      CLAWSWEEPER_IMMUTABLE_PUBLISH_DEADLINE_MS: "60000",
      CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "5000",
    }),
    () =>
      withCwd(source, () =>
        publishMainCommit({
          message: "chore: append immutable event through mutable storm",
          paths: [publishPath],
          coordination: "immutable",
        }),
      ),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${publishPath}`], fixture.root),
    '{"event":"storm"}\n',
  );
  for (let race = 1; race <= raceCount; race += 1) {
    assert.equal(
      run(
        "git",
        ["--git-dir", fixture.origin, "show", `state:results/remote-race-${race}.txt`],
        fixture.root,
      ),
      `remote race ${race}\n`,
    );
  }
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("immutable publishers yield to an active exclusive state mutation", async () => {
  const fixture = createStatePublishRemote("immutable-exclusive-priority");
  const exclusiveState = path.join(fixture.root, "state-exclusive");
  const immutableState = path.join(fixture.root, "state-immutable");
  const exclusiveSource = path.join(fixture.root, "source-exclusive");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const releaseSignal = path.join(fixture.root, "release-exclusive");
  const releaseObserved = path.join(fixture.root, "exclusive-released");
  const immutablePath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-priority-review-a.jsonl";
  cloneState(fixture.origin, exclusiveState);
  cloneState(fixture.origin, immutableState);
  fs.mkdirSync(exclusiveSource);
  fs.mkdirSync(immutableSource);
  write(path.join(exclusiveSource, "results/exclusive.txt"), "exclusive\n");
  write(path.join(immutableSource, immutablePath), "immutable\n");
  installStatePushReleaseHook(exclusiveState, releaseSignal, releaseObserved);
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "4000",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
  });

  const exclusive = startPublishCli(
    exclusiveSource,
    exclusiveState,
    "chore: publish exclusive mutation",
    env,
  );
  const exclusiveResult = waitForChild(exclusive);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const immutable = startImmutablePublishProcess(
    immutableSource,
    immutableState,
    "chore: append priority event",
    immutablePath,
    env,
  );
  const immutableResult = waitForChild(immutable);
  await waitForChildOutput(immutable, "Immutable publish yielding to exclusive state lease");
  assert.throws(() =>
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
  );
  write(releaseSignal, "release\n");

  const [exclusiveCompleted, immutableCompleted] = await Promise.all([
    exclusiveResult,
    immutableResult,
  ]);
  assert.equal(exclusiveCompleted.status, 0, exclusiveCompleted.stderr);
  assert.equal(immutableCompleted.status, 0, immutableCompleted.stderr);
  assert.equal(fs.existsSync(releaseObserved), true);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    "immutable\n",
  );
  const subjects = run(
    "git",
    ["--git-dir", fixture.origin, "log", "--reverse", "--format=%s", "state"],
    fixture.root,
  );
  assert.ok(
    subjects.indexOf("chore: publish exclusive mutation") <
      subjects.indexOf("chore: append priority event"),
  );
});

test("immutable publishers make progress after the exclusive priority budget", async () => {
  const fixture = createStatePublishRemote("immutable-exclusive-bounded-priority");
  const exclusiveState = path.join(fixture.root, "state-exclusive");
  const immutableState = path.join(fixture.root, "state-immutable");
  const exclusiveSource = path.join(fixture.root, "source-exclusive");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const releaseSignal = path.join(fixture.root, "release-exclusive");
  const releaseObserved = path.join(fixture.root, "exclusive-released");
  const exclusivePath = "results/exclusive-bounded-priority.txt";
  const immutablePath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-bounded-priority-review-a.jsonl";
  cloneState(fixture.origin, exclusiveState);
  cloneState(fixture.origin, immutableState);
  fs.mkdirSync(exclusiveSource);
  fs.mkdirSync(immutableSource);
  write(path.join(exclusiveSource, exclusivePath), "exclusive\n");
  write(path.join(immutableSource, immutablePath), "immutable\n");
  installStatePushReleaseHook(exclusiveState, releaseSignal, releaseObserved);
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "4000",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
  });

  const exclusive = startPublishCli(
    exclusiveSource,
    exclusiveState,
    "chore: publish bounded-priority exclusive mutation",
    env,
  );
  const exclusiveResult = waitForChild(exclusive);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const immutable = startImmutablePublishProcess(
    immutableSource,
    immutableState,
    "chore: append bounded-priority event",
    immutablePath,
    env,
  );
  const immutableResult = waitForChild(immutable);
  await waitForChildOutput(
    immutable,
    "Immutable publish priority yield exhausted",
    "proceeding alongside active exclusive state lease",
  );
  const immutableCompleted = await immutableResult;
  assert.equal(immutableCompleted.status, 0, immutableCompleted.stderr);
  assert.equal(fs.existsSync(releaseObserved), false);

  write(releaseSignal, "release\n");
  const exclusiveCompleted = await exclusiveResult;
  assert.equal(exclusiveCompleted.status, 0, exclusiveCompleted.stderr);
  assert.equal(fs.existsSync(releaseObserved), true);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${exclusivePath}`], fixture.root),
    "exclusive\n",
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    "immutable\n",
  );
});

test("replacement exclusive leases share one immutable priority budget", async () => {
  const fixture = createStatePublishRemote("immutable-replacement-lease-priority");
  const leaseState = path.join(fixture.root, "state-lease");
  const immutableState = path.join(fixture.root, "state-immutable");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const immutablePath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-replacement-priority-review-a.jsonl";
  const firstOwner = "11111111-1111-4111-8111-111111111111";
  const secondOwner = "22222222-2222-4222-8222-222222222222";
  const ttlMs = 12_000;
  cloneState(fixture.origin, leaseState);
  cloneState(fixture.origin, immutableState);
  fs.mkdirSync(immutableSource);
  write(path.join(immutableSource, immutablePath), "immutable\n");
  const firstIssuedAt = new Date();
  const firstLeaseOid = createRemoteLease(leaseState, {
    owner: firstOwner,
    issuedAt: firstIssuedAt.toISOString(),
    expiresAt: new Date(firstIssuedAt.getTime() + ttlMs).toISOString(),
    ttlMs,
  });
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "9000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(ttlMs),
  });

  const immutable = startImmutablePublishProcess(
    immutableSource,
    immutableState,
    "chore: append replacement-priority event",
    immutablePath,
    env,
  );
  const immutableResult = waitForChild(immutable);
  await waitForChildOutput(immutable, `owner=${firstOwner}`);
  const secondIssuedAt = new Date();
  createRemoteLease(leaseState, {
    owner: secondOwner,
    issuedAt: secondIssuedAt.toISOString(),
    expiresAt: new Date(secondIssuedAt.getTime() + ttlMs).toISOString(),
    ttlMs,
    expectedOid: firstLeaseOid,
  });
  await waitForChildOutput(immutable, `owner=${secondOwner}`);

  const immutableCompleted = await immutableResult;
  assert.equal(immutableCompleted.status, 0, immutableCompleted.stderr);
  const firstWaitMs = Number(
    new RegExp(`owner=${firstOwner} wait_ms=(\\d+)`).exec(immutableCompleted.stdout)?.[1],
  );
  const secondWaitMs = Number(
    new RegExp(`owner=${secondOwner} wait_ms=(\\d+)`).exec(immutableCompleted.stdout)?.[1],
  );
  assert.ok(firstWaitMs > 0);
  assert.ok(secondWaitMs > 0 && secondWaitMs < firstWaitMs);
  assert.match(immutableCompleted.stdout, /Immutable publish priority yield exhausted/);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    "immutable\n",
  );
});

test("slow lease observation cannot consume the immutable CAS reserve", async () => {
  const fixture = createStatePublishRemote("immutable-slow-lease-observation");
  const leaseState = path.join(fixture.root, "state-lease");
  const immutableState = path.join(fixture.root, "state-immutable");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const immutablePath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-slow-observation-review-a.jsonl";
  const ttlMs = 10_000;
  cloneState(fixture.origin, leaseState);
  cloneState(fixture.origin, immutableState);
  fs.mkdirSync(immutableSource);
  write(path.join(immutableSource, immutablePath), "immutable\n");
  const issuedAt = new Date();
  createRemoteLease(leaseState, {
    owner: "33333333-3333-4333-8333-333333333333",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    ttlMs,
  });
  const wrapper = installSlowLeaseObservationGitWrapper(fixture.root, 2);
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(ttlMs),
    PATH: `${wrapper.bin}:${process.env.PATH ?? ""}`,
    REAL_GIT: wrapper.realGit,
  });

  const immutable = startImmutablePublishProcess(
    immutableSource,
    immutableState,
    "chore: append after slow lease observation",
    immutablePath,
    env,
  );
  const immutableCompleted = await waitForChild(immutable);

  assert.equal(immutableCompleted.status, 0, immutableCompleted.stderr);
  assert.equal(fs.existsSync(wrapper.marker), true);
  assert.match(
    immutableCompleted.stdout,
    /priority yield exhausted during lease observation; proceeding without further exclusive lease preference/,
  );
  assert.doesNotMatch(immutableCompleted.stdout, /State publication deadline exceeded/);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    "immutable\n",
  );
});

test("pre-convergence work consumes the shared immutable priority budget", async () => {
  const fixture = createStatePublishRemote("immutable-pre-convergence-priority");
  const leaseState = path.join(fixture.root, "state-lease");
  const immutableState = path.join(fixture.root, "state-immutable");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const immutablePath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-pre-convergence-review-a.jsonl";
  const ttlMs = 10_000;
  cloneState(fixture.origin, leaseState);
  cloneState(fixture.origin, immutableState);
  fs.mkdirSync(immutableSource);
  write(path.join(immutableSource, immutablePath), "immutable\n");
  const issuedAt = new Date();
  createRemoteLease(leaseState, {
    owner: "44444444-4444-4444-8444-444444444444",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    ttlMs,
  });
  const wrapper = installDelayedPreConvergenceGitWrapper(fixture.root, 1);
  const env = leasedPublishEnv({
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: String(ttlMs),
    PATH: `${wrapper.bin}:${process.env.PATH ?? ""}`,
    REAL_GIT: wrapper.realGit,
  });

  const immutable = startImmutablePublishProcess(
    immutableSource,
    immutableState,
    "chore: append after delayed pre-convergence work",
    immutablePath,
    env,
  );
  const immutableCompleted = await waitForChild(immutable);

  assert.equal(immutableCompleted.status, 0, immutableCompleted.stderr);
  assert.equal(fs.existsSync(wrapper.delayMarker), true);
  assert.equal(fs.existsSync(wrapper.leaseProbeMarker), false);
  assert.doesNotMatch(immutableCompleted.stdout, /State publication deadline exceeded/);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    "immutable\n",
  );
});

test("immutable publisher converges when an exclusive lease appears before its push", () => {
  const fixture = createStatePublishRemote("immutable-exclusive-acquisition-race");
  const immutableState = path.join(fixture.root, "state-immutable");
  const exclusiveState = path.join(fixture.root, "state-exclusive");
  const immutableSource = path.join(fixture.root, "source-immutable");
  const exclusiveSource = path.join(fixture.root, "source-exclusive");
  const immutablePath = `ledger/v1/import-bindings/events/${"e".repeat(64)}.json`;
  const exclusivePath = "results/exclusive-after-check.txt";
  cloneState(fixture.origin, immutableState);
  cloneState(fixture.origin, exclusiveState);
  fs.mkdirSync(immutableSource);
  fs.mkdirSync(exclusiveSource);
  write(path.join(immutableSource, immutablePath), '{"event":"immutable"}\n');
  write(path.join(exclusiveSource, exclusivePath), "exclusive\n");
  const marker = installExclusivePublishDuringStatePushHook(
    immutableState,
    exclusiveSource,
    exclusiveState,
  );
  const lines = captureConsoleLog(() =>
    withEnv(
      leasedPublishEnv({
        CLAWSWEEPER_STATE_DIR: immutableState,
        CLAWSWEEPER_PUBLISH_ACQUIRE_DEADLINE_MS: "5000",
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_IMMUTABLE_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
        CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "4000",
        CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
      }),
      () =>
        withCwd(immutableSource, () =>
          publishMainCommit({
            message: "chore: append immutable event after exclusive acquisition",
            paths: [immutablePath],
            coordination: "immutable",
          }),
        ),
    ),
  );

  assert.equal(fs.existsSync(marker), true);
  assert.equal(
    lines.some((line) => line.includes("Immutable publish lost state race attempt=1/128")),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${immutablePath}`], fixture.root),
    '{"event":"immutable"}\n',
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", `state:${exclusivePath}`], fixture.root),
    "exclusive\n",
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("immutable publication deadline bounds continuous rejected branch pushes", () => {
  const fixture = createStatePublishRemote("immutable-deadline");
  const state = path.join(fixture.root, "state");
  const source = path.join(fixture.root, "source");
  const publishPath =
    "ledger/v1/events/2026/07/14/openclaw-clawsweeper/review/run-deadline-review-a.jsonl";
  cloneState(fixture.origin, state);
  fs.mkdirSync(source);
  write(path.join(source, publishPath), "deadline event\n");
  installStatePushRejectHook(fixture.origin);
  const startedAt = Date.now();

  assert.throws(
    () =>
      withEnv(
        leasedPublishEnv({
          CLAWSWEEPER_STATE_DIR: state,
          CLAWSWEEPER_IMMUTABLE_PUBLISH_DEADLINE_MS: "120",
          CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "100",
        }),
        () =>
          withCwd(source, () =>
            publishMainCommit({
              message: "chore: bound immutable retries",
              paths: [publishPath],
              coordination: "immutable",
              maxAttempts: 100,
            }),
          ),
      ),
    /State publication deadline exceeded|git \S+ timed out after \d+ms during state publication/,
  );
  assert.ok(Date.now() - startedAt < 1500);
});

test("setTokenOrigin redacts tokens from command logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  run("git", ["init"], root);
  run("git", ["remote", "add", "origin", "https://github.com/openclaw/clawsweeper.git"], root);
  const lines = captureConsoleLog(() =>
    withCwd(root, () => setTokenOrigin("super-secret-token", "openclaw/clawsweeper")),
  );

  assert.equal(
    lines.some((line) => line.includes("super-secret-token")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("git remote <redacted-args>")),
    true,
  );
});

function createStatePublishRemote(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-lease-${label}-`));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  write(path.join(seed, "results/initial.txt"), "initial\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:state"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  return { root, origin };
}

function cloneState(origin, destination) {
  run("git", ["clone", origin, destination], path.dirname(destination));
  configureUser(destination);
}

function leasedPublishEnv(overrides = {}) {
  return {
    CLAWSWEEPER_PUBLISH_LEASE: "true",
    CLAWSWEEPER_PUBLISH_BRANCH: "state",
    ...overrides,
  };
}

function startPublishCli(cwd, stateDir, message, env) {
  const publishPath = path.relative(cwd, listFixtureFiles(cwd)[0]).split(path.sep).join("/");
  return spawn(
    process.execPath,
    [path.resolve("dist/repair/publish-main.js"), "--message", message, "--path", publishPath],
    {
      cwd,
      detached: true,
      env: {
        ...process.env,
        ...env,
        CLAWSWEEPER_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function startImmutablePublishProcess(cwd, stateDir, message, publishPath, env) {
  const moduleUrl = pathToFileURL(path.resolve("dist/repair/git-publish.js")).href;
  const script = `const { publishMainCommit } = await import(${JSON.stringify(moduleUrl)});
publishMainCommit({
  message: process.argv[1],
  paths: [process.argv[2]],
  coordination: "immutable",
});`;
  return spawn(process.execPath, ["--input-type=module", "--eval", script, message, publishPath], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      ...env,
      CLAWSWEEPER_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listFixtureFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? listFixtureFiles(target) : [target];
  });
}

function waitForChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function waitForChildOutput(child, ...needles) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child output: ${needles.join(" ... ")}`));
    }, 5000);
    const onData = (chunk) => {
      stdout += chunk;
      if (needles.every((needle) => stdout.includes(needle))) {
        cleanup();
        resolve(stdout);
      }
    };
    const onClose = (status) => {
      cleanup();
      reject(
        new Error(
          `child exited with status ${status} before output appeared: ${needles.join(" ... ")}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
  });
}

async function waitForRemoteRef(origin, ref) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (remoteRefExists(origin, ref)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${ref}`);
}

async function waitForRemoteRefRemoval(origin, ref) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!remoteRefExists(origin, ref)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${ref} removal`);
}

function remoteRefExists(origin, ref) {
  try {
    run("git", ["--git-dir", origin, "show-ref", "--verify", "--quiet", ref], path.dirname(origin));
    return true;
  } catch {
    return false;
  }
}

function remoteLeaseExpiryMs(origin) {
  const message = readRemoteLeaseMessage(origin);
  const expiresAt = /^expires_at: (.+)$/m.exec(message)?.[1];
  const expiresAtMs = Date.parse(expiresAt ?? "");
  assert.ok(Number.isFinite(expiresAtMs), "remote lease must have a valid expiry");
  return expiresAtMs;
}

function readRemoteLeaseMessage(origin) {
  return run(
    "git",
    ["--git-dir", origin, "show", "-s", "--format=%B", STATE_PUBLISH_LEASE_REF],
    path.dirname(origin),
  );
}

function createRemoteLease(state, { owner, issuedAt, expiresAt, ttlMs, expectedOid = "" }) {
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], state).trim();
  const parent = run("git", ["rev-parse", "HEAD"], state).trim();
  const lease = execFileSync(
    "git",
    [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      [
        "ClawSweeper state publish lease",
        "",
        `owner: ${owner}`,
        "branch: state",
        `lease_protocol: ${STATE_PUBLISH_TIMING_DEFAULTS.leaseProtocolVersion}`,
        `issued_at: ${issuedAt}`,
        `ttl_ms: ${ttlMs}`,
        `expires_at: ${expiresAt}`,
      ].join("\n"),
    ],
    {
      cwd: state,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: issuedAt,
        GIT_COMMITTER_DATE: issuedAt,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  run(
    "git",
    [
      "push",
      `--force-with-lease=${STATE_PUBLISH_LEASE_REF}:${expectedOid}`,
      "origin",
      `${lease}:${STATE_PUBLISH_LEASE_REF}`,
    ],
    state,
  );
  return lease;
}

function installVanishingLeaseGitWrapper(root) {
  const bin = path.join(root, "git-wrapper");
  const marker = path.join(root, "lease-vanished");
  const realGit = run("sh", ["-c", "command -v git"], root).trim();
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
: "\${REAL_GIT:?real git path is required}"
if test "$1" = "fetch" &&
   test "$2" = "--no-tags" &&
   test "$3" = "--quiet" &&
   test "$5" = "${STATE_PUBLISH_LEASE_REF}" &&
   test ! -f "\${VANISHING_LEASE_MARKER}"; then
  touch "\${VANISHING_LEASE_MARKER}"
  "$REAL_GIT" --git-dir="\${VANISHING_LEASE_ORIGIN}" update-ref -d "${STATE_PUBLISH_LEASE_REF}"
fi
exec "$REAL_GIT" "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return { bin, marker, realGit };
}

function installSlowLeaseObservationGitWrapper(root, seconds) {
  const bin = path.join(root, "git-wrapper-slow-lease");
  const marker = path.join(root, "slow-lease-observation");
  const realGit = run("sh", ["-c", "command -v git"], root).trim();
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
: "\${REAL_GIT:?real git path is required}"
if test "$1" = "ls-remote" &&
   test "$2" = "--refs" &&
   test "$4" = "${STATE_PUBLISH_LEASE_REF}" &&
   test ! -f "${marker}"; then
  touch "${marker}"
  sleep "${seconds}"
fi
exec "$REAL_GIT" "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return { bin, marker, realGit };
}

function installDelayedPreConvergenceGitWrapper(root, seconds) {
  const bin = path.join(root, "git-wrapper-delayed-pre-convergence");
  const delayMarker = path.join(root, "pre-convergence-delay");
  const leaseProbeMarker = path.join(root, "pre-convergence-lease-probe");
  const realGit = run("sh", ["-c", "command -v git"], root).trim();
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
: "\${REAL_GIT:?real git path is required}"
if test "$1" = "fetch" &&
   test "$2" = "origin" &&
   test "$3" = "state" &&
   test ! -f "${delayMarker}"; then
  touch "${delayMarker}"
  sleep "${seconds}"
fi
if test "$1" = "ls-remote" &&
   test "$2" = "--refs" &&
   test "$4" = "${STATE_PUBLISH_LEASE_REF}"; then
  touch "${leaseProbeMarker}"
fi
exec "$REAL_GIT" "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return { bin, delayMarker, leaseProbeMarker, realGit };
}

function installAcceptedStatePushTimeoutHook(origin, seconds) {
  const hook = path.join(origin, "hooks/post-receive");
  const marker = path.join(origin, "accepted-state-push-timeout");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r old_oid new_oid ref; do
  if test "$ref" = "refs/heads/state" && test ! -f "${marker}"; then
    touch "${marker}"
    sleep "${seconds}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
  return marker;
}

function installAcceptedLeasePushTimeoutHook(origin, seconds) {
  const hook = path.join(origin, "hooks/post-receive");
  const marker = path.join(origin, "accepted-lease-push-timeout");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r old_oid new_oid ref; do
  if test "$ref" = "${STATE_PUBLISH_LEASE_REF}" && test ! -f "${marker}"; then
    touch "${marker}"
    sleep "${seconds}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
  return marker;
}

function installUnacceptedLeasePushTimeoutHook(state, seconds) {
  const hook = path.join(state, ".git/hooks/pre-push");
  const marker = path.join(state, ".git/hooks/unaccepted-lease-push-timeout");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
if test ! -f "${marker}"; then
  while read -r local_ref local_oid remote_ref remote_oid; do
    if test "$remote_ref" = "${STATE_PUBLISH_LEASE_REF}"; then
      touch "${marker}"
      sleep "${seconds}"
    fi
  done
fi
`,
  );
  fs.chmodSync(hook, 0o755);
  return marker;
}

function installStatePushRejectHook(origin) {
  const hook = path.join(origin, "hooks/pre-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r old_oid new_oid ref; do
  if test "$ref" = "refs/heads/state"; then
    echo "rejecting state push for recovery test" >&2
    exit 1
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
  return hook;
}

function installStatePushSleepHook(state, seconds) {
  const hook = path.join(state, ".git/hooks/pre-push");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" = "refs/heads/state"; then
    sleep "${seconds}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installStatePushReleaseHook(state, releaseSignal, releaseObserved) {
  const hook = path.join(state, ".git/hooks/pre-push");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" = "refs/heads/state"; then
    attempts=0
    while test ! -f "${releaseSignal}"; do
      attempts=$((attempts + 1))
      if test "$attempts" -ge 500; then
        echo "timed out waiting for publisher release signal" >&2
        exit 1
      fi
      sleep 0.01
    done
    printf 'released\\n' > "${releaseObserved}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installExclusivePublishDuringStatePushHook(state, source, exclusiveState) {
  const hook = path.join(state, ".git/hooks/pre-push");
  const marker = path.join(state, ".git/hooks/exclusive-publish-completed");
  const publishCli = path.resolve("dist/repair/publish-main.js");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" = "refs/heads/state" && test ! -f "${marker}"; then
    (
      cd "${source}"
      CLAWSWEEPER_STATE_DIR="${exclusiveState}" \
      "${process.execPath}" "${publishCli}" \
        --message "chore: publish exclusive mutation during immutable push" \
        --path "results/exclusive-after-check.txt"
    )
    touch "${marker}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
  return marker;
}

function installLeasePushSleepHook(state, seconds) {
  const hook = path.join(state, ".git/hooks/pre-push");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" = "${STATE_PUBLISH_LEASE_REF}"; then
    sleep "${seconds}"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installStateRaceHook(state, other) {
  const hook = path.join(state, ".git/hooks/pre-push");
  const counter = path.join(state, ".git/hooks/state-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" != "refs/heads/state"; then
    continue
  fi
  count=0
  if test -f "${counter}"; then count=$(cat "${counter}"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "${counter}"
  if test "$count" -eq 1; then
    git -C "${other}" push origin HEAD:state
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installRepeatedStateRaceHook(state, other, races) {
  const hook = path.join(state, ".git/hooks/pre-push");
  const counter = path.join(state, ".git/hooks/state-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r local_ref local_oid remote_ref remote_oid; do
  if test "$remote_ref" != "refs/heads/state"; then
    continue
  fi
  count=0
  if test -f "${counter}"; then count=$(cat "${counter}"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "${counter}"
  if test "$count" -le "${races}"; then
    printf 'remote race %s\\n' "$count" > "${other}/results/remote-race-$count.txt"
    git -C "${other}" add "results/remote-race-$count.txt"
    git -C "${other}" commit -m "remote state race $count"
    git -C "${other}" push origin HEAD:state
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installStatePoisonHook(origin) {
  const hook = path.join(origin, "hooks/post-receive");
  const marker = path.join(origin, "state-poisoned");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read -r old_oid new_oid ref; do
  if test "$ref" = "refs/heads/state" && test ! -f "${marker}"; then
    touch "${marker}"
    poison=$(git --git-dir="${origin}" rev-parse refs/heads/poison)
    git --git-dir="${origin}" update-ref refs/heads/state "$poison"
  fi
done
`,
  );
  fs.chmodSync(hook, 0o755);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function withEnv(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function configureUser(cwd) {
  run("git", ["config", "core.autocrlf", "false"], cwd);
  run("git", ["config", "core.eol", "lf"], cwd);
  run("git", ["config", "user.name", "Tester"], cwd);
  run("git", ["config", "user.email", "tester@example.com"], cwd);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRecordTuple(
  root,
  {
    number,
    marker,
    reviewedAt,
    itemUpdatedAt,
    location = "items",
    packet = true,
    plan = true,
    recordFile = `${number}.md`,
    planFile = recordFile,
    extraFrontMatter = [],
  },
) {
  const recordRoot = path.join(root, "records/openclaw-openclaw");
  const itemPath = path.join(recordRoot, "items", recordFile);
  const closedPath = path.join(recordRoot, "closed", recordFile);
  const planPath = path.join(recordRoot, "plans", planFile);
  const packetPath = path.join(recordRoot, "decision-packets", `${number}.json`);
  const packetContent = packet
    ? `${JSON.stringify(
        {
          version: 1,
          generatedAt: reviewedAt,
          updatedAt: itemUpdatedAt,
          subject: { repo: "openclaw/openclaw", number },
          source: {
            reportPath: `records/openclaw-openclaw/${location}/${recordFile}`,
            reviewedAt,
          },
          marker,
        },
        null,
        2,
      )}\n`
    : null;
  const digest = packetContent ? createHash("sha256").update(packetContent).digest("hex") : "none";
  const pointer = packetContent
    ? `records/openclaw-openclaw/decision-packets/${number}.json`
    : "none";
  const primary = [
    "---",
    `decision_packet_sha256: ${digest}`,
    `decision_packet_path: ${pointer}`,
    `number: ${number}`,
    "repository: openclaw/openclaw",
    `item_updated_at: ${itemUpdatedAt}`,
    `reviewed_at: ${reviewedAt}`,
    ...extraFrontMatter,
    "---",
    "",
    `# ${marker}`,
    "",
  ].join("\n");
  const planContent = plan
    ? [
        "---",
        `number: ${number}`,
        "repository: openclaw/openclaw",
        `reviewed_at: ${reviewedAt}`,
        "---",
        "",
        `# Plan ${marker}`,
        "",
      ].join("\n")
    : null;

  fs.rmSync(location === "items" ? closedPath : itemPath, { force: true });
  write(location === "items" ? itemPath : closedPath, primary);
  if (planContent) write(planPath, planContent);
  else fs.rmSync(planPath, { force: true });
  if (packetContent) write(packetPath, packetContent);
  else fs.rmSync(packetPath, { force: true });
  return { primary, plan: planContent, packet: packetContent };
}

function readOriginJson(origin, revision, cwd) {
  return JSON.parse(run("git", ["--git-dir", origin, "show", revision], cwd));
}

function sweepStatus(updatedAt, state, applyHealth, lastCloseApplyHealth) {
  return {
    schema_version: 1,
    slug: "openclaw-openclaw",
    display_name: "OpenClaw",
    target_repo: "openclaw/openclaw",
    state,
    detail: `${state} detail`,
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
    apply_health: applyHealth,
    last_close_apply_health: lastCloseApplyHealth,
    updated_at: updatedAt,
  };
}

function sweepHealth(generatedAt, mode, processed) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    target_repo: "openclaw/openclaw",
    mode,
    processed,
  };
}

function installSecondPushRaceHook(work, other) {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "${counter}"
if test "$count" -eq 2; then git -C "${other}" push origin HEAD:main; fi
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installFirstPushRaceHook(work, other, branch = "main") {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "${counter}"
if test "$count" -eq 1; then git -C "${other}" push origin HEAD:${branch}; fi
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installCheckpointFailureHook(work, other, branch) {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "${counter}"
if test "$count" -eq 1; then git -C "${other}" push origin HEAD:${branch}; fi
case "$count" in
  3|4|6|7|8|9) exit 1 ;;
esac
`,
  );
  fs.chmodSync(hook, 0o755);
}

function captureConsoleLog(callback, lines = []) {
  const original = console.log;
  console.log = (message) => {
    lines.push(String(message));
  };
  try {
    callback();
    return lines;
  } finally {
    console.log = original;
  }
}

function captureProcessWrites(callback) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return callback();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}
