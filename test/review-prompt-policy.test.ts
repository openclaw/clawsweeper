import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isGitHubLabelCapacityErrorForTest,
  isMissingGitHubLabelErrorForTest,
  prepareMediaProofArtifactsForTest,
  proofVideoUrlsFromContextForTest,
  realBehaviorProofMediaLabelsForTest,
  realBehaviorProofSufficientLabelsForTest,
  renderReviewCommentFromReport,
  reviewPromptForTest,
} from "../dist/clawsweeper.js";
import { item, reportFrontMatter } from "./helpers.ts";

test("review prompt routes PR likely owners through feature history", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /feature-history hunt/);
  assert.match(prompt, /who introduced the feature/);
  assert.match(prompt, /git log --follow -- <file>/);
  assert.match(prompt, /do not list the PR author solely/);
  assert.match(prompt, /not to the PR\s+author merely for writing the proposal/);
  assert.match(prompt, /Do\s+not use `maintainer` as a likely-owner role/);
  assert.match(prompt, /Do not include email\s+addresses in `likelyOwners`/);
  assert.match(prompt, /use names without email addresses/);
});

test("review prompt describes concrete review metrics without vague examples", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Always fill `reviewMetrics`/);
  assert.match(prompt, /useful, concrete, maintainer-relevant/);
  assert.match(prompt, /2 added, 1 changed, 0\s+removed/);
  assert.match(prompt, /Do not use vague\s+labels or values/);
  assert.doesNotMatch(prompt, /Risky change/);
  assert.doesNotMatch(prompt, /Some changes/);
  assert.doesNotMatch(prompt, /This seems risky/);
});

test("review prompt reads maintainer notes before PR diffs", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /\.agents\/maintainer-notes\//);
  assert.match(prompt, /before reviewing the diff/);
  assert.match(prompt, /Treat matching notes as maintainer decisions/);
  assert.match(prompt, /do not publish raw internal note contents/);
});

test("review prompts treat target AGENTS as optional review policy", () => {
  const itemPrompt = readFileSync("prompts/review-item.md", "utf8");
  const commitPrompt = readFileSync("prompts/review-commit.md", "utf8");

  for (const prompt of [itemPrompt, commitPrompt]) {
    assert.match(
      prompt,
      /Before reviewing, read the target\s+repository's full `AGENTS\.md` file if present/,
    );
    assert.match(prompt, /Do not rely only on search\s+snippets/);
    assert.match(
      prompt,
      /`head` output, local excerpts, partial line ranges, or truncated\s+copies/,
    );
    assert.match(prompt, /optional\s+repository-authored\s+review policy and review guidance/);
    assert.match(
      prompt,
      /do not conflict with this prompt or higher-priority\s+system\/developer\s+instructions/,
    );
    assert.match(prompt, /existing repository\s+profiles and owner\/default fallback behavior/);
    assert.match(prompt, /Use target `AGENTS\.md` policy as review input/);
  }

  assert.match(itemPrompt, /report it through `reviewFindings`/);
  assert.match(
    itemPrompt,
    /route the\s+concern through the existing `risks`, `bestSolution`, `solutionAssessment`, or\s+`workReason` fields/,
  );
  assert.match(
    commitPrompt,
    /Report an AGENTS-policy conflict only when the commit creates a\s+concrete bug/,
  );
  assert.match(commitPrompt, /keep it out of `result: findings`/);
});

test("review prompt requires a dedicated securityReview section", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Always summarize this pass in `securityReview`/);
  assert.match(prompt, /Always fill `securityReview`/);
  assert.match(prompt, /status: "needs_attention"/);
});

test("review prompt treats duplicated behavior as a P1 PR finding", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /dedicated solution-fit and upgrade-safety pass/);
  assert.match(prompt, /current code, documented configuration, CLI flags, env vars/);
  assert.match(prompt, /Search the codebase and docs for the existing capability/);
  assert.match(prompt, /Treat duplicated behavior as a high-priority defect/);
  assert.match(prompt, /add a P1 review finding unless the PR proves/);
  assert.match(prompt, /maintenance drift, conflicting behavior,\s+or user confusion/);
});

test("review prompt treats plugin API changes as compatibility-sensitive P1 repair work", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Treat plugin API surface changes as compatibility-sensitive/);
  assert.match(prompt, /adds,\s+removes, renames, deprecates, changes behavior for/);
  assert.match(prompt, /adds new similar\/parallel\s+calls to a plugin API/);
  assert.match(prompt, /require explicit maintainer-visible discussion/);
  assert.match(prompt, /Use\s+`merge-risk: 🚨 compatibility`/);
  assert.match(prompt, /name the plugin API concern in `risks`/);
  assert.match(prompt, /make\s+`mergeRiskOptions` spell out the maintainer choices or repair path/);
  assert.match(prompt, /Prefer a\s+resolvable P1 review finding/);
  assert.match(prompt, /preserving the existing API/);
  assert.match(prompt, /removing the duplicate\/parallel call/);
  assert.match(prompt, /clear deprecation path/);
  assert.match(prompt, /focused\s+compatibility tests/);
  assert.match(
    prompt,
    /Choose\s+`queue_fix_pr` for plugin API findings only when the\s+repair is concrete/,
  );
  assert.match(
    prompt,
    /Use\s+`manual_review` when the unresolved blocker is whether the new API should exist/,
  );
});

test("review prompt requires upgrade and preference overwrite checks", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Treat compatibility and user settings as merge-critical/);
  assert.match(prompt, /override existing preferences, persisted config, provider choices/);
  assert.match(
    prompt,
    /A new default must not change an existing user's stored\s+value during upgrade/,
  );
  assert.match(prompt, /Call out upgrade and settings breakage directly in `reviewFindings`/);
  assert.match(prompt, /existing config\/preferences can be overwritten/);
  assert.match(prompt, /preserving the existing\s+behavior as the default/);
  assert.match(prompt, /explicit strict config option/);
  assert.match(prompt, /default compatibility mode and the\s+opt-in strict mode/);
  assert.match(prompt, /require evidence for both fresh-install behavior and upgrade\s+behavior/);
  assert.match(prompt, /If upgrade behavior is ambiguous, mark the PR incorrect/);
});

test("review prompt treats stored data-model changes as compatibility-sensitive", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Treat stored data-model changes as compatibility-sensitive/);
  assert.match(prompt, /SQL\s+DDL or migrations/);
  assert.match(prompt, /persistent cache schemas/);
  assert.match(prompt, /Durable Object or hosted storage schemas/);
  assert.match(prompt, /serialized JSON state written to disk/);
  assert.match(prompt, /vector or embedding row identity\/query-compatibility metadata/);
  assert.match(prompt, /doctor, repair, migration, or backfill code/);
  assert.match(prompt, /pure query-only changes or non-semantic docs wording/);
  assert.match(prompt, /migration or upgrade compatibility proof before any pass/);
});

test("review prompt requires real behavior proof for PR reviews", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /realBehaviorProof/);
  assert.match(prompt, /Terminal screenshots|terminal screenshots/);
  assert.match(prompt, /download\/open GitHub attachment links/);
  assert.match(prompt, /generate stills or contact sheets from videos/);
  assert.match(prompt, /compare the proof against the PR diff/);
  assert.match(prompt, /Prefer asking for screenshots or videos/);
  assert.match(prompt, /redact private information like IP addresses, API keys/);
  assert.match(prompt, /screenshot-only proof sufficient/);
  assert.match(prompt, /no visible console violation/);
  assert.match(prompt, /scratch directory/);
  assert.match(prompt, /@clawsweeper re-review/);
  assert.match(
    prompt,
    /Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental only/,
  );
  assert.match(prompt, /do not request ClawSweeper repair markers/);
});

test("media proof preparation extracts browser-unplayable ffmpeg-decodeable video proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-media-proof-"));
  try {
    const context = {
      issue: {},
      comments: [
        {
          body: [
            "Chromium media error code 4 on this upload, but ffmpeg can decode it:",
            "https://github.com/user/repo/releases/download/proof/Screen.Recording.mov",
          ].join("\n"),
        },
      ],
      timeline: [],
    };
    const calls: string[] = [];
    const prepared = prepareMediaProofArtifactsForTest(context, dir, (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "curl") {
        const outputIndex = args.indexOf("--output");
        assert.notEqual(outputIndex, -1);
        writeFileSync(String(args[outputIndex + 1]), "fake mov bytes");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "ffprobe") {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: { duration: "46.49" },
            streams: [{ codec_name: "h264", width: 734, height: 1038 }],
          }),
          stderr: "",
        };
      }
      if (command === "ffmpeg") {
        const output = String(args.at(-1));
        writeFileSync(output, "fake contact sheet");
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    assert.equal(prepared.artifacts.length, 1);
    assert.equal(prepared.artifacts[0]?.status, "prepared");
    assert.ok(prepared.manifestPath);
    assert.ok(prepared.summaryPath);
    assert.ok(prepared.artifacts[0]?.metadataPath);
    assert.ok(prepared.artifacts[0]?.contactSheetPath);
    assert.equal(existsSync(prepared.manifestPath), true);
    assert.equal(existsSync(prepared.artifacts[0].metadataPath), true);
    assert.equal(existsSync(prepared.artifacts[0].contactSheetPath), true);
    assert.match(calls.join("\n"), /^curl /m);
    assert.match(calls.join("\n"), /^ffprobe /m);
    assert.match(calls.join("\n"), /^ffmpeg /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime prompt tells Codex to inspect ffmpeg video artifacts before browser fallback", () => {
  const context = {
    issue: {},
    comments: [{ body: "Proof: https://github.com/user/repo/releases/download/proof/demo.mov" }],
    timeline: [],
  };
  const prompt = reviewPromptForTest(
    item({ kind: "pull_request" }),
    context,
    { mainSha: "abc123", latestRelease: null },
    "",
    {
      proofScratchDir: "/tmp/proof",
      mediaProofManifestPath: "/tmp/proof/media-proof-manifest.json",
      mediaProofSummary: "prepared: https://github.com/user/repo/releases/download/proof/demo.mov",
    },
  );

  assert.deepEqual(proofVideoUrlsFromContextForTest(context), [
    "https://github.com/user/repo/releases/download/proof/demo.mov",
  ]);
  assert.match(prompt, /preprocessed linked video proof with ffprobe\/ffmpeg/);
  assert.match(prompt, /generated contact-sheet image paths before trying browser playback/);
  assert.match(
    prompt,
    /Only fall back to browser playback after checking the prepared ffmpeg artifacts/,
  );
  assert.match(
    prompt,
    /If browser playback fails but ffprobe metadata and ffmpeg contact sheets are readable/,
  );
});

test("review prompt keeps draft and protected workflow state out of PR rank", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /Rate PR evidence\s+and patch quality/);
  assert.match(prompt, /weaker proof-or-patch quality signal/);
  assert.match(
    prompt,
    /Do not lower `proofTier`, `patchTier`,\s+or `overallTier` solely because the PR is draft/,
  );
  assert.match(prompt, /has protected labels/);
  assert.match(prompt, /not\s+automerge-eligible/);
  assert.match(prompt, /workflow\s+state signals, not proof or patch quality defects/);
});

test("decision schema keeps draft and protected workflow state out of PR rank", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const prRating = schema.properties.prRating;

  assert.match(prRating.description, /Calibrated PR quality rating/);
  assert.match(prRating.description, /Rate the PR evidence and patch quality/);
  assert.match(prRating.description, /Do not lower any tier solely because the PR is draft/);
  assert.match(prRating.description, /has protected labels/);
  assert.match(prRating.description, /not automerge-eligible/);
  assert.match(
    prRating.properties.overallTier.description,
    /Draft, protected-label, automerge eligibility, and maintainer-waiting workflow states must not lower this tier by themselves/,
  );
});

test("review finding schema requires every structured-output property", () => {
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const finding = schema.properties.reviewFindings.items;

  assert.deepEqual([...finding.required].sort(), Object.keys(finding.properties).sort());
});

test("review prompt and schema describe positive-only feature showcase labels", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  const featureShowcase = schema.properties.featureShowcase;

  assert.match(prompt, /featureShowcase/);
  assert.match(prompt, /positive-only maintainer spotlight/);
  assert.match(prompt, /really compelling feature ideas/);
  assert.match(prompt, /not a merge gate/);
  assert.match(featureShowcase.description, /Positive-only maintainer spotlight/);
  assert.match(featureShowcase.description, /not a merge gate/);
  assert.deepEqual(featureShowcase.properties.status.enum, ["showcase", "none"]);
});

test("review prompt uses token-light maturity shortlist helper", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");
  const runtimePrompt = reviewPromptForTest(
    item({ kind: "issue" }),
    { issue: {}, comments: [], timeline: [] },
    { mainSha: "abc123", latestRelease: null },
    "",
    { proofScratchDir: "/tmp/proof" },
  );

  assert.match(prompt, /maturity-stable-shortlist\.mjs/);
  assert.match(prompt, /compare the issue against the M4\+ shortlist/);
  assert.match(
    runtimePrompt,
    /node "\$CLAWSWEEPER_PROOF_SCRATCH_DIR\/maturity-stable-shortlist\.mjs"/,
  );
  assert.match(
    runtimePrompt,
    /read the full scorecard or taxonomy only if the shortlist is ambiguous/,
  );
});

test("review prompt classifies Telegram visible proof candidates", () => {
  const prompt = readFileSync("prompts/review-item.md", "utf8");

  assert.match(prompt, /telegramVisibleProof/);
  assert.match(prompt, /telegram-crabbox-e2e-proof/);
  assert.match(prompt, /message formatting/);
  assert.match(prompt, /mantis: telegram-visible-proof/);
  assert.match(prompt, /mantisRecommendation/);
  assert.match(prompt, /@openclaw-mantis/);
  assert.match(prompt, /ambiguous Mantis account mention/);
});

test("pull request review comments suggest copy-paste Mantis proof comments", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83140",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this Telegram PR open for maintainer review.

## What This Changes

Fixes Telegram topic stop targeting.

## Real Behavior Proof

Status: mock_only

Evidence kind: none

Needs contributor action: true

Summary: Current proof is test-only for visible Telegram topic behavior.

## Mantis Recommendation

Status: recommended

Scenario: telegram_desktop_proof

Reason: This changes visible Telegram topic behavior that should be proven in native Telegram Desktop.

Maintainer comment: @openclaw-mantis telegram desktop proof: verify that /stop targets the active topic and does not affect other topics.

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Maintainers should review the proof before merge.
	`,
    "none",
  );

  assert.match(comment, /\*\*Mantis proof suggestion\*\*/);
  assert.match(comment, /posting this exact PR comment/);
  assert.match(comment, /```text\n@openclaw-mantis telegram desktop proof:/);
});

test("pull request review comments suppress unsafe Mantis recommendations", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83140",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this Telegram PR open for maintainer review.

## Mantis Recommendation

Status: recommended

Scenario: telegram_desktop_proof

Reason: This changes visible Telegram behavior.

Maintainer comment: @${"mantis"} telegram desktop proof

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Maintainers should review the proof before merge.
	`,
    "none",
  );

  assert.doesNotMatch(comment, /\*\*Mantis proof suggestion\*\*/);
  assert.doesNotMatch(comment, /@openclaw-mantis/);
});

test("ClawSweeper proof judgement controls the sufficient proof label", () => {
  assert.deepEqual(realBehaviorProofSufficientLabelsForTest(["bug"], "sufficient"), [
    "bug",
    "proof: sufficient",
  ]);
  assert.deepEqual(
    realBehaviorProofSufficientLabelsForTest(["bug", "proof: sufficient"], "insufficient"),
    ["bug"],
  );
  assert.deepEqual(realBehaviorProofSufficientLabelsForTest(["proof: sufficient"], "missing"), []);
});

test("ClawSweeper proof evidence kind controls media proof labels", () => {
  assert.deepEqual(realBehaviorProofMediaLabelsForTest(["bug"], "screenshot"), [
    "bug",
    "proof: 📸 screenshot",
  ]);
  assert.deepEqual(realBehaviorProofMediaLabelsForTest(["proof: 📸 screenshot"], "recording"), [
    "proof: 🎥 video",
  ]);
  assert.deepEqual(
    realBehaviorProofMediaLabelsForTest(["proof: 📸 screenshot", "proof: 🎥 video"], "terminal"),
    [],
  );
});

test("ClawSweeper proof label sync recognizes missing optional labels", () => {
  assert.equal(
    isMissingGitHubLabelErrorForTest(
      "failed to update https://github.com/openclaw/fs-safe/pull/18: 'proof: sufficient' not found",
      "proof: sufficient",
    ),
    true,
  );
  assert.equal(
    isMissingGitHubLabelErrorForTest(
      "failed to update https://github.com/openclaw/fs-safe/pull/18: 'other label' not found",
      "proof: sufficient",
    ),
    false,
  );
});

test("ClawSweeper optional label sync recognizes GitHub label capacity errors", () => {
  assert.equal(
    isGitHubLabelCapacityErrorForTest(
      "GraphQL: Validation failed: Labels can have a maximum of 100 labels (addLabelsToLabelable)",
    ),
    true,
  );
  assert.equal(
    isGitHubLabelCapacityErrorForTest("GraphQL: Resource not accessible by integration"),
    false,
  );
});
