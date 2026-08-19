import crypto from "node:crypto";

import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  CLOSE_PROTECTED_LABEL_NAMES,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
} from "./exact-review-guard-labels.js";

const PROTECTED_LABELS = new Set<string>([
  ...CLOSE_PROTECTED_LABEL_NAMES,
  HUMAN_REVIEW_LABEL,
  MANUAL_ONLY_LABEL,
]);
const CLAWSWEEPER_BOTS = new Set([
  "clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper",
  "openclaw-clawsweeper[bot]",
]);

export function issueSourceRevisionSha256(issue: LooseRecord, comments: JsonValue[] = []): string {
  const snapshot = {
    title: String(issue.title ?? ""),
    body: String(issue.body ?? ""),
    labels: revisionLabels(issue.labels ?? []),
    comments: comments
      .map(asRecord)
      .filter((comment) => !isClawSweeperComment(comment))
      .map((comment) => ({
        id: String(comment.id ?? ""),
        author: String(comment.user?.login ?? ""),
        body: String(comment.body ?? ""),
        updated_at: String(comment.updated_at ?? comment.created_at ?? ""),
      }))
      .sort((left, right) =>
        `${left.id}:${left.updated_at}`.localeCompare(`${right.id}:${right.updated_at}`),
      ),
  };
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function normalizedLabels(labels: JsonValue[]): string[] {
  return labels
    .map((label) =>
      String(label?.name ?? label)
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .sort();
}

function revisionLabels(labels: JsonValue[]): string[] {
  return normalizedLabels(labels).filter((label) => !isIgnorableAutomationLabel(label));
}

function isIgnorableAutomationLabel(label: string) {
  return (
    isClawSweeperAdvisoryLabel(label) ||
    (label.startsWith("clawsweeper:") &&
      !PROTECTED_LABELS.has(label) &&
      label !== "clawsweeper:bulk-filed") ||
    label === "no-stale" ||
    label === "stale"
  );
}

function isClawSweeperAdvisoryLabel(label: string): boolean {
  return (
    /^(?:status|rating|proof|merge-risk|impact|issue-rating):/.test(label) ||
    /^p[0-3]$/.test(label) ||
    label === "maturity:stable" ||
    label === "feature: ✨ showcase" ||
    label === "good first issue" ||
    label === "mantis: telegram-visible-proof" ||
    label === "triage: needs-real-behavior-proof"
  );
}

function isClawSweeperComment(comment: LooseRecord): boolean {
  return CLAWSWEEPER_BOTS.has(
    String(comment.user?.login ?? "")
      .trim()
      .toLowerCase(),
  );
}

function asRecord(value: JsonValue): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
