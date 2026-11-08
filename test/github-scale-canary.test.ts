import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  alertAlreadySent,
  collectScaleFindings,
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

test("canary keeps observed findings and reports each source it could not read", async () => {
  const outageStatus = {
    exact_review_queue: {
      review_failure_health: {
        window_minutes: 60,
        by_stage: { source_preparation: openclaw.reviewFailuresPerHourDuringTreeOutage },
      },
    },
  };
  const githubDown = await collectScaleFindings(
    ["openclaw/openclaw"],
    async () => outageStatus,
    () => {
      throw new Error("HTTP 502 from GraphQL");
    },
  );
  assert.deepEqual(
    githubDown.findings.map((finding) => finding.key),
    ["source_preparation_failures", "check_runs_unavailable:openclaw/openclaw"],
  );

  const quiet = { repository: "openclaw/openclaw", maxCheckRuns: 12, maxCheckRunsPr: 1 };
  for (const readStatus of [
    async () => {
      throw new Error("HTTP 503");
    },
    async () => ({ exact_review_queue: {} }),
  ]) {
    const statusDown = await collectScaleFindings(["openclaw/openclaw"], readStatus, () => quiet);
    assert.deepEqual(
      statusDown.findings.map((finding) => finding.key),
      ["review_failures_unavailable"],
    );
  }

  const healthy = await collectScaleFindings(
    ["openclaw/openclaw"],
    async () => ({
      exact_review_queue: {
        review_failure_health: { window_minutes: 60, by_stage: { source_preparation: 0 } },
      },
    }),
    () => quiet,
  );
  assert.deepEqual(healthy.findings, []);
});

test("canary suppresses an alert key already sent today", () => {
  const sent = join(mkdtempSync(join(tmpdir(), "scale-canary-")), "sent.txt");
  const key = "github-scale-canary:2026-11-08:source_preparation_failures";
  assert.equal(alertAlreadySent(sent, key), false);
  writeFileSync(sent, `${key}\n`);
  assert.equal(alertAlreadySent(sent, key), true);
  assert.equal(alertAlreadySent(sent, `${key},check_runs:openclaw/openclaw`), false);
});
