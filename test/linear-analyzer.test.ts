import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYZER_VERSION,
  analyzerFingerprint,
  citedShas,
  deriveCloseLeaning,
  needsReanalysis,
  renderAnalyzerSections,
  serializeAnalyzerRecord,
  verifyEvidenceShas,
} from "../dist/linear/analyzer.js";
import type { AnalyzerDecision } from "../dist/linear/analyzer.js";
// Barrel wiring check.
import { deriveCloseLeaning as deriveFromIndex } from "../dist/linear/index.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import type { RepositoryProfile } from "../dist/repository-profiles.js";

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<AnalyzerDecision> = {}): AnalyzerDecision {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    changeSummary: "Adds a --foo flag to the CLI.",
    evidence: [
      {
        label: "implemented on main",
        detail: "the flag is wired in src/cli.ts",
        file: "src/cli.ts",
        line: 42,
        command: "git log -1 -- src/cli.ts",
        sha: "abc1234",
      },
    ],
    reproductionStatus: "not_applicable",
    reproductionAssessment: "N/A — feature request, not a bug.",
    workReason: "Already shipped on main; no fix PR needed.",
    bestSolution: "Close as implemented; mention the release that carries it.",
    ...overrides,
  };
}

// openclaw/openclaw core profile: issue rule includes implemented_on_main.
const CORE: RepositoryProfile = repositoryProfileFor("openclaw/openclaw");

const verifyAll = () => true;
const verifyNone = () => false;

// ---------------------------------------------------------------------------
// citedShas / verifyEvidenceShas
// ---------------------------------------------------------------------------

test("citedShas returns distinct non-empty shas", () => {
  const d = makeDecision({
    evidence: [
      { label: "a", detail: "", file: null, line: null, command: null, sha: "abc" },
      { label: "b", detail: "", file: null, line: null, command: null, sha: "abc" },
      { label: "c", detail: "", file: null, line: null, command: null, sha: " " },
      { label: "d", detail: "", file: null, line: null, command: null, sha: "def" },
    ],
  });
  assert.deepEqual(citedShas(d), ["abc", "def"]);
});

test("verifyEvidenceShas marks unverifiable shas and computes allVerified", () => {
  const d = makeDecision({
    evidence: [
      { label: "a", detail: "", file: null, line: null, command: null, sha: "good" },
      { label: "b", detail: "", file: null, line: null, command: null, sha: "bad" },
    ],
  });
  const result = verifyEvidenceShas(d, (sha) => sha === "good");
  assert.deepEqual(result.verifiedShas, ["good"]);
  assert.deepEqual(result.unverifiableShas, ["bad"]);
  assert.equal(result.allVerified, false);
});

test("verifyEvidenceShas requires at least one cited sha", () => {
  const d = makeDecision({
    evidence: [{ label: "a", detail: "", file: null, line: null, command: null, sha: null }],
  });
  const result = verifyEvidenceShas(d, verifyNone);
  assert.equal(result.citedShas.length, 0);
  assert.equal(result.allVerified, false);
});

// ---------------------------------------------------------------------------
// deriveCloseLeaning — code-derived, advisory
// ---------------------------------------------------------------------------

test("deriveCloseLeaning true for high-confidence implemented_on_main issue with verified shas", () => {
  const d = makeDecision();
  const verification = verifyEvidenceShas(d, verifyAll);
  const result = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verification,
  });
  assert.equal(result.closeLeaning, true);
});

test("deriveCloseLeaning forced false when a cited sha is unverifiable", () => {
  const d = makeDecision();
  const verification = verifyEvidenceShas(d, verifyNone);
  const result = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verification,
  });
  assert.equal(result.closeLeaning, false);
  assert.ok(result.reasons.some((r) => r.includes("unverifiable")));
});

test("deriveCloseLeaning false when decision is keep_open", () => {
  const d = makeDecision({ decision: "keep_open" });
  const result = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  assert.equal(result.closeLeaning, false);
});

test("deriveCloseLeaning false when confidence is not high", () => {
  const d = makeDecision({ confidence: "medium" });
  const result = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  assert.equal(result.closeLeaning, false);
});

test("deriveCloseLeaning false when maintainer-authored", () => {
  const d = makeDecision();
  const result = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: true,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  assert.equal(result.closeLeaning, false);
});

test("deriveCloseLeaning false when closeReason is none or not auto-close-allowed for issue", () => {
  // clawhub's issue auto-close rule is ONLY implemented_on_main, so an evidence-bearing reason
  // outside that rule (cannot_reproduce) is not auto-close-allowed → not close-leaning.
  const clawhub: RepositoryProfile = repositoryProfileFor("openclaw/clawhub");
  const d = makeDecision({ closeReason: "cannot_reproduce" });
  const result = deriveCloseLeaning({
    decision: d,
    profile: clawhub,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  assert.equal(result.closeLeaning, false);

  // "none" is never evidence-bearing and never auto-close-allowed for any profile.
  const none = makeDecision({ closeReason: "none" });
  const r2 = deriveCloseLeaning({
    decision: none,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(none, verifyAll),
  });
  assert.equal(r2.closeLeaning, false);
});

test("deriveCloseLeaning is exported from the barrel", () => {
  assert.equal(typeof deriveFromIndex, "function");
});

// ---------------------------------------------------------------------------
// analyzerFingerprint / needsReanalysis
// ---------------------------------------------------------------------------

test("analyzerFingerprint is stable and changes with any input", () => {
  const base = {
    snapshotHash: "snap",
    repoHEAD: "head",
    modelId: "internal",
    analyzerVersion: ANALYZER_VERSION,
  };
  const fp = analyzerFingerprint(base);
  assert.equal(analyzerFingerprint(base), fp);
  assert.notEqual(analyzerFingerprint({ ...base, repoHEAD: "head2" }), fp);
  assert.notEqual(analyzerFingerprint({ ...base, snapshotHash: "snap2" }), fp);
  assert.notEqual(analyzerFingerprint({ ...base, modelId: "other" }), fp);
});

test("needsReanalysis true when no persisted fingerprint or when it differs", () => {
  assert.equal(needsReanalysis(undefined, "fp"), true);
  assert.equal(needsReanalysis("old", "fp"), true);
  assert.equal(needsReanalysis("fp", "fp"), false);
});

// ---------------------------------------------------------------------------
// renderAnalyzerSections — documented ISSUE sections, deterministic
// ---------------------------------------------------------------------------

test("renderAnalyzerSections emits Summary, What I checked, Next step (issue heading)", () => {
  const d = makeDecision();
  const leaning = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  const body = renderAnalyzerSections(d, leaning);
  assert.ok(body.includes("**Summary**"));
  assert.ok(body.includes("Adds a --foo flag"));
  assert.ok(body.includes("Reproducibility:"));
  assert.ok(body.includes("What I checked:"));
  assert.ok(body.includes("src/cli.ts:42"));
  assert.ok(body.includes("**Next step**"));
  // Issue heading, never the PR "Next step before merge".
  assert.ok(!body.includes("Next step before merge"));
  // Advisory closeLeaning note present when leaning is true.
  assert.ok(body.includes("Advisory"));
});

test("renderAnalyzerSections is byte-stable across calls (planHash determinism)", () => {
  const d = makeDecision();
  const leaning = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  assert.equal(renderAnalyzerSections(d, leaning), renderAnalyzerSections(d, leaning));
});

test("renderAnalyzerSections omits advisory when not close-leaning", () => {
  const d = makeDecision({ decision: "keep_open" });
  const leaning = deriveCloseLeaning({
    decision: d,
    profile: CORE,
    kind: "issue",
    maintainerAuthored: false,
    shaVerification: verifyEvidenceShas(d, verifyAll),
  });
  const body = renderAnalyzerSections(d, leaning);
  assert.ok(!body.includes("Advisory"));
});

// ---------------------------------------------------------------------------
// serializeAnalyzerRecord — flattened front matter, frontMatterValue-parseable
// ---------------------------------------------------------------------------

test("serializeAnalyzerRecord writes flattened scalar front matter then the body", () => {
  const body = serializeAnalyzerRecord(
    {
      decision: "close",
      close_reason: "implemented_on_main",
      confidence: "high",
      type: "issue",
      author: "https://linear.app/x/issue/PAR-1",
      action_taken: "reviewed",
      reviewed_at: "2026-06-24T00:00:00Z",
      item_updated_at: "2026-06-01T00:00:00Z",
      review_comment_synced_at: "",
      review_policy: "clawsweeper:needs-maintainer-review",
      identifier: "PAR-1",
      url: "https://linear.app/x/issue/PAR-1",
      target_repo: "openclaw/clawhub",
      source_provider: "linear",
      source_id: "uuid-1",
      snapshot_hash: "snap",
      model_id: "internal",
      analyzer_version: ANALYZER_VERSION,
      repo_head: "headsha",
      close_leaning: "true",
    },
    "## review body\n\nhello",
  );
  assert.ok(body.startsWith("---\n"));
  assert.ok(body.includes('decision: "close"'));
  assert.ok(body.includes('close_leaning: "true"'));
  assert.ok(body.includes('analyzer_version: "' + ANALYZER_VERSION + '"'));
  assert.ok(body.includes("## review body"));
  // Front matter is NOT raw JSON.
  assert.ok(!body.includes("{"));
});

test("serializeAnalyzerRecord escapes embedded quotes", () => {
  const body = serializeAnalyzerRecord(
    {
      decision: "keep_open",
      close_reason: "none",
      confidence: "low",
      type: "issue",
      author: 'a "quoted" author',
      action_taken: "reviewed",
      reviewed_at: "t",
      item_updated_at: "t",
      review_comment_synced_at: "",
      review_policy: "x",
      identifier: "PAR-9",
      url: "u",
      target_repo: "openclaw/clawhub",
      source_provider: "linear",
      source_id: "uuid-9",
      snapshot_hash: "s",
      model_id: "internal",
      analyzer_version: ANALYZER_VERSION,
      repo_head: "h",
      close_leaning: "false",
    },
    "body",
  );
  assert.ok(body.includes('author: "a \\"quoted\\" author"'));
});
