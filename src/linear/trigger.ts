/**
 * Linear weekly-cron and on-demand trigger wiring + run-expectations contract
 * (deterministic, offline, pure).
 *
 * Doctrine — schedule lives gateway-side, logic lives in a committed script:
 *   Weekly Linear triage runs from an OpenClaw cron job on the hub (user `ostemini`),
 *   not a local launchd timer. Keeping the schedule gateway-side means it survives
 *   node reinstalls, gets built-in failure alerting, and keeps an audit trail in
 *   `openclaw cron runs`. The cron agent only routes and summarizes; the real logic
 *   lives in the committed snapshot + review-only runners (`scripts/linear-snapshot.mjs`
 *   and `scripts/linear-triage.mjs`). This
 *   module builds the cron trigger spec, the on-demand handle, and the run-expectations
 *   contract as pure values — no network, no clock, no I/O.
 *
 * On-demand uses the same entry:
 *   There is one cron entry. A human or another agent triggers an out-of-band run with
 *   `openclaw cron run <id>` (optionally `--wait --expect-final` to block on the final
 *   sentinel). This is the Linear-side equivalent of ClawSweeper's `repository_dispatch`
 *   trigger for exact GitHub events.
 *
 * Review-only by default:
 *   The cron message always invokes the runner with `--review-only --json`; no mutate
 *   flag is ever wired into the schedule. Weekly runs snapshot, classify, and emit a
 *   digest — they never apply. Any real mutation is gated separately in authority.ts.
 *
 * Sentinels and expectations:
 *   A healthy run ends with a recognized sentinel — `TRIAGE_OK` for a clean run or
 *   `TRIAGE_ALERT_SENT` when the run escalated. The expectations contract mirrors the
 *   convention used by existing cron jobs: `deliveryStrict`, `semanticFailurePatterns`,
 *   and `maxRunAgeMs`. `evaluateRunExpectations` is a pure verdict over a run outcome
 *   and the contract, so alerting stays deterministic and clock-free.
 *
 * Hub user path, never the macbook node:
 *   The cron runs as `ostemini`, so the script path must be a `/Users/ostemini/...`
 *   path. A `/Users/ostehost/...` path (this MacBook node) would break the cron, so the
 *   spec builder rejects it outright.
 */

/** Sentinel a clean triage run ends with. */
export const TRIAGE_OK_SENTINEL = "TRIAGE_OK";
/** Sentinel a triage run ends with after it escalates an alert. */
export const TRIAGE_ALERT_SENTINEL = "TRIAGE_ALERT_SENT";

/** Weekly schedule: Monday 09:00 in WEEKLY_TRIAGE_TZ. */
export const WEEKLY_TRIAGE_CRON = "0 9 * * 1";
/** IANA timezone the weekly cron is evaluated in. */
export const WEEKLY_TRIAGE_TZ = "America/Chicago";

/** Hub user the cron runs as. Paths must belong to this user, never `ostehost`. */
export const HUB_USER = "ostemini";
/** Hub-side ClawSweeper checkout containing the committed runners and compiled imports. */
export const HUB_CLAWSWEEPER_ROOT = `/Users/${HUB_USER}/projects/clawsweeper`;
/** Committed read-only snapshot runner, relative to the ClawSweeper root. */
export const SNAPSHOT_SCRIPT_REL = "scripts/linear-snapshot.mjs";
/** Committed review-only runner, relative to the ClawSweeper root. */
export const TRIAGE_SCRIPT_REL = "scripts/linear-triage.mjs";

const MS_PER_DAY = 86_400_000;
// One weekly interval plus a one-day grace — a healthy weekly run is never older than this.
export const DEFAULT_MAX_RUN_AGE_MS = 8 * MS_PER_DAY;

/** The recognized sentinel pair an evaluator checks a run outcome against. */
export interface RunSentinels {
  ok: string;
  alert: string;
}

/** A registered OpenClaw cron trigger specification. */
export interface CronTriggerSpec {
  name: string;
  cron: string; // crontab expression
  tz: string; // IANA timezone
  agent: string; // cron agent that routes and summarizes
  tools: string[]; // tools the cron agent may use
  timeoutSeconds: number; // hard timeout for the run
  message: string; // the cron agent message (routes to the runner, ends with sentinels)
}

/** Overrides for the weekly cron spec; every field defaults to a doctrine-safe value. */
export interface CronTriggerOptions {
  name?: string;
  cron?: string;
  tz?: string;
  timeoutSeconds?: number;
  projectRoot?: string; // absolute hub ClawSweeper checkout root
}

/** Shell handles for triggering and observing the same cron entry out of band. */
export interface OnDemandHandle {
  list: string; // discover the cron id
  run: string; // trigger a run now
  runAndWait: string; // trigger and block on the final sentinel
}

/** The run-expectations contract, mirroring existing cron `expectations.json` blocks. */
export interface RunExpectations {
  deliveryStrict: boolean; // the run must deliver a final message
  semanticFailurePatterns: string[]; // substrings whose presence marks a failed run
  maxRunAgeMs: number; // a run result older than this is stale
  sentinels: RunSentinels; // the recognized terminal sentinels
}

/** A run outcome to evaluate. Age is supplied by the caller to keep this module clock-free. */
export interface RunOutcome {
  text: string; // the run's final summary / output text
  delivered: boolean; // a final message was delivered to the operator
  runAgeMs: number; // age of this run result at evaluation time (>= 0)
}

/** Which terminal sentinel a run ended with, if any. */
export type RunSentinel = "ok" | "alert" | "none";

/** The deterministic verdict for one run outcome against the expectations contract. */
export interface RunVerdict {
  healthy: boolean;
  sentinel: RunSentinel;
  fresh: boolean;
  delivered: boolean;
  semanticFailures: string[]; // which patterns matched, in contract order
  reasons: string[]; // ordered, non-empty: blocking reasons when unhealthy, else one healthy line
}

/**
 * Default semantic-failure substrings. Each marks a run that completed but did the wrong
 * thing or crashed: a Linear self-throttle, an unparseable snapshot, a review-only run that
 * somehow proposed a close, a python client traceback, or a generic unhandled error line.
 */
export const DEFAULT_SEMANTIC_FAILURE_PATTERNS: readonly string[] = [
  "RATELIMITED",
  "snapshot is not valid JSON",
  '"proposesClose": true',
  "Traceback (most recent call last)",
  "Error:",
];

const SAFE_HUB_PROJECT_ROOT = new RegExp(`^/Users/${HUB_USER}/projects/[A-Za-z0-9._/-]+$`);

// The root is interpolated into a shell pipeline, so require the exact hub-user projects
// prefix and reject traversal, whitespace, and metacharacters.
function assertHubProjectRoot(projectRoot: string): void {
  if (
    !SAFE_HUB_PROJECT_ROOT.test(projectRoot) ||
    projectRoot.split("/").some((part) => part === "..")
  ) {
    throw new Error(
      `cron project root must be a safe hub user path under /Users/${HUB_USER}/projects/: ${projectRoot}`,
    );
  }
}

// The cron agent message: snapshot into the review-only runner, then end with a sentinel.
function triageCronMessage(projectRoot: string): string {
  const snapshotPath = `${projectRoot}/${SNAPSHOT_SCRIPT_REL}`;
  const triagePath = `${projectRoot}/${TRIAGE_SCRIPT_REL}`;
  return [
    "Weekly Linear triage.",
    `Run: node ${snapshotPath} | node ${triagePath} --review-only --json.`,
    `Summarize the digest and end your reply with ${TRIAGE_OK_SENTINEL} on a clean run`,
    `or ${TRIAGE_ALERT_SENTINEL} if you escalated.`,
  ].join(" ");
}

/**
 * Builds the weekly OpenClaw cron trigger spec. Defaults to the Monday-09:00
 * America/Chicago schedule, the `main` agent with `exec,message` tools, a 600s timeout,
 * and the committed hub-side read-only pipeline. Throws unless the project root is a safe
 * absolute path under the hub user's projects directory.
 */
export function weeklyTriageCronSpec(options: CronTriggerOptions = {}): CronTriggerSpec {
  const projectRoot = options.projectRoot ?? HUB_CLAWSWEEPER_ROOT;
  assertHubProjectRoot(projectRoot);
  return {
    name: options.name ?? "Linear weekly triage",
    cron: options.cron ?? WEEKLY_TRIAGE_CRON,
    tz: options.tz ?? WEEKLY_TRIAGE_TZ,
    agent: "main",
    tools: ["exec", "message"],
    timeoutSeconds: options.timeoutSeconds ?? 600,
    message: triageCronMessage(projectRoot),
  };
}

// Conservative cron-id allowlist: letters, digits, and the punctuation real OpenClaw cron
// ids use (underscore, hyphen, colon, dot). Anything else — whitespace or a shell
// metacharacter — is rejected before the id is embedded in a command string.
const SAFE_CRON_ID = /^[A-Za-z0-9_.:-]+$/;

/**
 * Builds the shell handles for triggering and observing the same cron entry on demand.
 * `run` fires a run now; `runAndWait` blocks on the final sentinel; `list` discovers the
 * cron id. The cron id is embedded into command strings, so it is validated against a
 * conservative allowlist first: throws if it is empty or contains any character outside
 * `[A-Za-z0-9_.:-]` (whitespace or shell metacharacters).
 */
export function onDemandTriggerHandle(cronId: string): OnDemandHandle {
  const id = cronId.trim();
  if (id.length === 0) {
    throw new Error("onDemandTriggerHandle requires a non-empty cron id");
  }
  if (!SAFE_CRON_ID.test(id)) {
    throw new Error(
      `onDemandTriggerHandle: cron id ${JSON.stringify(id)} contains unsafe characters — only letters, digits, "_", "-", ":", and "." are allowed`,
    );
  }
  return {
    list: "openclaw cron list",
    run: `openclaw cron run ${id}`,
    runAndWait: `openclaw cron run ${id} --wait --expect-final`,
  };
}

/**
 * Builds the run-expectations contract. Defaults to strict delivery, the default
 * semantic-failure patterns, the weekly-plus-grace max run age, and the TRIAGE sentinels.
 * Any field can be overridden; an omitted field keeps its doctrine-safe default.
 */
export function triageRunExpectations(overrides: Partial<RunExpectations> = {}): RunExpectations {
  return {
    deliveryStrict: overrides.deliveryStrict ?? true,
    semanticFailurePatterns: overrides.semanticFailurePatterns ?? [
      ...DEFAULT_SEMANTIC_FAILURE_PATTERNS,
    ],
    maxRunAgeMs: overrides.maxRunAgeMs ?? DEFAULT_MAX_RUN_AGE_MS,
    sentinels: overrides.sentinels ?? { ok: TRIAGE_OK_SENTINEL, alert: TRIAGE_ALERT_SENTINEL },
  };
}

/**
 * Detects which terminal sentinel a run ended with. A run is expected to end with the
 * sentinel as its own final whitespace-delimited token, so detection compares that last
 * token exactly. Suffix-attached text like `NOT_TRIAGE_OK` is not a match, and a body that
 * merely quotes a sentinel mid-text (ending on some other word) is not a match either.
 */
export function detectSentinel(text: string, sentinels: RunSentinels): RunSentinel {
  const tokens = text.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  if (last === sentinels.ok) return "ok";
  if (last === sentinels.alert) return "alert";
  return "none";
}

// Returns the failure patterns present in the text, preserving contract order.
function matchedFailures(text: string, patterns: string[]): string[] {
  return patterns.filter((pattern) => text.includes(pattern));
}

/**
 * Evaluates a run outcome against the expectations contract. Pure and offline. A run is
 * healthy only when it ended with a recognized sentinel, matched no semantic-failure
 * pattern, is fresh (age within maxRunAgeMs and non-negative), and — when deliveryStrict —
 * delivered a final message. Collects every blocking reason so the verdict is informative;
 * a healthy verdict carries a single explanatory line.
 */
export function evaluateRunExpectations(
  outcome: RunOutcome,
  expectations: RunExpectations,
): RunVerdict {
  const sentinel = detectSentinel(outcome.text, expectations.sentinels);
  const semanticFailures = matchedFailures(outcome.text, expectations.semanticFailurePatterns);
  const fresh = outcome.runAgeMs >= 0 && outcome.runAgeMs <= expectations.maxRunAgeMs;

  const reasons: string[] = [];
  if (sentinel === "none") {
    reasons.push(
      `no recognized sentinel — run must end with ${expectations.sentinels.ok} or ${expectations.sentinels.alert}`,
    );
  }
  if (semanticFailures.length > 0) {
    reasons.push(`semantic failure pattern(s) matched: ${semanticFailures.join(", ")}`);
  }
  if (outcome.runAgeMs < 0) {
    reasons.push(`run age is negative (${outcome.runAgeMs}ms) — clock skew or bad timestamps`);
  } else if (!fresh) {
    reasons.push(
      `run is stale: age ${outcome.runAgeMs}ms exceeds maxRunAgeMs ${expectations.maxRunAgeMs}`,
    );
  }
  if (expectations.deliveryStrict && !outcome.delivered) {
    reasons.push("deliveryStrict: run did not deliver a final message");
  }

  const healthy = reasons.length === 0;
  if (healthy) {
    reasons.push(sentinel === "ok" ? "healthy: clean triage run" : "healthy: alert escalated");
  }
  return { healthy, sentinel, fresh, delivered: outcome.delivered, semanticFailures, reasons };
}
