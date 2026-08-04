import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_RUN_AGE_MS,
  DEFAULT_SEMANTIC_FAILURE_PATTERNS,
  detectSentinel,
  evaluateRunExpectations,
  HUB_CLAWSWEEPER_ROOT,
  HUB_USER,
  onDemandTriggerHandle,
  SNAPSHOT_SCRIPT_REL,
  TRIAGE_ALERT_SENTINEL,
  TRIAGE_OK_SENTINEL,
  TRIAGE_SCRIPT_REL,
  triageRunExpectations,
  weeklyTriageCronSpec,
  WEEKLY_TRIAGE_CRON,
  WEEKLY_TRIAGE_TZ,
} from "../dist/linear/trigger.js";
import type { RunExpectations, RunOutcome } from "../dist/linear/trigger.js";

// Barrel wiring check
import {
  evaluateRunExpectations as evaluateRunExpectationsFromIndex,
  weeklyTriageCronSpec as weeklyTriageCronSpecFromIndex,
} from "../dist/linear/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    text: `Triage digest summary.\n${TRIAGE_OK_SENTINEL}`,
    delivered: true,
    runAgeMs: 0,
    ...overrides,
  };
}

function makeExpectations(overrides: Partial<RunExpectations> = {}): RunExpectations {
  return triageRunExpectations(overrides);
}

// ---------------------------------------------------------------------------
// weeklyTriageCronSpec — doctrine-safe defaults
// ---------------------------------------------------------------------------

test("weeklyTriageCronSpec returns the Monday-09:00 America/Chicago default", () => {
  const spec = weeklyTriageCronSpec();
  assert.equal(spec.cron, WEEKLY_TRIAGE_CRON);
  assert.equal(spec.cron, "0 9 * * 1");
  assert.equal(spec.tz, WEEKLY_TRIAGE_TZ);
  assert.equal(spec.tz, "America/Chicago");
  assert.equal(spec.agent, "main");
  assert.deepEqual(spec.tools, ["exec", "message"]);
  assert.equal(spec.timeoutSeconds, 600);
  assert.equal(spec.name, "Linear weekly triage");
});

test("weeklyTriageCronSpec message routes to the review-only runner and ends with sentinels", () => {
  const spec = weeklyTriageCronSpec();
  const snapshot = `${HUB_CLAWSWEEPER_ROOT}/${SNAPSHOT_SCRIPT_REL}`;
  const triage = `${HUB_CLAWSWEEPER_ROOT}/${TRIAGE_SCRIPT_REL}`;
  assert.ok(spec.message.includes(`node ${snapshot} | node ${triage}`));
  assert.ok(spec.message.includes("--review-only --json"));
  assert.ok(spec.message.includes(TRIAGE_OK_SENTINEL));
  assert.ok(spec.message.includes(TRIAGE_ALERT_SENTINEL));
  // Never wires a mutate flag into the schedule.
  assert.ok(!spec.message.includes("--apply"));
  assert.ok(!spec.message.includes("--mutate"));
});

test("weeklyTriageCronSpec defaults to the committed hub-side runner path", () => {
  const spec = weeklyTriageCronSpec();
  assert.ok(spec.message.includes(`${HUB_CLAWSWEEPER_ROOT}/${SNAPSHOT_SCRIPT_REL}`));
  assert.ok(spec.message.includes(`${HUB_CLAWSWEEPER_ROOT}/${TRIAGE_SCRIPT_REL}`));
  assert.ok(spec.message.includes(`/Users/${HUB_USER}/`));
});

test("weeklyTriageCronSpec accepts overrides", () => {
  const spec = weeklyTriageCronSpec({
    name: "Custom triage",
    cron: "30 8 * * 2",
    tz: "UTC",
    timeoutSeconds: 900,
    projectRoot: "/Users/ostemini/projects/clawsweeper-alt",
  });
  assert.equal(spec.name, "Custom triage");
  assert.equal(spec.cron, "30 8 * * 2");
  assert.equal(spec.tz, "UTC");
  assert.equal(spec.timeoutSeconds, 900);
  assert.ok(spec.message.includes("/projects/clawsweeper-alt/scripts/linear-snapshot.mjs"));
  assert.ok(spec.message.includes("/projects/clawsweeper-alt/scripts/linear-triage.mjs"));
});

test("weeklyTriageCronSpec rejects the macbook node path", () => {
  assert.throws(
    () =>
      weeklyTriageCronSpec({
        projectRoot: "/Users/ostehost/projects/clawsweeper",
      }),
    /hub user path/,
  );
});

test("weeklyTriageCronSpec rejects paths outside the hub projects root and unsafe shell text", () => {
  for (const projectRoot of [
    "/tmp/clawsweeper",
    "/Users/another/projects/clawsweeper",
    "/Users/ostemini/projects/../config",
    "/Users/ostemini/projects/clawsweeper;touch-pwned",
    "/Users/ostemini/projects/claw sweeper",
  ]) {
    assert.throws(() => weeklyTriageCronSpec({ projectRoot }), /safe hub user path/);
  }
});

// ---------------------------------------------------------------------------
// onDemandTriggerHandle — same entry, triggered out of band
// ---------------------------------------------------------------------------

test("onDemandTriggerHandle builds run / runAndWait / list handles", () => {
  const handle = onDemandTriggerHandle("abc123");
  assert.equal(handle.run, "openclaw cron run abc123");
  assert.equal(handle.runAndWait, "openclaw cron run abc123 --wait --expect-final");
  assert.equal(handle.list, "openclaw cron list");
});

test("onDemandTriggerHandle trims the cron id", () => {
  const handle = onDemandTriggerHandle("  abc123  ");
  assert.equal(handle.run, "openclaw cron run abc123");
});

test("onDemandTriggerHandle throws on an empty id", () => {
  assert.throws(() => onDemandTriggerHandle(""), /non-empty cron id/);
  assert.throws(() => onDemandTriggerHandle("   "), /non-empty cron id/);
});

test("onDemandTriggerHandle accepts real OpenClaw cron id punctuation", () => {
  const handle = onDemandTriggerHandle("linear-weekly_triage.v2:01");
  assert.equal(handle.run, "openclaw cron run linear-weekly_triage.v2:01");
});

test("onDemandTriggerHandle rejects shell metacharacters and whitespace in the id", () => {
  // Regression: a cron id is embedded into command strings, so an injection-shaped id
  // must be rejected rather than interpolated.
  for (const bad of [
    "abc; rm -rf /",
    "abc && curl evil",
    "abc | tee x",
    "abc`whoami`",
    "abc$(id)",
    "abc with space",
    "abc\nnewline",
    "$(touch pwned)",
  ]) {
    assert.throws(() => onDemandTriggerHandle(bad), /unsafe characters/, `expected reject: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// triageRunExpectations — contract defaults and overrides
// ---------------------------------------------------------------------------

test("triageRunExpectations defaults to strict, review-safe expectations", () => {
  const exp = triageRunExpectations();
  assert.equal(exp.deliveryStrict, true);
  assert.equal(exp.maxRunAgeMs, DEFAULT_MAX_RUN_AGE_MS);
  assert.deepEqual(exp.semanticFailurePatterns, [...DEFAULT_SEMANTIC_FAILURE_PATTERNS]);
  assert.deepEqual(exp.sentinels, { ok: TRIAGE_OK_SENTINEL, alert: TRIAGE_ALERT_SENTINEL });
});

test("triageRunExpectations default failure patterns include the Linear throttle signal", () => {
  const exp = triageRunExpectations();
  assert.ok(exp.semanticFailurePatterns.includes("RATELIMITED"));
});

test("triageRunExpectations returns a fresh patterns array (no shared mutation)", () => {
  const exp = triageRunExpectations();
  exp.semanticFailurePatterns.push("MUTATED");
  const second = triageRunExpectations();
  assert.ok(!second.semanticFailurePatterns.includes("MUTATED"));
});

test("triageRunExpectations honours overrides", () => {
  const exp = triageRunExpectations({
    deliveryStrict: false,
    maxRunAgeMs: 1000,
    semanticFailurePatterns: ["BOOM"],
    sentinels: { ok: "OK", alert: "ALERT" },
  });
  assert.equal(exp.deliveryStrict, false);
  assert.equal(exp.maxRunAgeMs, 1000);
  assert.deepEqual(exp.semanticFailurePatterns, ["BOOM"]);
  assert.deepEqual(exp.sentinels, { ok: "OK", alert: "ALERT" });
});

// ---------------------------------------------------------------------------
// detectSentinel — trailing-token detection
// ---------------------------------------------------------------------------

const SENTINELS = { ok: TRIAGE_OK_SENTINEL, alert: TRIAGE_ALERT_SENTINEL };

test("detectSentinel recognizes a clean run", () => {
  assert.equal(detectSentinel(`done\n${TRIAGE_OK_SENTINEL}`, SENTINELS), "ok");
});

test("detectSentinel recognizes an escalated run", () => {
  assert.equal(detectSentinel(`escalated\n${TRIAGE_ALERT_SENTINEL}`, SENTINELS), "alert");
});

test("detectSentinel tolerates trailing whitespace", () => {
  assert.equal(detectSentinel(`done\n${TRIAGE_OK_SENTINEL}\n\n  `, SENTINELS), "ok");
});

test("detectSentinel returns none when no sentinel terminates the text", () => {
  assert.equal(detectSentinel("just a summary, no sentinel", SENTINELS), "none");
});

test("detectSentinel ignores a sentinel merely quoted mid-body", () => {
  // The body quotes both sentinels but ends with neither — must not falsely match.
  const text = `End your reply with ${TRIAGE_OK_SENTINEL} or ${TRIAGE_ALERT_SENTINEL}, then summarize.`;
  assert.equal(detectSentinel(text, SENTINELS), "none");
});

test("detectSentinel rejects suffix-attached text on the final token", () => {
  // Regression: the final token must equal the sentinel exactly — `NOT_TRIAGE_OK` and
  // `TRIAGE_OK_LATER` only contain the sentinel as a substring and must not match.
  assert.equal(detectSentinel("run done\nNOT_TRIAGE_OK", SENTINELS), "none");
  assert.equal(detectSentinel("run done\nTRIAGE_OK_LATER", SENTINELS), "none");
  assert.equal(detectSentinel("run done\nNOT_TRIAGE_ALERT_SENT", SENTINELS), "none");
  // The bare sentinel as the final token still matches.
  assert.equal(detectSentinel("run done TRIAGE_OK", SENTINELS), "ok");
});

// ---------------------------------------------------------------------------
// evaluateRunExpectations — the pure verdict
// ---------------------------------------------------------------------------

test("evaluateRunExpectations: clean delivered fresh run is healthy", () => {
  const verdict = evaluateRunExpectations(makeOutcome(), makeExpectations());
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.sentinel, "ok");
  assert.equal(verdict.fresh, true);
  assert.equal(verdict.delivered, true);
  assert.deepEqual(verdict.semanticFailures, []);
  assert.deepEqual(verdict.reasons, ["healthy: clean triage run"]);
});

test("evaluateRunExpectations: an escalated alert run is still healthy", () => {
  const outcome = makeOutcome({ text: `problem found\n${TRIAGE_ALERT_SENTINEL}` });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.sentinel, "alert");
  assert.deepEqual(verdict.reasons, ["healthy: alert escalated"]);
});

test("evaluateRunExpectations: a missing sentinel is unhealthy", () => {
  const outcome = makeOutcome({ text: "summary with no terminal sentinel" });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.sentinel, "none");
  assert.ok(verdict.reasons.some((r) => r.includes("no recognized sentinel")));
});

test("evaluateRunExpectations: a matched failure pattern is unhealthy", () => {
  const outcome = makeOutcome({
    text: `partial run\nRATELIMITED backoff hit\n${TRIAGE_OK_SENTINEL}`,
  });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.deepEqual(verdict.semanticFailures, ["RATELIMITED"]);
  assert.ok(verdict.reasons.some((r) => r.includes("semantic failure pattern")));
});

test("evaluateRunExpectations: a review-only run proposing close trips the guard", () => {
  const outcome = makeOutcome({
    text: `{ "reviewOnly": true, "proposesClose": true }\n${TRIAGE_OK_SENTINEL}`,
  });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.deepEqual(verdict.semanticFailures, ['"proposesClose": true']);
});

test("evaluateRunExpectations: a stale run is unhealthy", () => {
  const outcome = makeOutcome({ runAgeMs: DEFAULT_MAX_RUN_AGE_MS + 1 });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.fresh, false);
  assert.ok(verdict.reasons.some((r) => r.includes("stale")));
});

test("evaluateRunExpectations: a run exactly at the age bound is fresh", () => {
  const outcome = makeOutcome({ runAgeMs: DEFAULT_MAX_RUN_AGE_MS });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.fresh, true);
  assert.equal(verdict.healthy, true);
});

test("evaluateRunExpectations: a negative run age is flagged distinctly", () => {
  const outcome = makeOutcome({ runAgeMs: -1 });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.fresh, false);
  assert.ok(verdict.reasons.some((r) => r.includes("negative")));
});

test("evaluateRunExpectations: deliveryStrict fails an undelivered run", () => {
  const outcome = makeOutcome({ delivered: false });
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some((r) => r.includes("deliveryStrict")));
});

test("evaluateRunExpectations: non-strict delivery tolerates an undelivered run", () => {
  const outcome = makeOutcome({ delivered: false });
  const verdict = evaluateRunExpectations(outcome, makeExpectations({ deliveryStrict: false }));
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.delivered, false);
});

test("evaluateRunExpectations: collects every blocking reason at once", () => {
  const outcome: RunOutcome = {
    text: "summary, no sentinel, Error: boom",
    delivered: false,
    runAgeMs: DEFAULT_MAX_RUN_AGE_MS + 1,
  };
  const verdict = evaluateRunExpectations(outcome, makeExpectations());
  assert.equal(verdict.healthy, false);
  // sentinel + semantic failure + stale + delivery → four distinct reasons.
  assert.equal(verdict.reasons.length, 4);
});

// ---------------------------------------------------------------------------
// Barrel wiring
// ---------------------------------------------------------------------------

test("trigger surface is re-exported from the linear barrel", () => {
  assert.equal(typeof weeklyTriageCronSpecFromIndex, "function");
  assert.equal(typeof evaluateRunExpectationsFromIndex, "function");
  const spec = weeklyTriageCronSpecFromIndex();
  assert.equal(spec.cron, "0 9 * * 1");
});
