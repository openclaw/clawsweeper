import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  captureStatePublishBaseline,
  commitMessageForPublishedPaths,
  GitCommandTimeoutError,
  hardResetToRemoteMain,
  publishMainCommit,
  pushSingleRecordTupleCommit,
  refreshSourceAfterStatePublish,
  runGit,
  setTokenOrigin,
  spawnGit,
  stagePaths,
  uniqueNonEmpty,
} from "../../dist/repair/git-publish.js";

for (const key of [
  "CLAWSWEEPER_STATE_DIR",
  "CLAWSWEEPER_PUBLISH_ROOT",
  "CLAWSWEEPER_PUBLISH_BRANCH",
  "CLAWSWEEPER_STATE_REPOSITORY",
]) {
  delete process.env[key];
}

test("uniqueNonEmpty trims, drops blanks, and deduplicates paths", () => {
  assert.deepEqual(uniqueNonEmpty([" jobs ", "", "results", "jobs", "results "]), [
    "jobs",
    "results",
  ]);
});

test("runGit reports a stalled fetch transport timeout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-git-timeout-"));
  run("git", ["init"], root);
  // The ext transport stalls during fetch protocol negotiation without depending on
  // GitHub or wall-clock races, matching the production failure before any tuple work.
  const stalledFetch = ["fetch", "ext::node -e setTimeout(()=>{},5000)", "main"];
  const result = withEnv({ GIT_ALLOW_PROTOCOL: "ext" }, () =>
    withCwd(root, () => spawnGit(stalledFetch, { quiet: true, timeout: 100 })),
  );

  assert.equal(result.timedOut, true);
  assert.throws(
    () =>
      withEnv({ GIT_ALLOW_PROTOCOL: "ext" }, () =>
        withCwd(root, () =>
          runGit(stalledFetch, { allowFailure: true, quiet: true, timeout: 100 }),
        ),
      ),
    GitCommandTimeoutError,
  );
  assert.equal(
    new GitCommandTimeoutError(["fetch"], 60_000).message,
    "git fetch timed out after 60000ms",
  );
});

test("publisher reset applies the production fetch timeout before touching state", () => {
  const script = String.raw`
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";

    const calls = [];
    childProcess.spawnSync = (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout ?? null });
      const stdout = args[0] === "rev-parse" ? "true\n" : "";
      return { status: 0, stdout, stderr: "" };
    };
    syncBuiltinESMExports();
    console.log = () => {};

    const { hardResetToRemoteMain } = await import("./dist/repair/git-publish.js");
    hardResetToRemoteMain("origin", "state");
    process.stdout.write(JSON.stringify(calls));
  `;

  assert.deepEqual(JSON.parse(run("node", ["--input-type=module", "-e", script], process.cwd())), [
    {
      command: "git",
      args: ["rev-parse", "--is-shallow-repository"],
      timeout: null,
    },
    {
      command: "git",
      args: ["fetch", "--depth=1", "origin", "state"],
      timeout: 60_000,
    },
    {
      command: "git",
      args: ["reset", "--hard", "origin/state"],
      timeout: null,
    },
  ]);
});

test("publisher fetches share the bounded fetch helper", () => {
  const source = fs.readFileSync(path.resolve("src/repair/git-publish.ts"), "utf8");

  assert.match(source, /const PUBLISH_FETCH_TIMEOUT_MS = 60_000/);
  assert.match(
    source,
    /function fetchPublishRemote\([\s\S]*const shallow = isShallowRepository\(\)[\s\S]*runGit\(\["fetch", \.\.\.depthArgs, remote, branch\], \{/,
  );
  assert.equal(source.match(/runGit\(\["fetch"/g)?.length, 1);
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

test("publishMainCommit survives a shallow-checkout push race without a common Git base", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  write(path.join(seed, "results/spam-scanner.json"), '{"scans":0}\n');
  write(path.join(seed, "results/other.txt"), "remote\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial"], seed);
  run("git", ["push", "origin", "HEAD:main"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);

  // Production state checkouts are shallow, so the racing writer's commits
  // arrive through a --depth=1 fetch that shares no ancestry with local HEAD.
  run("git", ["clone", "--depth", "1", `file://${origin}`, work], root);
  configureUser(work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "results/other.txt"), "remote update one\n");
  run("git", ["commit", "-am", "remote update one"], other);
  write(path.join(other, "results/other.txt"), "remote update two\n");
  run("git", ["commit", "-am", "remote update two"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  write(path.join(work, "results/spam-scanner.json"), '{"scans":1}\n');
  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: record ClawSweeper spam scan",
      paths: ["results/spam-scanner.json"],
      maxAttempts: 1,
      pushAttempts: 1,
      rebaseStrategy: "theirs",
    }),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/spam-scanner.json"], root),
    '{"scans":1}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:results/other.txt"], root),
    "remote update two\n",
  );
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

test("reconcile-records preserves a newer remote tuple after resetting unrelated state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-unrelated-"));
  const origin = path.join(root, "origin.git");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, state], root);
  configureUser(state);
  const remoteTuple = writeRecordTuple(state, {
    number: 42,
    marker: "newer remote tuple",
    reviewedAt: "2026-07-09T23:03:00.000Z",
    itemUpdatedAt: "2026-07-09T23:02:00Z",
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
  let result;
  captureConsoleLog(() => {
    result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: publish from unrelated state",
          paths: [recordsRoot],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    );
  }, lines);

  assert.equal(result, "unchanged");
  assert.equal(
    lines.some((line) =>
      line.includes(
        "No common Git base with origin/state; resetting the unpublished reconciliation checkpoint to the remote head",
      ),
    ),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/42.md`], root),
    remoteTuple.primary,
  );
  assert.throws(() => run("git", ["--git-dir", origin, "show", "state:unrelated.txt"], root));
});

test("reconcile-records resets shallow state to a truly unrelated remote head", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-shallow-unrelated-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  writeRecordTuple(seed, {
    number: 42,
    marker: "remote base",
    reviewedAt: "2026-07-19T23:00:00.000Z",
    itemUpdatedAt: "2026-07-19T22:59:00Z",
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:state"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, state], root);
  configureUser(state);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  const candidateTuple = writeRecordTuple(work, {
    number: 42,
    marker: "candidate update",
    reviewedAt: "2026-07-19T23:02:00.000Z",
    itemUpdatedAt: "2026-07-19T23:01:00Z",
  });

  run("git", ["checkout", "--orphan", "replacement"], seed);
  run("git", ["read-tree", "--empty"], seed);
  fs.rmSync(path.join(seed, "records"), { force: true, recursive: true });
  write(path.join(seed, "replacement.txt"), "replacement history\n");
  run("git", ["add", "-A"], seed);
  run("git", ["commit", "-m", "replace state history"], seed);
  run("git", ["push", "--force", "origin", "HEAD:state"], seed);

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: publish from unrelated shallow state",
          paths: [recordsRoot],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    lines.some((line) =>
      line.includes(
        "No common Git base with origin/state; resetting the unpublished reconciliation checkpoint to the remote head",
      ),
    ),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:replacement.txt"], root),
    "replacement history\n",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/42.md`], root),
    candidateTuple.primary,
  );
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], state).trim(), "false");
});

test("reconcile-records prepares a shallow state checkout from the remote head", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-shallow-prepare-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  writeRecordTuple(seed, {
    number: 42,
    marker: "remote base",
    reviewedAt: "2026-07-19T23:00:00.000Z",
    itemUpdatedAt: "2026-07-19T22:59:00Z",
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:state"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, state], root);
  configureUser(state);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "remote.txt"), "remote update one\n");
  const remoteTuple = writeRecordTuple(other, {
    number: 42,
    marker: "remote winner",
    reviewedAt: "2026-07-19T23:05:00.000Z",
    itemUpdatedAt: "2026-07-19T23:04:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote update one"], other);
  write(path.join(other, "remote.txt"), "remote update two\n");
  run("git", ["commit", "-am", "remote update two"], other);
  run("git", ["push", "origin", "HEAD:state"], other);

  fs.mkdirSync(work);
  fs.cpSync(path.join(state, "records"), path.join(work, "records"), { recursive: true });
  writeRecordTuple(work, {
    number: 42,
    marker: "candidate close",
    reviewedAt: "2026-07-19T23:03:00.000Z",
    itemUpdatedAt: "2026-07-19T23:02:00Z",
    location: "closed",
    packet: false,
    plan: false,
  });
  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withEnv({ CLAWSWEEPER_STATE_DIR: state }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: prepare shallow state",
          paths: [recordsRoot],
          maxAttempts: 1,
          pushAttempts: 1,
          rebaseStrategy: "reconcile-records",
        }),
      ),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    lines.some((line) =>
      line.includes(
        "Recovered the common Git base with origin/state after hydrating the shallow state checkout",
      ),
    ),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/42.md`], root),
    remoteTuple.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/closed/42.md`], root),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "state:remote.txt"], root),
    "remote update two\n",
  );
});

test("reconcile-records rebuilds on a shallow remote head without local ancestry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-shallow-reconcile-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  writeRecordTuple(seed, {
    number: 42,
    marker: "local base",
    reviewedAt: "2026-07-19T23:00:00.000Z",
    itemUpdatedAt: "2026-07-19T22:59:00Z",
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:main"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, work], root);
  configureUser(work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  const remoteTuple = writeRecordTuple(other, {
    number: 43,
    marker: "remote update one",
    reviewedAt: "2026-07-19T23:01:00.000Z",
    itemUpdatedAt: "2026-07-19T23:00:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote update one"], other);
  write(path.join(other, "remote.txt"), "remote update two\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote update two"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  const localTuple = writeRecordTuple(work, {
    number: 42,
    marker: "local close",
    reviewedAt: "2026-07-19T23:03:00.000Z",
    itemUpdatedAt: "2026-07-19T23:02:00Z",
    location: "closed",
    packet: false,
    plan: false,
  });
  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: reconcile shallow state",
        paths: [recordsRoot],
        maxAttempts: 1,
        pushAttempts: 2,
        rebaseStrategy: "reconcile-records",
      }),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    lines.some((line) => line.includes("deferring overlap detection to a remote-head rebuild")),
    true,
  );
  assert.equal(
    lines.some(
      (line) => line === "Rebuilding reconciliation directly on origin/main after a shallow fetch",
    ),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/closed/42.md`], root),
    localTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/43.md`], root),
    remoteTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:remote.txt"], root),
    "remote update two\n",
  );
});

test("single-record publisher rebuilds a shallow losing writer without hydrating history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-single-record-race-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const publisher = path.join(root, "publisher");
  const other = path.join(root, "other");
  const fakeBin = path.join(root, "bin");
  const recordsRoot = "records/openclaw-openclaw";
  const publisherPaths = [
    `${recordsRoot}/items/42.md`,
    `${recordsRoot}/closed/42.md`,
    `${recordsRoot}/plans/42.md`,
    `${recordsRoot}/decision-packets/42.json`,
  ];
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  writeRecordTuple(seed, {
    number: 42,
    marker: "shared base",
    reviewedAt: "2026-07-20T11:00:00.000Z",
    itemUpdatedAt: "2026-07-20T10:59:00Z",
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:state"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, publisher], root);
  configureUser(publisher);
  run("git", ["clone", origin, other], root);
  configureUser(other);

  const localTuple = writeRecordTuple(publisher, {
    number: 42,
    marker: "publisher update",
    reviewedAt: "2026-07-20T11:02:00.000Z",
    itemUpdatedAt: "2026-07-20T11:01:00Z",
  });
  run("git", ["add", "."], publisher);
  run("git", ["commit", "-m", "publisher update"], publisher);

  const remoteTuple = writeRecordTuple(other, {
    number: 43,
    marker: "concurrent remote update",
    reviewedAt: "2026-07-20T11:03:00.000Z",
    itemUpdatedAt: "2026-07-20T11:02:00Z",
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent remote update"], other);
  run("git", ["push", "origin", "HEAD:state"], other);
  installDeepenFetchFailureShim(fakeBin);

  const lines = [];
  let published;
  captureConsoleLog(() => {
    published = withEnv({ PATH: `${fakeBin}:${process.env.PATH}` }, () =>
      withCwd(publisher, () =>
        pushSingleRecordTupleCommit({
          paths: publisherPaths,
          branch: "state",
          pushAttempts: 2,
        }),
      ),
    );
  }, lines);

  assert.equal(published, true);
  assert.equal(
    lines.some(
      (line) =>
        line ===
        "No common Git base with origin/state; rebuilding reconciliation on the remote head",
    ),
    true,
  );
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], publisher).trim(), "true");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/42.md`], root),
    localTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/43.md`], root),
    remoteTuple.primary,
  );
});

test("checkpoint publish rebuilds on the remote head when histories are unrelated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-checkpoint-unrelated-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const recordsRoot = "records/openclaw-openclaw";
  const numbers = Array.from({ length: 129 }, (_, index) => 120_000 + index);
  const overlapNumber = numbers[0];
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  for (const number of numbers) {
    writeRecordTuple(work, {
      number,
      marker: `base ${number}`,
      reviewedAt: "2026-07-20T06:00:00.000Z",
      itemUpdatedAt: "2026-07-20T05:59:00Z",
      packet: false,
      plan: false,
    });
  }
  write(path.join(work, "old-history-only.txt"), "must not be resurrected\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial state"], work);
  run("git", ["push", "origin", "HEAD:state"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/state"], root);
  run("git", ["checkout", "-B", "state", "origin/state"], work);
  for (const number of numbers) {
    writeRecordTuple(work, {
      number,
      marker: `closed ${number}`,
      reviewedAt: "2026-07-20T06:02:00.000Z",
      itemUpdatedAt: "2026-07-20T06:01:00Z",
      location: "closed",
      packet: false,
      plan: false,
    });
  }

  run("git", ["clone", origin, other], root);
  configureUser(other);
  run("git", ["checkout", "--orphan", "replacement"], other);
  run("git", ["read-tree", "--empty"], other);
  fs.rmSync(path.join(other, "records"), { force: true, recursive: true });
  fs.rmSync(path.join(other, "old-history-only.txt"));
  let remoteOverlapTuple;
  for (const number of numbers) {
    const tuple = writeRecordTuple(other, {
      number,
      marker: number === overlapNumber ? `newer remote ${number}` : `base ${number}`,
      reviewedAt:
        number === overlapNumber ? "2026-07-20T06:04:00.000Z" : "2026-07-20T06:00:00.000Z",
      itemUpdatedAt: number === overlapNumber ? "2026-07-20T06:03:00Z" : "2026-07-20T05:59:00Z",
      packet: false,
      plan: false,
    });
    if (number === overlapNumber) remoteOverlapTuple = tuple;
  }
  const remoteTuple = writeRecordTuple(other, {
    number: 130_000,
    marker: "replacement-history remote tuple",
    reviewedAt: "2026-07-20T06:03:00.000Z",
    itemUpdatedAt: "2026-07-20T06:02:00Z",
    packet: false,
    plan: false,
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "replacement state history"], other);
  run("git", ["push", "--force", "origin", "HEAD:state"], other);

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: publish checkpoint records",
        paths: [recordsRoot],
        branch: "state",
        maxAttempts: 1,
        pushAttempts: 2,
        rebaseStrategy: "reconcile-records",
      }),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    lines.some(
      (line) =>
        line ===
        "No common Git base with origin/state; rebuilding reconciliation on the remote head",
    ),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/closed/${numbers[1]}.md`],
      root,
    ).includes(`# closed ${numbers[1]}`),
    true,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", `state:${recordsRoot}/items/${overlapNumber}.md`],
      root,
    ),
    remoteOverlapTuple.primary,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `state:${recordsRoot}/items/130000.md`], root),
    remoteTuple.primary,
  );
  assert.throws(() =>
    run("git", ["--git-dir", origin, "show", "state:old-history-only.txt"], root),
  );
});

test("reconcile-records keeps non-1 merge-base failures fatal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-merge-base-error-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const fakeBin = path.join(root, "bin");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeRecordTuple(work, {
    number: 42,
    marker: "local base",
    reviewedAt: "2026-07-20T06:00:00.000Z",
    itemUpdatedAt: "2026-07-20T05:59:00Z",
    packet: false,
    plan: false,
  });
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial state"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  writeRecordTuple(work, {
    number: 42,
    marker: "local close",
    reviewedAt: "2026-07-20T06:02:00.000Z",
    itemUpdatedAt: "2026-07-20T06:01:00Z",
    location: "closed",
    packet: false,
    plan: false,
  });

  run("git", ["clone", origin, other], root);
  configureUser(other);
  run("git", ["checkout", "--orphan", "replacement"], other);
  run("git", ["read-tree", "--empty"], other);
  fs.rmSync(path.join(other, "records"), { force: true, recursive: true });
  const remoteTuple = writeRecordTuple(other, {
    number: 43,
    marker: "replacement remote tuple",
    reviewedAt: "2026-07-20T06:03:00.000Z",
    itemUpdatedAt: "2026-07-20T06:02:00Z",
    packet: false,
    plan: false,
  });
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "replacement state history"], other);
  run("git", ["push", "--force", "origin", "HEAD:main"], other);
  installSecondMergeBaseFailureShim(fakeBin, work);

  const lines = [];
  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withEnv({ PATH: `${fakeBin}:${process.env.PATH}` }, () =>
            withCwd(work, () =>
              publishMainCommit({
                message: "chore: reject broken merge-base",
                paths: [recordsRoot],
                maxAttempts: 1,
                pushAttempts: 2,
                rebaseStrategy: "reconcile-records",
              }),
            ),
          ),
        lines,
      ),
    /fatal: synthetic merge-base failure/,
  );
  assert.equal(
    lines.some((line) => line.includes("Git publish failure: phase=push")),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/43.md`], root),
    remoteTuple.primary,
  );
});

test("reconcile-records keeps shallow hydration failures fatal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-shallow-hydration-error-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  const fakeBin = path.join(root, "bin");
  const recordsRoot = "records/openclaw-openclaw";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  writeRecordTuple(seed, {
    number: 42,
    marker: "local base",
    reviewedAt: "2026-07-20T06:00:00.000Z",
    itemUpdatedAt: "2026-07-20T05:59:00Z",
    packet: false,
    plan: false,
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial state"], seed);
  run("git", ["push", "origin", "HEAD:main"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, work], root);
  configureUser(work);
  writeRecordTuple(work, {
    number: 42,
    marker: "local close",
    reviewedAt: "2026-07-20T06:02:00.000Z",
    itemUpdatedAt: "2026-07-20T06:01:00Z",
    location: "closed",
    packet: false,
    plan: false,
  });

  run("git", ["checkout", "--orphan", "replacement"], seed);
  run("git", ["read-tree", "--empty"], seed);
  fs.rmSync(path.join(seed, "records"), { force: true, recursive: true });
  const remoteTuple = writeRecordTuple(seed, {
    number: 43,
    marker: "replacement remote tuple",
    reviewedAt: "2026-07-20T06:03:00.000Z",
    itemUpdatedAt: "2026-07-20T06:02:00Z",
    packet: false,
    plan: false,
  });
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "replacement state history"], seed);
  run("git", ["push", "--force", "origin", "HEAD:main"], seed);
  installDeepenFetchFailureShim(fakeBin);

  const lines = [];
  assert.throws(
    () =>
      captureConsoleLog(
        () =>
          withEnv({ PATH: `${fakeBin}:${process.env.PATH}` }, () =>
            withCwd(work, () =>
              publishMainCommit({
                message: "chore: reject failed shallow hydration",
                paths: [recordsRoot],
                maxAttempts: 1,
                pushAttempts: 2,
                rebaseStrategy: "reconcile-records",
              }),
            ),
          ),
        lines,
      ),
    /fatal: synthetic deepen failure/,
  );
  assert.equal(
    lines.some((line) => line.includes("Git publish failure: phase=push")),
    true,
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${recordsRoot}/items/43.md`], root),
    remoteTuple.primary,
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

test("publishMainCommit rebuilds immutable ledger batches within the router process budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const ledgerPaths = Array.from(
    { length: 257 },
    (_, index) => `ledger/v1/import-bindings/events/${index.toString(16).padStart(64, "0")}.json`,
  );
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "keep.txt"), "base\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "remote.txt"), "concurrent\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent state update"], other);
  for (const ledgerPath of ledgerPaths) {
    write(path.join(work, ledgerPath), `{"path":"${ledgerPath}"}\n`);
  }
  installFirstTwoPushRaceHook(work, other);

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: append command action ledger",
        paths: ledgerPaths,
        maxAttempts: 1,
        pushAttempts: 1,
      }),
    );
  }, lines);

  assert.equal(result, "committed");
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  assert.ok(metrics, "ledger race publish emits metrics");
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 50,
    `ledger race rebuild used ${processCount} git subprocesses; expected at most 50`,
  );
  for (const ledgerPath of ledgerPaths) {
    assert.equal(
      run("git", ["--git-dir", origin, "show", `main:${ledgerPath}`], root),
      `{"path":"${ledgerPath}"}\n`,
    );
  }
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:remote.txt"], root),
    "concurrent\nsecond race\n",
  );
});

test("publishMainCommit converges after production-sized immutable ledger races", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const ledgerPaths = Array.from(
    { length: 25 },
    (_, index) => `ledger/v1/import-bindings/events/${index.toString(16).padStart(64, "0")}.json`,
  );
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "keep.txt"), "base\n");
  for (let index = 0; index < 1024; index += 1) {
    write(path.join(work, `unrelated/${index.toString().padStart(4, "0")}.txt`), "base\n");
  }
  write(path.join(work, "scratch/dirty.txt"), "base\n");
  write(path.join(work, ".gitignore"), "ignored/\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  for (const ledgerPath of ledgerPaths) {
    write(path.join(work, ledgerPath), `{"path":"${ledgerPath}"}\n`);
  }
  write(path.join(work, "unrelated/0000.txt"), "local scratch remains\n");
  write(path.join(work, "scratch/dirty.txt"), "nested local scratch remains\n");
  write(path.join(work, "ignored/secret.txt"), "ignored local scratch remains\n");
  installPushRaceHook(work, other, 20);

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withCwd(work, () =>
      publishMainCommit({
        message: "chore: append command action ledger",
        paths: ledgerPaths,
        maxAttempts: 8,
        pushAttempts: 3,
      }),
    );
  }, lines);

  assert.equal(result, "committed");
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  assert.ok(metrics, "sustained ledger race publish emits metrics");
  const processCount = Number(/processes=(\d+)/.exec(metrics)?.[1]);
  assert.ok(
    Number.isInteger(processCount) && processCount <= 280,
    `sustained ledger races used ${processCount} git subprocesses; expected at most 280`,
  );
  assert.match(metrics, /actions=.*push:21(?:,|$)/, "the publish survives twenty lost pushes");
  assert.doesNotMatch(metrics, /actions=.*rebase:/, "immutable ledger retries never nest rebases");
  assert.doesNotMatch(
    metrics,
    /actions=.*reset:/,
    "immutable ledger retries never reset the worktree",
  );
  assert.match(
    metrics,
    /actions=.*read-tree:1(?:,|$)/,
    "the full index refresh happens only after push",
  );
  assert.match(metrics, /actions=.*restore:1(?:,|$)/, "worktree paths refresh only after push");
  assert.equal(
    fs.readFileSync(path.join(work, "unrelated/0000.txt"), "utf8"),
    "local scratch remains\n",
  );
  assert.equal(
    fs.readFileSync(path.join(work, "scratch/dirty.txt"), "utf8"),
    "nested local scratch remains\n",
    "a remote directory-to-file transition preserves a dirty descendant",
  );
  assert.equal(
    fs.readFileSync(path.join(work, "ignored/secret.txt"), "utf8"),
    "ignored local scratch remains\n",
    "a remote directory-to-file transition preserves an ignored descendant",
  );
  assert.equal(
    fs.readFileSync(path.join(work, "remote.txt"), "utf8"),
    Array.from({ length: 20 }, (_, index) => `race ${index + 1}\n`).join(""),
    "clean worktree paths follow every fetched remote parent",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:remote.txt"], root),
    Array.from({ length: 20 }, (_, index) => `race ${index + 1}\n`).join(""),
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:unrelated/0000.txt"], root),
    "remote scratch 20\n",
    "the rebuilt commit keeps the remote version of a locally dirty path",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:scratch"], root),
    "remote parent 20\n",
    "the rebuilt commit keeps a remote file that replaced a dirty local directory",
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:ignored"], root),
    "remote ignored parent 20\n",
    "the rebuilt commit keeps a remote file that replaced an ignored local directory",
  );
  for (const ledgerPath of ledgerPaths) {
    assert.equal(
      run("git", ["--git-dir", origin, "show", `main:${ledgerPath}`], root),
      `{"path":"${ledgerPath}"}\n`,
    );
  }
});

test("publishMainCommit rebuilds with unavailable unchanged remote ledger objects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-missing-object-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const fakeBin = path.join(root, "bin");
  const localPath =
    "ledger/v1/import-bindings/events/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json";
  const remotePaths = [
    "ledger/v1/import-bindings/events/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    "ledger/v1/import-bindings/events/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
  ];
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, seed], root);
  configureUser(seed);
  write(path.join(seed, "base.txt"), "base\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "initial"], seed);
  run("git", ["push", "origin", "HEAD:main"], seed);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["clone", "--depth", "1", `file://${origin}`, work], root);
  configureUser(work);
  run("git", ["config", "fetch.unpackLimit", "9999"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  for (const [index, remotePath] of remotePaths.entries()) {
    write(path.join(other, remotePath), `{"remote":${index + 1}}\n`);
  }
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "concurrent ledger event"], other);
  const missingObjects = remotePaths.map((remotePath) =>
    run("git", ["rev-parse", `HEAD:${remotePath}`], other).trim(),
  );
  installFirstPushRaceHook(work, other);
  installMissingObjectFetchShim(fakeBin, work, missingObjects);
  write(path.join(work, localPath), '{"local":true}\n');

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withEnv({ PATH: `${fakeBin}:${process.env.PATH}` }, () =>
      withCwd(work, () =>
        publishMainCommit({
          message: "chore: append command action ledger",
          paths: [localPath],
          maxAttempts: 1,
          pushAttempts: 1,
        }),
      ),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    lines.some((line) => line === "Recovering 1 unavailable Git object(s) from origin"),
    false,
  );
  assert.equal(fs.existsSync(path.join(work, ".git", "missing-object-removed")), true);
  for (const [index, remotePath] of remotePaths.entries()) {
    assert.throws(() => run("git", ["cat-file", "-e", missingObjects[index]], work));
    assert.equal(
      run("git", ["--git-dir", origin, "show", `main:${remotePath}`], root),
      `{"remote":${index + 1}}\n`,
    );
  }
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${localPath}`], root),
    '{"local":true}\n',
  );
});

test("publishMainCommit fails closed when a written ledger object is unavailable locally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-missing-written-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const fakeBin = path.join(root, "bin");
  const localPath =
    "ledger/v1/import-bindings/events/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "remote.txt"), "base\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "remote.txt"), "concurrent\n");
  run("git", ["add", "remote.txt"], other);
  run("git", ["commit", "-m", "concurrent state update"], other);
  installFirstPushRaceHook(work, other);
  installMissingWrittenObjectFetchShim(fakeBin, work, localPath);
  write(path.join(work, localPath), '{"local":true}\n');

  assert.throws(
    () =>
      withEnv({ PATH: `${fakeBin}:${process.env.PATH}` }, () =>
        withCwd(work, () =>
          publishMainCommit({
            message: "chore: append command action ledger",
            paths: [localPath],
            maxAttempts: 1,
            pushAttempts: 1,
          }),
        ),
      ),
    /Immutable action-ledger source object is unavailable locally/,
  );
  assert.equal(run("git", ["--git-dir", origin, "show", "main:remote.txt"], root), "concurrent\n");
  assert.throws(() => run("git", ["--git-dir", origin, "show", `main:${localPath}`], root));
});

test("publishMainCommit escapes sustained immutable ledger races through a server merge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-server-merge-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const fakeBin = path.join(root, "bin");
  const ledgerPath =
    "ledger/v1/import-bindings/events/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "remote.txt"), "base\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);
  installCheckoutHeader(work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(work, ledgerPath), '{"local":true}\n');
  installSimplePushRaceHook(work, other, 65);
  installFakeGitHubMerge(fakeBin, origin);

  const lines = [];
  let result;
  captureConsoleLog(() => {
    result = withEnv(
      {
        CLAWSWEEPER_STATE_REPOSITORY: "openclaw/clawsweeper-state",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      () =>
        withCwd(work, () =>
          publishMainCommit({
            message: "chore: append command action ledger",
            paths: [ledgerPath],
            maxAttempts: 8,
            pushAttempts: 3,
          }),
        ),
    );
  }, lines);

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${ledgerPath}`], root),
    '{"local":true}\n',
  );
  assert.equal(
    run("git", ["--git-dir", origin, "show", "main:remote.txt"], root),
    "base\nrace 1\nrace 2\n",
    "the server merge preserves state writes that beat both client pushes",
  );
  const metrics = lines.find((line) => line.startsWith("Git publish metrics:"));
  assert.match(metrics, /actions=.*gh-api:2(?:,|$)/, "merge and cleanup use the GitHub API");
  assert.match(metrics, /actions=.*push:2(?:,|$)/, "the client stops racing the state ref");
});

test("publishMainCommit rebuilds a production-sized flat immutable ledger tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-large-tree-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const localPath =
    "ledger/v1/import-bindings/events/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json";
  run("git", ["init", "--bare", origin], root);
  configureUser(origin);

  const blob = runWithInput(
    "git",
    ["--git-dir", origin, "hash-object", "-w", "--stdin"],
    root,
    "{}\n",
  ).trim();
  const flatTree = runWithInput(
    "git",
    ["--git-dir", origin, "mktree", "-z"],
    root,
    Array.from(
      { length: 150_000 },
      (_, index) => `100644 blob ${blob}\t${index.toString(16).padStart(64, "0")}.json\0`,
    ).join(""),
  ).trim();
  const importBindingsTree = singleEntryTree(origin, "events", flatTree, root);
  const v1Tree = singleEntryTree(origin, "import-bindings", importBindingsTree, root);
  const ledgerTree = singleEntryTree(origin, "v1", v1Tree, root);
  const remoteBlob = runWithInput(
    "git",
    ["--git-dir", origin, "hash-object", "-w", "--stdin"],
    root,
    "base\n",
  ).trim();
  const rootTree = runWithInput(
    "git",
    ["--git-dir", origin, "mktree", "-z"],
    root,
    `040000 tree ${ledgerTree}\tledger\0` + `100644 blob ${remoteBlob}\tremote.txt\0`,
  ).trim();
  const initialCommit = runWithInput(
    "git",
    ["--git-dir", origin, "commit-tree", rootTree, "-m", "initial large ledger"],
    root,
    "",
  ).trim();
  run("git", ["--git-dir", origin, "update-ref", "refs/heads/main", initialCommit], root);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);

  for (const checkout of [work, other]) {
    run("git", ["clone", "--no-checkout", origin, checkout], root);
    configureUser(checkout);
    run("git", ["sparse-checkout", "init", "--no-cone"], checkout);
    run("git", ["sparse-checkout", "set", "--no-cone", "remote.txt", localPath], checkout);
    run("git", ["checkout", "-B", "main", "origin/main"], checkout);
  }
  write(path.join(other, "remote.txt"), "concurrent\n");
  run("git", ["add", "remote.txt"], other);
  run("git", ["commit", "-m", "concurrent state update"], other);
  installFirstPushRaceHook(work, other);
  write(path.join(work, localPath), '{"local":true}\n');

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: append command action ledger",
      paths: [localPath],
      maxAttempts: 1,
      pushAttempts: 1,
    }),
  );

  assert.equal(result, "committed");
  assert.equal(
    run("git", ["--git-dir", origin, "show", `main:${localPath}`], root),
    '{"local":true}\n',
  );
  assert.equal(run("git", ["--git-dir", origin, "show", "main:remote.txt"], root), "concurrent\n");
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

test("publishMainCommit preserves concurrent comment router ledger commands", () => {
  for (const rebaseStrategy of ["normal", "theirs"]) {
    assertConcurrentCommentRouterLedgerPublish(rebaseStrategy);
  }
});

function assertConcurrentCommentRouterLedgerPublish(rebaseStrategy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const ledgerFile = "results/comment-router.json";
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  writeJson(path.join(work, ledgerFile), commentRouterLedger([commentRouterCommand("base", 1)]));
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  writeJson(
    path.join(other, ledgerFile),
    commentRouterLedger([
      commentRouterCommand("base", 1),
      commentRouterCommand("remote-resume", 2),
    ]),
  );
  run("git", ["commit", "-am", "remote router command"], other);

  writeJson(
    path.join(work, ledgerFile),
    commentRouterLedger([commentRouterCommand("base", 1), commentRouterCommand("local-resume", 3)]),
  );
  installFirstPushRaceHook(work, other);

  const result = withCwd(work, () =>
    publishMainCommit({
      message: "chore: publish router command",
      paths: ["."],
      maxAttempts: 1,
      pushAttempts: 2,
      rebaseStrategy,
    }),
  );

  assert.equal(result, "committed");
  const published = readOriginJson(origin, `main:${ledgerFile}`, root);
  assert.deepEqual(
    published.commands.map((entry) => entry.comment_version_key),
    ["base", "remote-resume", "local-resume"],
  );
}

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

function runWithInput(command, args, cwd, input) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function singleEntryTree(gitDir, name, oid, cwd) {
  return runWithInput(
    "git",
    ["--git-dir", gitDir, "mktree", "-z"],
    cwd,
    `040000 tree ${oid}\t${name}\0`,
  ).trim();
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

function commentRouterLedger(commands) {
  return { updated_at: "2026-07-18T22:10:32Z", commands };
}

function commentRouterCommand(key, second) {
  const timestamp = `2026-07-18T22:10:${String(second).padStart(2, "0")}Z`;
  return {
    comment_version_key: key,
    comment_id: key,
    comment_updated_at: timestamp,
    status: "executed",
    processed_at: timestamp,
  };
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

function installMissingObjectFetchShim(fakeBin, work, objectIds) {
  fs.mkdirSync(fakeBin, { recursive: true });
  const git = path.join(fakeBin, "git");
  const marker = path.join(work, ".git", "missing-object-removed");
  const objectPaths = objectIds.map((objectId) =>
    path.join(work, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)),
  );
  const realGit = run("/usr/bin/env", ["which", "git"], process.cwd()).trim();
  fs.writeFileSync(
    git,
    `#!/bin/sh
set -eu
if test "$1" = fetch && test "$3" = "${objectIds[0]}"; then
  printf '%s\n' 'fatal: remote rejected direct object want' >&2
  exit 128
fi
"${realGit}" "$@"
result=$?
if test "$result" -eq 0 && test "$1" = fetch && test ! -e "${marker}"; then
${objectPaths.map((objectPath) => `  test -f "${objectPath}"\n  rm "${objectPath}"`).join("\n")}
  : > "${marker}"
fi
exit "$result"
`,
  );
  fs.chmodSync(git, 0o755);
}

function installMissingWrittenObjectFetchShim(fakeBin, work, localPath) {
  fs.mkdirSync(fakeBin, { recursive: true });
  const git = path.join(fakeBin, "git");
  const marker = path.join(work, ".git", "missing-written-object-removed");
  const pushCounter = path.join(work, ".git", "hooks", "pre-push-count");
  const realGit = run("/usr/bin/env", ["which", "git"], process.cwd()).trim();
  fs.writeFileSync(
    git,
    `#!/bin/sh
set -u
"${realGit}" "$@"
result=$?
if test "$result" -eq 0 && test "$1" = fetch && test -e "${pushCounter}" && test ! -e "${marker}"; then
  object_id=$("${realGit}" -C "${work}" rev-parse "HEAD:${localPath}")
  object_path="${path.join(work, ".git", "objects")}/$(printf '%s' "$object_id" | cut -c1-2)/$(printf '%s' "$object_id" | cut -c3-)"
  test -f "$object_path"
  rm "$object_path"
  printf '%s\n' "$object_id" > "${marker}"
fi
exit "$result"
`,
  );
  fs.chmodSync(git, 0o755);
}

function installSecondMergeBaseFailureShim(fakeBin, work) {
  fs.mkdirSync(fakeBin, { recursive: true });
  const git = path.join(fakeBin, "git");
  const counter = path.join(work, ".git", "merge-base-count");
  const realGit = run("/usr/bin/env", ["which", "git"], process.cwd()).trim();
  fs.writeFileSync(
    git,
    `#!/bin/sh
set -u
if test "$1" = merge-base; then
  count=0
  if test -f "${counter}"; then count=$(cat "${counter}"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "${counter}"
  if test "$count" -eq 2; then
    printf '%s\n' 'fatal: synthetic merge-base failure' >&2
    exit 2
  fi
fi
exec "${realGit}" "$@"
`,
  );
  fs.chmodSync(git, 0o755);
}

function installDeepenFetchFailureShim(fakeBin) {
  fs.mkdirSync(fakeBin, { recursive: true });
  const git = path.join(fakeBin, "git");
  const realGit = run("/usr/bin/env", ["which", "git"], process.cwd()).trim();
  fs.writeFileSync(
    git,
    `#!/bin/sh
set -u
if test "$1" = fetch && test "$2" = --deepen=32; then
  printf '%s\n' 'fatal: synthetic deepen failure' >&2
  exit 2
fi
exec "${realGit}" "$@"
`,
  );
  fs.chmodSync(git, 0o755);
}

function installFirstTwoPushRaceHook(work, other, branch = "main") {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "${counter}"
if test "$count" -eq 1; then
  git -C "${other}" push origin HEAD:${branch}
elif test "$count" -eq 2; then
  printf 'second race\\n' >> "${path.join(other, "remote.txt")}"
  git -C "${other}" add remote.txt
  git -C "${other}" commit -m 'second concurrent state update'
  git -C "${other}" push origin HEAD:${branch}
fi
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installPushRaceHook(work, other, raceCount, branch = "main") {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "${counter}"
if test "$count" -le ${raceCount}; then
  printf 'race %s\\n' "$count" >> "${path.join(other, "remote.txt")}"
  printf 'remote scratch %s\\n' "$count" > "${path.join(other, "unrelated/0000.txt")}"
  if test "$count" -eq 1; then git -C "${other}" rm scratch/dirty.txt; fi
  printf 'remote parent %s\\n' "$count" > "${path.join(other, "scratch")}"
  printf 'remote ignored parent %s\\n' "$count" > "${path.join(other, "ignored")}"
  git -C "${other}" add remote.txt unrelated/0000.txt scratch ignored
  git -C "${other}" commit -m "concurrent state update $count"
  git -C "${other}" push origin HEAD:${branch}
fi
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installSimplePushRaceHook(work, other, raceCount, branch = "main") {
  const hook = path.join(work, ".git/hooks/pre-push");
  const counter = path.join(work, ".git/hooks/pre-push-count");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
set -e
count=0
if test -f "${counter}"; then count=$(cat "${counter}"); fi
count=$((count + 1))
printf '%s\n' "$count" > "${counter}"
if test "$count" -le ${raceCount}; then
  printf 'race %s\n' "$count" >> "${path.join(other, "remote.txt")}"
  git -C "${other}" add remote.txt
  git -C "${other}" commit -m "concurrent state update $count"
  git -C "${other}" push origin HEAD:${branch}
fi
`,
  );
  fs.chmodSync(hook, 0o755);
}

function installFakeGitHubMerge(fakeBin, origin) {
  fs.mkdirSync(fakeBin, { recursive: true });
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(
    gh,
    `#!/bin/sh
set -eu
method=GET
endpoint=
base=
head=
while test "$#" -gt 0; do
  case "$1" in
    api) shift; endpoint="$1" ;;
    --method) shift; method="$1" ;;
    -f)
      shift
      case "$1" in
        base=*) base=\${1#base=} ;;
        head=*) head=\${1#head=} ;;
      esac
      ;;
  esac
  shift
done
case "$method:$endpoint" in
  POST:repos/openclaw/clawsweeper-state/merges)
    base_sha=$(git --git-dir "${origin}" rev-parse "refs/heads/$base")
    head_sha=$(git --git-dir "${origin}" rev-parse "refs/heads/$head")
    tree=$(git --git-dir "${origin}" merge-tree --write-tree "$base_sha" "$head_sha")
    commit=$(printf '%s\n' 'server merge' | GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com git --git-dir "${origin}" commit-tree "$tree" -p "$base_sha" -p "$head_sha")
    git --git-dir "${origin}" update-ref "refs/heads/$base" "$commit" "$base_sha"
    printf '{"sha":"%s"}\n' "$commit"
    ;;
  DELETE:repos/openclaw/clawsweeper-state/git/refs/heads/*)
    ref=\${endpoint#repos/openclaw/clawsweeper-state/git/refs/heads/}
    git --git-dir "${origin}" update-ref -d "refs/heads/$ref"
    ;;
  *)
    printf '%s\n' "unexpected fake gh call: $method $endpoint" >&2
    exit 2
    ;;
esac
`,
  );
  fs.chmodSync(gh, 0o755);
}

function installCheckoutHeader(work) {
  const encoded = Buffer.from(
    ["fixture-user", "fixture"].join(String.fromCharCode(58)),
    "utf8",
  ).toString("base64");
  const header = [`${"AUTH"}ORIZATION:`, `${"bas"}ic`, encoded].join(" ");
  const credentialsConfig = path.join(path.dirname(work), "checkout-credentials.config");
  run(
    "git",
    ["config", "--file", credentialsConfig, "http.https://github.com/.extraheader", header],
    work,
  );
  run(
    "git",
    ["config", "--local", `includeIf.gitdir:${path.join(work, ".git")}.path`, credentialsConfig],
    work,
  );
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
