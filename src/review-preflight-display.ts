import { reviewMergeBase } from "./pr-review-evidence.js";
import { parseReviewPreflightBody } from "./review-preflight-body.js";
import { frontMatterValue } from "./report-front-matter.js";
import { asRecord } from "./value-coerce.js";

type SourceState = "matches" | "stale" | "unknown";

const heading = "## Local preflight source";
const qualification =
  "Source comparison at the observed PR snapshot only. Completion is self-reported; body, policy, tests, execution, and report bytes are not verified.";

function sourceState(options: {
  repo: string;
  number: number;
  pull: unknown;
  targetDir: string;
  reportHead: string | undefined;
}): SourceState {
  const pull = asRecord(options.pull);
  const base = asRecord(pull.base);
  const head = asRecord(pull.head);
  const target = asRecord(base.repo).full_name;
  if (
    pull.number !== options.number ||
    typeof target !== "string" ||
    target.toLowerCase() !== options.repo.toLowerCase() ||
    typeof pull.body !== "string" ||
    typeof base.sha !== "string" ||
    typeof head.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(base.sha) ||
    !/^[0-9a-f]{40}$/.test(head.sha) ||
    options.reportHead !== head.sha
  )
    return "unknown";
  const parsed = parseReviewPreflightBody(pull.body);
  if (parsed.status !== "valid") return "unknown";
  if (parsed.payload.repo.toLowerCase() !== options.repo.toLowerCase()) return "stale";
  // Use the review's ancestry owner, never the target branch tip. Missing local
  // history stays unknown; optional display must not hydrate or fetch source.
  const mergeBase = reviewMergeBase(options.targetDir, base.sha, head.sha);
  if (mergeBase.status !== "verified" || !/^[0-9a-f]{40}$/.test(mergeBase.sha)) return "unknown";
  return parsed.payload.base === mergeBase.sha && parsed.payload.head === head.sha
    ? "matches"
    : "stale";
}

/** Host-only local output: no contributor strings enter reports or model/cache state. */
export function withLocalPreflightSource(
  markdown: string,
  observation?: {
    repo: string;
    number: number;
    pull: unknown;
    targetDir: string;
  },
): string {
  // Replace only our exact terminal section on carried reports. Hosted output
  // removes it, so a locally retained report cannot cross-post the advisory.
  let clean = markdown;
  for (const state of ["matches", "stale", "unknown"] as const) {
    const section = `\n\n${heading}\n\nSource ${state}. ${qualification}\n`;
    if (clean.endsWith(section)) clean = clean.slice(0, -section.length);
  }
  if (!observation) return clean;
  const reportMatchesTarget =
    frontMatterValue(clean, "repository")?.toLowerCase() === observation.repo.toLowerCase() &&
    frontMatterValue(clean, "number") === String(observation.number);
  const state = reportMatchesTarget
    ? sourceState({
        ...observation,
        reportHead: frontMatterValue(clean, "pull_head_sha"),
      })
    : "unknown";
  return `${clean}\n\n${heading}\n\nSource ${state}. ${qualification}\n`;
}
