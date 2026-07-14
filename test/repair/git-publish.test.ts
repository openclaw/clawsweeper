import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";

import {
  captureStatePublishBaseline,
  commitMessageForPublishedPaths,
  hardResetToRemoteMain,
  publishMainCommit,
  refreshSourceAfterStatePublish,
  setTokenOrigin,
  stagePaths,
  uniqueNonEmpty,
} from "../../dist/repair/git-publish.js";

for (const key of [
  "CLAWSWEEPER_STATE_DIR",
  "CLAWSWEEPER_PUBLISH_ROOT",
  "CLAWSWEEPER_PUBLISH_BRANCH",
  "CLAWSWEEPER_PUBLISH_LEASE",
  "CLAWSWEEPER_PUBLISH_DEADLINE_MS",
  "CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS",
  "CLAWSWEEPER_PUBLISH_LEASE_TTL_MS",
  "CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS",
  "CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS",
  "CLAWSWEEPER_PUBLISH_STALE_RECOVERY_ATTEMPTS",
]) {
  delete process.env[key];
}
process.env.CLAWSWEEPER_PUBLISH_LEASE = "false";

const STATE_PUBLISH_LEASE_REF = "refs/heads/clawsweeper-publish-lease/state";

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
    CLAWSWEEPER_PUBLISH_DEADLINE_MS: "5000",
    CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "2000",
    CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "3000",
    CLAWSWEEPER_PUBLISH_LEASE_ATTEMPTS: "80",
    CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
  });
  const first = startPublishCli(firstSource, firstState, "chore: publish first", env);
  const firstResult = waitForChild(first);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  const second = startPublishCli(secondSource, secondState, "chore: publish second", env);
  const [firstCompleted, secondCompleted] = await Promise.all([firstResult, waitForChild(second)]);

  assert.equal(firstCompleted.status, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.status, 0, secondCompleted.stderr);
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
    const processCount = Number(/Git publish metrics:.*processes=(\d+)/.exec(output)?.[1]);
    assert.ok(
      Number.isInteger(processCount) && processCount <= 40,
      `leased concurrent publish used ${processCount} git subprocesses`,
    );
  }
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
    expiresAt: "2026-01-01T00:00:00.000Z",
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

  const crashed = startPublishCli(
    crashedSource,
    crashedState,
    "chore: crash while publishing",
    leasedPublishEnv({
      CLAWSWEEPER_PUBLISH_DEADLINE_MS: "60000",
      CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "60000",
      CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "100",
      CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
    }),
  );
  const crashedResult = waitForChild(crashed);
  await waitForRemoteRef(fixture.origin, STATE_PUBLISH_LEASE_REF);
  process.kill(-crashed.pid, "SIGKILL");
  const crashedCompleted = await crashedResult;
  assert.equal(crashedCompleted.signal, "SIGKILL");
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
  await delay(160);

  const recovered = await waitForChild(
    startPublishCli(
      recoveredSource,
      recoveredState,
      "chore: recover crashed publisher",
      leasedPublishEnv({
        CLAWSWEEPER_PUBLISH_DEADLINE_MS: "3000",
        CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "1000",
        CLAWSWEEPER_PUBLISH_LEASE_TTL_MS: "1000",
        CLAWSWEEPER_PUBLISH_LEASE_WAIT_MS: "10",
      }),
    ),
  );
  assert.equal(recovered.status, 0, recovered.stderr);
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
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
  assert.ok(Date.now() - startedAt < 1000);
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 12,
    `deadline path used ${processCount} git subprocesses`,
  );
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), true);
});

test("state publisher times out an individual blocked git command", () => {
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
          CLAWSWEEPER_PUBLISH_DEADLINE_MS: "2000",
          CLAWSWEEPER_PUBLISH_COMMAND_TIMEOUT_MS: "50",
        }),
        () =>
          withCwd(source, () =>
            publishMainCommit({
              message: "chore: hit command timeout",
              paths: ["results/timeout.txt"],
            }),
          ),
      ),
    /timed out after 50ms/,
  );
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(remoteRefExists(fixture.origin, STATE_PUBLISH_LEASE_REF), false);
});

test("leased publisher performs only one rebuild after an unexpected state race", () => {
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
  assert.equal(lines.filter((line) => line.includes("rebuilding once")).length, 1);
});

test("leased publisher rejects a successful push whose remote blobs changed", () => {
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

  assert.throws(
    () =>
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
    /expected-blob verification/,
  );
  assert.equal(
    run("git", ["--git-dir", fixture.origin, "show", "state:results/verified.txt"], fixture.root),
    "poison\n",
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

test("publishMainCommit refreshes merged health before the next state-root status publish", () => {
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
  const results = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
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

test("publishMainCommit refreshes published source paths after a state rebase", () => {
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
  const results = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
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

async function waitForRemoteRef(origin, ref) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (remoteRefExists(origin, ref)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${ref}`);
}

function remoteRefExists(origin, ref) {
  try {
    run("git", ["--git-dir", origin, "show-ref", "--verify", "--quiet", ref], path.dirname(origin));
    return true;
  } catch {
    return false;
  }
}

function createRemoteLease(state, { owner, expiresAt }) {
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], state).trim();
  const parent = run("git", ["rev-parse", "HEAD"], state).trim();
  const lease = run(
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
        `expires_at: ${expiresAt}`,
      ].join("\n"),
    ],
    state,
  ).trim();
  run(
    "git",
    [
      "push",
      `--force-with-lease=${STATE_PUBLISH_LEASE_REF}:`,
      "origin",
      `${lease}:${STATE_PUBLISH_LEASE_REF}`,
    ],
    state,
  );
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
