import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { withGitHubRun } from "../dist/clawsweeper-github-runtime.js";
import { mockGhBinEnv } from "./helpers.ts";

export const githubTest = ((name: string, operation: (t: TestContext) => void | Promise<void>) =>
  nodeTest(name, (t) => {
    const keys = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "REPO_TOKEN",
      "CLAWSWEEPER_PUBLIC_GH_TOKEN",
      "GH_HOST",
      "EXACT_EVENT_PUBLICATION",
      "EXACT_REVIEW_QUEUE_URL",
      "CLAWSWEEPER_WEBHOOK_SECRET",
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.GH_TOKEN = "synthetic-runtime-token";
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return withGitHubRun(() => operation(t));
  })) as typeof nodeTest;

export function installGhFixture(t: TestContext, source: string) {
  const root = mkdtempSync(join(tmpdir(), "github-runtime-fixture-"));
  const requestsPath = join(root, "requests.jsonl");
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify({ now: 1_000_000 }));
  const executable = join(root, "gh");
  writeFileSync(
    executable,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = __dirname;
const statePath = join(root, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const pool = process.env.CLAWSWEEPER_GITHUB_POOL_CLASS;
appendFileSync(join(root, "requests.jsonl"), JSON.stringify({ args, token, pool, at: Date.now(), pid: process.pid }) + "\\n");
try {
${source}
} finally {
  const temporary = statePath + "." + process.pid;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
}
`,
  );
  chmodSync(executable, 0o755);
  const previous = {
    PATH: process.env.PATH,
    GH_BIN: process.env.GH_BIN,
    GH_BIN_ARGS: process.env.GH_BIN_ARGS,
  };
  Object.assign(process.env, mockGhBinEnv(executable, root));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    statePath,
    requests: () =>
      existsSync(requestsPath)
        ? readFileSync(requestsPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  args: string[];
                  token: string;
                  pool: string;
                  at: number;
                  pid: number;
                },
            )
        : [],
  };
}

/** Separate process keeps the real curl transport usable from synchronous callers. */
export async function installEtagBroker(t: TestContext, root: string, source = "") {
  const addressPath = join(root, "broker-address");
  const requestsPath = join(root, "broker-requests.jsonl");
  const serverPath = join(root, "broker.cjs");
  writeFileSync(
    serverPath,
    `
const { createServer } = require("node:http");
const { createHash, createHmac } = require("node:crypto");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const root = __dirname;
const entries = new Map();
let lookups = 0;
createServer((req, res) => {
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    const signature = "sha256=" + createHmac("sha256", "synthetic-broker-secret").update(body).digest("hex");
    if (req.headers["x-clawsweeper-exact-review-signature"] !== signature) { res.writeHead(401).end(); return; }
    const value = JSON.parse(body);
    const operation = req.url.split("/").at(-1);
    appendFileSync(join(root, "broker-requests.jsonl"), JSON.stringify({ operation, value }) + "\\n");
    const key = value.cache_key;
    const entry = entries.get(key);
    let result;
    if (operation === "lookup") { lookups++; result = entry ? { hit: true, entry } : { hit: false }; }
    else if (operation === "store") {
      const stored = { etag: value.etag, body: value.body, bodyDigest: createHash("sha256").update(value.body || "").digest("hex") };
      entries.set(key, stored); result = { stored: true };
    } else result = entry && entry.etag === value.etag && entry.bodyDigest === value.body_digest
      ? { confirmed: true, body: entry.body, entry } : { confirmed: false };
    ${source}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  });
}).listen(0, "127.0.0.1", function () { writeFileSync(${JSON.stringify(addressPath)}, "http://127.0.0.1:" + this.address().port); });
`,
  );
  const child = spawn(process.execPath, [serverPath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    child.kill();
  });
  const started = Date.now();
  while (!existsSync(addressPath)) {
    if (child.exitCode !== null || Date.now() - started > 5_000)
      throw new Error(`ETag fixture failed to start: ${stderr}`);
    await setTimeout(10);
  }
  const previous = {
    EXACT_REVIEW_QUEUE_URL: process.env.EXACT_REVIEW_QUEUE_URL,
    CLAWSWEEPER_WEBHOOK_SECRET: process.env.CLAWSWEEPER_WEBHOOK_SECRET,
  };
  process.env.EXACT_REVIEW_QUEUE_URL = readFileSync(addressPath, "utf8");
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-broker-secret";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return () =>
    existsSync(requestsPath)
      ? readFileSync(requestsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
}
