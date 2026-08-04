/**
 * Linear analysis layer — pure, offline mapping from a parsed ClawSweeper Decision to the
 * review-comment sections, the code-derived closeLeaning advisory, the analyzer fingerprint,
 * and the record front-matter serialization.
 *
 * Doctrine — the model runs at the runner's IMPURE boundary; this module never calls a model,
 * never reads git, never touches the network or the clock:
 *   The runner (scripts/linear-analyze.mjs) calls the existing Codex review harness
 *   (clawsweeper.ts runCodex) under sandbox:'read-only'. The MODEL runs its own read-only
 *   git blame/log/show inside the sandbox and emits evidence[]{file,line,command,sha}. The
 *   HOST only RE-VERIFIES cited SHAs (git rev-parse/cat-file) and forces closeLeaning=false
 *   on any unverifiable sha. That parsed Decision is then passed into THIS module as plain
 *   data; every function here is a pure function of its inputs and is unit-testable with
 *   fakes only — no live model, no live Linear, no live git.
 *
 * REUSE, never reinvent:
 *   - schema/clawsweeper-decision.schema.json is the model's --output-schema verbatim; this
 *     module consumes the parsed Decision and canonical closeReason enum, the
 *     evidence[] item shape, reproductionStatus/reproductionAssessment, changeSummary,
 *     workReason/bestSolution, rootCauseCluster). No new schema is coined.
 *   - closeLeaning is the ONLY new bit, and it is CODE-DERIVED, advisory, and NEVER a schema
 *     field / CloseEvidence / a close mutation. It composes authority.EVIDENCE_CLOSE_REASONS
 *     + repository-profiles.isAutoCloseAllowed; the close gate stays default-closed and only
 *     the comment gate may ever open.
 *   - The review sections follow docs/pr-review-comments.md (the ISSUE "**Next step**" heading,
 *     not the PR "Next step before merge"); the body is rendered from the cached deterministic
 *     Decision so comment.planHashFor noops on an unchanged re-plan.
 */

import { EVIDENCE_CLOSE_REASONS } from "./authority.js";
import type { CloseConfidence, CloseDecision, CloseReason } from "./authority.js";
import type { RepositoryItemKind, RepositoryProfile } from "../repository-profiles.js";
import { isAutoCloseAllowed } from "../repository-profiles.js";

/** Current analyzer version. Bump when the prompt, mapping, or sections change materially. */
export const ANALYZER_VERSION = "linear-analyzer/3" as const;

/** Model identity is left to the harness config; the runner records the resolved id. */
export const ANALYZER_INTERNAL_MODEL = "internal" as const;

/**
 * A single piece of model-emitted evidence (mirrors the decision schema `evidence[]` item:
 * label, detail, file, line, command, sha). The host re-verifies any non-null `sha`.
 */
export interface AnalyzerEvidence {
  label: string;
  detail: string;
  file: string | null;
  line: number | null;
  command: string | null;
  sha: string | null;
}

/**
 * The subset of the parsed ClawSweeper Decision the analysis layer consumes. Field names
 * mirror schema/clawsweeper-decision.schema.json exactly; nothing is renamed. PR-only fields
 * are simply absent for issues. This is plain data — the runner parses the model's output
 * (via the harness's parseDecision) and hands the relevant slice in.
 */
export interface AnalyzerDecision {
  decision: CloseDecision; // "close" | "keep_open"
  closeReason: CloseReason; // canonical schema enum (including "none")
  confidence: CloseConfidence; // "high" | "medium" | "low"
  changeSummary: string;
  evidence: AnalyzerEvidence[];
  reproductionStatus: string;
  reproductionAssessment: string;
  workReason: string;
  bestSolution: string;
  /** Optional advisory duplicate-discovery (schema rootCauseCluster). */
  rootCauseCluster?: {
    confidence?: string;
    canonicalRef?: string | null;
    currentItemRelationship?: string;
    summary?: string;
  };
}

/** Verifies whether a cited git object/sha exists in the local checkout. Pure of this module. */
export type ShaVerifier = (sha: string) => boolean;

/** The result of re-verifying every cited sha in a Decision's evidence. */
export interface ShaVerificationResult {
  citedShas: string[]; // distinct, non-empty shas the model cited
  verifiedShas: string[]; // subset that the host confirmed exists
  unverifiableShas: string[]; // cited but NOT confirmed — forces closeLeaning=false
  allVerified: boolean; // true iff at least one sha is cited and every cited sha verified
}

/** Returns the distinct, non-empty, trimmed shas cited across a Decision's evidence. */
export function citedShas(decision: AnalyzerDecision): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of decision.evidence) {
    const sha = (e.sha ?? "").trim();
    if (sha !== "" && !seen.has(sha)) {
      seen.add(sha);
      out.push(sha);
    }
  }
  return out;
}

/**
 * Re-verifies every cited sha with the host-supplied verifier. Pure given `verify`. The runner
 * passes a verifier backed by `git rev-parse --verify <sha>^{commit}` / `git cat-file -e` in
 * the mapped local checkout; tests pass a fake. Any cited-but-unverifiable sha makes
 * `allVerified` false, which forces closeLeaning=false downstream.
 */
export function verifyEvidenceShas(
  decision: AnalyzerDecision,
  verify: ShaVerifier,
): ShaVerificationResult {
  const cited = citedShas(decision);
  const verified: string[] = [];
  const unverifiable: string[] = [];
  for (const sha of cited) {
    if (verify(sha)) verified.push(sha);
    else unverifiable.push(sha);
  }
  return {
    citedShas: cited,
    verifiedShas: verified,
    unverifiableShas: unverifiable,
    allVerified: cited.length > 0 && unverifiable.length === 0,
  };
}

/** Inputs to the code-derived closeLeaning predicate. */
export interface CloseLeaningInput {
  decision: AnalyzerDecision;
  profile: RepositoryProfile;
  kind: RepositoryItemKind; // "issue" for Linear items
  maintainerAuthored: boolean;
  /** Result of host sha re-verification — closeLeaning is forced false unless allVerified. */
  shaVerification: ShaVerificationResult;
}

/** A closeLeaning verdict plus the ordered, secret-free reasons that produced it. */
export interface CloseLeaning {
  closeLeaning: boolean;
  reasons: string[];
}

/**
 * The code-derived, advisory closeLeaning predicate. NEVER a schema field, NEVER a
 * CloseEvidence, NEVER a close/state mutation — it is a hint a maintainer reads.
 *
 *   closeLeaning :=
 *        decision === "close"
 *     && confidence === "high"
 *     && EVIDENCE_CLOSE_REASONS.has(closeReason)
 *     && maintainerAuthored !== true
 *     && isAutoCloseAllowed(profile, kind, closeReason)
 *     && shaVerification.allVerified         // any unverifiable cited sha forces false
 *
 * For Linear issues this is true only when closeReason === "implemented_on_main", even when
 * the underlying repository profile permits broader issue close reasons. The close gate stays
 * default-closed; this never opens it.
 */
export function deriveCloseLeaning(input: CloseLeaningInput): CloseLeaning {
  const { decision, profile, kind, maintainerAuthored, shaVerification } = input;
  const reasons: string[] = [];

  if (decision.decision !== "close") {
    reasons.push(`decision is "${decision.decision}" — not close-leaning`);
  }
  if (decision.confidence !== "high") {
    reasons.push(`confidence is "${decision.confidence}" — close-leaning requires high`);
  }
  if (!EVIDENCE_CLOSE_REASONS.has(decision.closeReason)) {
    reasons.push(`closeReason "${decision.closeReason}" is not evidence-bearing`);
  }
  if (maintainerAuthored) {
    reasons.push("issue is maintainer-authored — never close-leaning");
  }
  const allowedByRepositoryProfile = isAutoCloseAllowed(profile, kind, decision.closeReason);
  const allowedByLinearAnalyzer =
    kind !== "issue" || decision.closeReason === "implemented_on_main";
  if (!allowedByRepositoryProfile || !allowedByLinearAnalyzer) {
    reasons.push(
      `closeReason "${decision.closeReason}" is not auto-close-allowed for ${kind} in ${profile.targetRepo}`,
    );
  }
  if (shaVerification.citedShas.length === 0) {
    reasons.push("no commit evidence cited — forcing closeLeaning=false");
  } else if (!shaVerification.allVerified) {
    reasons.push(
      `unverifiable cited sha(s) [${shaVerification.unverifiableShas.join(", ")}] — forcing closeLeaning=false`,
    );
  }

  const closeLeaning = reasons.length === 0;
  if (closeLeaning) {
    reasons.push(
      `close-leaning: high-confidence ${decision.closeReason} for ${kind} in ${profile.targetRepo}, all cited shas verified — advisory only, ClawSweeper never closes`,
    );
  }
  return { closeLeaning, reasons };
}

/**
 * The analyzer fingerprint persisted in the record front matter and used to gate
 * re-analysis. It is deliberately SEPARATE from linearReviewSnapshotHash (which must stay
 * live-Linear-recomputable for the apply-time drift gate). Re-run the model only when this
 * fingerprint would change: repo HEAD moved, model id changed, analyzer version bumped, or
 * the source snapshot drifted.
 */
export interface AnalyzerFingerprintInput {
  snapshotHash: string; // record.snapshotHash (the live-Linear drift fingerprint)
  commentContextHash: string; // bounded canonical comment context passed to the model
  repoHEAD: string; // the analyzed checkout's HEAD sha
  modelId: string; // resolved model id (e.g. "internal" → harness config.toml governs)
  analyzerVersion: string; // ANALYZER_VERSION
}

/** Stable string fingerprint; equality means "no need to re-analyze". */
export function analyzerFingerprint(input: AnalyzerFingerprintInput): string {
  return [
    `snapshot=${input.snapshotHash}`,
    `comments=${input.commentContextHash}`,
    `head=${input.repoHEAD}`,
    `model=${input.modelId}`,
    `analyzer=${input.analyzerVersion}`,
  ].join(";");
}

/** True iff a fresh fingerprint differs from the persisted one (or none was persisted). */
export function needsReanalysis(persisted: string | undefined, fresh: string): boolean {
  return persisted === undefined || persisted !== fresh;
}

// --- Review-comment sections (docs/pr-review-comments.md) --------------------------------

function nonEmpty(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Renders the analyzer-derived sections appended to the deterministic review content. Follows
 * docs/pr-review-comments.md for ISSUES (the "**Next step**" heading, not the PR
 * "Next step before merge"). Pure and deterministic in its inputs, so the comment body — and
 * therefore comment.planHashFor — is byte-stable across re-plans of an unchanged Decision.
 *
 * Sections, in order, each omitted when its source field is empty:
 *   **Summary**           — changeSummary (+ compact Reproducibility line when present)
 *   What I checked:       — evidence[] (label — detail [file:line] [git command] [sha])
 *   Reproducibility:      — reproductionAssessment (top-level fallback if not folded above)
 *   **Next step**         — workReason (issue next action) or bestSolution
 *   Remaining risk:       — bestSolution when it adds a distinct end-state
 *   (closeLeaning advisory line, when true)
 */
export function renderAnalyzerSections(
  decision: AnalyzerDecision,
  closeLeaning: CloseLeaning,
): string {
  const lines: string[] = [];

  // **Summary** + folded Reproducibility line.
  if (nonEmpty(decision.changeSummary)) {
    lines.push("**Summary**");
    lines.push("");
    lines.push(decision.changeSummary.trim());
    if (nonEmpty(decision.reproductionAssessment)) {
      lines.push("");
      lines.push(`Reproducibility: ${decision.reproductionAssessment.trim()}`);
    }
    lines.push("");
  } else if (nonEmpty(decision.reproductionAssessment)) {
    lines.push(`Reproducibility: ${decision.reproductionAssessment.trim()}`);
    lines.push("");
  }

  // What I checked: — the model's own evidence, with cited file:line / command / sha.
  const evidenceLines = decision.evidence
    .map((e) => renderEvidenceLine(e))
    .filter((l) => l.length > 0);
  if (evidenceLines.length > 0) {
    lines.push("What I checked:");
    for (const l of evidenceLines) lines.push(`- ${l}`);
    lines.push("");
  }

  // **Next step** (ISSUE heading) — work next action, falling back to bestSolution.
  const nextStep = nonEmpty(decision.workReason)
    ? decision.workReason.trim()
    : nonEmpty(decision.bestSolution)
      ? decision.bestSolution.trim()
      : "";
  if (nextStep !== "") {
    lines.push("**Next step**");
    lines.push("");
    lines.push(nextStep);
    lines.push("");
  }

  // Remaining risk: — only when bestSolution adds a distinct end-state beyond the next step.
  if (nonEmpty(decision.bestSolution) && decision.bestSolution.trim() !== nextStep) {
    lines.push(`Remaining risk: ${decision.bestSolution.trim()}`);
    lines.push("");
  }

  // Advisory closeLeaning note (never a close; a hint a maintainer reads).
  if (closeLeaning.closeLeaning) {
    lines.push(
      `_Advisory: ClawSweeper leans toward closing this (high-confidence ${decision.closeReason}, all cited evidence verified) — but it never closes; a maintainer decides._`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Renders one evidence bullet: "label — detail [file:line] (`command`) (sha)". */
function renderEvidenceLine(e: AnalyzerEvidence): string {
  const head = nonEmpty(e.label) ? e.label.trim() : "";
  const detail = nonEmpty(e.detail) ? e.detail.trim() : "";
  let line = [head, detail].filter((p) => p.length > 0).join(" — ");
  if (nonEmpty(e.file)) {
    line += e.line != null ? ` [${e.file}:${e.line}]` : ` [${e.file}]`;
  }
  if (nonEmpty(e.command)) line += ` (\`${e.command?.trim()}\`)`;
  if (nonEmpty(e.sha)) line += ` (${e.sha?.trim()})`;
  return line.trim();
}

// --- Record front-matter serialization (mirrors the GitHub lane) ------------------------

/** Flattened scalar front-matter fields persisted in records/<workspaceSlug>/items/<key>.md. */
export interface AnalyzerRecordFrontMatter {
  // GitHub-lane vocabulary.
  decision: string; // "close" | "keep_open"
  close_reason: string; // canonical enum
  confidence: string;
  type: string; // "issue"
  author: string;
  action_taken: string; // always "reviewed" — analysis never mutates state
  reviewed_at: string; // caller-supplied ISO (runner's nowIso)
  item_updated_at: string; // issue.updatedAt
  review_comment_synced_at: string; // ISO or "" when dry-run
  review_policy: string; // routing label / policy ruleId
  // Linear identity + drift fingerprint.
  identifier: string;
  url: string;
  target_repo: string;
  source_provider: string;
  source_id: string;
  snapshot_hash: string;
  comment_context_hash: string;
  // Analyzer fingerprint.
  model_id: string;
  analyzer_version: string;
  repo_head: string;
  close_leaning: string; // "true" | "false" — advisory
}

/** Quotes a front-matter value (always double-quoted, with embedded quotes escaped). */
function fm(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serializes the record file body: `--- ` front matter (FLATTENED scalar keys, NOT raw JSON,
 * frontMatterValue-parseable) followed by the rendered review-comment body. Mirrors the
 * GitHub lane's records/<workspaceSlug>/items/<key>.md shape. Pure; no I/O (the runner writes).
 */
export function serializeAnalyzerRecord(
  frontMatter: AnalyzerRecordFrontMatter,
  reviewBody: string,
): string {
  const order: Array<keyof AnalyzerRecordFrontMatter> = [
    "decision",
    "close_reason",
    "confidence",
    "type",
    "author",
    "action_taken",
    "reviewed_at",
    "item_updated_at",
    "review_comment_synced_at",
    "review_policy",
    "identifier",
    "url",
    "target_repo",
    "source_provider",
    "source_id",
    "snapshot_hash",
    "comment_context_hash",
    "model_id",
    "analyzer_version",
    "repo_head",
    "close_leaning",
  ];
  const head = order.map((key) => `${key}: ${fm(frontMatter[key])}`);
  return ["---", ...head, "---", "", reviewBody.trimEnd(), ""].join("\n");
}
