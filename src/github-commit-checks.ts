import { asRecord } from "./value-coerce.js";

// GitHub returns at most 100 check runs or statuses per page. openclaw/openclaw
// PR heads routinely carry 100-250 check runs, so a single page is partial data.
export const COMMIT_CHECKS_PAGE_SIZE = 100;
// Bounded read: a head with more check runs than this reports itself incomplete.
export const COMMIT_CHECKS_MAX_PAGES = 10;

export type CommitChecks = {
  checkRuns: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  combinedState: string | null;
  complete: boolean;
};

type Page = { items: Record<string, unknown>[]; total: number | null; state?: unknown };

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkRunsPage(value: unknown): Page {
  const response = asRecord(value);
  const items = Array.isArray(response.check_runs) ? response.check_runs.map(asRecord) : [];
  return { items, total: count(response.total_count) };
}

function statusesPage(value: unknown): Page {
  const response = asRecord(value);
  const items = Array.isArray(response.statuses) ? response.statuses.map(asRecord) : [];
  return { items, total: count(response.total_count), state: response.state };
}

/**
 * Reads every check run and commit status for one commit. `readPages` takes
 * request paths and returns their JSON in order, so callers may run a batch
 * concurrently. The first page of each list gives its total; only the
 * remaining pages are requested after that.
 */
export function readCommitChecks({
  repository,
  sha,
  readPages,
}: {
  repository: string;
  sha: string;
  readPages: (paths: string[]) => unknown[];
}): CommitChecks {
  const root = `repos/${repository}/commits/${sha}`;
  const checksPath = (page: number) =>
    `${root}/check-runs?per_page=${COMMIT_CHECKS_PAGE_SIZE}&page=${page}`;
  const statusPath = (page: number) =>
    `${root}/status?per_page=${COMMIT_CHECKS_PAGE_SIZE}&page=${page}`;
  const [firstChecks, firstStatuses] = readPages([checksPath(1), statusPath(1)]);
  const checks = checkRunsPage(firstChecks);
  const statuses = statusesPage(firstStatuses);
  const remaining = (total: number | null) =>
    total === null
      ? 0
      : Math.min(COMMIT_CHECKS_MAX_PAGES, Math.ceil(total / COMMIT_CHECKS_PAGE_SIZE)) - 1;
  const checkPages = Array.from({ length: Math.max(0, remaining(checks.total)) }, (_, i) => i + 2);
  const statusPages = Array.from(
    { length: Math.max(0, remaining(statuses.total)) },
    (_, i) => i + 2,
  );
  const rest = readPages([...checkPages.map(checksPath), ...statusPages.map(statusPath)]);
  const checkRuns = [
    ...checks.items,
    ...rest.slice(0, checkPages.length).flatMap((value) => checkRunsPage(value).items),
  ];
  const statusEntries = [
    ...statuses.items,
    ...rest.slice(checkPages.length).flatMap((value) => statusesPage(value).items),
  ];
  return {
    checkRuns,
    statuses: statusEntries,
    combinedState: typeof statuses.state === "string" ? statuses.state : null,
    complete:
      checks.total !== null &&
      statuses.total !== null &&
      checkRuns.length === checks.total &&
      statusEntries.length === statuses.total,
  };
}
