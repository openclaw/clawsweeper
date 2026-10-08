import { asRecord } from "./clawsweeper-item-policy.js";
import { primaryBodySourceSha256 } from "./clawsweeper-primary-body.js";
import type { ItemContext } from "./clawsweeper-types.js";

const PASSED_CHECK_OUTCOMES = new Set(["success", "neutral", "skipped"]);
// Items other than the one under review. The agent reads their full records on demand.
const LINKED_ITEM_KEYS = [
  "relatedItems",
  "closingPullRequests",
  "referencingMergedPullRequests",
] as const;

function withoutBodies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBodies);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "body" && key !== "bodyCoverage")
      .map(([key, entry]) => [key, withoutBodies(entry)]),
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Counts every check; lists only runs and statuses that did not pass. */
function checksOutline(value: unknown): unknown {
  const checks = asRecord(value);
  const checkRuns = Array.isArray(checks.checkRuns) ? checks.checkRuns.map(asRecord) : [];
  const statuses = Array.isArray(checks.statuses) ? checks.statuses.map(asRecord) : [];
  const outcome = (value: unknown) => (typeof value === "string" ? value : "unknown");
  const runOutcome = (run: Record<string, unknown>) =>
    outcome(run.status === "completed" ? run.conclusion : run.status);
  const statusOutcome = (status: Record<string, unknown>) => outcome(status.state);
  return {
    complete: checks.complete,
    checkRunsTruncated: checks.checkRunsTruncated,
    statusesTruncated: checks.statusesTruncated,
    checkRunCounts: countBy(checkRuns.map(runOutcome)),
    checkRunsNotPassed: checkRuns.filter((run) => !PASSED_CHECK_OUTCOMES.has(runOutcome(run))),
    statusCounts: countBy(statuses.map(statusOutcome)),
    statusesNotPassed: statuses.filter((status) => statusOutcome(status) !== "success"),
  };
}

/**
 * The prompt is an index, not an archive: it carries the item under review in full and points
 * at everything else. Linked-item bodies stay inline only when the agent cannot read GitHub.
 */
export function reviewPromptContext(
  context: ItemContext,
  options: { agentCanReadGitHub: boolean },
): Omit<ItemContext, "pullCommitsRevision" | "prHydrationSnapshot"> {
  const { pullCommitsRevision: _, prHydrationSnapshot: __, ...view } = context;
  const pullRequest = asRecord(context.pullRequest);
  // `body` is only a prefix for long bodies; compare full-source identities, not prefixes.
  const pullBodySha256 = context.pullRequest ? primaryBodySourceSha256(pullRequest) : null;
  if (pullBodySha256 && pullBodySha256 === primaryBodySourceSha256(context.issue)) {
    const { bodyCoverage: _coverage, ...rest } = pullRequest;
    view.pullRequest = { ...rest, body: "[same as issue.body]" };
  }
  if (context.pullChecks !== undefined) view.pullChecks = checksOutline(context.pullChecks);
  if (options.agentCanReadGitHub) {
    for (const key of LINKED_ITEM_KEYS) {
      if (context[key]) view[key] = withoutBodies(context[key]) as unknown[];
    }
  }
  return view;
}
