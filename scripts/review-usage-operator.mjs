import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

const ACCOUNT = "91b59577e757131d68d55a471fe32aca";
const WORKER = "clawsweeper-status";
const DATASET = "clawsweeper_review_usage";
const REPOSITORY = "openclaw/__review_usage_canary__";
const LANE = "operator-canary";
const API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT;
const SCRIPT = API + "/workers/scripts/" + WORKER;
const EXCLUDE = "blob1 != '" + REPOSITORY + "' AND blob4 != '" + LANE + "'";
const WINDOW = "timestamp >= NOW() - INTERVAL '30' DAY";
const HISTORICAL =
  "SELECT sum(_sample_interval) AS historical_full_rows, " +
  "sum(double1 * _sample_interval) AS input_tokens FROM " +
  DATASET +
  " WHERE " +
  WINDOW +
  " AND " +
  EXCLUDE +
  " AND double7 = 1 AND double8 = 0 LIMIT 8 FORMAT JSON";
const CORE_COUNT = "sum(if(double7 = 1 OR double8 = 1, _sample_interval, 0))";
const COHORTS =
  "sum(_sample_interval) AS reviews, sum(double7 * _sample_interval) AS full_reviews, " +
  "sum(if(double7 = 0 AND double8 = 1, _sample_interval, 0)) AS partial_reviews, " +
  "sum(if(double7 = 0 AND double8 = 0, _sample_interval, 0)) AS missing_reviews, " +
  CORE_COUNT +
  " AS core_reviews, sum(double1 * _sample_interval) AS input_tokens, " +
  "sum(double4 * _sample_interval) AS output_tokens, " +
  "sum(((double1 - double2 - double3) * 2 + double2 * 0.10 + double3 * 2.50 + double4 * 10) " +
  "* double7 * _sample_interval) / 1000000 AS full_usage_estimated_usd";
const AVERAGES =
  "sum(double1 * _sample_interval) / " +
  CORE_COUNT +
  " AS avg_input_tokens, " +
  "sum(double4 * _sample_interval) / " +
  CORE_COUNT +
  " AS avg_output_tokens, " +
  "sum((double1 + double4) * _sample_interval) / " +
  CORE_COUNT +
  " AS avg_total_tokens";
const DURATIONS =
  "quantileExactWeighted(0.50)(double6, _sample_interval) AS duration_p50_ms, " +
  "quantileExactWeighted(0.95)(double6, _sample_interval) AS duration_p95_ms";
const COHORT_FIELDS = [
  "reviews",
  "full_reviews",
  "partial_reviews",
  "missing_reviews",
  "core_reviews",
  "input_tokens",
  "output_tokens",
  "full_usage_estimated_usd",
];
const AVERAGE_FIELDS = ["avg_input_tokens", "avg_output_tokens", "avg_total_tokens"];
const DURATION_FIELDS = ["duration_p50_ms", "duration_p95_ms"];
const GLOBAL = [
  "SELECT " +
    COHORTS +
    " FROM " +
    DATASET +
    " WHERE " +
    WINDOW +
    " AND " +
    EXCLUDE +
    " LIMIT 8 FORMAT JSON",
  "SELECT " +
    CORE_COUNT +
    " AS core_reviews, " +
    DURATIONS +
    ", " +
    AVERAGES +
    " FROM " +
    DATASET +
    " WHERE " +
    WINDOW +
    " AND " +
    EXCLUDE +
    " HAVING " +
    CORE_COUNT +
    " > 0 LIMIT 8 FORMAT JSON",
  HISTORICAL,
];

let writeProgress;
class OperatorError extends Error {}
function requireCondition(condition, code) {
  if (!condition) throw new OperatorError(code);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function request(url, options, cap, status = 200) {
  let response;
  let reader;
  try {
    response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    requireCondition(response.status === status, "http_" + response.status);
    requireCondition(Number(response.headers.get("content-length") || 0) <= cap, "response_limit");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireCondition(size <= cap, "response_limit");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError("transport_or_json");
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}

async function metadata(path, token) {
  const value = await request(
    SCRIPT + path,
    { headers: { authorization: "Bearer " + token } },
    256 * 1024,
  );
  requireCondition(value.success === true && record(value.result), "metadata_shape");
  return value.result;
}

function bindingsMatch(bindings, sha) {
  if (!Array.isArray(bindings)) return false;
  const deploy = bindings.filter((binding) => binding?.name === "CLAWSWEEPER_DEPLOY_SHA");
  const dataset = bindings.filter((binding) => binding?.name === "REVIEW_USAGE");
  return (
    deploy.length === 1 &&
    deploy[0].type === "plain_text" &&
    deploy[0].text === sha &&
    dataset.length === 1 &&
    dataset[0].type === "analytics_engine" &&
    dataset[0].dataset === DATASET
  );
}

async function guard(token, sha, version) {
  const deployment = await metadata("/deployments?per_page=1&page=1", token);
  requireCondition(
    Array.isArray(deployment.deployments) && deployment.deployments.length === 1,
    "deployment_shape",
  );
  const versions = deployment.deployments[0]?.versions;
  requireCondition(
    Array.isArray(versions) &&
      versions.length === 1 &&
      versions[0].version_id === version &&
      versions[0].percentage === 100,
    "traffic_guard",
  );
  const details = await metadata("/versions/" + version, token);
  requireCondition(
    details.id === version && bindingsMatch(details.resources?.bindings, sha),
    "version_guard",
  );
  const settings = await metadata("/settings", token);
  requireCondition(bindingsMatch(settings.bindings, sha), "settings_guard");
}

async function query(sql, token, fields) {
  const value = await request(
    API + "/analytics_engine/sql",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "text/plain" },
      body: sql,
    },
    64 * 1024,
  );
  requireCondition(Array.isArray(value.data) && value.data.length <= 8, "analytics_shape");
  return value.data.map((row) => {
    requireCondition(record(row), "analytics_row");
    return Object.fromEntries(
      fields.map((field) => {
        const raw = row[field];
        // FORMAT JSON may encode UInt64 aggregates as decimal strings. Never echo raw fields.
        const item =
          typeof raw === "string" && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw) ? Number(raw) : raw;
        requireCondition(
          typeof item === "number" &&
            Number.isFinite(item) &&
            item >= 0 &&
            item <= Number.MAX_SAFE_INTEGER,
          "analytics_value",
        );
        return [field, item];
      }),
    );
  });
}

function output(value, env) {
  console.log(JSON.stringify(value));
  if (env.GITHUB_OUTPUT) {
    for (const key of ["source_sha", "deployment_sha", "version_id", "canary_run_id"])
      if (value[key]) appendFileSync(env.GITHUB_OUTPUT, key + "=" + value[key] + "\n");
  }
}

async function main(env) {
  requireCondition(process.argv.length === 2, "arguments");
  const mode = env.USAGE_OPERATOR_MODE;
  const sha = env.USAGE_DEPLOY_SHA || "";
  const version = env.USAGE_VERSION_ID || "";
  requireCondition(
    env.GITHUB_REPOSITORY === "openclaw/clawsweeper" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ""),
    "trusted_source",
  );
  requireCondition(
    /^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(version),
    "approved_identity",
  );
  requireCondition(["operator-read", "canary", "read-back"].includes(mode), "mode");
  const identity = { mode, source_sha: env.GITHUB_SHA, deployment_sha: sha, version_id: version };
  if (mode === "canary") {
    requireCondition(
      env.USAGE_CANARY_AUTHORIZED === "true" &&
        env.USAGE_EXECUTE === "true" &&
        env.GITHUB_RUN_ATTEMPT === "1" &&
        /^[1-9][0-9]{0,31}$/.test(env.GITHUB_RUN_ID || "") &&
        env.USAGE_GUARD_SOURCE_SHA === env.GITHUB_SHA &&
        env.USAGE_GUARD_DEPLOY_SHA === sha &&
        env.USAGE_GUARD_VERSION_ID === version,
      "write_authorization",
    );
    requireCondition(
      env.CLAWSWEEPER_WEBHOOK_SECRET && !env.CLOUDFLARE_API_TOKEN,
      "write_credential",
    );
    const usages = [
      null,
      {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: null,
        output_tokens: 30,
        reasoning_output_tokens: 10,
      },
      {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
      {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 5,
        output_tokens: 30,
        reasoning_output_tokens: 10,
      },
    ];
    writeProgress = { canary_run_id: env.GITHUB_RUN_ID, attempted: 0, acknowledged: 0 };
    for (const [index, usage] of usages.entries()) {
      writeProgress.attempted = index + 1;
      const body = JSON.stringify({
        schema: 1,
        target_repo: REPOSITORY,
        item_number: index + 1,
        item_kind: "pull_request",
        run_id: env.GITHUB_RUN_ID,
        run_attempt: 1,
        trigger_lane: LANE,
        outcome: "ok",
        duration_ms: 100,
        usage,
      });
      const signature =
        "sha256=" + createHmac("sha256", env.CLAWSWEEPER_WEBHOOK_SECRET).update(body).digest("hex");
      const result = await request(
        "https://clawsweeper.openclaw.ai/internal/exact-review/review-usage",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body,
        },
        64 * 1024,
        202,
      );
      requireCondition(result.ok === true, "canary_acknowledgement");
      writeProgress.acknowledged++;
    }
    output({ ...identity, canary_run_id: env.GITHUB_RUN_ID, submitted: 4 }, env);
    return;
  }
  const token = env.CLOUDFLARE_API_TOKEN;
  requireCondition(token && !env.CLAWSWEEPER_WEBHOOK_SECRET, "read_credential");
  const run = env.USAGE_CANARY_RUN_ID || "";
  if (mode === "read-back") requireCondition(/^[1-9][0-9]{0,31}$/.test(run), "canary_run_id");
  await guard(token, sha, version);
  let evidence;
  if (mode === "operator-read") {
    evidence = [
      await query(GLOBAL[0], token, COHORT_FIELDS),
      await query(GLOBAL[1], token, ["core_reviews", ...DURATION_FIELDS, ...AVERAGE_FIELDS]),
      await query(GLOBAL[2], token, ["historical_full_rows", "input_tokens"]),
    ];
  } else {
    const where =
      " FROM " +
      DATASET +
      " WHERE timestamp >= NOW() - INTERVAL '1' DAY AND blob1 = '" +
      REPOSITORY +
      "' AND blob4 = '" +
      LANE +
      "' AND blob7 = '" +
      run +
      "'";
    const points = await query(
      "SELECT blob8 AS item, double7 AS full_mask, double8 AS core_mask, double6 AS duration_ms, " +
        "sum(_sample_interval) AS samples, sum(double1 * _sample_interval) AS input_tokens, " +
        "sum(double3 * _sample_interval) AS cache_write_input_tokens, " +
        "sum(double2 * _sample_interval) AS cached_input_tokens, sum(double4 * _sample_interval) AS output_tokens, " +
        "sum(double5 * _sample_interval) AS reasoning_output_tokens" +
        where +
        " GROUP BY item, full_mask, core_mask, duration_ms ORDER BY item LIMIT 8 FORMAT JSON",
      token,
      [
        "item",
        "full_mask",
        "core_mask",
        "samples",
        "input_tokens",
        "cache_write_input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "duration_ms",
      ],
    );
    const expected = [
      [1, 0, 0, 1, 0, 0, 0, 0, 0, 100],
      [2, 0, 1, 1, 100, 0, 20, 30, 10, 100],
      [3, 1, 1, 1, 0, 0, 0, 0, 0, 100],
      [4, 1, 1, 1, 100, 5, 20, 30, 10, 100],
    ];
    requireCondition(
      JSON.stringify(points.map((point) => Object.values(point))) === JSON.stringify(expected),
      "canary_persistence",
    );
    const aggregate = await query(
      "SELECT " +
        COHORTS +
        ", " +
        DURATIONS +
        ", " +
        AVERAGES +
        where +
        " HAVING " +
        CORE_COUNT +
        " > 0 LIMIT 8 FORMAT JSON",
      token,
      [...COHORT_FIELDS, ...DURATION_FIELDS, ...AVERAGE_FIELDS],
    );
    const expectedAggregate = {
      reviews: 4,
      full_reviews: 2,
      partial_reviews: 1,
      missing_reviews: 1,
      core_reviews: 3,
      input_tokens: 200,
      output_tokens: 60,
      full_usage_estimated_usd: 0.0004645,
      duration_p50_ms: 100,
      duration_p95_ms: 100,
      avg_input_tokens: 200 / 3,
      avg_output_tokens: 20,
      avg_total_tokens: 260 / 3,
    };
    // SQL and JSON double rounding can differ by a few ulps; this is not an accounting tolerance.
    requireCondition(
      aggregate.length === 1 &&
        Object.entries(expectedAggregate).every(
          ([key, value]) =>
            Math.abs(aggregate[0][key] - value) <= Math.max(1, value) * Number.EPSILON * 8,
        ),
      "canary_aggregate",
    );
    evidence = [
      points,
      aggregate,
      await query(HISTORICAL, token, ["historical_full_rows", "input_tokens"]),
    ];
  }
  await guard(token, sha, version);
  output({ ...identity, ...(mode === "read-back" ? { canary_run_id: run } : {}), evidence }, env);
}

main(process.env).catch((error) => {
  if (writeProgress) console.log(JSON.stringify({ ...writeProgress, partial_or_uncertain: true }));
  console.error(
    "review usage operator failed (" +
      (error instanceof OperatorError ? error.message : "internal_error") +
      ")",
  );
  console.error("[review-usage-operator] FAILED (exit 1)");
  process.exitCode = 1;
});
