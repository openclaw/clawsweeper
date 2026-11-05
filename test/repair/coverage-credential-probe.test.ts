import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { parse } from "yaml";
import { PROBE_QUERY, PROBE_LIMITS } from "../../dist/repair/coverage-credential-probe.js";

// Persistent evidence stays in ignored workspace scratch, never /tmp.
const root = resolve(".openclaw/tmp/coverage-probe");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "http-proof-"));
const cli = resolve("dist/repair/coverage-credential-probe.js");
const fakeA = "FAKE_ROLE_A_DO_NOT_PRINT";
const fakeB = "FAKE_ROLE_B_DO_NOT_PRINT";
const secret = "NEGATIVE_SECRET_VALUE_DO_NOT_PRINT";
const traces: unknown[] = [];
function payload() {
  const connection = {
    totalCount: 1,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        number: 7,
        updatedAt: "2026-11-05T00:00:00Z",
        headRefOid: "a".repeat(40),
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        timelineItems: { nodes: [] },
      },
    ],
  };
  return {
    data: {
      r0: { id: "PRIVATE_INTERNAL_ID", nameWithOwner: "openclaw/openclaw", issues: connection },
      r1: {
        id: "PRIVATE_INTERNAL_ID",
        nameWithOwner: "openclaw/openclaw",
        pullRequests: connection,
      },
      rateLimit: { cost: 2, remaining: 99, resetAt: "2026-11-05T18:00:00Z" },
    },
  };
}

async function scenario(name: string, mode: string, missing: boolean | "B" = false) {
  const trace: { role: string; method: string | undefined; querySHA: string; bytes: number }[] = [];
  let sentBytes = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(req.url, "/graphql");
    const query = JSON.parse(body.toString()).query;
    assert.equal(query, PROBE_QUERY);
    const role =
      req.headers.authorization === "Bearer " + fakeA
        ? "A"
        : req.headers.authorization === "Bearer " + fakeB
          ? "B"
          : "INVALID";
    assert.notEqual(role, "INVALID");
    trace.push({
      role,
      method: req.method,
      querySHA: createHash("sha256").update(query).digest("hex"),
      bytes: body.length,
    });
    if (role === "B") {
      res.end(JSON.stringify(payload()));
      return;
    }
    switch (mode) {
      case "rate403remaining":
        res.writeHead(403, { "x-ratelimit-remaining": "0" });
        res.end(secret);
        break;
      case "rate403retry":
        res.writeHead(403, { "retry-after": "60" });
        res.end(secret);
        break;
      case "rate403date":
        res.writeHead(403, { "retry-after": "Thu, 05 Nov 2026 18:00:00 GMT" });
        res.end(secret);
        break;
      case "rate403secondary":
        res.writeHead(403);
        res.end(
          JSON.stringify({
            message:
              "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            private: secret,
          }),
        );
        break;
      case "ambiguous403":
        res.writeHead(403);
        res.end(secret);
        break;
      case "invalidretry403":
        res.writeHead(403, { "retry-after": secret });
        res.end(secret);
        break;
      case "access":
        res.writeHead(403);
        res.end(
          JSON.stringify({ message: "Resource not accessible by integration", private: secret }),
        );
        break;
      case "authentication":
        res.writeHead(401);
        res.end(secret);
        break;
      case "http429":
        res.writeHead(429);
        res.end(secret);
        break;
      case "quota-success":
        res.writeHead(200, { "x-ratelimit-remaining": "0" });
        res.end(JSON.stringify(payload()));
        break;
      case "mixed-rate-access":
        res.end(
          JSON.stringify({
            errors: [
              { type: "FORBIDDEN", message: secret },
              { type: "RATE_LIMITED", message: secret },
            ],
          }),
        );
        break;
      case "mixed-rate-unknown":
        res.end(
          JSON.stringify({
            errors: [
              { type: "RATE_LIMITED" },
              { type: "FORBIDDEN" },
              { type: secret, message: secret },
            ],
          }),
        );
        break;
      case "body-rate200":
        res.end(
          JSON.stringify({
            errors: [
              {
                message:
                  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
                private: secret,
              },
            ],
          }),
        );
        break;
      case "typed403":
        res.writeHead(403);
        res.end(JSON.stringify({ errors: [{ type: "FORBIDDEN", message: secret }] }));
        break;
      case "unknown403":
        res.writeHead(403);
        res.end(
          JSON.stringify({
            message: "Resource not accessible by integration",
            errors: [{ type: "FORBIDDEN" }, { type: secret }],
          }),
        );
        break;
      case "auth200":
        res.end(JSON.stringify({ errors: [{ type: "UNAUTHORIZED", message: secret }] }));
        break;
      case "notfound200":
        res.end(JSON.stringify({ errors: [{ type: "NOT_FOUND", message: secret }] }));
        break;
      case "errors":
        res.end(
          JSON.stringify({
            data: payload().data,
            errors: [
              { type: "FORBIDDEN", message: secret, extensions: { secret }, path: [secret] },
            ],
          }),
        );
        break;
      case "rate":
        res.end(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: secret }] }));
        break;
      case "unknown":
        res.end(
          JSON.stringify({ errors: [{ type: "FORBIDDEN" }, { type: secret, message: secret }] }),
        );
        break;
      case "schema":
        res.end(
          JSON.stringify({ errors: [{ type: "GRAPHQL_VALIDATION_FAILED", message: secret }] }),
        );
        break;
      case "malformed":
        res.end(secret);
        break;
      case "badparser":
        res.end(JSON.stringify({ data: { r0: { id: secret }, r1: { id: secret } } }));
        break;
      case "redirect":
        res.writeHead(302, {
          location:
            "http://127.0.0.1:" +
            (server.address() as { port: number }).port +
            "/must-not-follow?" +
            secret,
        });
        res.end(secret);
        break;
      case "transport":
        req.socket.destroy(new Error(secret));
        break;
      case "oversize": {
        const chunk = Buffer.alloc(100_000, 120);
        res.writeHead(200);
        for (let i = 0; i < 20; i++) {
          sentBytes += chunk.length;
          res.write(chunk);
        }
        res.end();
        break;
      }
      case "timeout":
        break; // Real 15-second production deadline, no test timeout override.
      default:
        res.end(JSON.stringify(payload()));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const local = join(directory, name);
  // Node mkdir is kept here instead of shell or external destinations.
  mkdirSync(local);
  const preload = join(local, "reroute.mjs");
  writeFileSync(
    preload,
    'const realFetch = globalThis.fetch; globalThis.fetch = (url, options) => { if (url !== "https://api.github.com/graphql") throw new Error("unexpected destination"); return realFetch("http://127.0.0.1:' +
      port +
      '/graphql", options); };',
  );
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", preload, cli], {
    cwd: local,
    // No inherited host credentials or secret-bearing env. Production URL stays fixed.
    env: {
      PATH: process.env.PATH,
      GITHUB_SHA: "a".repeat(40),
      ...(missing === true ? {} : { COVERAGE_PROBE_TOKEN_A: fakeA }),
      ...(!missing ? { COVERAGE_PROBE_TOKEN_B: fakeB } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (s) => {
    stdout += s;
  });
  child.stderr.on("data", (s) => {
    stderr += s;
  });
  try {
    const [exit] = await once(child, "exit");
    const elapsedMs = Math.round(performance.now() - started);
    const artifact = readFileSync(join(local, "coverage-credential-probe.json"), "utf8");
    assert.equal(stdout, artifact);
    assert.equal(stderr, "");
    for (const sensitive of [
      fakeA,
      fakeB,
      secret,
      "PRIVATE_INTERNAL_ID",
      "must-not-follow",
      "authorization",
      "retry-after",
      "x-ratelimit-remaining",
      "Resource not accessible",
      "secondary rate limit",
      "extensions",
      "cursor",
    ])
      assert.ok(!(stdout + stderr + artifact).includes(sensitive), sensitive);
    const result = JSON.parse(artifact);
    assert.deepEqual(Object.keys(result).sort(), [
      "observations",
      "publicTarget",
      "querySHA",
      "sourceSHA",
    ]);
    for (const observation of result.observations)
      assert.deepEqual(Object.keys(observation).sort(), [
        "category",
        "elapsedMs",
        "httpStatus",
        "parserItemCount",
        "phase",
        "rate",
        "role",
      ]);
    assert.equal(trace.length, missing === true ? 0 : missing === "B" ? 1 : 2);
    assert.deepEqual(
      trace.map((t) => t.role),
      missing === true ? [] : missing === "B" ? ["A"] : ["A", "B"],
    );
    assert.ok(trace.every((t) => t.method === "POST" && t.querySHA === result.querySHA));
    assert.equal(result.observations[1].phase, missing ? "missing_role" : "parsed");
    assert.equal(result.observations[1].parserItemCount, missing ? null : 2);
    traces.push({ name, trace, sentBytes, elapsedMs, exit, observations: result.observations });
    writeFileSync(
      join(directory, "http-trace.json"),
      JSON.stringify({ node: process.version, limits: PROBE_LIMITS, scenarios: traces }, null, 2),
    );
    return { result, exit, elapsedMs, sentBytes };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test(
  "compiled fixed-URL CLI: real paired HTTP, redaction, limits, no fallback or redirects",
  { timeout: 35_000 },
  async () => {
    const cases = [
      ["healthy", "parsed", "none", 0],
      ["rate403remaining", "http", "rate", 0],
      ["rate403retry", "http", "rate", 0],
      ["rate403date", "http", "rate", 0],
      ["rate403secondary", "http", "rate", 0],
      ["ambiguous403", "http", "ambiguous", 1],
      ["invalidretry403", "http", "ambiguous", 1],
      ["authentication", "http", "authentication", 1],
      ["http429", "http", "rate", 0],
      ["quota-success", "parsed", "none", 0],
      ["mixed-rate-access", "graphql", "rate", 0],
      ["mixed-rate-unknown", "graphql", "graphql", 1],
      ["body-rate200", "graphql", "rate", 0],
      ["access", "http", "access", 0],
      ["typed403", "http", "access", 0],
      ["unknown403", "http", "graphql", 1],
      ["auth200", "graphql", "authentication", 1],
      ["notfound200", "graphql", "ambiguous", 1],
      ["errors", "graphql", "access", 0],
      ["rate", "graphql", "rate", 0],
      ["schema", "graphql", "schema", 1],
      ["unknown", "graphql", "graphql", 1],
      ["malformed", "parser", "schema", 1],
      ["badparser", "parser", "schema", 1],
      ["redirect", "http", "http", 1],
      ["transport", "transport", "transport", 1],
      ["oversize", "body_oversize", "body_oversize", 1],
      ["timeout", "timeout", "timeout", 1],
    ] as const;
    for (const [mode, phase, category, exit] of cases) {
      const actual = await scenario(mode, mode);
      assert.equal(actual.exit, exit, mode);
      assert.equal(actual.result.observations[0].phase, phase, mode);
      assert.equal(actual.result.observations[0].category, category, mode);
      if (mode === "oversize") assert.ok(actual.sentBytes > PROBE_LIMITS.bytes);
      if (mode === "timeout")
        assert.ok(
          actual.elapsedMs >= 15_000 && actual.elapsedMs < 20_000,
          "actual elapsed deadline",
        );
    }
    const missing = await scenario("missing", "healthy", true);
    assert.equal(missing.exit, 1);
    const missingB = await scenario("mint-failure", "healthy", "B");
    assert.equal(missingB.exit, 1);
    assert.equal(missingB.result.observations[0].phase, "parsed");
    assert.equal(missingB.result.observations[1].phase, "missing_role");
    assert.ok(
      missing.result.observations.every((o: { category: string }) => o.category === "missing_role"),
    );
  },
);

test("manual workflow contract has one guarded read-only job and no production controls", () => {
  const source = readFileSync(".github/workflows/coverage-credential-probe.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["paired-read"]);
  const job = workflow.jobs["paired-read"];
  assert.equal(
    job.if,
    "github.repository == 'openclaw/clawsweeper' && github.ref == 'refs/heads/main'",
  );
  assert.equal(job.steps[0].with["persist-credentials"], false);
  const setup = job.steps[1];
  assert.deepEqual(setup.with, {
    "node-version": "24.22.1",
    "pnpm-version": "12.15.0",
    "build-script": "build:repair",
  });
  const mint = job.steps[2];
  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.deepEqual(mint.with, {
    "client-id": "Iv23liOECG0slfuhz093",
    "private-key": "$" + "{{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
    owner: "openclaw",
    "permission-metadata": "read",
  });
  assert.equal(mint["continue-on-error"], true);
  assert.deepEqual(job.steps[3].env, {
    COVERAGE_PROBE_TOKEN_A: "$" + "{{ github.token }}",
    COVERAGE_PROBE_TOKEN_B: "$" + "{{ steps.inventory.outputs.token }}",
    GITHUB_SHA: "$" + "{{ github.sha }}",
  });
  assert.equal(job.steps[1].uses, "./.github/actions/setup-pnpm");
  const composite = parse(readFileSync(".github/actions/setup-pnpm/action.yml", "utf8"));
  assert.equal(
    composite.runs.steps[0].uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.equal(job.steps[3].run, "node dist/repair/coverage-credential-probe.js");
  const artifact = job.steps.at(-1);
  assert.equal(artifact.with.path, "coverage-credential-probe.json");
  assert.equal(artifact.with["retention-days"], 3);
  assert.equal(artifact.with["if-no-files-found"], "error");
  assert.equal((source.match(/secrets\./g) ?? []).length, 1);
  assert.doesNotMatch(
    source,
    /CLOUDFLARE|WEBHOOK|WORKER|workflow_call|schedule:|: write|dispatches|curl|gh api/,
  );
  const probe = readFileSync("src/repair/coverage-credential-probe.ts", "utf8");
  assert.equal((probe.match(/https:\/\//g) ?? []).length, 1);
  assert.doesNotMatch(
    probe,
    /process\.env\.(?:GH_TOKEN|GITHUB_TOKEN)|runReviewCoverageCensus|runGh|console\.|error\.message|\.stack/,
  );
  assert.ok(!probe.includes("/internal/"));
  assert.match(PROBE_QUERY, /^query ResumableCoverage/);
  assert.equal((PROBE_QUERY.match(/first:100,after:null/g) ?? []).length, 2);
  assert.doesNotMatch(PROBE_QUERY, /mutation|rateLimit|cursor:/);
});
