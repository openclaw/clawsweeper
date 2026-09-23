#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "transport") {
  const response = await fetch(process.argv[3], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: process.argv.slice(4), token: process.env.GH_TOKEN }),
  });
  const body = await response.text();
  if (response.ok) process.stdout.write(body);
  else {
    process.stderr.write(body);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "member") {
  const { createGitHubRuntime } = await import(pathToFileURL(process.argv[3]));
  const { createGitHubExecution } = await import("../../dist/clawsweeper-github-execution.js");
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    targetRepo: () => "openclaw/openclaw",
    run: (_command, args, options) => {
      try {
        return execFileSync(
          process.execPath,
          [script, "transport", process.env.PROOF_URL, ...args],
          {
            env: { ...process.env, ...options?.env },
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        throw new Error(String(error.stderr || error.message), { cause: error });
      }
    },
  });
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    gitHubRuntime: runtime,
    labelAlreadyExistsError: () => false,
  });
  try {
    const item = execution.ghJson(["api", "repos/openclaw/openclaw/issues/123"]);
    const comments = execution.ghJson(["api", "repos/openclaw/openclaw/issues/123/comments"]);
    process.stdout.write(JSON.stringify({ kind: "fresh", item, comments }));
  } catch (error) {
    if (error.name !== "GitHubRateLimitError") throw error;
    process.stdout.write(
      JSON.stringify({ kind: "deferred", scope: error.scope, retryAt: error.retryAt }),
    );
  }
} else {
  const requestedBase =
    process.argv[2] === "--base" ? process.argv[3] : "74df933aeed3f01eddcf027150f1484fdcb57904";
  const base = execFileSync("git", ["rev-parse", requestedBase], { encoding: "utf8" }).trim();
  const baselinePath = resolve("dist/clawsweeper-github-runtime-budget-baseline.js");
  const source = execFileSync("git", ["show", `${base}:src/clawsweeper-github-runtime.ts`], {
    encoding: "utf8",
  });
  writeFileSync(baselinePath, stripTypeScriptTypes(source, { mode: "transform" }));
  try {
    const baseline = await scenario(baselinePath);
    const fixed = await scenario(resolve("dist/clawsweeper-github-runtime.js"));
    assert.deepEqual(fixed.outcomes, baseline.outcomes);
    assert.equal(baseline.beforeReset.total, 11);
    assert.equal(fixed.beforeReset.total, 3);
    assert.equal(fixed.beforeReset.publicReads, 1);
    assert.equal(fixed.beforeReset.appReads, 1);
    assert.equal(fixed.beforeReset.resetLookups, 1);
    assert.equal(fixed.authoritativeResetPreserved, true);
    assert.deepEqual(fixed.afterReset, baseline.afterReset);
    assert.equal(fixed.afterReset.item.version, 2);
    assert.equal(fixed.afterReset.comments[0].body, "changed while deferred");
    console.log(
      JSON.stringify(
        {
          base,
          sourceHashes: Object.fromEntries(
            ["src/clawsweeper-github-runtime.ts", "src/github-rate-limit-circuit.ts"].map(
              (path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")],
            ),
          ),
          environment: { node: process.version, platform: process.platform },
          surface:
            "production publication GitHub runtime and retry executor; eight separate publisher processes sharing one batch circuit",
          transport:
            "native loopback HTTP through a synthetic gh transport; no live credentials or GitHub mutations",
          baseline,
          fixed,
          limits:
            "Does not measure production throughput, GitHub quota accounting, or healthy-publication request budgets.",
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(baselinePath, { force: true });
  }
}

async function scenario(runtimePath) {
  const root = mkdtempSync(join(tmpdir(), "publication-quota-proof-"));
  const observations = join(root, "observations.jsonl");
  let exhausted = true;
  const reset = Math.floor(Date.now() / 1000) + 600;
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const { args, token } = JSON.parse(text);
    requests.push({ route: args[1], credential: token === "synthetic-public" ? "public" : "app" });
    response.setHeader("content-type", "application/json");
    if (args[1] === "rate_limit") return response.end(JSON.stringify({ remaining: 0, reset }));
    if (exhausted && token === "synthetic-public") {
      response.statusCode = 403;
      return response.end("HTTP 403: API rate limit exceeded");
    }
    response.end(
      JSON.stringify(
        args[1].endsWith("/comments")
          ? [{ body: exhausted ? "original" : "changed while deferred" }]
          : { version: exhausted ? 1 : 2 },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    PATH: process.env.PATH,
    PROOF_URL: `http://127.0.0.1:${server.address().port}`,
    EXACT_EVENT_PUBLICATION: "true",
    GH_TOKEN: "synthetic-app",
    REPO_TOKEN: "synthetic-public",
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observations,
    CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: join(root, "metrics.jsonl"),
  };
  try {
    const members = [];
    for (let index = 0; index < 8; index++) members.push(await member(runtimePath, env));
    const beforeReset = {
      total: requests.length,
      publicReads: requests.filter(
        (row) => row.credential === "public" && row.route !== "rate_limit",
      ).length,
      appReads: requests.filter((row) => row.credential === "app").length,
      resetLookups: requests.filter((row) => row.route === "rate_limit").length,
    };
    const rows = readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    writeFileSync(
      observations,
      rows
        .map((row) =>
          JSON.stringify({ ...row, retry_at: new Date(Date.now() - 1000).toISOString() }),
        )
        .join("\n") + "\n",
    );
    exhausted = false;
    const afterReset = await member(runtimePath, env);
    return {
      outcomes: members.map(({ kind, scope }) => ({ kind, scope })),
      beforeReset,
      authoritativeResetPreserved: members.every(
        (row) => row.retryAt === new Date(reset * 1000).toISOString(),
      ),
      afterReset,
      resumedRequests: requests.length - beforeReset.total,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function member(runtimePath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "member", runtimePath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`proof publisher failed: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}
