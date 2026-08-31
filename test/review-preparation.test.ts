import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
