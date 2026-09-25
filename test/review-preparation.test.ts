import { mockReviewGitTransport } from "./review-git-transport-fixture.ts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  isExplicitReviewDispatch,
  prepareReviewCommand,
} from "../dist/clawsweeper-review-preparation.js";
import { reviewPromptForTest } from "../dist/clawsweeper.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { hydratePrimaryBody, longProofBody } from "./primary-body-fixture.ts";
import { git } from "./helpers.ts";
import { runText } from "../dist/command.js";
import { ReviewGitError } from "../dist/clawsweeper-review-blobs.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
import { createReviewCommandWorkflow } from "../dist/clawsweeper-review-command-workflow.js";
import { ValidationRecoveryRequiredError } from "../dist/repair/validation-recovery.js";

test("body-file keeps its authoritative precedence over compact hosted context", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-body-override-"));
  let prepared: ReturnType<typeof prepareReviewCommand> | undefined;
  try {
    const bodyFile = join(dir, "body.md");
    const provided = "Provided override\n" + "x".repeat(12001) + "\nOVERRIDE_TAIL";
    writeFileSync(bodyFile, provided);
    const { target, context } = hydratePrimaryBody(longProofBody(), "pull_request");
    prepared = prepareReviewCommand(
      parseArgs(["--body-file", bodyFile, "--artifact-dir", dir, "--output-retention", "debug"]),
      {
        DEFAULT_PLAN_BATCH_SIZE: 3,
        repoFromArgs: () => repositoryProfileFor(target.repo),
        targetRepo: () => target.repo,
        localExactReviewItem: () => false,
        defaultReviewArtifactDir: () => dir,
        defaultItemsDir: () => dir,
        resolveReviewCheckout: () => ({ openclawDir: dir }),
        ensureDir: () => {},
        suppliedReviewStartLeaseFromArgs: () => null,
        reviewCodexForcedLoginMethod: () => "chatgpt",
        gitInfo: () => git,
        reviewPolicyHash: () => "fixture-policy",
      } as unknown as Parameters<typeof prepareReviewCommand>[1],
    );
    const prompt = reviewPromptForTest(target, context, git, prepared.additionalPrompt);
    assert.ok(prompt.includes(provided));
    assert.ok(prompt.indexOf("AUTHORITATIVE PR BODY") > prompt.indexOf("## GitHub Context"));
    assert.match(prepared.additionalPrompt, /Do NOT fetch, prefer, or assume any other version/);
  } finally {
    prepared?.cleanupReviewOutput();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled queue source actions are automatic while exact actions remain explicit", () => {
  for (const sourceAction of ["scheduled_hot_intake", "scheduled_normal_backfill"]) {
    const args = parseArgs(["--review-source-action", sourceAction]);
    assert.equal(isExplicitReviewDispatch(args, true), false, sourceAction);
  }

  for (const sourceAction of [
    "issues_opened",
    "exact_review_command",
    "legacy_dispatch",
    "source_drift_requeue",
    "",
  ]) {
    const args = sourceAction ? parseArgs(["--review-source-action", sourceAction]) : parseArgs([]);
    assert.equal(isExplicitReviewDispatch(args, true), true, sourceAction || "missing action");
  }
});

test("planned review compatibility and non-exact selection preserve existing behavior", () => {
  assert.equal(isExplicitReviewDispatch(parseArgs(["--planned-automatic-review"]), true), false);
  assert.equal(isExplicitReviewDispatch(parseArgs([]), false), false);
});

test("initial fetch timeout retains native evidence before any review work", (t) => {
  let nativeError: Error;
  try {
    runText(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 });
    assert.fail("native command must time out");
  } catch (error) {
    assert.ok(error instanceof Error);
    nativeError = error;
  }
  let fetches = 0;
  const nativeSpawn = childProcess.spawnSync;
  mockReviewGitTransport(t, (command, args, options) => {
    if (command !== "git") return nativeSpawn(command, args, options);
    if (args.includes("--is-shallow-repository")) return { status: 0, stdout: "false", stderr: "" };
    assert.equal(args[0], "fetch");
    assert.ok(options.timeout > 0 && options.timeout <= 60_000);
    assert.equal(options.killSignal, "SIGKILL");
    fetches += 1;
    return { status: null, signal: "SIGKILL", stdout: "", stderr: "", error: nativeError };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const runtime = createReviewRuntime({
    run: () => "main",
  } as Parameters<typeof createReviewRuntime>[0]);
  let failure: ReviewGitError;
  try {
    runtime.gitInfo("fixture", { classifyFetchFailure: true });
    assert.fail("initial fetch must fail");
  } catch (error) {
    assert.ok(error instanceof ReviewGitError);
    failure = error;
  }
  assert.equal(fetches, 2);
  assert.equal((failure.cause as Error).message, nativeError.message);
  assert.equal((failure.cause as NodeJS.ErrnoException).code, "ETIMEDOUT");
  assert.equal(failure.errorCode, "ETIMEDOUT");
  assert.equal(failure.status, null);
  assert.match(failure.signal ?? "", /^SIG[A-Z0-9]+$/);
  assert.throws(
    () => runtime.gitInfo("fixture"),
    (error: NodeJS.ErrnoException) =>
      error.code === "ETIMEDOUT" && error.message === nativeError.message,
  );

  const oldEnv = process.env;
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-initial-fetch-"));
  try {
    for (const scenario of [
      { kind: "issue", args: ["--item-number", "42"], expected: true },
      { kind: "pull_request", args: ["--item-numbers", "42"], expected: true },
      { kind: "pull_request", args: ["--item-numbers", "42"], expected: true, full: true },
      { kind: "", args: ["--item-number", "42"], expected: false },
      { kind: "unknown", args: ["--item-number", "42"], expected: false },
      { kind: "issue", args: ["--item-number", "43"], expected: false },
      { kind: "issue", args: ["--item-numbers", "42,43"], expected: false },
      { kind: "issue", args: ["--item-number", "42", "--item-numbers", "42"], expected: false },
      { kind: "issue", args: [], expected: false },
      { kind: "issue", args: ["--item-number", "42"], key: "", expected: false },
      { kind: "issue", args: ["--item-number", "42"], key: "other/repo#42", expected: false },
      { kind: "issue", args: ["--item-number", "42", "--local-only"], expected: false },
    ]) {
      const dir = join(root, String(readdirSync(root).length));
      if (scenario.full) {
        mkdirSync(dir);
        for (let index = 0; index < 4096; index += 1) writeFileSync(join(dir, `${index}`), "");
      }
      process.env = {
        ...oldEnv,
        EXACT_REVIEW_ITEM_KEY: scenario.key ?? "openclaw/openclaw#42",
        EXACT_REVIEW_ITEM_KIND: scenario.kind,
        EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
      };
      const unexpectedCalls: string[] = [];
      const dependencies = {
        DEFAULT_PLAN_BATCH_SIZE: 3,
        repoFromArgs: () => repositoryProfileFor("openclaw/openclaw"),
        targetRepo: () => "openclaw/openclaw",
        localExactReviewItem: () => false,
        defaultReviewArtifactDir: () => dir,
        defaultItemsDir: () => dir,
        resolveReviewCheckout: () => ({ openclawDir: dir }),
        ensureDir: () => {},
        suppliedReviewStartLeaseFromArgs: () => null,
        reviewCodexForcedLoginMethod: () => "chatgpt",
        gitInfo: (_dir: string, options: { classifyFetchFailure?: boolean }) => {
          assert.equal(options.classifyFetchFailure, scenario.expected ? true : undefined);
          throw scenario.expected ? failure : nativeError;
        },
        codexReviewFailureRetryable: runtime.codexReviewFailureRetryable,
      };
      const workflow = createReviewCommandWorkflow(
        new Proxy(dependencies, {
          get(target, key) {
            if (key in target) return target[key as keyof typeof target];
            return () => {
              unexpectedCalls.push(String(key));
              throw new Error(`Unexpected review work: ${String(key)}`);
            };
          },
        }) as unknown as Parameters<typeof createReviewCommandWorkflow>[0],
      );
      assert.throws(
        () =>
          workflow.reviewCommand(
            parseArgs(["--artifact-dir", dir, "--output-retention", "debug", ...scenario.args]),
          ),
        (error) => error === (scenario.expected ? failure : nativeError),
      );
      assert.deepEqual(unexpectedCalls, []);
      const manifestPath = join(dir, "failure-diagnostics", "manifest.json");
      assert.equal(
        existsSync(manifestPath),
        scenario.expected && !scenario.full,
        JSON.stringify(scenario),
      );
      assert.equal(existsSync(join(dir, "selection.json")), false);
      if (scenario.full) assert.equal(readdirSync(dir).length, 4096);
      if (scenario.expected && !scenario.full) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        assert.equal(manifest.classification, "source_preparation");
        assert.deepEqual(manifest.failure, {
          stage: "source_preparation",
          reason_code: "review_commit_fetch_failed",
        });
        assert.equal(manifest.process.error_code, "ETIMEDOUT");
        assert.equal(manifest.process.signal, failure.signal);
        assert.equal(manifest.process.workflow_exit, 1);
        assert.equal(manifest.retryable, true);
        assert.equal(manifest.source.item_kind, scenario.kind);
        assert.equal(manifest.source.item_number, 42);
        assert.equal(manifest.source.sha, scenario.kind === "pull_request" ? "a".repeat(40) : null);
      }
    }
  } finally {
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local-range preparation remains offline even with a claimed exact item in the environment", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-local-range-"));
  const oldEnv = process.env;
  let prepared: ReturnType<typeof prepareReviewCommand> | undefined;
  try {
    process.env = {
      ...oldEnv,
      EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#42",
      EXACT_REVIEW_ITEM_KIND: "pull_request",
    };
    prepared = prepareReviewCommand(parseArgs(["--local-range", "--artifact-dir", root]), {
      DEFAULT_PLAN_BATCH_SIZE: 3,
      repoFromArgs: () => repositoryProfileFor("openclaw/openclaw"),
      targetRepo: () => "openclaw/openclaw",
      localExactReviewItem: () => false,
      defaultReviewArtifactDir: () => root,
      defaultItemsDir: () => root,
      defaultLocalRangeHistoryPath: () => join(root, "history"),
      resolveReviewCheckout: () => ({ openclawDir: root }),
      ensureDir: () => {},
      suppliedReviewStartLeaseFromArgs: () => null,
      reviewCodexForcedLoginMethod: () => "chatgpt",
      buildLocalRangeReview: () => ({ baseSha: "b".repeat(40), headSha: "c".repeat(40) }),
      gitInfo: () => {
        assert.fail("local-range must not fetch Git metadata");
      },
      reviewPolicyHash: () => "fixture-policy",
    } as unknown as Parameters<typeof prepareReviewCommand>[1]);
    assert.equal(prepared.git.mainSha, "b".repeat(40));
    assert.equal(prepared.git.releaseStateComplete, true);
    assert.equal(existsSync(join(root, "failure-diagnostics")), false);
  } finally {
    prepared?.cleanupReviewOutput();
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("default local-range preparation owns private transient output and retains no history", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-local-range-default-"));
  const oldEnv = process.env;
  let prepared: ReturnType<typeof prepareReviewCommand> | undefined;
  try {
    process.env = { ...oldEnv };
    prepared = prepareReviewCommand(parseArgs(["--local-range"]), {
      DEFAULT_PLAN_BATCH_SIZE: 3,
      repoFromArgs: () => repositoryProfileFor("openclaw/openclaw"),
      targetRepo: () => "openclaw/openclaw",
      localExactReviewItem: () => false,
      defaultReviewArtifactDir: () => join(root, "generated-artifacts"),
      defaultItemsDir: () => join(root, "items"),
      defaultLocalRangeHistoryPath: () => {
        assert.fail("no-retention local range must not create history");
      },
      resolveReviewCheckout: () => ({ openclawDir: root }),
      ensureDir: () => {},
      suppliedReviewStartLeaseFromArgs: () => null,
      reviewCodexForcedLoginMethod: () => "chatgpt",
      buildLocalRangeReview: () => ({ baseSha: "b".repeat(40), headSha: "c".repeat(40) }),
      gitInfo: () => {
        assert.fail("local-range must not fetch Git metadata");
      },
      reviewPolicyHash: () => "fixture-policy",
    } as unknown as Parameters<typeof prepareReviewCommand>[1]);
    assert.equal(prepared.outputSelection.retention, "none");
    assert.equal(prepared.localReviewHistoryPath, null);
    assert.equal(statSync(prepared.artifactDir).mode & 0o777, 0o700);
    assert.notEqual(prepared.reviewWorkspaceDir, prepared.artifactDir);
    assert.equal(statSync(prepared.reviewWorkspaceDir).mode & 0o777, 0o700);
    assert.equal(existsSync(join(root, "generated-artifacts")), false);
  } finally {
    prepared?.cleanupReviewOutput();
    if (prepared) {
      assert.equal(existsSync(prepared.artifactDir), false);
      assert.equal(existsSync(prepared.reviewWorkspaceDir), false);
    }
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const uncertain of [false, true])
  test(`summary preparation preserves only unsettled checkout scratch: uncertain=${uncertain}`, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-summary-preparation-"));
    const output = join(root, "summary");
    let checkoutScratch = "";
    try {
      assert.throws(
        () =>
          prepareReviewCommand(parseArgs(["--local-only", "--output-retention", "summary"]), {
            DEFAULT_PLAN_BATCH_SIZE: 3,
            repoFromArgs: () => repositoryProfileFor("openclaw/openclaw"),
            targetRepo: () => "openclaw/openclaw",
            localExactReviewItem: () => false,
            defaultReviewArtifactDir: () => output,
            defaultItemsDir: () => join(root, "items"),
            resolveReviewCheckout: ({ artifactDir }: { artifactDir: string }) => {
              checkoutScratch = artifactDir;
              assert.notEqual(artifactDir, output);
              assert.match(artifactDir, /clawsweeper-review-workspace-/);
              mkdirSync(join(artifactDir, "review-trees"));
              symlinkSync(root, join(artifactDir, "review-trees", "codex"));
              throw new Error(
                "synthetic checkout failure",
                uncertain
                  ? {
                      cause: Object.assign(
                        new ValidationRecoveryRequiredError("unsettled Git", undefined, [
                          artifactDir,
                        ]),
                        { code: "EPROCESSSETTLEMENT" },
                      ),
                    }
                  : undefined,
              );
            },
            ensureDir: () => {},
            suppliedReviewStartLeaseFromArgs: () => null,
            reviewCodexForcedLoginMethod: () => "chatgpt",
            reviewPolicyHash: () => "fixture-policy",
          } as unknown as Parameters<typeof prepareReviewCommand>[1]),
        /synthetic checkout failure/,
      );
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(checkoutScratch), uncertain);
      assert.equal(existsSync(root), true);
    } finally {
      if (checkoutScratch) rmSync(checkoutScratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

test("invalid PR admission cleans private preparation scratch and preserves existing debug output", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-admission-preparation-"));
  const scratch = join(root, "tmp");
  mkdirSync(scratch);
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const admissionPath = join(root, "admission.json");
  try {
    for (const retention of ["none", "summary", "debug"]) {
      for (const malformed of [false, true]) {
        const output = join(root, `${retention}-${malformed}`);
        if (retention === "debug") {
          mkdirSync(output);
          writeFileSync(join(output, "existing.txt"), "preserve");
        }
        writeFileSync(
          admissionPath,
          malformed
            ? "{"
            : JSON.stringify({
                repo: "other/project",
                pull: { number: 123, state: "open" },
              }),
        );
        let checkoutCalls = 0;
        let gitCalls = 0;
        const dependencies = {
          DEFAULT_PLAN_BATCH_SIZE: 3,
          repoFromArgs: () => repositoryProfileFor("openclaw/openclaw"),
          targetRepo: () => "openclaw/openclaw",
          localExactReviewItem: () => false,
          defaultReviewArtifactDir: () => output,
          defaultItemsDir: () => root,
          resolveReviewCheckout: () => {
            checkoutCalls++;
            assert.fail("invalid admission must precede checkout preparation");
          },
          gitInfo: () => {
            gitCalls++;
            assert.fail("invalid admission must not read Git");
          },
        };
        assert.throws(
          () =>
            prepareReviewCommand(
              parseArgs([
                "--local-only",
                "--item-number",
                "123",
                "--pr-admission-file",
                admissionPath,
                "--output-retention",
                retention,
                ...(retention === "none" ? [] : ["--artifact-dir", output]),
              ]),
              dependencies as unknown as Parameters<typeof prepareReviewCommand>[1],
            ),
          malformed ? SyntaxError : /does not match the selected open pull request/,
        );
        assert.equal(checkoutCalls, 0);
        assert.equal(gitCalls, 0);
        assert.deepEqual(readdirSync(scratch), []);
        assert.equal(existsSync(output), retention === "debug");
        if (retention === "debug") {
          assert.deepEqual(readdirSync(output), ["existing.txt"]);
          assert.equal(readFileSync(join(output, "existing.txt"), "utf8"), "preserve");
        }
      }
    }
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const uncertain of [false, true])
  test(`post-preparation cleanup follows nested recovery cause: uncertain=${uncertain}`, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-readonly-preparation-"));
    const scratch = join(root, "tmp");
    const recovery = Object.assign(
      new ValidationRecoveryRequiredError("unsettled Git", undefined, [root]),
      { code: "EPROCESSSETTLEMENT" },
    );
    const failure = new Error(
      "synthetic partial read-only failure",
      uncertain ? { cause: new Error("wrapper", { cause: recovery }) } : undefined,
    );
    const snapshot = { path: join(root, "partially-readonly"), mode: 0o100644 };
    const previousTmpdir = process.env.TMPDIR;
    let restored: Array<{ path: string; mode: number }> = [];
    try {
      mkdirSync(scratch);
      process.env.TMPDIR = scratch;
      writeFileSync(snapshot.path, "fixture\n");
      const dependencies = {
        DEFAULT_PLAN_BATCH_SIZE: 3,
        buildLocalRangeReview: () => ({
          baseSha: "b".repeat(40),
          headSha: "c".repeat(40),
        }),
        defaultItemsDir: () => join(root, "items"),
        defaultLocalRangeArtifactDir: () => join(root, "retained"),
        defaultLocalRangeHistoryPath: () => join(root, "history"),
        defaultReviewArtifactDir: () => join(root, "default-artifacts"),
        ensureDir: (path: string) => {
          mkdirSync(path, { recursive: true });
        },
        gitInfo: () => assert.fail("local range must not load remote Git metadata"),
        localExactReviewItem: () => false,
        makeTreeReadOnly: (_path: string, snapshots: Array<{ path: string; mode: number }>) => {
          snapshots.push(snapshot);
          throw failure;
        },
        repoFromArgs: () => repositoryProfileFor("openclaw/clawsweeper"),
        resolveReviewCheckout: () => ({ openclawDir: root }),
        restoreTreeModes: (snapshots: Array<{ path: string; mode: number }>) => {
          restored = [...snapshots];
        },
        reviewCodexForcedLoginMethod: () => "chatgpt",
        reviewPolicyHash: () => "fixture-policy",
        suppliedReviewStartLeaseFromArgs: () => null,
        targetRepo: () => "openclaw/clawsweeper",
      };
      const workflow = createReviewCommandWorkflow(
        new Proxy(dependencies, {
          get(target, key) {
            if (key in target) return target[key as keyof typeof target];
            return () => {
              throw new Error(`Unexpected review work: ${String(key)}`);
            };
          },
        }) as unknown as Parameters<typeof createReviewCommandWorkflow>[0],
      );
      assert.throws(
        () =>
          workflow.reviewCommand(
            parseArgs([
              "--local-range",
              "--target-repo",
              "openclaw/clawsweeper",
              "--target-dir",
              root,
              "--readonly-openclaw",
            ]),
          ),
        (error) => error === failure,
      );
      assert.deepEqual(restored, [snapshot]);
      if (uncertain) {
        const retained = readdirSync(scratch).map((name) => join(scratch, name));
        assert.equal(retained.length, 2);
        for (const path of retained) assert.ok(recovery.recoveryPaths.has(path));
      } else assert.deepEqual(readdirSync(scratch), []);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      rmSync(root, { recursive: true, force: true });
    }
  });
