import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("body-file keeps its authoritative precedence over compact hosted context", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-body-override-"));
  try {
    const bodyFile = join(dir, "body.md");
    const provided = "Provided override\n" + "x".repeat(12001) + "\nOVERRIDE_TAIL";
    writeFileSync(bodyFile, provided);
    const { target, context } = hydratePrimaryBody(longProofBody(), "pull_request");
    const prepared = prepareReviewCommand(
      parseArgs(["--body-file", bodyFile, "--artifact-dir", dir]),
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

test("initial fetch timeout retains native evidence before any review work", () => {
  let nativeError: Error;
  try {
    runText(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 });
    assert.fail("native command must time out");
  } catch (error) {
    assert.ok(error instanceof Error);
    nativeError = error;
  }
  let fetches = 0;
  const runtime = createReviewRuntime({
    run: (command: string, args: string[], options?: { timeoutMs?: number }) => {
      assert.equal(command, "git");
      if (args.includes("--abbrev-ref")) return "main";
      if (args.includes("--is-shallow-repository")) return "false";
      assert.equal(args[0], "fetch");
      assert.equal(options?.timeoutMs, 30_000);
      fetches += 1;
      throw nativeError;
    },
  } as Parameters<typeof createReviewRuntime>[0]);
  let failure: ReviewGitError;
  try {
    runtime.gitInfo("fixture", { classifyFetchFailure: true });
    assert.fail("initial fetch must fail");
  } catch (error) {
    assert.ok(error instanceof ReviewGitError);
    failure = error;
  }
  assert.equal(fetches, 1);
  assert.equal(failure.cause, nativeError);
  assert.equal(failure.errorCode, "ETIMEDOUT");
  assert.equal(failure.status, null);
  assert.match(failure.signal ?? "", /^SIG[A-Z0-9]+$/);
  assert.throws(
    () => runtime.gitInfo("fixture"),
    (error) => error === nativeError,
  );

  const oldEnv = process.env;
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-initial-fetch-"));
  try {
    for (const scenario of [
      { kind: "issue", args: ["--item-number", "42"], expected: true },
      { kind: "pull_request", args: ["--item-numbers", "42"], expected: true },
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
        () => workflow.reviewCommand(parseArgs(["--artifact-dir", dir, ...scenario.args])),
        (error) => error === (scenario.expected ? failure : nativeError),
      );
      assert.deepEqual(unexpectedCalls, []);
      const manifestPath = join(dir, "failure-diagnostics", "manifest.json");
      assert.equal(existsSync(manifestPath), scenario.expected, JSON.stringify(scenario));
      assert.equal(existsSync(join(dir, "selection.json")), false);
      if (scenario.expected) {
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
  try {
    process.env = {
      ...oldEnv,
      EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#42",
      EXACT_REVIEW_ITEM_KIND: "pull_request",
    };
    const prepared = prepareReviewCommand(parseArgs(["--local-range", "--artifact-dir", root]), {
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
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
