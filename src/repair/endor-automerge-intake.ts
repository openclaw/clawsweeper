import { pathToFileURL } from "node:url";
import { isRecord, requirePositiveInteger, requireRecord, requireString } from "../value-coerce.js";
import { ghJsonWithRetry, type GhRetryOptions } from "./github-cli.js";
import { parseArgs } from "./lib.js";
import { AUTOMERGE_BLOCKING_LABEL_NAMES, AUTOMERGE_LABEL } from "./exact-review-guard-labels.js";

type GitHub = (args: string[], options?: GhRetryOptions) => unknown;
const TARGET_REPO = "openclaw/openclaw";
const ENDOR_LOGIN = "endor-labs-pro[bot]";
const ENDOR_USER_ID = 179191674;
const CONTROL_LABELS = new Set<string>([AUTOMERGE_LABEL, ...AUTOMERGE_BLOCKING_LABEL_NAMES]);

export function enrollEndorPullRequests({
  repo,
  execute = false,
  github = ghJsonWithRetry,
}: {
  repo: string;
  execute?: boolean;
  github?: GitHub;
}): { number: number; status: "enrolled" | "planned" | "skipped" }[] {
  if (repo !== TARGET_REPO)
    throw new Error(`Endor automerge intake is restricted to ${TARGET_REPO}`);
  const repository = requireRecord(github(["api", `repos/${repo}`]), "repository");
  if (
    repository.full_name !== repo ||
    repository.private !== false ||
    repository.archived !== false ||
    repository.disabled !== false ||
    repository.has_issues !== true
  ) {
    throw new Error(
      "Endor automerge intake requires an active public repository with Issues enabled",
    );
  }
  const defaultBranch = requireString(repository.default_branch, "default branch");
  const candidates = paged(
    `repos/${repo}/issues?creator=${encodeURIComponent(ENDOR_LOGIN)}&state=open&per_page=100`,
  );
  const results: ReturnType<typeof enrollEndorPullRequests> = [];
  for (const value of candidates) {
    const candidate = requireRecord(value, "issue");
    if (!isEndor(candidate.user) || !isRecord(candidate.pull_request)) continue;
    const number = requirePositiveInteger(candidate.number, "PR number");
    const events = paged(`repos/${repo}/issues/${number}/events?per_page=100`);
    if (events.some(hasPriorControlLabel)) {
      results.push({ number, status: "skipped" });
      continue;
    }
    // Refresh mutable eligibility after discovery/history, immediately before the only write.
    const pull = requireRecord(github(["api", `repos/${repo}/pulls/${number}`]), "pull request");
    if (!isEligiblePull(pull, repo, defaultBranch)) {
      results.push({ number, status: "skipped" });
      continue;
    }
    if (execute) {
      github(
        [
          "api",
          `repos/${repo}/issues/${number}/labels`,
          "--method",
          "POST",
          "-f",
          `labels[]=${AUTOMERGE_LABEL}`,
        ],
        { attempts: 1 },
      );
    }
    results.push({ number, status: execute ? "enrolled" : "planned" });
  }
  return results;

  function paged(endpoint: string): unknown[] {
    const pages = github(["api", endpoint, "--paginate", "--slurp"]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray))
      throw new Error("Invalid GitHub pagination response");
    return pages.flat();
  }
}

function isEndor(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.login === ENDOR_LOGIN &&
    value.id === ENDOR_USER_ID &&
    value.type === "Bot"
  );
}

function isEligiblePull(
  pull: Record<string, unknown>,
  repo: string,
  defaultBranch: string,
): boolean {
  if (pull.state !== "open" || pull.draft !== false || pull.locked !== false || !isEndor(pull.user))
    return false;
  const base = requireRecord(pull.base, "PR base");
  const head = requireRecord(pull.head, "PR head");
  if (
    !isRecord(base.repo) ||
    !isRecord(head.repo) ||
    base.repo.full_name !== repo ||
    head.repo.full_name !== repo ||
    base.ref !== defaultBranch
  )
    return false;
  if (!Array.isArray(pull.labels)) throw new Error("Invalid PR labels");
  return !pull.labels.some((label: unknown) => CONTROL_LABELS.has(labelName(label)));
}

function labelName(value: unknown): string {
  return requireString(requireRecord(value, "label").name, "label name").toLowerCase();
}

function hasPriorControlLabel(value: unknown): boolean {
  const event = requireRecord(value, "issue event");
  const kind = requireString(event.event, "issue event type");
  return (kind === "labeled" || kind === "unlabeled") && CONTROL_LABELS.has(labelName(event.label));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const results = enrollEndorPullRequests({
    repo: String(args.repo ?? ""),
    execute: args.execute === true,
  });
  console.log(JSON.stringify(results, null, 2));
}
