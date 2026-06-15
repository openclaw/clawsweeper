import { codexLoginConfig, codexModelArgs } from "./codex-env.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexEnv } from "./codex-env.js";
import { runCodexProcess } from "./codex-process.js";
import { safeOutputTail, truncateText } from "./clawsweeper-text.js";

export type PrCloseCoverageProofModelDecision = "covered" | "keep_open";

export interface PrCloseCoverageProofModelResult {
  sourceSummary: string;
  coveringSummary: string;
  coveredWork: string[];
  uniqueSourceWork: string[];
  decision: PrCloseCoverageProofModelDecision;
  reason: string;
}

export interface PrCloseCoverageProofCloseDecision {
  close: boolean;
  reason: string;
  proof: PrCloseCoverageProofModelResult;
}

export interface PrCloseCoverageProofPullRequestView {
  number: number;
  title: string;
  url: string;
  state: string;
  mergedAt: string | null;
  body: string;
  updatedAt: string | null;
  comments: unknown[];
  commentsTruncated: boolean;
}

export interface PrCloseCoverageProofRuntime {
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
  rootDir: string;
  schemaPath: string;
  promptTemplate: string;
  ghToken?: string;
}

const PR_CLOSE_COVERAGE_PROOF_DECISIONS = new Set<PrCloseCoverageProofModelDecision>([
  "covered",
  "keep_open",
]);

const PR_CLOSE_COVERAGE_PROOF_SCHEMA_KEYS = new Set([
  "sourceSummary",
  "coveringSummary",
  "coveredWork",
  "uniqueSourceWork",
  "decision",
  "reason",
]);
const PR_CLOSE_COVERAGE_PROOF_GENERIC_WORDS = new Set([
  "a",
  "an",
  "and",
  "b",
  "behavior",
  "candidate",
  "carries",
  "carry",
  "close",
  "cover",
  "covered",
  "covering",
  "covers",
  "fix",
  "fixed",
  "fixes",
  "forward",
  "from",
  "includes",
  "intent",
  "it",
  "pr",
  "proposed",
  "same",
  "source",
  "support",
  "supported",
  "supports",
  "that",
  "the",
  "this",
  "work",
]);

export function parsePrCloseCoverageProofModelResult(
  value: unknown,
): PrCloseCoverageProofModelResult {
  const parsed = requireRecord(value, "prCloseCoverageProof");
  rejectUnexpectedKeys(parsed, PR_CLOSE_COVERAGE_PROOF_SCHEMA_KEYS, "prCloseCoverageProof");
  return {
    sourceSummary: requireString(parsed.sourceSummary, "prCloseCoverageProof.sourceSummary"),
    coveringSummary: requireString(parsed.coveringSummary, "prCloseCoverageProof.coveringSummary"),
    coveredWork: requireStringArray(parsed.coveredWork, "prCloseCoverageProof.coveredWork"),
    uniqueSourceWork: requireStringArray(
      parsed.uniqueSourceWork,
      "prCloseCoverageProof.uniqueSourceWork",
    ),
    decision: requireEnum(
      parsed.decision,
      PR_CLOSE_COVERAGE_PROOF_DECISIONS,
      "prCloseCoverageProof.decision",
    ),
    reason: requireString(parsed.reason, "prCloseCoverageProof.reason"),
  };
}

export function normalizedPrCloseCoverageProofModelResult(
  proof: PrCloseCoverageProofModelResult,
): PrCloseCoverageProofModelResult {
  const normalizedProof = {
    ...proof,
    sourceSummary: proof.sourceSummary.trim(),
    coveringSummary: proof.coveringSummary.trim(),
    coveredWork: proof.coveredWork.map((entry) => entry.trim()).filter(Boolean),
    uniqueSourceWork: proof.uniqueSourceWork.map((entry) => entry.trim()).filter(Boolean),
    reason: proof.reason.trim(),
  };
  if (normalizedProof.decision !== "covered") return normalizedProof;
  if (prCloseCoverageProofHasConcreteCloseEvidence(normalizedProof)) return normalizedProof;
  return {
    ...normalizedProof,
    decision: "keep_open",
    reason: `model PR close coverage proof was incomplete: ${
      normalizedProof.reason || "missing concrete coverage proof"
    }`,
  };
}

export function prCloseCoverageProofCloseDecision(
  proof: PrCloseCoverageProofModelResult,
): PrCloseCoverageProofCloseDecision {
  const normalized = normalizedPrCloseCoverageProofModelResult(proof);
  return {
    close: normalized.decision === "covered",
    reason: normalized.reason || "PR close coverage proof was incomplete",
    proof: normalized,
  };
}

export function compactPrCloseCoverageProofText(value: unknown, limit = 200): string {
  if (typeof value !== "string") return "";
  return truncateText(value.replace(/\s+/g, " ").trim(), limit);
}

export function compactPrCloseCoverageProofComment(value: unknown): unknown {
  const comment = requireRecord(value, "comment");
  return {
    author: loginFromCommentUser(comment.user) ?? stringFromUnknown(comment.author),
    createdAt: stringFromUnknown(comment.created_at) ?? stringFromUnknown(comment.createdAt),
    updatedAt: stringFromUnknown(comment.updated_at) ?? stringFromUnknown(comment.updatedAt),
    body: compactPrCloseCoverageProofText(comment.body, 800),
  };
}

export function formatPrCloseCoverageProofDetailList(values: readonly string[]): string {
  if (!values.length) return "  - none";
  return values.map((value) => `  - ${value}`).join("\n");
}

export function prCloseCoverageProofStateText(
  covering: Pick<PrCloseCoverageProofPullRequestView, "mergedAt">,
): string {
  return covering.mergedAt ? `merged at ${covering.mergedAt}` : "still open as the covering PR";
}

export function prCloseCoverageProofCandidateCanClose(
  covering: Pick<PrCloseCoverageProofPullRequestView, "state" | "mergedAt">,
): boolean {
  return covering.state === "open" || Boolean(covering.mergedAt);
}

export function summarizePrCloseCoverageProofPullRequest(
  pull: PrCloseCoverageProofPullRequestView,
): string {
  const body = compactPrCloseCoverageProofText(pull.body);
  const bodyText = body ? ` Body: ${body}` : "";
  const commentText = pull.comments.length
    ? ` Comments hydrated: ${pull.comments.length}${pull.commentsTruncated ? " (truncated)" : ""}.`
    : "";
  return `#${pull.number} ${pull.title}.${bodyText}${commentText}`;
}

function stringifyPrCloseCoverageProofPromptJson(value: unknown, space?: number): string {
  const serialized = JSON.stringify(value, null, space);
  // These JSON payloads live inside Markdown fences, so untrusted backticks must stay escaped.
  return (serialized ?? "null").replace(/`/g, "\\u0060");
}

export function buildPrCloseCoverageProofPrompt(options: {
  source: PrCloseCoverageProofPullRequestView;
  covering: PrCloseCoverageProofPullRequestView;
  reportMarkdown: string;
  relationshipSignalSnippets: readonly string[];
  promptTemplate: string;
}): string {
  return [
    options.promptTemplate.trimEnd(),
    "",
    "Candidate relationship signal snippets:",
    "```json",
    stringifyPrCloseCoverageProofPromptJson(options.relationshipSignalSnippets, 2),
    "```",
    "",
    "PR A source report JSON string:",
    "```json",
    stringifyPrCloseCoverageProofPromptJson(options.reportMarkdown.trim()),
    "```",
    "",
    "Current PR title, body, and comments:",
    "```json",
    stringifyPrCloseCoverageProofPromptJson(
      {
        sourcePrA: options.source,
        coveringPrB: options.covering,
      },
      2,
    ),
    "```",
  ].join("\n");
}

export function runPrCloseCoverageProofModel(options: {
  source: PrCloseCoverageProofPullRequestView;
  covering: PrCloseCoverageProofPullRequestView;
  markdown: string;
  relationshipSignalSnippets: readonly string[];
  runtime: PrCloseCoverageProofRuntime;
}): PrCloseCoverageProofModelResult {
  mkdirSync(options.runtime.workDir, { recursive: true });
  const prefix = `${options.source.number}-${options.covering.number}`;
  const outputPath = join(options.runtime.workDir, `${prefix}.json`);
  const prompt = buildPrCloseCoverageProofPrompt({
    source: options.source,
    covering: options.covering,
    reportMarkdown: options.markdown,
    relationshipSignalSnippets: options.relationshipSignalSnippets,
    promptTemplate: options.runtime.promptTemplate,
  });
  writeFileSync(join(options.runtime.workDir, `${prefix}.prompt.md`), prompt, "utf8");
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const codexConfig = [
    `model_reasoning_effort="${options.runtime.reasoningEffort}"`,
    codexLoginConfig(),
    'approval_policy="never"',
  ];
  if (options.runtime.serviceTier) {
    codexConfig.splice(1, 0, `service_tier="${options.runtime.serviceTier}"`);
  }
  const result = runCodexProcess({
    args: [
      "exec",
      ...codexModelArgs(options.runtime.model),
      ...codexConfig.flatMap((config) => ["-c", config]),
      "-C",
      options.runtime.rootDir,
      "--output-schema",
      options.runtime.schemaPath,
      "--output-last-message",
      outputPath,
      "--sandbox",
      options.runtime.sandboxMode,
      "-",
    ],
    cwd: options.runtime.rootDir,
    env: codexEnv({ ghToken: options.runtime.ghToken }),
    input: prompt,
    timeoutMs: options.runtime.timeoutMs,
  });
  if (result.error) {
    throw new Error(
      `Codex PR close coverage proof failed for #${options.source.number}: ${
        result.error.message
      }\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
    );
  }
  if (result.status !== 0) {
    if (existsSync(outputPath)) {
      try {
        return readPrCloseCoverageProofModelOutput(outputPath);
      } catch (error) {
        throw new Error(
          `Codex PR close coverage proof failed for #${options.source.number} with exit ${
            result.status ?? "unknown"
          } and wrote invalid JSON or schema-invalid output to ${outputPath}: ${
            error instanceof Error ? error.message : String(error)
          }.\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
        );
      }
    }
    throw new Error(
      `Codex PR close coverage proof failed for #${options.source.number} with exit ${
        result.status ?? "unknown"
      }.\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."}`,
    );
  }
  if (!existsSync(outputPath)) {
    throw new Error(`Codex PR close coverage proof did not write ${outputPath}.`);
  }
  return readPrCloseCoverageProofModelOutput(outputPath);
}

export function readPrCloseCoverageProofModelOutput(
  outputPath: string,
): PrCloseCoverageProofModelResult {
  return normalizedPrCloseCoverageProofModelResult(
    parsePrCloseCoverageProofModelResult(JSON.parse(readFileSync(outputPath, "utf8").trim())),
  );
}

function prCloseCoverageProofHasConcreteCloseEvidence(
  proof: PrCloseCoverageProofModelResult,
): boolean {
  return (
    proof.sourceSummary.trim().length > 0 &&
    proof.coveringSummary.trim().length > 0 &&
    proof.coveredWork.length > 0 &&
    proof.coveredWork.some(prCloseCoverageProofCoveredWorkIsConcrete) &&
    proof.uniqueSourceWork.length === 0 &&
    proof.reason.trim().length > 0
  );
}

function prCloseCoverageProofCoveredWorkIsConcrete(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  const words = normalized.match(/\b[a-z0-9][a-z0-9'-]*\b/g) ?? [];
  if (words.length < 4) return false;
  const concreteWords = words
    .map((word) => word.replace(/'s$/, ""))
    .filter((word) => !PR_CLOSE_COVERAGE_PROOF_GENERIC_WORDS.has(word));
  if (concreteWords.length < 2) return false;
  if (
    /\b(?:touch(?:es|ed)?|chang(?:es|ed|ing)|modif(?:ies|ied)|updates?|mentions?|references?)\b.*\b(?:same|nearby|related|shared)\b.*\b(?:file|files|package|module|area|code|path|component|discussion)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /\b(?:behavior|intent|review concern|fix(?:es|ed)?|handling|support|validation|proof|guard|route|transport|proxy|bypass|loopback|embeddings?|restart|drain|legacy|config)\b/.test(
    normalized,
  );
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new Error(`${path} had unexpected keys: ${unexpected.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value];
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${path} must be one of: ${[...allowed].join(", ")}`);
  }
  return value as T;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function loginFromCommentUser(value: unknown): string | undefined {
  const user = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!user || !("login" in user)) return undefined;
  return stringFromUnknown(user.login);
}
