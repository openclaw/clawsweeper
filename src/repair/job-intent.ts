import type { WorkerLane } from "../limits.js";
import type { JsonValue, LooseRecord } from "./json-types.js";

export const REPAIR_JOB_INTENTS = [
  "repair_cluster",
  "automerge_pr",
  "pr_repair",
  "clawsweeper_self_rebase",
  "implement_issue",
  "commit_finding",
  "low_signal_pr_cleanup",
] as const;

export type RepairJobIntent = (typeof REPAIR_JOB_INTENTS)[number];

const REPAIR_JOB_INTENT_SET = new Set<string>(REPAIR_JOB_INTENTS);

export function isRepairJobIntent(value: unknown): value is RepairJobIntent {
  return typeof value === "string" && REPAIR_JOB_INTENT_SET.has(value);
}

export function normalizeRepairJobIntent(
  value: JsonValue,
  fallback: RepairJobIntent = "repair_cluster",
): RepairJobIntent {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return isRepairJobIntent(normalized) ? normalized : fallback;
}

export function repairJobIntentFromSource(source: JsonValue): RepairJobIntent {
  const normalized = String(source ?? "").trim();
  if (normalized === "pr_automerge") return "automerge_pr";
  if (normalized === "issue_implementation") return "implement_issue";
  if (normalized === "clawsweeper_commit") return "commit_finding";
  return "repair_cluster";
}

export function repairJobIntentForFrontmatter(frontmatter: LooseRecord): RepairJobIntent {
  if (frontmatter.job_intent) {
    return normalizeRepairJobIntent(frontmatter.job_intent, "repair_cluster");
  }
  if (frontmatter.triage_policy === "low_signal_prs") return "low_signal_pr_cleanup";
  return repairJobIntentFromSource(frontmatter.source);
}

export function workerLaneForRepairJobIntent(intent: RepairJobIntent): WorkerLane {
  if (intent === "automerge_pr") return "automerge_repair";
  if (intent === "pr_repair") return "automerge_repair";
  if (intent === "clawsweeper_self_rebase") return "automerge_repair";
  if (intent === "implement_issue") return "issue_implementation";
  return "repair";
}

export function repairJobUsesClusterLane(frontmatter: LooseRecord): boolean {
  const intent = repairJobIntentForFrontmatter(frontmatter);
  if (intent !== "repair_cluster") return false;

  const clusterId = String(frontmatter.cluster_id ?? "")
    .trim()
    .toLowerCase();
  return /^gitcrawl-\d+\b/.test(clusterId) || /^ghcrawl-\d+\b/.test(clusterId);
}

export function renderJobIntentFrontmatter(intent: RepairJobIntent): string {
  return `job_intent: ${intent}`;
}
