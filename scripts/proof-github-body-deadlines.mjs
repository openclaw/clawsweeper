// Run with repository-pinned Wrangler tooling installed outside the checkout.
// node scripts/proof-github-body-deadlines.mjs BASE TOOL_PREFIX OUTPUT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE TOOL_PREFIX OUTPUT");
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(out, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base = git("rev-parse", `${baseRef}^{commit}`);
const head = git("rev-parse", "HEAD");
const sources = ["dashboard/exact-review-queue.ts", "dashboard/github-api.ts"];
const scenarios = [
  { name: "json", status: 200 },
  { name: "malformed", status: 200, malformed: true },
  { name: "empty", status: 204 },
  { name: "delayed-success", status: 200, delay: 5400 },
  { name: "delayed-error", status: 503, delay: 5400 },
  { name: "delayed-rate-limit", status: 429, delay: 5400 },
  { name: "stalled-success", status: 200, stalled: true },
  { name: "stalled-error", status: 503, stalled: true },
];
const manifest = {
  base,
  head,
  working_tree_dirty: Boolean(git("status", "--porcelain")),
  runtime: process.version,
  workerd: require("workerd/package.json").version,
  sources: {},
  results: {},
  limits:
    "Actual workerd handlers and native HTTP to a loopback fixture. Synthetic credential only; no live GitHub calls, inference, queue mutation, or deployment. Baseline uses finite delayed bodies; candidate also proves never-ending bodies are cancelled.",
};

for (const variant of ["baseline", "candidate"]) {
  const dir = path.join(out, variant);
  mkdirSync(dir);
  execFileSync("tar", ["-x", "-C", dir], {
    input: execFileSync("git", ["archive", variant === "baseline" ? base : head], {
      maxBuffer: 128 * 1024 * 1024,
    }),
  });
  if (variant === "candidate")
    for (const file of sources) copyFileSync(path.join(root, file), path.join(dir, file));
  manifest.sources[variant] = Object.fromEntries(
    sources.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(dir, file)))
        .digest("hex"),
    ]),
  );
  const observations = new Map();
  const timers = new Set();
  const server = createServer((request, response) => {
    const owner = request.url.startsWith("/fixture/") ? "app" : "queue";
    const id = Number(request.url.split("/").at(-1));
    const scenario = scenarios[id - 1];
    assert.ok(scenario, "unexpected upstream path");
    assert.equal(request.headers.authorization, "Bearer synthetic-fixture-token");
    const observation = { cancelled: false };
    observations.set(`${owner}/${id}`, observation);
    response.on("close", () => {
      observation.cancelled = !response.writableEnded;
    });
    response.writeHead(scenario.status, {
      "content-type": "application/json",
      ...(scenario.status === 429 ? { "retry-after": "7" } : {}),
    });
    response.flushHeaders();
    const finish = () =>
      response.end(
        scenario.status === 204
          ? ""
          : scenario.malformed
            ? "invalid JSON"
            : JSON.stringify({ id, run_attempt: 1, status: "in_progress", fixture: true }),
      );
    if (scenario.delay) timers.add(setTimeout(finish, scenario.delay));
    else if (!scenario.stalled) finish();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `127.0.0.1:${server.address().port}`;
  const entry = path.join(dir, "proof-worker.ts");
  writeFileSync(
    entry,
    `
import { exactReviewTerminalRun } from "./dashboard/exact-review-queue.ts";
import { githubAppJson } from "./dashboard/github-api.ts";
export default { async fetch(request, env) {
  const [owner, id] = new URL(request.url).pathname.slice(1).split("/");
  try {
    const value = owner === "queue"
      ? await exactReviewTerminalRun("synthetic-fixture-token", { runId: id, runAttempt: 1, claimGeneration: 1 }, env)
      : await githubAppJson("/fixture/" + id, "synthetic-fixture-token", {}, env);
    return Response.json({ outcome: "resolved", value });
  } catch (error) {
    return Response.json({ outcome: "rejected", errorType: error.name,
      timedOut: error.timedOut ?? null, status: error.status ?? null, rateLimited: error.rateLimited ?? null });
  }
} };
`,
  );
  let mf;
  try {
    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
    });
    mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { GITHUB_API_URL: `http://${address}` },
      outboundService: { external: { address, http: {} } },
    });
    await mf.ready;
    manifest.results[variant] = await Promise.all(
      ["queue", "app"]
        .flatMap((owner) =>
          scenarios.map((scenario, index) => ({ owner, scenario, id: index + 1 })),
        )
        .filter(({ scenario }) => variant === "candidate" || !scenario.stalled)
        .map(async ({ owner, scenario, id }) => {
          const started = performance.now();
          const response = await mf.dispatchFetch(`http://proof/${owner}/${id}`, {
            signal: AbortSignal.timeout(10000),
          });
          const result = await response.json();
          const elapsedMs = Math.round(performance.now() - started);
          if (variant === "candidate" && (scenario.delay || scenario.stalled)) {
            assert.ok(
              elapsedMs >= 4000 && elapsedMs < 6000,
              `${owner}/${scenario.name} deadline: ${elapsedMs}ms`,
            );
          }
          if (scenario.name === "json") assert.equal(result.outcome, "resolved");
          else if (scenario.malformed || scenario.status === 204)
            assert.equal(
              result.errorType,
              owner === "queue" && scenario.status === 204 ? "Error" : "SyntaxError",
            );
          else if (scenario.status >= 400) {
            assert.equal(result.errorType, "GitHubRequestError");
            assert.equal(result.status, scenario.status);
            assert.equal(result.timedOut, false);
            assert.equal(result.rateLimited, scenario.status === 429);
          } else if (variant === "candidate") {
            assert.equal(result.errorType, "GitHubRequestError");
            assert.equal(result.timedOut, true);
          } else if (owner === "queue") {
            assert.equal(result.outcome, "resolved");
            assert.ok(elapsedMs >= 5300);
          } else assert.notEqual(result.errorType, "GitHubRequestError");
          return {
            owner,
            scenario: scenario.name,
            elapsedMs,
            ...result,
            observation: `${owner}/${id}`,
          };
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const result of manifest.results[variant]) {
      result.cancelled = observations.get(result.observation).cancelled;
      delete result.observation;
      if (variant === "candidate" && /^(delayed|stalled)-/.test(result.scenario))
        assert.equal(
          result.cancelled,
          true,
          `${result.owner}/${result.scenario} did not cancel upstream`,
        );
    }
  } finally {
    try {
      await mf?.dispose();
    } finally {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
writeFileSync(path.join(out, "result.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
