import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { ExactReviewQueue } from "../dashboard/exact-review-queue.ts";
import { GithubEgressTelemetryStore } from "../dashboard/github-egress-telemetry.ts";
import { createGitHubRuntime } from "../dist/clawsweeper-github-runtime.js";
import {
  githubEgressCommandDescriptor,
  githubEgressRouteTemplate,
} from "../dist/github-egress-descriptor.js";
import {
  observeGitHubDebugStderr,
  recordGithubEgressBrokerEvent,
  recordGithubEgressMember,
  recordUnobservedGitHubInvocation,
} from "../dist/github-egress-observer.js";
import {
  githubEgressTelemetrySubmissions,
  submitGitHubEgressTelemetry,
} from "../dist/repair/github-egress-telemetry-client.js";
import { MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

test("GH_DEBUG observation counts paginated wire attempts and strips unsafe diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-observer-"));
  try {
    const metricsPath = join(root, "metrics.jsonl");
    const rateLimitPath = join(root, "rate-limits.jsonl");
    const env = observerEnv(metricsPath, rateLimitPath);
    const stderr = Buffer.from(
      [
        "ordinary warning before",
        debugFrame({ page: null, status: 200, at: "2026-08-12T11:59:58.000Z m=+0.000001" }),
        debugFrame({ page: 2, status: 200, at: "2026-08-12T11:59:58.100Z" }),
        debugFrame({
          page: 3,
          status: 403,
          at: "2026-08-12T11:59:58.200Z",
          duration: "900µs",
        }),
        "ordinary warning after",
        "",
      ].join("\n"),
      "utf8",
    );

    const clean = observeGitHubDebugStderr(
      stderr,
      ["api", "repos/private-owner/private-repo/issues/991/comments", "--paginate"],
      env,
      NOW,
    );
    assert.equal(clean.toString("utf8"), "ordinary warning before\nordinary warning after\n");

    const metrics = jsonLines(metricsPath);
    const wire = metrics.filter((metric) => metric.unit === "wire_attempt");
    assert.equal(wire.length, 3);
    assert.deepEqual(
      wire.map((metric) => metric.pageBucket),
      ["1", "2", "3_5"],
    );
    assert.ok(wire.every((metric) => metric.poolClass === "repository_actions"));
    assert.ok(wire.every((metric) => metric.operation === "comments"));
    assert.ok(wire.every((metric) => metric.method === "GET"));
    assert.ok(wire.every((metric) => metric.firstRepeat === "first"));
    assert.ok(wire.every((metric) => metric.claimGenerationBucket === "2"));
    assert.ok(wire.every((metric) => metric.telemetryComplete === true));
    assert.equal(metrics.filter((metric) => metric.unit === "invocation").length, 1);

    const observations = jsonLines(rateLimitPath);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.status, 403);
    assert.equal(observations[0]?.pageBucket, "3_5");
    assert.equal(observations[0]?.resetAuthorityCandidate, "rate_limit_reset");
    assert.deepEqual(observations[0]?.headers, {
      retryAfterPresent: false,
      retryAfterSeconds: null,
      limitPresent: true,
      limit: 5_000,
      remainingPresent: true,
      remaining: 0,
      usedPresent: true,
      used: 5_000,
      resetPresent: true,
      resetEpochSeconds: 1_786_533_900,
      resourcePresent: true,
      resource: "core",
    });
    const persisted = `${readFileSync(metricsPath, "utf8")}\n${readFileSync(rateLimitPath, "utf8")}`;
    for (const sentinel of [
      "private-owner",
      "private-repo",
      "991",
      "cursor-secret",
      "etag-secret",
      "request-id-secret",
      "body-secret",
    ]) {
      assert.equal(persisted.includes(sentinel), false, sentinel);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe or unavailable wire parsing fails open with incomplete bounded metrics", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-incomplete-"));
  try {
    const metricsPath = join(root, "metrics.jsonl");
    const env = observerEnv(metricsPath, join(root, "rate.jsonl"));
    const partial = Buffer.from(
      "prefix preserved\n* Request at 2026-08-12T11:00:00Z\n* Request to https://api.github.com/repos/raw/secret\n> GET /repos/raw/secret?cursor=cursor-secret HTTP/1.1\nbody-secret",
    );
    assert.equal(
      observeGitHubDebugStderr(partial, ["api", "repos/raw/secret"], env, NOW).toString(),
      "prefix preserved\n",
    );
    const incomplete = jsonLines(metricsPath);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.unit, "invocation");
    assert.equal(incomplete[0]?.attempted, false);
    assert.equal(incomplete[0]?.telemetryComplete, false);

    recordUnobservedGitHubInvocation(["run", "download", "123", "--repo", "raw/secret"], env, NOW);
    recordGithubEgressMember({ env, nowMs: NOW });
    const recorded = jsonLines(metricsPath);
    assert.equal(recorded[1]?.operation, "artifact_download");
    assert.equal(recorded[1]?.unit, "invocation");
    assert.equal(recorded[1]?.telemetryComplete, false);
    assert.equal(recorded[2]?.unit, "member");
    assert.equal(recorded[2]?.firstRepeat, "first");
    assert.equal(recorded[2]?.telemetryComplete, true);
    assert.equal(readFileSync(metricsPath, "utf8").includes("raw/secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broker lookups and conditional responses use separate telemetry units", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-etag-"));
  try {
    const metricsPath = join(root, "metrics.jsonl");
    const env = observerEnv(metricsPath, join(root, "rate.jsonl"));
    const args = ["api", "repos/openclaw/openclaw/issues/42/comments?per_page=100&page=2"];
    recordGithubEgressBrokerEvent(args, {
      env,
      nowMs: NOW,
      unit: "broker_lookup",
      outcome: "cache_hit",
    });
    recordGithubEgressBrokerEvent(args, {
      env,
      nowMs: NOW,
      unit: "conditional_response",
      outcome: "cache_304_served",
      status: 304,
    });
    const metrics = jsonLines(metricsPath);
    assert.deepEqual(
      metrics.map((metric) => ({
        unit: metric.unit,
        outcome: metric.outcome,
        statusBucket: metric.statusBucket,
        pageBucket: metric.pageBucket,
      })),
      [
        {
          unit: "broker_lookup",
          outcome: "cache_hit",
          statusBucket: "none",
          pageBucket: "2",
        },
        {
          unit: "conditional_response",
          outcome: "cache_304_served",
          statusBucket: "3xx",
          pageBucket: "2",
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor exposes only closed method, operation, and route dimensions", () => {
  assert.deepEqual(
    githubEgressCommandDescriptor([
      "api",
      "repos/o/r/issues/4/comments?per_page=100&cursor=secret",
      "--paginate",
    ]),
    { operation: "comments", method: "GET", routeTemplate: "issue_comments", wireSafe: true },
  );
  assert.deepEqual(githubEgressCommandDescriptor(["workflow", "run", "repair.yml"]), {
    operation: "workflow_dispatch",
    method: "POST",
    routeTemplate: "actions_workflow_dispatch",
    wireSafe: true,
  });
  assert.equal(githubEgressCommandDescriptor(["run", "download", "1"]).wireSafe, false);
  assert.equal(githubEgressRouteTemplate("/repos/o/r/unknown/raw/path"), "unknown");
  assert.deepEqual(
    [
      ["/graphql", "graphql"],
      ["/user", "authenticated_user"],
      ["/search/issues?q=private", "search_issues"],
      ["/repos/o/r/issues", "issues_collection"],
      ["/repos/o/r/issues/4/timeline", "issue_timeline"],
      ["/repos/o/r/pulls/4/comments", "pull_comments"],
      ["/repos/o/r/pulls/4/files", "pull_files"],
      ["/repos/o/r/pulls/4/commits", "pull_commits"],
      ["/repos/o/r/labels/name", "repository_labels"],
      ["/repos/o/r/collaborators/person/permission", "collaborator_permission"],
      ["/repos/o/r/contents/private/path", "repository_contents"],
      ["/repos/o/r/commits", "commits_collection"],
      ["/repos/o/r/commits/secret", "commit_metadata"],
      ["/repos/o/r/commits/secret/status", "commit_status"],
      ["/repos/o/r/commits/secret/check-runs", "commit_check_runs"],
      ["/repos/o/r/commits/secret/pulls", "commit_pulls"],
      ["/repos/o/r/actions/runs", "actions_runs"],
      ["/repos/o/r/actions/runs/42/jobs", "actions_run_jobs"],
    ].map(([route, expected]) => [githubEgressRouteTemplate(route!), expected]),
    [
      ["graphql", "graphql"],
      ["authenticated_user", "authenticated_user"],
      ["search_issues", "search_issues"],
      ["issues_collection", "issues_collection"],
      ["issue_timeline", "issue_timeline"],
      ["pull_comments", "pull_comments"],
      ["pull_files", "pull_files"],
      ["pull_commits", "pull_commits"],
      ["repository_labels", "repository_labels"],
      ["collaborator_permission", "collaborator_permission"],
      ["repository_contents", "repository_contents"],
      ["commits_collection", "commits_collection"],
      ["commit_metadata", "commit_metadata"],
      ["commit_status", "commit_status"],
      ["commit_check_runs", "commit_check_runs"],
      ["commit_pulls", "commit_pulls"],
      ["actions_runs", "actions_runs"],
      ["actions_run_jobs", "actions_run_jobs"],
    ],
  );
});

test("wire evidence completes high-level gh invocations without leaking their arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-high-level-"));
  try {
    const metricsPath = join(root, "metrics.jsonl");
    const env = observerEnv(metricsPath, join(root, "rate.jsonl"));
    observeGitHubDebugStderr(
      Buffer.from(
        debugFrame({
          page: null,
          status: 200,
          at: "2026-08-12T11:59:58.000Z",
          route: "/repos/private-owner/private-repo/issues/991",
          method: "PATCH",
        }),
      ),
      ["issue", "edit", "991", "--add-label", "private-label"],
      env,
      NOW,
    );
    const invocation = jsonLines(metricsPath).find((metric) => metric.unit === "invocation");
    assert.deepEqual(
      {
        operation: invocation?.operation,
        method: invocation?.method,
        routeTemplate: invocation?.routeTemplate,
        telemetryComplete: invocation?.telemetryComplete,
      },
      {
        operation: "item_metadata",
        method: "PATCH",
        routeTemplate: "issue_metadata",
        telemetryComplete: true,
      },
    );
    assert.equal(readFileSync(metricsPath, "utf8").includes("private-label"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime attribution follows the selected credential instead of throttle text", () => {
  const keys = [
    "CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH",
    "CLAWSWEEPER_GITHUB_STAGE",
    "CLAWSWEEPER_GITHUB_SOURCE_ACTION",
    "CLAWSWEEPER_GITHUB_CLAIM_GENERATION",
    "CLAWSWEEPER_GITHUB_REQUEST_REPEAT",
    "CLAWSWEEPER_PUBLIC_GH_TOKEN",
    "GH_TOKEN",
    "REPO_TOKEN",
    "GITHUB_REPOSITORY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: "metrics.jsonl",
    CLAWSWEEPER_GITHUB_STAGE: "publication_apply",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "scheduled_hot_intake",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "2",
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "true",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-actions-token",
    GH_TOKEN: "target-app-token",
    REPO_TOKEN: "repository-actions-token",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
  });
  const requests: Array<{ token: string; pool: string }> = [];
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    targetRepo: () => "openclaw/openclaw",
    run: (_command, _args, options) => {
      requests.push({
        token: String(options?.env?.GH_TOKEN || process.env.GH_TOKEN || ""),
        pool: String(options?.env?.CLAWSWEEPER_GITHUB_POOL_CLASS || ""),
      });
      return "{}";
    },
  });
  try {
    runtime.ghWithPreparedTimeout(["api", "repos/openclaw/openclaw/issues/1"], 1_000);
    runtime.ghWithPreparedTimeout(
      ["api", "repos/openclaw/openclaw/issues/1", "--method", "PATCH"],
      1_000,
    );
    runtime.ghWithPreparedTimeout(["api", "repos/openclaw/openclaw/issues/1"], 1_000, {
      GH_TOKEN: "repository-actions-token",
    });
    assert.deepEqual(requests, [
      { token: "public-actions-token", pool: "public_read_fallback" },
      { token: "target-app-token", pool: "target_app" },
      { token: "repository-actions-token", pool: "repository_actions" },
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("publication workflows retain v1 metrics while wiring bounded v2 observation and upload", () => {
  const batchSource = readFileSync(".github/workflows/exact-review-batch-publish.yml", "utf8");
  const sweepSource = readFileSync(".github/workflows/sweep.yml", "utf8");
  const batch = YAML.parse(batchSource) as {
    jobs: { publish: { env: Record<string, string>; steps: Array<Record<string, unknown>> } };
  };
  const sweep = YAML.parse(sweepSource) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
  };
  assert.ok(batch.jobs.publish.env.CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH);
  assert.ok(batch.jobs.publish.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH);
  const batchSteps = batch.jobs.publish.steps;
  assertStepOrder(batchSteps, [
    "./.github/actions/setup-github-egress-observer",
    "Prepare each item independently",
    "Finalize healthy members under a fenced heartbeat",
    "Submit batch GitHub egress telemetry",
    "Release unfinished batch members",
  ]);
  assert.match(batchSource, /CLAWSWEEPER_GITHUB_POOL_CLASS=repository_actions/);
  assert.match(batchSource, /CLAWSWEEPER_GITHUB_STAGE=publication_router/);
  assert.equal(
    batchSteps.find((step) => step.id === "github-egress-observer")?.["continue-on-error"],
    true,
  );

  const direct = sweep.jobs["event-review-apply"]!.steps;
  assertStepOrder(direct, [
    "./.github/actions/setup-github-egress-observer",
    "Record direct-publication member",
    "Deliver GitHub effects and prepare direct state mutation",
    "Finalize direct exact review lifecycle",
    "Submit direct GitHub egress telemetry",
    "Fail unsuccessful exact review generation",
  ]);
  assert.equal(
    direct.find((step) => step.id === "direct-github-egress-observer")?.["continue-on-error"],
    true,
  );
  assert.equal(
    direct.find((step) => step.name === "Record direct-publication member")?.["continue-on-error"],
    true,
  );
  assert.equal(
    direct.find((step) => step.name === "Record direct-publication member")?.env?.TARGET_REPO,
    "${{ steps.target.outputs.target_repo }}",
  );
  const artifact = sweep.jobs["event-review-publish"]!.steps;
  assertStepOrder(artifact, [
    "./.github/actions/setup-github-egress-observer",
    "Record artifact-publication member",
    "Download exact review artifact bundle",
    "Record artifact download transport boundary",
    "Publish event result and apply safe close",
    "Queue deferred exact verdict router",
    "Submit artifact-publication GitHub egress telemetry",
    "Fail unsuccessful exact review publication",
  ]);
  assert.equal(
    artifact.find((step) => step.id === "artifact-github-egress-observer")?.["continue-on-error"],
    true,
  );
  assert.equal(
    artifact.find((step) => step.name === "Record artifact-publication member")?.env?.TARGET_REPO,
    "${{ steps.publication-context.outputs.target_repo }}",
  );
  assert.match(sweepSource, /CLAWSWEEPER_GITHUB_POOL_CLASS: repository_actions/);
  assert.match(sweepSource, /CLAWSWEEPER_GITHUB_STAGE: publication_router/);
  assert.match(
    sweepSource,
    /repeat_revision=\$\{responseProtocol === 2 \? repeatRevision : false\}/,
  );
});

test("signed upload, SQLite restart, retention, cardinality, and public privacy are bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-egress-upload-"));
  try {
    const metricsPath = join(root, "metrics.jsonl");
    const rateLimitPath = join(root, "rate.jsonl");
    const env = observerEnv(metricsPath, rateLimitPath);
    recordGithubEgressMember({ env, nowMs: NOW });
    recordUnobservedGitHubInvocation(["run", "download", "123"], env, NOW);
    writeFileSync(metricsPath, '{"raw_repo":"private-owner/private-repo"}\nnot-json\n', {
      flag: "a",
    });
    const submissions = githubEgressTelemetrySubmissions({
      metricsPath,
      rateLimitPath,
      receiptScope: "test-run:1:test-job",
    });
    assert.equal(submissions.length, 1);
    assert.ok(submissions[0]?.metrics.some((metric) => metric.telemetryComplete === false));
    assert.equal(JSON.stringify(submissions).includes("private-owner"), false);
    const otherRun = githubEgressTelemetrySubmissions({
      metricsPath,
      rateLimitPath,
      receiptScope: "test-run:2:test-job",
    });
    assert.notEqual(otherRun[0]?.receiptId, submissions[0]?.receiptId);

    const emptySink = githubEgressTelemetrySubmissions({
      metricsPath: join(root, "missing-metrics.jsonl"),
      rateLimitPath: join(root, "missing-rate-limits.jsonl"),
      receiptScope: "test-run:3:missing-sink",
    });
    assert.equal(emptySink.length, 1);
    assert.deepEqual(
      emptySink[0]?.metrics.map((metric) => ({
        unit: metric.unit,
        attempted: metric.attempted,
        outcome: metric.outcome,
        telemetryComplete: metric.telemetryComplete,
        count: metric.count,
      })),
      [
        {
          unit: "invocation",
          attempted: false,
          outcome: "ambiguous",
          telemetryComplete: false,
          count: 1,
        },
      ],
    );

    const storage = new MemoryDurableStorage();
    const store = new GithubEgressTelemetryStore(storage);
    store.ensureSchemaSync();
    assert.deepEqual(store.publicSummary(NOW).completeness, {
      complete: 0,
      incomplete: 0,
      observed: false,
      telemetry_complete: false,
    });
    let signature = "";
    const fakeFetch: typeof fetch = async (_input, init) => {
      signature = new Headers(init?.headers).get("x-clawsweeper-exact-review-signature") || "";
      const result = store.ingest(JSON.parse(String(init?.body)), NOW);
      return Response.json(result.ok ? { ok: true, ...result } : { error: result.error }, {
        status: result.ok ? 202 : 400,
      });
    };
    const first = await submitGitHubEgressTelemetry({
      baseUrl: "https://clawsweeper.invalid",
      webhookSecret: "test-secret",
      submission: submissions[0]!,
      fetch: fakeFetch,
    });
    assert.deepEqual(first, { accepted: true, deduped: false });
    assert.match(signature, /^sha256=[0-9a-f]{64}$/);
    const duplicate = await submitGitHubEgressTelemetry({
      baseUrl: "https://clawsweeper.invalid",
      webhookSecret: "test-secret",
      submission: submissions[0]!,
      fetch: fakeFetch,
    });
    assert.deepEqual(duplicate, { accepted: false, deduped: true });

    const restarted = new GithubEgressTelemetryStore(storage);
    restarted.ensureSchemaSync();
    const publicView = restarted.publicObservability(6, NOW);
    assert.ok(publicView);
    assert.equal(publicView!.completeness.telemetry_complete, false);
    assert.equal(publicView!.completeness.rows_truncated, false);
    assert.equal(publicView!.completeness.rate_limit_rows_truncated, false);
    assert.equal(publicView!.completeness.query_complete, true);
    assert.deepEqual(publicView!.units, {
      invocation: 3,
      wire_attempt: 0,
      member: 1,
      broker_lookup: 0,
      conditional_response: 0,
    });
    assert.equal(publicView!.privacy.pool_identity, "withheld");
    const serialized = JSON.stringify(publicView);
    for (const sentinel of [
      "private-owner",
      "private-repo",
      "pool:v1",
      "item_key",
      "branch",
      "cursor",
      "etag",
      "request_id",
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }

    const windowStorage = new MemoryDurableStorage();
    const windowStore = new GithubEgressTelemetryStore(windowStorage);
    windowStore.ensureSchemaSync();
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1_000;
    assert.equal(
      windowStore.ingest(telemetryBody("9".repeat(64), twoHoursAgo), twoHoursAgo).ok,
      true,
    );
    assert.equal(windowStore.publicObservability(1, NOW)?.completeness.observed, false);
    assert.equal(windowStore.publicObservability(6, NOW)?.completeness.observed, true);
    assert.equal(windowStore.publicObservability(0.5, NOW), null);

    const unalignedNow = NOW + 2 * 60 * 1_000;
    const firstPartialBucket = unalignedNow - 60 * 60 * 1_000 + 30 * 1_000;
    assert.equal(
      windowStore.ingest(telemetryBody("8".repeat(64), firstPartialBucket), firstPartialBucket).ok,
      true,
    );
    const oneHourView = windowStore.publicObservability(1, unalignedNow);
    assert.equal(oneHourView?.completeness.observed, true);
    assert.equal(oneHourView?.units.wire_attempt, 1);

    const fifteenMinutesAgo = unalignedNow - 15 * 60 * 1_000 + 30 * 1_000;
    assert.equal(
      windowStore.ingest(telemetryBody("6".repeat(64), fifteenMinutesAgo), fifteenMinutesAgo).ok,
      true,
    );
    const fifteenMinuteView = windowStore.publicObservability(0.25, unalignedNow);
    assert.equal(fifteenMinuteView?.window.hours, 0.25);
    assert.equal(fifteenMinuteView?.window.bucket_minutes, 5);
    assert.equal(fifteenMinuteView?.completeness.observed, true);
    assert.equal(fifteenMinuteView?.completeness.query_complete, true);
    assert.equal(fifteenMinuteView?.units.wire_attempt, 1);

    const unalignedDayNow = NOW + 30 * 60 * 1_000;
    const firstPartialHour = unalignedDayNow - 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000;
    assert.equal(
      windowStore.ingest(telemetryBody("7".repeat(64), firstPartialHour), firstPartialHour).ok,
      true,
    );
    const oneDayView = windowStore.publicObservability(24, unalignedDayNow);
    assert.equal(oneDayView?.completeness.observed, true);
    assert.equal(oneDayView?.units.wire_attempt, 4);

    const highCardinalityStorage = new MemoryDurableStorage();
    const highCardinalityStore = new GithubEgressTelemetryStore(highCardinalityStorage);
    highCardinalityStore.ensureSchemaSync();
    const insertRollup = (bucketStart: number, configRevision: string) =>
      highCardinalityStorage.sql.exec(
        `INSERT INTO exact_review_github_egress_rollups_v2 (
           bucket_kind, bucket_start, deployment_revision, config_revision,
           pool_class, pool_identity, stage, source_action, operation, method,
           route_template, page_bucket, unit, outcome, status_bucket,
           latency_bucket, claim_generation_bucket, first_repeat, attempted,
           telemetry_complete, count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "five_minute",
        bucketStart,
        "a".repeat(16),
        configRevision,
        "repository_actions",
        "private-pool",
        "publication_apply",
        "scheduled_normal",
        "item_metadata",
        "GET",
        "issue_metadata",
        "none",
        "invocation",
        "success",
        "2xx",
        "100_249ms",
        "1",
        "first",
        1,
        1,
        1,
      );
    for (let index = 0; index < 2_001; index += 1) {
      insertRollup(NOW - 50 * 60 * 1_000, index.toString(16).padStart(16, "0"));
    }
    insertRollup(NOW - 10 * 60 * 1_000, "f".repeat(16));
    const truncatedHour = highCardinalityStore.publicObservability(1, NOW);
    assert.equal(truncatedHour?.rows.length, 2_000);
    assert.equal(truncatedHour?.completeness.rows_truncated, true);
    assert.equal(truncatedHour?.completeness.query_complete, false);
    const completeQuarterHour = highCardinalityStore.publicObservability(0.25, NOW);
    assert.equal(completeQuarterHour?.rows.length, 1);
    assert.equal(completeQuarterHour?.units.invocation, 1);
    assert.equal(completeQuarterHour?.completeness.rows_truncated, false);
    assert.equal(completeQuarterHour?.completeness.query_complete, true);

    const future = NOW + 8 * 24 * 60 * 60 * 1_000;
    const futureBody = telemetryBody("f".repeat(64), future);
    assert.equal(restarted.ingest(futureBody, future).ok, true);
    const fiveMinuteRows = Array.from(
      storage.sql.exec(
        "SELECT bucket_start FROM exact_review_github_egress_rollups_v2 WHERE bucket_kind = 'five_minute' ORDER BY bucket_start",
      ),
    );
    const hourlyRows = Array.from(
      storage.sql.exec(
        "SELECT bucket_start FROM exact_review_github_egress_rollups_v2 WHERE bucket_kind = 'hour' ORDER BY bucket_start",
      ),
    );
    assert.deepEqual(
      fiveMinuteRows.map((row) => row.bucket_start),
      [future],
    );
    assert.equal(hourlyRows.length >= 2, true);

    const invalidRoute = telemetryBody("e".repeat(64), future);
    invalidRoute.metrics[0]!.route_template = "repos/raw/private";
    assert.deepEqual(restarted.ingest(invalidRoute, future), {
      ok: false,
      error: "invalid_github_egress_telemetry",
    });
    const oversized = telemetryBody("d".repeat(64), future);
    oversized.metrics = Array.from({ length: 129 }, () => structuredClone(oversized.metrics[0]!));
    assert.equal(restarted.ingest(oversized, future).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signed egress evidence applies only authoritative resets attributable to Actions", async () => {
  const now = Math.floor(Date.now() / 1_000) * 1_000;
  const resetAt = now + 90_000;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const body = telemetryBody("1".repeat(64), now) as Record<string, unknown>;
  body.rate_limit_observations = [
    rateLimitObservation("public_read_fallback", now, resetAt, 0),
    rateLimitObservation("repository_actions", now + 1, resetAt + 10_000, 0),
    rateLimitObservation("target_app", now + 2, resetAt + 20_000, 0),
    rateLimitObservation("repository_actions", now + 3, resetAt + 30_000, 10),
  ];

  const submit = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/github-egress-telemetry", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  assert.deepEqual(await (await submit()).json(), { ok: true, accepted: true, deduped: false });
  assert.deepEqual(await (await submit()).json(), { ok: true, accepted: false, deduped: true });

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(
    stats.lanes.publication.credential_circuits.map((circuit) => ({
      pool: circuit.pool,
      scope: circuit.scope,
      target_owner: circuit.target_owner,
      blocked_until: circuit.blocked_until,
      reset_source: circuit.reset_source,
      authoritative: circuit.authoritative,
    })),
    [
      {
        pool: "actions:openclaw/clawsweeper",
        scope: "repository_actions",
        target_owner: null,
        blocked_until: new Date(resetAt + 10_000).toISOString(),
        reset_source: "rate_limit_reset",
        authoritative: true,
      },
    ],
  );
});

test("a deduped egress receipt cannot introduce circuit evidence from a conflicting body", async () => {
  const now = Math.floor(Date.now() / 1_000) * 1_000;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const receiptId = "2".repeat(64);
  const metricsOnly = telemetryBody(receiptId, now) as Record<string, unknown>;
  const submit = (body: Record<string, unknown>) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/github-egress-telemetry", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  assert.deepEqual(await (await submit(metricsOnly)).json(), {
    ok: true,
    accepted: true,
    deduped: false,
  });
  const conflicting = structuredClone(metricsOnly);
  conflicting.rate_limit_observations = [
    rateLimitObservation("repository_actions", now, now + 90_000, 0),
  ];
  assert.deepEqual(await (await submit(conflicting)).json(), {
    ok: true,
    accepted: false,
    deduped: true,
  });

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(stats.lanes.publication.credential_circuits, []);
});

test("legacy egress receipts migrate without accepting new circuit evidence", () => {
  const now = Math.floor(Date.now() / 1_000) * 1_000;
  const receiptId = "3".repeat(64);
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_github_egress_receipts_v2 (
       receipt_id TEXT PRIMARY KEY,
       observed_at INTEGER NOT NULL
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_github_egress_receipts_v2 (receipt_id, observed_at)
     VALUES (?, ?)`,
    receiptId,
    now,
  );
  const store = new GithubEgressTelemetryStore(storage);
  store.ensureSchemaSync();
  const conflicting = telemetryBody(receiptId, now) as Record<string, unknown>;
  conflicting.rate_limit_observations = [
    rateLimitObservation("repository_actions", now, now + 90_000, 0),
  ];

  const result = store.ingest(conflicting, now);
  assert.equal(result.ok, true);
  assert.equal(result.accepted, false);
  assert.equal(result.deduped, true);
  assert.deepEqual(result.credentialCircuits, []);
  assert.ok(
    Array.from(
      storage.sql.exec(
        `SELECT name FROM pragma_table_info('exact_review_github_egress_receipts_v2')`,
      ),
    ).some((row) => row.name === "credential_circuits_json"),
  );
});

function observerEnv(metricsPath: string, rateLimitPath: string): NodeJS.ProcessEnv {
  return {
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: metricsPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_DETAILS_PATH: rateLimitPath,
    CLAWSWEEPER_GITHUB_POOL_CLASS: "repository_actions",
    CLAWSWEEPER_GITHUB_STAGE: "publication_prepare",
    CLAWSWEEPER_GITHUB_SOURCE_ACTION: "scheduled_hot_intake",
    CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "2",
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: "false",
    CLAWSWEEPER_DEPLOYMENT_REVISION: "a".repeat(40),
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    EXACT_REVIEW_BATCH_MAX_ITEMS: "50",
    EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY: "1",
  };
}

function debugFrame(options: {
  page: number | null;
  status: number;
  at: string;
  route?: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  duration?: string;
}) {
  const route = options.route ?? "/repos/private-owner/private-repo/issues/991/comments";
  const method = options.method ?? "GET";
  const query =
    options.page === null ? "?per_page=100&cursor=cursor-secret" : `?page=${options.page}`;
  return [
    `* Request at ${options.at}`,
    `* Request to https://api.github.com${route}${query}`,
    `> ${method} ${route}${query} HTTP/1.1`,
    "> X-GitHub-Api-Version: 2022-11-28",
    "< HTTP/2.0 " + options.status,
    "< Etag: etag-secret",
    "< X-Github-Request-Id: request-id-secret",
    "< X-Ratelimit-Limit: 5000",
    `< X-Ratelimit-Remaining: ${options.status === 403 ? 0 : 10}`,
    `< X-Ratelimit-Used: ${options.status === 403 ? 5000 : 4990}`,
    "< X-Ratelimit-Reset: 1786533900",
    "< X-Ratelimit-Resource: core",
    "body-secret",
    `* Request took ${options.duration ?? "20ms"}`,
  ].join("\n");
}

function jsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function telemetryBody(receiptId: string, now: number) {
  const bucket = new Date(Math.floor(now / 300_000) * 300_000).toISOString();
  return {
    version: 2,
    receipt_id: receiptId,
    metrics: [
      {
        bucket_start: bucket,
        deployment_revision: "a".repeat(16),
        config_revision: "b".repeat(16),
        pool_class: "repository_actions",
        pool_identity: "c".repeat(24),
        stage: "publication_apply",
        source_action: "scheduled_hot",
        operation: "comments",
        method: "GET",
        route_template: "issue_comments",
        page_bucket: "1",
        unit: "wire_attempt",
        outcome: "success",
        status_bucket: "2xx",
        latency_bucket: "100_249ms",
        claim_generation_bucket: "1",
        first_repeat: "first",
        attempted: true,
        telemetry_complete: true,
        count: 1,
      },
    ],
    rate_limit_observations: [],
  };
}

function rateLimitObservation(
  poolClass: "repository_actions" | "target_app" | "public_read_fallback",
  observedAt: number,
  resetAt: number,
  remaining: number,
) {
  return {
    observed_at: new Date(observedAt).toISOString(),
    deployment_revision: "a".repeat(16),
    config_revision: "b".repeat(16),
    pool_class: poolClass,
    pool_identity: "c".repeat(24),
    stage: "publication_apply",
    source_action: "scheduled_hot",
    operation: "item_metadata",
    method: "GET",
    route_template: "issue_metadata",
    page_bucket: "1",
    status: 403,
    headers: {
      retryAfterPresent: false,
      retryAfterSeconds: null,
      limitPresent: true,
      limit: 5_000,
      remainingPresent: true,
      remaining,
      usedPresent: true,
      used: 5_000 - remaining,
      resetPresent: true,
      resetEpochSeconds: Math.floor(resetAt / 1_000),
      resourcePresent: true,
      resource: "core",
    },
    reset_authority_candidate: "rate_limit_reset",
    telemetry_complete: true,
  };
}

function assertStepOrder(steps: Array<Record<string, unknown>>, labels: string[]) {
  const indexes = labels.map((label) => {
    const index = steps.findIndex((step) => step.name === label || step.uses === label);
    assert.notEqual(index, -1, label);
    return index;
  });
  for (let index = 1; index < indexes.length; index += 1) {
    assert.ok(
      indexes[index - 1]! < indexes[index]!,
      `${labels[index - 1]} before ${labels[index]}`,
    );
  }
}
