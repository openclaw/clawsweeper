import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { githubTest as test, installGhFixture } from "./github-runtime-fixture.ts";
import * as runtime from "../dist/clawsweeper-github-runtime.js";
import * as execution from "../dist/clawsweeper-github-execution.js";
import { activeGitHubRateLimitCircuit } from "../dist/github-rate-limit-circuit.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "publication-quota-"));
  const observationPath = join(root, "observations.jsonl");
  const metricsPath = join(root, "metrics.jsonl");
  const now = Date.now();
  const env: NodeJS.ProcessEnv = {
    EXACT_EVENT_PUBLICATION: "true",
    GH_TOKEN: `synthetic-app-${root}`,
    REPO_TOKEN: "synthetic-repository",
    GITHUB_TOKEN: undefined,
    GH_HOST: undefined,
    CLAWSWEEPER_PUBLIC_GH_TOKEN: undefined,
    EXACT_REVIEW_QUEUE_URL: undefined,
    CLAWSWEEPER_WEBHOOK_SECRET: undefined,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: undefined,
    CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: metricsPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationPath,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const observation = (overrides: Record<string, unknown> = {}) => ({
    scope: "repository_actions",
    observed_at: new Date(now - 1000).toISOString(),
    retry_at: new Date(now + 30_000).toISOString(),
    provenance: "rate_limit_reset",
    authoritative: true,
    ...overrides,
  });
  const write = (...rows: unknown[]) =>
    writeFileSync(observationPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { root, observationPath, metricsPath, now, env, observation, write };
}

test("shared circuits respect scope, owner, expiry and partial observations", (t) => {
  const f = fixture(t);
  f.write(
    f.observation(),
    f.observation({
      scope: "target_app",
      target_owner: "other-owner",
      retry_at: new Date(f.now + 90_000).toISOString(),
    }),
    f.observation({ retry_at: new Date(f.now + 3 * 60 * 60_000).toISOString() }),
    f.observation({ observed_at: new Date(f.now + 1).toISOString() }),
    f.observation({ provenance: "untrusted" }),
    f.observation({ authoritative: "true" }),
  );
  appendFileSync(f.observationPath, '{"scope":"repository_actions"');
  const circuit = activeGitHubRateLimitCircuit(
    f.observationPath,
    "repository_actions",
    "openclaw",
    f.now,
  );
  assert.equal(circuit?.retryAt, new Date(f.now + 30_000).toISOString());
  assert.equal(circuit?.authoritative, true);
  assert.equal(
    activeGitHubRateLimitCircuit(f.observationPath, "target_app", "openclaw", f.now),
    null,
  );
  assert.ok(activeGitHubRateLimitCircuit(f.observationPath, "target_app", "other-owner", f.now));
  assert.equal(
    activeGitHubRateLimitCircuit(
      f.observationPath,
      "repository_actions",
      "openclaw",
      f.now + 30_000,
    ),
    null,
  );
  assert.equal(
    activeGitHubRateLimitCircuit(join(f.root, "missing"), "repository_actions", "openclaw", f.now),
    null,
  );
});

test("publication siblings stop probing exhausted quota and resume fresh reads after reset", (t) => {
  const f = fixture(t);
  const reset = Math.floor(f.now / 1000) + 600;
  const gh = installGhFixture(
    t,
    `
    if (args[1] === "rate_limit") {
      const rows = readFileSync(process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH, "utf8");
      if (!rows.includes('"scope":"repository_actions"')) throw new Error("circuit missing before lookup");
      process.stdout.write(JSON.stringify({ remaining: 0, reset: ${reset} }));
    } else if (token === process.env.REPO_TOKEN && !state.recovered) {
      throw new Error("HTTP 403: API rate limit exceeded");
    } else {
      process.stdout.write(JSON.stringify({ version: state.recovered ? 2 : 1 }));
    }
  `,
  );
  const metadata = ["api", "repos/openclaw/openclaw/issues/123"];
  assert.equal(JSON.parse(runtime.withGitHubRun(() => execution.ghWithRetry(metadata))).version, 1);
  const observed = readFileSync(f.observationPath, "utf8");
  const firstCount = gh.requests().length;
  assert.equal(firstCount, 3); // Initial read, one reset lookup, one App fallback.
  for (let sibling = 0; sibling < 8; sibling++) {
    assert.throws(
      () =>
        runtime.withGitHubRun(() =>
          execution.ghWithRetry([
            "api",
            `repos/openclaw/openclaw/issues/${sibling + 124}/comments`,
          ]),
        ),
      (error: unknown) => {
        assert.equal((error as { retryAt: string }).retryAt, new Date(reset * 1000).toISOString());
        return true;
      },
    );
  }
  assert.equal(gh.requests().length, firstCount);
  assert.equal(readFileSync(f.observationPath, "utf8"), observed);
  const metrics = readFileSync(f.metricsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(metrics.filter((row) => row.outcome === "throttle").length, 1);
  assert.equal(metrics.filter((row) => row.outcome === "skipped_by_circuit").length, 8);
  f.write(f.observation({ retry_at: new Date(f.now - 1).toISOString() }));
  writeFileSync(gh.statePath, JSON.stringify({ recovered: true }));
  assert.equal(JSON.parse(runtime.withGitHubRun(() => execution.ghWithRetry(metadata))).version, 2);
  assert.equal(gh.requests().length, firstCount + 1);
});

test("publication circuit preserves App fallback and leaves mutation routing unchanged", (t) => {
  const f = fixture(t);
  f.write(f.observation());
  const gh = installGhFixture(t, 'process.stdout.write("{}");');
  execution.ghWithRetry(["api", "repos/openclaw/openclaw/issues/123"]);
  assert.deepEqual(
    gh.requests().map(({ token }) => token),
    [f.env.GH_TOKEN],
  );
  runtime.ghWithPreparedTimeout(
    ["api", "repos/openclaw/openclaw/issues/123", "--method", "PATCH"],
    1000,
  );
  assert.deepEqual(
    gh.requests().map(({ token }) => token),
    [f.env.GH_TOKEN, f.env.GH_TOKEN],
  );
});

test("an exhausted matching App circuit cannot spend the fallback credential", (t) => {
  const f = fixture(t);
  f.write(f.observation(), f.observation({ scope: "target_app", target_owner: "openclaw" }));
  const gh = installGhFixture(t, 'throw new Error("exhausted credentials must not dispatch");');
  assert.throws(() => execution.ghWithRetry(["api", "repos/openclaw/openclaw/issues/123"]), {
    name: "GitHubRateLimitError",
  });
  assert.equal(gh.requests().length, 0);
});
