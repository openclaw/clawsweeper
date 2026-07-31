import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchedIssueImplementationWorkerRetryDue,
  ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS,
  issueImplementationWorkerAttemptCount,
  recentIssueImplementationWorkflowRuns,
  recoverableIssueImplementationWorker,
} from "../../dist/repair/issue-worker-recovery.js";

const jobPath = "jobs/openclaw/inbox/issue-openclaw-openclaw-98276.md";
const reportRevision = "a".repeat(64);
const nowMs = Date.parse("2026-07-31T19:00:00.000Z");

function audit(overrides: Record<string, string> = {}) {
  return {
    frontmatter: {
      report_revision_sha256: reportRevision,
      worker_dispatched: "true",
      worker_attempt_count: "1",
      worker_retry_after: "2026-07-31T18:59:00.000Z",
      ...overrides,
    },
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    display_title: `issue implementation ${jobPath}`,
    status: "completed",
    conclusion: "failure",
    updated_at: "2026-07-31T18:59:30.000Z",
    ...overrides,
  };
}

test("completed issue workers without an implementation PR can be retried", () => {
  for (const conclusion of ["failure", "cancelled", "success"]) {
    assert.equal(
      recoverableIssueImplementationWorker({
        audit: audit(),
        jobPath,
        reportRevision,
        nowMs,
        fetchRuns: () => [run({ conclusion })],
      }),
      true,
      conclusion,
    );
  }
});

test("active and unrelated issue workers never trigger a duplicate dispatch", () => {
  for (const runs of [
    [],
    [run({ display_title: "issue implementation jobs/openclaw/inbox/issue-other-1.md" })],
    [run(), run({ status: "in_progress", updated_at: "2026-07-31T18:59:45.000Z" })],
    [run({ status: "queued" })],
  ]) {
    assert.equal(
      recoverableIssueImplementationWorker({
        audit: audit(),
        jobPath,
        reportRevision,
        nowMs,
        fetchRuns: () => runs,
      }),
      false,
    );
  }
});

test("issue worker recovery respects review freshness, retry delays, and retry caps", () => {
  for (const previousAudit of [
    audit({ worker_dispatched: "false" }),
    audit({ worker_retry_after: "2026-07-31T19:01:00.000Z" }),
    audit({ worker_attempt_count: String(ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS) }),
  ]) {
    assert.equal(
      dispatchedIssueImplementationWorkerRetryDue({
        audit: previousAudit,
        reportRevision,
        nowMs,
      }),
      false,
    );
    assert.equal(
      recoverableIssueImplementationWorker({
        audit: previousAudit,
        jobPath,
        reportRevision,
        nowMs,
        fetchRuns: () => [run()],
      }),
      false,
    );
  }
});

test("a newer authoritative review can refresh a completed exhausted worker job", () => {
  const previousAudit = audit({
    report_revision_sha256: "b".repeat(64),
    worker_attempt_count: String(ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS),
  });

  assert.equal(
    dispatchedIssueImplementationWorkerRetryDue({
      audit: previousAudit,
      reportRevision,
      nowMs,
    }),
    true,
  );
  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [run()],
    }),
    true,
  );
  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [run({ status: "in_progress" })],
    }),
    false,
  );
});

test("retry caps follow the actual queued job when intake already observed a newer review", () => {
  const previousAudit = audit({
    report_revision_sha256: reportRevision,
    job_report_revision_sha256: "b".repeat(64),
    worker_attempt_count: String(ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS),
  });

  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [run()],
    }),
    true,
  );
});

test("empty legacy job-review metadata still respects the same-review retry cap", () => {
  const previousAudit = audit({
    job_report_revision_sha256: "",
    worker_attempt_count: String(ISSUE_IMPLEMENTATION_MAX_WORKER_ATTEMPTS),
  });

  assert.equal(
    dispatchedIssueImplementationWorkerRetryDue({
      audit: previousAudit,
      reportRevision,
      nowMs,
    }),
    false,
  );
});

test("historical completed runs cannot stand in for a newer worker dispatch", () => {
  const previousAudit = audit({
    prepared_at: "2026-07-31T18:58:00.000Z",
    worker_dispatched_at: "2026-07-31T18:58:00.000Z",
  });

  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [
        run({
          created_at: "2026-07-31T18:40:00.000Z",
          updated_at: "2026-07-31T18:55:00.000Z",
        }),
      ],
    }),
    false,
  );
  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [
        run({
          created_at: "2026-07-31T18:58:15.000Z",
          updated_at: "2026-07-31T18:59:00.000Z",
        }),
      ],
    }),
    true,
  );
});

test("deduplicated workers remain recoverable when they finish after the intake", () => {
  const workerCreatedAt = "2026-07-31T18:57:30.000Z";
  const previousAudit = audit({
    prepared_at: "2026-07-31T18:58:00.000Z",
    worker_dispatched_at: workerCreatedAt,
  });

  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchPage: (args) => {
        const query = new URL(`https://github.test/${args[1]}`).searchParams;
        assert.equal(query.get("created"), `>=${workerCreatedAt}`);
        return {
          total_count: 1,
          workflow_runs: [
            run({
              created_at: workerCreatedAt,
              updated_at: "2026-07-31T18:58:30.000Z",
            }),
          ],
        };
      },
    }),
    true,
  );
});

test("empty legacy dispatch metadata still fences out historical workers", () => {
  const previousAudit = audit({
    prepared_at: "2026-07-31T18:58:00.000Z",
    worker_dispatched_at: "",
  });

  assert.equal(
    recoverableIssueImplementationWorker({
      audit: previousAudit,
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [
        run({
          created_at: "2026-07-31T16:00:00.000Z",
          updated_at: "2026-07-31T16:01:00.000Z",
        }),
      ],
    }),
    false,
  );
});

test("issue worker recovery paginates beyond the configured concurrency ceiling", () => {
  const pages: number[] = [];
  const runs = recentIssueImplementationWorkflowRuns({
    fetchPage: (args) => {
      const page = Number(new URL(`https://github.test/${args[1]}`).searchParams.get("page"));
      pages.push(page);
      return {
        workflow_runs: Array.from({ length: page < 3 ? 100 : 5 }, (_, index) => ({
          id: (page - 1) * 100 + index,
        })),
      };
    },
  });

  assert.equal(runs.length, 205);
  assert.deepEqual(pages, [1, 2, 3]);
});

test("issue worker recovery scans all workflows created since the dispatch generation", () => {
  const pages: number[] = [];
  const since = "2026-07-31T18:00:00.000Z";
  const runs = recentIssueImplementationWorkflowRuns({
    since,
    fetchPage: (args) => {
      const query = new URL(`https://github.test/${args[1]}`).searchParams;
      const page = Number(query.get("page"));
      pages.push(page);
      assert.equal(query.get("created"), `>=${since}`);
      return {
        total_count: 401,
        workflow_runs: Array.from({ length: page < 5 ? 100 : 1 }, (_, index) => ({
          id: (page - 1) * 100 + index,
        })),
      };
    },
  });

  assert.equal(runs.length, 401);
  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
});

test("legacy dispatched issue audits count as one bounded worker attempt", () => {
  const legacy = audit({ worker_attempt_count: "", worker_retry_after: "" });
  assert.equal(issueImplementationWorkerAttemptCount(legacy), 1);
  assert.equal(
    dispatchedIssueImplementationWorkerRetryDue({
      audit: legacy,
      reportRevision,
      nowMs,
    }),
    true,
  );
});

test("router-tagged issue workers match their durable issue job", () => {
  assert.equal(
    recoverableIssueImplementationWorker({
      audit: audit(),
      jobPath,
      reportRevision,
      nowMs,
      fetchRuns: () => [run({ display_title: `issue implementation ${jobPath} [router-abc]` })],
    }),
    true,
  );
});
