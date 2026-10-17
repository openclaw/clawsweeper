import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

const script = "scripts/review-usage-operator.mjs";
const sha = "a".repeat(40);
const source = "b".repeat(40);
const version = "11111111-2222-3333-4444-555555555555";
const reservedRepo = "openclaw/__review_usage_canary__";
const lane = "operator-canary";
const bindings = [
  { name: "CLAWSWEEPER_DEPLOY_SHA", type: "plain_text", text: sha },
  { name: "REVIEW_USAGE", type: "analytics_engine", dataset: "clawsweeper_review_usage" },
  { name: "INGEST_TOKEN", type: "plain_text", text: "private-binding-sentinel" },
];
const baseEnv = {
  PATH: process.env.PATH,
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: source,
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "1",
  USAGE_OPERATOR_MODE: "operator-read",
  USAGE_DEPLOY_SHA: sha,
  USAGE_VERSION_ID: version,
  CLOUDFLARE_API_TOKEN: "synthetic-read-token",
};
type Call = {
  url: URL;
  method?: string;
  body: string;
  headers: import("node:http").IncomingHttpHeaders;
};
async function fixture(
  t: import("node:test").TestContext,
  options: {
    status?: number;
    mutate?: (value: any, call: Call, index: number) => unknown;
    raw?: string;
    redirect?: boolean;
    failWrite?: number;
    streamLimit?: boolean;
    stall?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const call = {
      url: new URL(String(request.headers["x-fixture-target"])),
      method: request.method,
      body,
      headers: request.headers,
    };
    calls.push(call);
    if (options.stall) return;
    if (options.redirect) {
      response.writeHead(307, { location: "/private-redirect-sentinel" }).end();
      return;
    }
    let value: any;
    const path = call.url.pathname;
    const write = path.endsWith("/review-usage");
    const writeCount = calls.filter((entry) => entry.url.pathname.endsWith("/review-usage")).length;
    let status = write ? 202 : 200;
    if (path.endsWith("/deployments"))
      value = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
    else if (path.includes("/versions/")) value = { id: version, resources: { bindings } };
    else if (path.endsWith("/settings")) value = { bindings };
    else if (write) value = { ok: true };
    else if (body.includes("GROUP BY item"))
      value = {
        data: [
          [1, 0, 0, 1, 0, 0, 0, 0, 0, 100],
          [2, 0, 1, 1, 100, 0, 20, 30, 10, 100],
          [3, 1, 1, 1, 0, 0, 0, 0, 0, 100],
          [4, 1, 1, 1, 100, 5, 20, 30, 10, 100],
        ].map((values) =>
          Object.fromEntries(
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
            ].map((key, i) => [key, values[i]]),
          ),
        ),
      };
    else if (body.includes("historical_full_rows"))
      value = { data: [{ historical_full_rows: "2", input_tokens: "40" }] };
    else if (body.includes("full_usage_estimated_usd"))
      value = {
        data: [
          {
            reviews: "4",
            full_reviews: "2",
            partial_reviews: "1",
            missing_reviews: "1",
            core_reviews: "3",
            input_tokens: "200",
            output_tokens: "60",
            full_usage_estimated_usd: 0.0004645,
            duration_p50_ms: 100,
            duration_p95_ms: 100,
            avg_input_tokens: 200 / 3,
            avg_output_tokens: 20,
            avg_total_tokens: 260 / 3,
          },
        ],
      };
    else if (body.includes("avg_input_tokens"))
      value = {
        data: [
          {
            core_reviews: 3,
            duration_p50_ms: 100,
            duration_p95_ms: 100,
            avg_input_tokens: 200 / 3,
            avg_output_tokens: 20,
            avg_total_tokens: 260 / 3,
          },
        ],
      };
    else if (body.includes("quantileExactWeighted"))
      value = { data: [{ duration_p50_ms: 100, duration_p95_ms: 100 }] };
    else
      value = {
        data: [
          {
            reviews: "4",
            full_reviews: "2",
            partial_reviews: "1",
            missing_reviews: "1",
            input_tokens: "200",
            output_tokens: "60",
          },
        ],
      };
    if (!path.endsWith("/sql") && !write) value = { success: true, result: value };
    value = options.mutate?.(value, call, calls.length) ?? value;
    if (options.failWrite === writeCount && write) status = 503;
    response.writeHead(options.status ?? status, { "content-type": "application/json" });
    if (options.streamLimit) {
      response.write(" ".repeat(270_000));
      response.end();
    } else response.end(options.raw ?? JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as import("node:net").AddressInfo;
  // Only the child test preload changes transport. Production has no endpoint override.
  const preload =
    "const native = globalThis.fetch; " +
    (options.stall
      ? "AbortSignal.timeout = (ms) => { if(ms !== 30000) throw Error('timeout contract'); return AbortSignal.abort(); }; "
      : "") +
    "globalThis.fetch = (url, options) => { if(options.redirect !== 'error' || !options.signal) throw Error('transport contract'); " +
    "return native('http://127.0.0.1:" +
    address.port +
    "', {...options, headers:{...options.headers, 'x-fixture-target':String(url)}}); };";
  const run = async (env: Record<string, string | undefined> = {}) => {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["--import", "data:text/javascript," + encodeURIComponent(preload), script],
        { env: { ...baseEnv, ...env }, timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { stdout: string; stderr: string; code: number };
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
  };
  return { calls, run };
}
function clean(result: { stdout: string; stderr: string }) {
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-.*-sentinel|synthetic-read-token|synthetic-hmac|INGEST_TOKEN/,
  );
}
const writeEnv = {
  USAGE_OPERATOR_MODE: "canary",
  CLOUDFLARE_API_TOKEN: undefined,
  CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-hmac",
  USAGE_EXECUTE: "true",
  USAGE_CANARY_AUTHORIZED: "true",
  USAGE_GUARD_SOURCE_SHA: source,
  USAGE_GUARD_DEPLOY_SHA: sha,
  USAGE_GUARD_VERSION_ID: version,
};

test("operator CLI exercises fixed transport, UInt64 JSON strings, guards and redaction", async (t) => {
  const f = await fixture(t);
  const result = await f.run({
    EXACT_REVIEW_QUEUE_URL: "https://ignored.invalid",
    OPENCLAW_CLOUDFLARE_API_TOKEN: "ignored",
  });
  assert.equal(result.code, 0, result.stderr);
  clean(result);
  const value = JSON.parse(result.stdout);
  assert.equal(value.source_sha, source);
  assert.equal(value.deployment_sha, sha);
  assert.equal(value.evidence[0][0].reviews, 4);
  assert.equal(f.calls.length, 9);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["GET", "GET", "GET", "POST", "POST", "POST", "GET", "GET", "GET"],
  );
  for (const call of f.calls) {
    assert.equal(call.url.origin, "https://api.cloudflare.com");
    assert.match(call.url.pathname, /^\/client\/v4\/accounts\/91b59577e757131d68d55a471fe32aca\//);
    assert.equal(call.headers.authorization, "Bearer synthetic-read-token");
    assert.equal(call.headers["x-clawsweeper-exact-review-signature"], undefined);
  }
  assert.equal(f.calls[0].url.search, "?per_page=1&page=1");
  const queries = f.calls.filter((call) => call.url.pathname.endsWith("/sql"));
  for (const query of queries) {
    assert.match(query.body, /^SELECT /);
    assert.match(query.body, /LIMIT 8 FORMAT JSON$/);
    assert.ok(query.body.includes("blob1 != '" + reservedRepo + "' AND blob4 != '" + lane + "'"));
  }
  assert.match(queries[1].body, /quantileExactWeighted\(0\.50\)\(double6, _sample_interval\)/);
  assert.match(queries[2].body, /double7 = 1 AND double8 = 0/);
  assert.match(
    queries[0].body,
    /\* double7 \* _sample_interval\) \/ 1000000 AS full_usage_estimated_usd/,
  );
  assert.match(queries[1].body, /AS avg_output_tokens/);
  assert.match(queries[1].body, /AS avg_total_tokens/);
});

test("both documented global queries semantically exclude either reserved identity", () => {
  const docs = readFileSync("docs/live-dashboard.md", "utf8");
  const section = docs.slice(
    docs.indexOf("### Querying daily tokens"),
    docs.indexOf("## What the status API shows"),
  );
  const sql = [...section.matchAll(/\x60\x60\x60sql\n([\s\S]*?)\n\x60\x60\x60/g)].map(
    (match) => match[1],
  );
  assert.equal(sql.length, 2);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE metrics(blob1 TEXT, blob4 TEXT)");
    const insert = db.prepare("INSERT INTO metrics VALUES (?, ?)");
    for (const row of [
      ["ordinary/repo", "ordinary"],
      [reservedRepo, "ordinary"],
      ["ordinary/repo", lane],
      [reservedRepo, lane],
    ])
      insert.run(...row);
    for (const query of sql) {
      const where = query
        .match(/WHERE ([\s\S]*?)\nGROUP BY/)![1]
        .replace(/timestamp >= NOW\(\) - INTERVAL '30' DAY\s+AND /, "");
      assert.equal(
        (
          db.prepare("SELECT count(*) AS count FROM metrics WHERE " + where).get() as {
            count: number;
          }
        ).count,
        1,
      );
    }
  } finally {
    db.close();
  }
});

test("guard rejects wrong traffic, version shape, binding and post-read drift before publishing outputs", async (t) => {
  for (const variant of ["traffic", "version", "settings", "after"])
    await t.test(variant, async (t) => {
      const f = await fixture(t, {
        mutate(value, call, index) {
          if (variant === "traffic" && index === 1)
            value.result.deployments[0].versions[0].percentage = 99;
          if (variant === "version" && call.url.pathname.includes("/versions/"))
            value.result = { id: version, bindings };
          if (variant === "settings" && call.url.pathname.endsWith("/settings"))
            value.result.bindings = [];
          if (variant === "after" && index === 7)
            value.result.deployments[0].versions.push({ version_id: version, percentage: 0 });
          return value;
        },
      });
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      clean(result);
      assert.equal(f.calls.length, { traffic: 1, version: 2, settings: 3, after: 7 }[variant]);
    });
});

test("missing credentials, untrusted source and invalid identities make no requests", async (t) => {
  const f = await fixture(t);
  for (const env of [
    { CLOUDFLARE_API_TOKEN: undefined, OPENCLAW_CLOUDFLARE_API_TOKEN: "ignored" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REPOSITORY: "other/repo" },
    { USAGE_DEPLOY_SHA: "invalid" },
    { USAGE_VERSION_ID: "invalid" },
    { USAGE_OPERATOR_MODE: "arbitrary" },
    { CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-hmac" },
    { USAGE_OPERATOR_MODE: "read-back", USAGE_CANARY_RUN_ID: "1' OR 1=1" },
  ]) {
    const result = await f.run(env);
    assert.notEqual(result.code, 0);
    clean(result);
  }
  assert.equal(f.calls.length, 0);
});

test("permission errors, redirects, malformed JSON, caps and aborts stop without fallback", async (t) => {
  for (const options of [
    { status: 401 },
    { status: 403 },
    { redirect: true },
    { raw: "private-json-sentinel" },
    { streamLimit: true },
    { stall: true },
  ])
    await t.test(JSON.stringify(options), async (t) => {
      const f = await fixture(t, options);
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      clean(result);
      assert.ok(f.calls.length <= 1);
      assert.match(result.stderr, /\[review-usage-operator\] FAILED \(exit 1\)/);
    });
});

test("analytics rejects excessive rows, unsafe numeric strings and failures without leaking the payload", async (t) => {
  for (const data of [
    Array(9).fill({ private: "private-row-sentinel" }),
    [{ reviews: "9007199254740993" }],
    [{ reviews: "private-value-sentinel" }],
  ])
    await t.test("invalid data", async (t) => {
      const f = await fixture(t, {
        mutate(value, call) {
          return call.url.pathname.endsWith("/sql") ? { data } : value;
        },
      });
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      clean(result);
      assert.equal(f.calls.length, 4);
    });
});

test("canary signs exactly four fixed records with only HMAC and never retries", async (t) => {
  const f = await fixture(t);
  const result = await f.run(writeEnv);
  assert.equal(result.code, 0, result.stderr);
  clean(result);
  assert.equal(f.calls.length, 4);
  assert.equal(JSON.parse(result.stdout).submitted, 4);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(
      call.url.href,
      "https://clawsweeper.openclaw.ai/internal/exact-review/review-usage",
    );
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, undefined);
    assert.equal(
      call.headers["x-clawsweeper-exact-review-signature"],
      "sha256=" + createHmac("sha256", "synthetic-hmac").update(call.body).digest("hex"),
    );
    const point = JSON.parse(call.body);
    assert.equal(point.target_repo, reservedRepo);
    assert.equal(point.trigger_lane, lane);
    assert.equal(point.item_number, index + 1);
    assert.equal(point.run_id, "123456");
  }
  assert.equal(JSON.parse(f.calls[0].body).usage, null);
  assert.equal(JSON.parse(f.calls[1].body).usage.cache_write_input_tokens, null);
  assert.equal(JSON.parse(f.calls[2].body).usage.cache_write_input_tokens, 0);
  assert.equal(JSON.parse(f.calls[3].body).usage.cache_write_input_tokens, 5);
});

test("canary refuses missing authorization, reruns or altered native guard outputs without writes", async (t) => {
  const f = await fixture(t);
  for (const env of [
    { USAGE_EXECUTE: "false" },
    { USAGE_CANARY_AUTHORIZED: "false" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { USAGE_GUARD_SOURCE_SHA: sha },
    { USAGE_GUARD_DEPLOY_SHA: source },
    { USAGE_GUARD_VERSION_ID: "" },
    { CLOUDFLARE_API_TOKEN: "synthetic-read-token" },
  ]) {
    const result = await f.run({ ...writeEnv, ...env });
    assert.notEqual(result.code, 0);
    clean(result);
  }
  assert.equal(f.calls.length, 0);
});

test("a partial canary stops at the first failed write and reports uncertainty, without replacement", async (t) => {
  const f = await fixture(t, { failWrite: 2 });
  const result = await f.run(writeEnv);
  assert.notEqual(result.code, 0);
  clean(result);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    canary_run_id: "123456",
    attempted: 2,
    acknowledged: 1,
    partial_or_uncertain: true,
  });
});

test("read-back proves all four masks/counters and executes real weighted and historical query shapes", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ USAGE_OPERATOR_MODE: "read-back", USAGE_CANARY_RUN_ID: "123456" });
  assert.equal(result.code, 0, result.stderr);
  clean(result);
  assert.equal(f.calls.length, 9);
  assert.equal(JSON.parse(result.stdout).canary_run_id, "123456");
  assert.match(f.calls[3].body, /blob7 = '123456'/);
  assert.match(f.calls[3].body, /INTERVAL '1' DAY/);
  assert.match(f.calls[4].body, /quantileExactWeighted\(0\.95\)\(double6, _sample_interval\)/);
  assert.match(f.calls[5].body, /double7 = 1 AND double8 = 0/);
});

test("read-back rejects missing, duplicate, sampled or corrupted persistence", async (t) => {
  for (const kind of ["missing", "duplicate", "sampled", "counter", "duration"])
    await t.test(kind, async (t) => {
      const f = await fixture(t, {
        mutate(value, call) {
          if (call.body.includes("GROUP BY item")) {
            if (kind === "missing") value.data.pop();
            if (kind === "duplicate") value.data.push(value.data[0]);
            if (kind === "sampled") value.data[0].samples = 2;
            if (kind === "counter") value.data[1].cached_input_tokens = 99;
            // The aggregate fixture still returns both percentiles as 100.
            if (kind === "duration") value.data[0].duration_ms = 50;
          }
          return value;
        },
      });
      const result = await f.run({
        USAGE_OPERATOR_MODE: "read-back",
        USAGE_CANARY_RUN_ID: "123456",
      });
      assert.notEqual(result.code, 0);
      clean(result);
      assert.equal(result.stdout, "");
      assert.equal(f.calls.length, 4);
    });
});

test("read-back executes cohort, full-mask reference cost and core-average arithmetic for the fixed four rows", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ USAGE_OPERATOR_MODE: "read-back", USAGE_CANARY_RUN_ID: "123456" });
  assert.equal(result.code, 0, result.stderr);
  const sql = f.calls[4].body;
  for (const alias of [
    "reviews",
    "full_reviews",
    "partial_reviews",
    "missing_reviews",
    "core_reviews",
    "input_tokens",
    "output_tokens",
    "full_usage_estimated_usd",
    "avg_input_tokens",
    "avg_output_tokens",
    "avg_total_tokens",
  ])
    assert.ok(sql.includes(" AS " + alias));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE clawsweeper_review_usage(timestamp TEXT, blob1 TEXT, blob4 TEXT, blob7 TEXT, double1 REAL, double2 REAL, double3 REAL, double4 REAL, double5 REAL, double6 REAL, double7 REAL, double8 REAL, _sample_interval REAL)",
    );
    const insert = db.prepare(
      "INSERT INTO clawsweeper_review_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const row of [
      [0, 0, 0, 0, 0, 100, 0, 0],
      [100, 20, 0, 30, 10, 100, 0, 1],
      [0, 0, 0, 0, 0, 100, 1, 1],
      [100, 20, 5, 30, 10, 100, 1, 1],
    ])
      insert.run("2026-10-16", reservedRepo, lane, "123456", ...row, 1);
    // SQLite proves cohort arithmetic only; real Cloudflare syntax/percentiles remain a live gate.
    const adapted = sql
      .replaceAll("if(", "iif(")
      .replace(/quantileExactWeighted\(0\.(50|95)\)\(double6, _sample_interval\)/g, "100")
      .replace("timestamp >= NOW() - INTERVAL '1' DAY", "timestamp >= '2000-01-01'")
      .replace(" FORMAT JSON", "");
    const actual = db.prepare(adapted).get() as Record<string, number>;
    const expected = {
      reviews: 4,
      full_reviews: 2,
      partial_reviews: 1,
      missing_reviews: 1,
      core_reviews: 3,
      input_tokens: 200,
      output_tokens: 60,
      full_usage_estimated_usd: 0.0004645,
      avg_input_tokens: 200 / 3,
      avg_output_tokens: 20,
      avg_total_tokens: 260 / 3,
    };
    for (const [field, value] of Object.entries(expected))
      assert.ok(Math.abs(actual[field] - value) < 1e-12, field);
  } finally {
    db.close();
  }
});

test("read-back refuses incorrect cohort, full-only cost or any core-token average", async (t) => {
  for (const field of [
    "full_reviews",
    "partial_reviews",
    "missing_reviews",
    "core_reviews",
    "full_usage_estimated_usd",
    "avg_input_tokens",
    "avg_output_tokens",
    "avg_total_tokens",
  ])
    await t.test(field, async (t) => {
      const f = await fixture(t, {
        mutate(value, call) {
          if (call.body.includes(" AS full_usage_estimated_usd")) value.data[0][field] = 0;
          return value;
        },
      });
      const result = await f.run({
        USAGE_OPERATOR_MODE: "read-back",
        USAGE_CANARY_RUN_ID: "123456",
      });
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      clean(result);
      assert.equal(f.calls.length, 5);
      assert.match(result.stderr, /canary_aggregate/);
    });
});
