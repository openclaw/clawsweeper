#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);
const proofDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = (await git(["rev-parse", "--show-toplevel"], proofDir)).trim();
const head = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
const mergeBase = (await git(["merge-base", "HEAD", "origin/main"], repoRoot)).trim();
const outputPath = path.resolve(
  process.env.TYPED_WEBHOOK_INGRESS_PROOF_OUTPUT ||
    path.join(repoRoot, ".artifacts/typed-webhook-ingress/behavior-report.json"),
);
const scratch = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-typed-webhook-ingress-"));
const baseRoot = path.join(scratch, "merge-base");
const webhookSecret = "typed-webhook-ingress-proof";

const repository = {
  full_name: "openclaw/gogcli",
  default_branch: "trunk",
  private: false,
  archived: false,
  fork: false,
  has_issues: true,
};
const fixtures = [
  {
    name: "issue_comment",
    event: "issue_comment",
    payload: {
      action: "created",
      repository,
      issue: { number: 1128, user: { login: "steipete" } },
      installation: { id: 123 },
      comment: {
        id: 456,
        body: "@clawsweeper review",
        author_association: "OWNER",
        user: { login: "steipete" },
      },
    },
  },
  {
    name: "issues",
    event: "issues",
    payload: {
      action: "opened",
      repository,
      issue: { number: 1129 },
      installation: { id: 123 },
    },
  },
  {
    name: "pull_request",
    event: "pull_request",
    payload: {
      action: "opened",
      repository,
      pull_request: {
        number: 1130,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        draft: false,
        title: "Typed webhook ingress proof",
        body: "Synthetic proof fixture.",
        updated_at: "2026-08-11T20:00:00Z",
      },
      installation: { id: 123 },
    },
  },
  {
    name: "unsupported_event",
    event: "future_event",
    payload: { action: "opened", repository, installation: { id: 123 } },
  },
];

await mkdir(baseRoot, { recursive: true });
await extractRevision(mergeBase, baseRoot);

let baseWorker;
let headWorker;
try {
  baseWorker = await startWorker(baseRoot, "merge-base");
  headWorker = await startWorker(repoRoot, "head");
  const before = await runFixtures(baseWorker.origin);
  const after = await runFixtures(headWorker.origin);
  assert.deepEqual(after, before);

  const report = {
    schema: "clawsweeper-typed-webhook-ingress-proof/v1",
    generated_at: new Date().toISOString(),
    merge_base: mergeBase,
    head,
    runtime: "two real wrangler dev --local Workers over loopback HTTP",
    fixtures: fixtures.map((fixture, index) => ({
      name: fixture.name,
      event: fixture.event,
      merge_base: before[index],
      head: after[index],
      identical: true,
    })),
    result: {
      compared: fixtures.length,
      identical: fixtures.length,
      different: 0,
      status: "succeeded",
    },
    limits: [
      "Fixtures use synthetic payloads and credentials.",
      "The proof exercises signed Worker intake and local Durable Objects but no live GitHub API or production state.",
      "The issue_comment fixture stops at missing synthetic App configuration; the item fixtures exercise local queue admission.",
    ],
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("TYPED_WEBHOOK_INGRESS_PROOF_RC=0\n");
} finally {
  await Promise.all([stopWorker(baseWorker), stopWorker(headWorker)]);
  await rm(scratch, { recursive: true, force: true });
}

async function runFixtures(origin) {
  const outcomes = [];
  for (const fixture of fixtures) {
    const body = JSON.stringify(fixture.payload);
    const response = await fetch(`${origin}/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": fixture.event,
        "x-github-delivery": `typed-webhook-${fixture.name}`,
        "x-hub-signature-256": signature(body),
      },
      body,
    });
    outcomes.push({ status: response.status, body: await response.json() });
  }
  return outcomes;
}

async function startWorker(sourceRoot, label) {
  const port = await availablePort();
  const persistence = path.join(scratch, `${label}-state`);
  const logs = [];
  const child = spawn(
    "npx",
    [
      "--yes",
      "wrangler@4.107.0",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistence,
      "--config",
      path.join(sourceRoot, "dashboard/wrangler.toml"),
      "--var",
      `CLAWSWEEPER_WEBHOOK_SECRET:${webhookSecret}`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(origin, child, logs);
  } catch (error) {
    await stopWorker({ child });
    throw error;
  }
  return { child, origin };
}

async function waitForWorker(origin, child, logs) {
  const body = "{}";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited early (${child.exitCode}):\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${origin}/github/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-hub-signature-256": signature(body),
        },
        body,
      });
      if (response.status === 202) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Wrangler did not become ready:\n${logs.join("")}`);
}

async function stopWorker(worker) {
  if (!worker?.child || worker.child.exitCode !== null) return;
  const signalTarget = process.platform === "win32" ? worker.child.pid : -worker.child.pid;
  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => worker.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (worker.child.exitCode === null) {
    try {
      process.kill(signalTarget, "SIGKILL");
    } catch {}
  }
}

async function extractRevision(revision, destination) {
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", revision], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-x", "-C", destination], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(extract.stdin);
    const errors = [];
    archive.stderr.on("data", (chunk) => errors.push(String(chunk)));
    extract.stderr.on("data", (chunk) => errors.push(String(chunk)));
    let archiveCode;
    let extractCode;
    const finish = () => {
      if (archiveCode === undefined || extractCode === undefined) return;
      if (archiveCode === 0 && extractCode === 0) resolve();
      else reject(new Error(`revision extraction failed:\n${errors.join("")}`));
    };
    archive.on("exit", (code) => {
      archiveCode = code;
      finish();
    });
    extract.on("exit", (code) => {
      extractCode = code;
      finish();
    });
  });
}

function signature(body) {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function git(args, cwd) {
  return (await execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
}
