import { createHash } from "node:crypto";

import type {
  PatternScorerOptions,
  PolicyPatternObservation,
  PolicyPatternType,
  ScoredPolicyPattern,
} from "./types.js";

export function scorePolicyPatterns(
  observations: readonly PolicyPatternObservation[],
  options: PatternScorerOptions,
): ScoredPolicyPattern[] {
  const minDistinctItems = options.minDistinctItems ?? Math.min(2, options.minOccurrences);
  const minDistinctRepos = options.minDistinctRepos ?? 1;
  const groups = new Map<string, PolicyPatternObservation[]>();

  for (const observation of observations) {
    const key = `${observation.patternType}\0${observation.value}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const scored: ScoredPolicyPattern[] = [];
  for (const group of groups.values()) {
    const sortedGroup = [...group].sort(compareObservation);
    const first = sortedGroup[0];
    if (!first) continue;
    const distinctItems = sortedUnique(sortedGroup.map((item) => `${item.repo}${item.item}`));
    const distinctRepos = sortedUnique(sortedGroup.map((item) => item.repo));
    if (sortedGroup.length < options.minOccurrences) continue;
    if (distinctItems.length < minDistinctItems) continue;
    if (distinctRepos.length < minDistinctRepos) continue;

    const successfulOutcomes = sortedGroup.filter((item) => item.successfulOutcome).length;
    const latestObservedAt = latestDate(sortedGroup);
    const confidenceScore = confidence({
      occurrenceCount: sortedGroup.length,
      distinctItems: distinctItems.length,
      distinctRepos: distinctRepos.length,
      successfulOutcomes,
      latestObservedAt,
      now: options.now ?? new Date(),
    });

    scored.push({
      id: policyPatternId(first.patternType, first.value),
      patternType: first.patternType,
      value: first.value,
      title: policyTitle(first.patternType, first.value),
      confidenceScore,
      occurrenceCount: sortedGroup.length,
      distinctItems,
      distinctRepos,
      successfulOutcomes,
      latestObservedAt,
      evidenceItems: sortedGroup.slice(0, 20),
      proposedConditions: proposedConditions(first.patternType, first.value),
      proposedAction: proposedAction(first.patternType),
      safetyConstraints: safetyConstraints(first.patternType),
      sourceRecords: sortedUnique(sortedGroup.map((item) => item.sourceRecord)),
    });
  }

  return scored.sort(
    (left, right) =>
      right.confidenceScore - left.confidenceScore ||
      right.occurrenceCount - left.occurrenceCount ||
      left.id.localeCompare(right.id),
  );
}

function confidence(options: {
  occurrenceCount: number;
  distinctItems: number;
  distinctRepos: number;
  successfulOutcomes: number;
  latestObservedAt?: string | undefined;
  now: Date;
}): number {
  const occurrence = Math.min(options.occurrenceCount / 10, 1) * 0.35;
  const itemSpread = Math.min(options.distinctItems / 5, 1) * 0.25;
  const repoSpread = Math.min(options.distinctRepos / 2, 1) * 0.15;
  const success =
    Math.min(options.successfulOutcomes / Math.max(options.occurrenceCount, 1), 1) * 0.15;
  const recentness = recencyScore(options.latestObservedAt, options.now) * 0.1;
  return Number((occurrence + itemSpread + repoSpread + success + recentness).toFixed(3));
}

function recencyScore(latestObservedAt: string | undefined, now: Date): number {
  if (!latestObservedAt) return 0.3;
  const latest = new Date(latestObservedAt);
  if (Number.isNaN(latest.valueOf())) return 0.3;
  const ageDays = Math.max(0, (now.valueOf() - latest.valueOf()) / 86_400_000);
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.7;
  if (ageDays <= 180) return 0.4;
  return 0.2;
}

function policyPatternId(patternType: PolicyPatternType, value: string): string {
  const slug = `${patternType}-${value}`
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  const hash = createHash("sha256").update(`${patternType}:${value}`).digest("hex").slice(0, 8);
  return `policy-rfc-${slug}-${hash}`;
}

function policyTitle(patternType: PolicyPatternType, value: string): string {
  return `Policy RFC: ${labelForPatternType(patternType)} - ${value}`;
}

function labelForPatternType(patternType: PolicyPatternType): string {
  return patternType
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function proposedConditions(patternType: PolicyPatternType, value: string): string[] {
  return [
    `The observed ${labelForPatternType(patternType).toLowerCase()} is "${value}".`,
    "At least the configured minimum number of distinct records show the same pattern.",
    "The source record has durable ClawSweeper evidence and is not a malformed or partial record.",
  ];
}

function proposedAction(patternType: PolicyPatternType): string {
  switch (patternType) {
    case "label":
      return "Document a candidate review heuristic for this repeated label; do not mutate labels automatically.";
    case "review_verdict":
      return "Document the repeated review verdict as a candidate triage heuristic for maintainer review.";
    case "safe_close_reason":
      return "Document a candidate close-policy clarification; keep all close actions on existing apply paths.";
    case "automerge_repair_cause":
      return "Document a candidate automerge repair precondition; do not change automerge behavior automatically.";
    case "file_conflict_type":
      return "Document a candidate conflict-handling policy for repair planning only.";
    case "repair_marker":
      return "Document a candidate repair policy based on repeated repair markers.";
  }
}

function safetyConstraints(patternType: PolicyPatternType): string[] {
  const base = [
    "Proposal-only: this RFC must not execute policy automatically.",
    "No GitHub mutation is allowed from the Policy RFC Engine.",
    "Existing scheduler review, apply, close, and automerge paths remain unchanged.",
  ];
  if (patternType === "safe_close_reason") {
    return [
      ...base,
      "Any close behavior must continue to require existing repository close rules.",
    ];
  }
  if (patternType === "automerge_repair_cause") {
    return [
      ...base,
      "Automerge eligibility must continue to be decided by existing automerge guards.",
    ];
  }
  return base;
}

function latestDate(observations: readonly PolicyPatternObservation[]): string | undefined {
  const dates = observations
    .map((item) => item.observedAt)
    .filter((item): item is string => Boolean(item))
    .sort();
  return dates.at(-1);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareObservation(
  left: PolicyPatternObservation,
  right: PolicyPatternObservation,
): number {
  return (
    left.repo.localeCompare(right.repo) ||
    left.item.localeCompare(right.item) ||
    left.sourceRecord.localeCompare(right.sourceRecord)
  );
}
