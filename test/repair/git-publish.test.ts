import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  captureStatePublishBaseline,
  commitMessageForPublishedPaths,
  hardResetToRemoteMain,
  publishMainCommit,
  refreshSourceAfterStatePublish,
  setTokenOrigin,
  uniqueNonEmpty,
} from "../../dist/repair/git-publish.js";

for (const key of [
  "CLAWSWEEPER_STATE_DIR",
  "CLAWSWEEPER_PUBLISH_ROOT",
  "CLAWSWEEPER_PUBLISH_BRANCH",
]) {
  delete process.env[key];
}

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

test("publishMainCommit rebuilds generated state commits without deleting concurrent records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publish-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  run("git", ["init", "--bare", origin], root);
  run("git", ["clone", origin, work], root);
  configureUser(work);
  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), "{}\n");
  write(path.join(work, "records/openclaw-openclaw/items/1.md"), "record old\n");
  write(path.join(work, "keep.txt"), "keep old\n");
  run("git", ["add", "."], work);
  run("git", ["commit", "-m", "initial"], work);
  run("git", ["push", "origin", "HEAD:main"], work);
  run("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"], root);
  run("git", ["checkout", "-B", "main", "origin/main"], work);

  run("git", ["clone", origin, other], root);
  configureUser(other);
  write(path.join(other, "results/sweep-status/openclaw-openclaw.json"), '{"state":"remote"}\n');
  write(path.join(other, "records/openclaw-openclaw/items/1.md"), "record remote\n");
  write(path.join(other, "records/openclaw-openclaw/items/2.md"), "remote only\n");
  write(path.join(other, "keep.txt"), "keep remote\n");
  run("git", ["add", "."], other);
  run("git", ["commit", "-m", "remote generated state update"], other);
  run("git", ["push", "origin", "HEAD:main"], other);

  write(path.join(work, "results/sweep-status/openclaw-openclaw.json"), '{"state":"local"}\n');
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
  assert.equal(
    run(
      "git",
      ["--git-dir", origin, "show", "main:results/sweep-status/openclaw-openclaw.json"],
      root,
    ),
    '{"state":"local"}\n',
  );
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
  const sweepStatus = "results/sweep-status/openclaw-openclaw.json";
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
  write(path.join(state, sweepStatus), '{"status":"base"}\n');
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
  write(path.join(work, sweepStatus), '{"status":"checkpoint"}\n');
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

      write(path.join(work, sweepStatus), '{"status":"checkpoint-again"}\n');
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

function captureConsoleLog(callback) {
  const original = console.log;
  const lines = [];
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
