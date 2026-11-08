import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateScaleCanary,
  observeCheckRunScale,
  observeReviewFailures,
} from "../dist/repair/github-scale-canary.js";

const openclaw = JSON.parse(
  readFileSync(new URL("./fixtures/openclaw-scale.json", import.meta.url), "utf8"),
);

test("canary alerts on the source-preparation failure rate the tree outage produced", () => {
  const findings = evaluateScaleCanary([], {
    windowMinutes: 60,
    sourcePreparationFailures: openclaw.reviewFailuresPerHourDuringTreeOutage,
  });
  assert.deepEqual(
    findings.map((finding) => finding.key),
    ["source_preparation_failures"],
  );
  assert.deepEqual(
    evaluateScaleCanary([], { windowMinutes: 60, sourcePreparationFailures: 2 }),
    [],
  );
});

test("canary stays quiet at openclaw's current check-run scale and warns before the reader bound", () => {
  const current = {
    repository: openclaw.repository,
    maxCheckRuns: openclaw.maxCheckRunsOnOpenHead,
    maxCheckRunsPr: 1,
  };
  assert.deepEqual(evaluateScaleCanary([current], null), []);
  assert.deepEqual(
    evaluateScaleCanary([{ ...current, maxCheckRuns: 800 }], null).map((finding) => finding.key),
    ["check_runs:openclaw/openclaw"],
  );
});

test("canary reads the largest open-PR check-run count from one GraphQL query", () => {
  const queries: string[] = [];
  const observed = observeCheckRunScale("openclaw/openclaw", (query) => {
    queries.push(query);
    const head = (count: number) => ({
      nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCount: count } } } }],
    });
    return {
      pullRequests: {
        nodes: [
          { number: 194898, commits: head(openclaw.checkRunsOnPr194898) },
          { number: 1, commits: head(12) },
          { number: 2, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
        ],
      },
    };
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(observed, {
    repository: "openclaw/openclaw",
    maxCheckRuns: 231,
    maxCheckRunsPr: 194898,
  });
  assert.throws(
    () => observeCheckRunScale('openclaw/x") { evil', () => null),
    /invalid repository/,
  );
});

test("canary reads source-preparation failures from the public status document", () => {
  assert.deepEqual(
    observeReviewFailures({
      exact_review_queue: {
        review_failure_health: { window_minutes: 60, by_stage: { source_preparation: 613 } },
      },
    }),
    { windowMinutes: 60, sourcePreparationFailures: 613 },
  );
  assert.equal(observeReviewFailures({}), null);
});
