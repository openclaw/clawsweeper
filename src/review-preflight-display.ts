import { reviewMergeBase } from "./pr-review-evidence.js";
import { parseReviewPreflightBody } from "./review-preflight-body.js";
import { frontMatterValue } from "./report-front-matter.js";
import { asRecord } from "./value-coerce.js";

type SourceState = "matches" | "stale" | "unknown";
type PreflightObservation = {
  repo: string;
  number: number;
  pull: unknown;
  targetDir: string;
};

const heading = "## Local preflight source";
const hostedHeading = "## Preflight source";
const states = ["matches", "stale", "unknown"] as const;
const qualification =
  "Source comparison at the observed PR snapshot only. Completion is self-reported; body, policy, tests, execution, and report bytes are not verified.";

function sourceState(
  options: PreflightObservation & {
    reportHead: string | undefined;
  },
): SourceState {
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

function section(state: SourceState, title: string): string {
  return `\n\n${title}\n\nSource ${state}. ${qualification}\n`;
}

function withoutPreflightSource(markdown: string): string {
  // Only exact host-written suffixes are replaceable. A carried report never
  // supplies the current observation, including when output modes change.
  let clean = markdown;
  const suffixes = [heading, hostedHeading].flatMap((title) =>
    states.map((state) => section(state, title)),
  );
  for (;;) {
    const suffix = suffixes.find((value) => clean.endsWith(value));
    if (!suffix) return clean;
    clean = clean.slice(0, -suffix.length);
  }
}

function reportSourceState(markdown: string, observation: PreflightObservation): SourceState {
  const reportMatchesTarget =
    frontMatterValue(markdown, "repository")?.toLowerCase() === observation.repo.toLowerCase() &&
    frontMatterValue(markdown, "number") === String(observation.number);
  return reportMatchesTarget
    ? sourceState({
        ...observation,
        reportHead: frontMatterValue(markdown, "pull_head_sha"),
      })
    : "unknown";
}

/** Host-only local output: no contributor strings enter reports or model/cache state. */
export function withLocalPreflightSource(
  markdown: string,
  observation?: PreflightObservation,
): string {
  const clean = withoutPreflightSource(markdown);
  return observation ? clean + section(reportSourceState(clean, observation), heading) : clean;
}

export function withHostedPreflightSource(
  markdown: string,
  observation?: PreflightObservation,
): string {
  const clean = withoutPreflightSource(markdown);
  if (!observation || !hostedSourceEligible(clean)) return clean;
  return clean + section(reportSourceState(clean, observation), hostedHeading);
}

function hostedSourceEligible(markdown: string): boolean {
  return (
    frontMatterValue(markdown, "type") === "pull_request" &&
    frontMatterValue(markdown, "review_status") === "complete" &&
    frontMatterValue(markdown, "decision") === "keep_open"
  );
}

/** Read only the finite host projection, never arbitrary report section text. */
export function hostedPreflightSource(markdown: string): string {
  if (!hostedSourceEligible(markdown)) return "";
  const state = states.find((value) => markdown.endsWith(section(value, hostedHeading)));
  return state ? `Source ${state}. ${qualification}` : "";
}
