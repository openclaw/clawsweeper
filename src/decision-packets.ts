import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

export type MaintainerDecisionKind =
  | "none"
  | "product_direction"
  | "security_boundary"
  | "proof_sufficiency"
  | "release_inclusion"
  | "merge_risk"
  | "manual_review";

export type MaintainerDecisionConfidence = "high" | "medium" | "low";
export type DecisionPacketPriority = "P0" | "P1" | "P2" | "P3" | "none";
export type DecisionPacketSubjectState = "open" | "closed" | "merged";

export interface MaintainerDecisionOption {
  title: string;
  body: string;
  recommended: boolean;
}

export interface MaintainerDecisionOwner {
  person: string;
  reason: string;
  confidence: MaintainerDecisionConfidence;
}

export interface MaintainerDecision {
  required: boolean;
  kind: MaintainerDecisionKind;
  question: string;
  rationale: string;
  options: MaintainerDecisionOption[];
  likelyOwner: MaintainerDecisionOwner;
}

export interface DecisionPacket {
  version: 1;
  generatedAt: string;
  updatedAt: string;
  subject: {
    repo: string;
    kind: "issue" | "pull_request";
    number: number;
    title: string;
    url: string;
    state: DecisionPacketSubjectState;
    labels: string[];
    createdAt?: string;
    updatedAt?: string;
    stateChangedAt?: string;
    headSha?: string;
  };
  lane: Exclude<MaintainerDecisionKind, "none">;
  priority: DecisionPacketPriority;
  question: string;
  rationale: string;
  options: MaintainerDecisionOption[];
  recommendation: MaintainerDecisionOption;
  likelyOwner: MaintainerDecisionOwner;
  source: {
    reportPath: string;
    reportUrl?: string;
    reviewCommentUrl?: string;
    reviewedAt?: string;
    mainSha?: string;
  };
}

export interface DecisionPacketBuildOptions {
  generatedAt?: string;
  reportPath?: string;
  reportUrl?: string;
  subjectState?: DecisionPacketSubjectState;
}

export interface DecisionPacketSyncOptions extends DecisionPacketBuildOptions {
  markdown: string;
  reportPath: string;
  packetsDir: string;
  repoRoot: string;
}

export interface DecisionPacketSyncResult {
  markdown: string;
  packet: DecisionPacket | null;
  packetPath?: string;
  packetSha256?: string;
}

const MAINTAINER_DECISION_KINDS = new Set<MaintainerDecisionKind>([
  "none",
  "product_direction",
  "security_boundary",
  "proof_sufficiency",
  "release_inclusion",
  "merge_risk",
  "manual_review",
]);
const CONFIDENCES = new Set<MaintainerDecisionConfidence>(["high", "medium", "low"]);
const DECISION_KEYS = new Set([
  "required",
  "kind",
  "question",
  "rationale",
  "options",
  "likelyOwner",
]);
const OPTION_KEYS = new Set(["title", "body", "recommended"]);
const OWNER_KEYS = new Set(["person", "reason", "confidence"]);

export function parseMaintainerDecision(
  value: unknown,
  path = "maintainerDecision",
): MaintainerDecision {
  const record = objectValue(value, path);
  rejectUnexpectedKeys(record, DECISION_KEYS, path);
  const required = booleanValue(record.required, `${path}.required`);
  const kind = enumValue(record.kind, MAINTAINER_DECISION_KINDS, `${path}.kind`);
  const question = stringValue(record.question, `${path}.question`).trim();
  const rationale = stringValue(record.rationale, `${path}.rationale`).trim();
  if (!Array.isArray(record.options)) throw new Error(`${path}.options must be an array`);
  const options = record.options.map((entry, index) =>
    parseMaintainerDecisionOption(entry, `${path}.options[${index}]`),
  );
  if (options.length > 3) throw new Error(`${path}.options must contain at most 3 options`);
  const likelyOwner = parseMaintainerDecisionOwner(record.likelyOwner, `${path}.likelyOwner`);

  if (!required) {
    if (kind !== "none") throw new Error(`${path}.kind must be none when no decision is required`);
    if (question || rationale || options.length || likelyOwner.person || likelyOwner.reason) {
      throw new Error(`${path} must be empty when no decision is required`);
    }
  } else {
    if (kind === "none") throw new Error(`${path}.kind must identify the required decision`);
    if (!question) throw new Error(`${path}.question must not be empty`);
    if (!rationale) throw new Error(`${path}.rationale must not be empty`);
    if (options.length === 0) throw new Error(`${path}.options must contain at least 1 option`);
    if (options.filter((option) => option.recommended).length !== 1) {
      throw new Error(`${path}.options must contain exactly 1 recommended option`);
    }
    if (!likelyOwner.person) throw new Error(`${path}.likelyOwner.person must not be empty`);
    if (!likelyOwner.reason) throw new Error(`${path}.likelyOwner.reason must not be empty`);
  }

  return { required, kind, question, rationale, options, likelyOwner };
}

export function emptyMaintainerDecision(): MaintainerDecision {
  return {
    required: false,
    kind: "none",
    question: "",
    rationale: "",
    options: [],
    likelyOwner: { person: "", reason: "", confidence: "low" },
  };
}

export function maintainerDecisionFromReport(markdown: string): MaintainerDecision | null {
  const raw = frontMatter(markdown).maintainer_decision;
  if (!raw || raw === "none" || raw === "unknown") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("maintainer_decision must contain valid JSON");
  }
  return parseMaintainerDecision(parsed, "maintainer_decision");
}

export function maintainerDecisionBlocksClose(markdown: string): boolean {
  try {
    return maintainerDecisionFromReport(markdown)?.required === true;
  } catch {
    return true;
  }
}

export function buildDecisionPacketFromReport(
  markdown: string,
  options: DecisionPacketBuildOptions = {},
): DecisionPacket | null {
  const frontmatter = frontMatter(markdown);
  const decision = maintainerDecisionFromReport(markdown);
  const repo = frontmatter.repository;
  const kind = frontmatter.type;
  const number = numberValue(frontmatter.number);
  if (
    !decision?.required ||
    decision.kind === "none" ||
    !repo ||
    (kind !== "issue" && kind !== "pull_request") ||
    number === null
  ) {
    return null;
  }

  const generatedAt = options.generatedAt ?? frontmatter.reviewed_at ?? new Date().toISOString();
  const createdAt = knownValue(frontmatter.item_created_at);
  const subjectUpdatedAt =
    knownValue(frontmatter.current_item_updated_at) ?? knownValue(frontmatter.item_updated_at);
  const updatedAt = subjectUpdatedAt ?? frontmatter.reviewed_at ?? generatedAt;
  const stateChangedAt = knownValue(frontmatter.current_item_closed_at);
  const headSha = knownValue(frontmatter.pull_head_sha);
  const reviewCommentUrl = knownValue(frontmatter.review_comment_url);
  const reviewedAt = knownValue(frontmatter.reviewed_at);
  const mainSha = knownValue(frontmatter.main_sha);
  const url =
    knownValue(frontmatter.url) ??
    `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`;
  const recommendation = decision.options.find((entry) => entry.recommended);
  if (!recommendation) return null;

  return {
    version: 1,
    generatedAt,
    updatedAt,
    subject: {
      repo,
      kind,
      number,
      title: frontmatter.title ?? `#${number}`,
      url,
      state: options.subjectState ?? stateFromReport(frontmatter),
      labels: stringArrayValue(frontmatter.labels),
      ...(createdAt ? { createdAt } : {}),
      ...(subjectUpdatedAt ? { updatedAt: subjectUpdatedAt } : {}),
      ...(stateChangedAt ? { stateChangedAt } : {}),
      ...(headSha ? { headSha } : {}),
    },
    lane: decision.kind,
    priority: priorityValue(frontmatter.triage_priority),
    question: decision.question,
    rationale: decision.rationale,
    options: decision.options,
    recommendation,
    likelyOwner: decision.likelyOwner,
    source: {
      reportPath: options.reportPath ?? "",
      ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}),
      ...(reviewCommentUrl ? { reviewCommentUrl } : {}),
      ...(reviewedAt ? { reviewedAt } : {}),
      ...(mainSha ? { mainSha } : {}),
    },
  };
}

export function renderDecisionPacketPublicBlock(markdown: string): string {
  const packet = buildDecisionPacketFromReport(markdown);
  if (!packet) return "";
  const recommendation = packet.options.find((option) => option.recommended);
  const tableCell = (value: string) =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/<(?=[a-z/!?])/gi, "&lt;")
      .replace(/\r?\n|\r/g, "<br>")
      .replace(/\|/g, "\\|")
      .trim();
  if (!recommendation) {
    // A packet without a flagged recommendation is still an outstanding maintainer
    // choice; show the question and any available options instead of hiding it.
    const optionCells = packet.options.length
      ? packet.options
          .map((option) => `**${tableCell(option.title)}:** ${tableCell(option.body)}`)
          .join("<br>")
      : "Maintainer decision needed.";
    return [
      "| Question | Options |",
      "|---|---|",
      `| ${tableCell(packet.question)} | ${optionCells} |`,
      "",
      `Why: ${packet.rationale}`,
    ].join("\n");
  }
  return [
    "| Question | Recommendation |",
    "|---|---|",
    `| ${tableCell(packet.question)} | **${tableCell(recommendation.title)}:** ${tableCell(recommendation.body)} |`,
    "",
    `Why: ${packet.rationale}`,
  ].join("\n");
}

export function syncDecisionPacketRecord(
  options: DecisionPacketSyncOptions,
): DecisionPacketSyncResult {
  const packet = buildDecisionPacketFromReport(options.markdown, {
    reportPath: repoRelativePath(options.repoRoot, options.reportPath),
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}),
    ...(options.subjectState ? { subjectState: options.subjectState } : {}),
  });
  const number = numberValue(frontMatter(options.markdown).number);
  const packetPath = number === null ? undefined : `${options.packetsDir}/${number}.json`;
  if (!packet || !packetPath) {
    if (packetPath && existsSync(packetPath)) unlinkSync(packetPath);
    return {
      markdown: replacePacketFrontmatter(options.markdown, "none", "none"),
      packet: null,
      ...(packetPath ? { packetPath } : {}),
    };
  }

  mkdirSync(dirname(packetPath), { recursive: true });
  const json = `${JSON.stringify(packet, null, 2)}\n`;
  writeFileSync(packetPath, json, "utf8");
  const packetSha256 = createHash("sha256").update(json).digest("hex");
  return {
    markdown: replacePacketFrontmatter(
      options.markdown,
      repoRelativePath(options.repoRoot, packetPath),
      packetSha256,
    ),
    packet,
    packetPath,
    packetSha256,
  };
}

function parseMaintainerDecisionOption(value: unknown, path: string): MaintainerDecisionOption {
  const record = objectValue(value, path);
  rejectUnexpectedKeys(record, OPTION_KEYS, path);
  const title = stringValue(record.title, `${path}.title`).trim();
  const body = stringValue(record.body, `${path}.body`).trim();
  if (!title) throw new Error(`${path}.title must not be empty`);
  if (!body) throw new Error(`${path}.body must not be empty`);
  return { title, body, recommended: booleanValue(record.recommended, `${path}.recommended`) };
}

function parseMaintainerDecisionOwner(value: unknown, path: string): MaintainerDecisionOwner {
  const record = objectValue(value, path);
  rejectUnexpectedKeys(record, OWNER_KEYS, path);
  return {
    person: stringValue(record.person, `${path}.person`).trim(),
    reason: stringValue(record.reason, `${path}.reason`).trim(),
    confidence: enumValue(record.confidence, CONFIDENCES, `${path}.confidence`),
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
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
  if (unexpected.length) throw new Error(`${path} has unexpected keys: ${unexpected.join(", ")}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  if (typeof value === "string" && values.has(value as T)) return value as T;
  throw new Error(`${path} has invalid value`);
}

function frontMatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const values: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
  }
  return values;
}

function replacePacketFrontmatter(markdown: string, path: string, sha256: string): string {
  return replaceFrontMatterValue(
    replaceFrontMatterValue(markdown, "decision_packet_path", path),
    "decision_packet_sha256",
    sha256,
  );
}

function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  if (pattern.test(markdown)) return markdown.replace(pattern, line);
  return markdown.replace(/^---\r?\n/, `---\n${line}\n`);
}

function numberValue(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function stringArrayValue(value: string | undefined): string[] {
  if (!value || value === "none" || value === "unknown") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Legacy report labels were comma separated.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function knownValue(value: string | undefined): string | undefined {
  return value && value !== "none" && value !== "unknown" ? value : undefined;
}

function priorityValue(value: string | undefined): DecisionPacketPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" ? value : "none";
}

function stateFromReport(frontmatter: Record<string, string>): DecisionPacketSubjectState {
  if (
    frontmatter.current_state === "open" ||
    frontmatter.current_state === "closed" ||
    frontmatter.current_state === "merged"
  ) {
    return frontmatter.current_state;
  }
  return frontmatter.action_taken === "closed" ||
    frontmatter.action_taken === "skipped_already_closed"
    ? "closed"
    : "open";
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function repoRelativePath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
