import { spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const outputDir = path.resolve(process.env.PROOF_OUTPUT || ".artifacts/durable-command-intake");
const baseRef = process.env.PROOF_BASE_SHA || "origin/main";
const commandBody = "@clawsweeper re-review\n\nPlease check the current head.";
const commandUpdatedAt = "2026-08-12T16:25:26Z";
const commandCommentId = 9_001;
const itemNumber = 42;
const headSha = "a".repeat(40);
const webhookSecret = "durable-command-intake-proof-secret";
const requiredTables = [
  "exact_review_command_intakes",
  "exact_review_command_receipts",
  "exact_review_command_watermarks",
  "exact_review_item_revisions",
];

fs.mkdirSync(outputDir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-command-intake-proof-"));
const baselineDir = path.join(root, "baseline");
const candidateDir = path.join(root, "candidate");
const baselinePersist = path.join(root, "baseline-persist");
const candidatePersist = path.join(root, "candidate-persist");
for (const directory of [baselineDir, candidateDir, baselinePersist, candidatePersist]) {
  fs.mkdirSync(directory, { recursive: true });
}

const hasGitMetadata = isGitRepository();
const baseSha = /^[0-9a-f]{40}$/.test(baseRef) ? baseRef : git(["rev-parse", baseRef]);
const candidateSha =
  process.env.PROOF_CANDIDATE_SHA || (hasGitMetadata ? git(["rev-parse", "HEAD"]) : "");
if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
  throw new Error("PROOF_CANDIDATE_SHA is required when Crabbox sync omits Git metadata");
}
if (hasGitMetadata) {
  archive(baseSha, baselineDir);
  archive(candidateSha, candidateDir);
} else {
  cloneBaseline(baseSha, baselineDir);
  copyCandidateTree(candidateDir);
}

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let activeBoot = "baseline";
const observations = {
  baseline: observation(),
  candidate: observation(),
};
const github = await startGithubLoopback(() => observations[activeBoot]);

try {
  writeDevVars(baselineDir, github.origin, privateKey);
  writeDevVars(candidateDir, github.origin, privateKey);

  const baseline = await runWorkerBoot({
    label: "baseline",
    checkout: baselineDir,
    persist: baselinePersist,
    setActive: () => {
      activeBoot = "baseline";
    },
  });
  const candidate = await runWorkerBoot({
    label: "candidate",
    checkout: candidateDir,
    persist: candidatePersist,
    setActive: () => {
      activeBoot = "candidate";
    },
  });

  const baselineSql = inspectPersistence(baselinePersist);
  const candidateSql = inspectPersistence(candidatePersist);
  const baselineHasCommandSchema = requiredTables.some((table) =>
    baselineSql.tables.includes(table),
  );
  const candidateHasCommandSchema = requiredTables.every((table) =>
    candidateSql.tables.includes(table),
  );
  const comparisonPass =
    baseline.response.status >= 500 &&
    observations.baseline.acknowledgements >= 1 &&
    observations.baseline.dispatchAttempts >= 1 &&
    !baselineHasCommandSchema &&
    candidate.response.status === 202 &&
    observations.candidate.acknowledgements === 0 &&
    candidateHasCommandSchema &&
    candidateSql.commandIntakes === 1 &&
    candidateSql.receiptOutcomes.includes("pending") &&
    baseline.processTreeKill.confirmed &&
    candidate.processTreeKill.confirmed;

  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    base_sha: baseSha,
    candidate_sha: candidateSha,
    provider_environment: "Crabbox-selected provider; see receipt.md",
    comparison_pass: comparisonPass,
    baseline: {
      response: baseline.response,
      github: observations.baseline,
      sqlite: baselineSql,
      process_tree_kill: baseline.processTreeKill,
    },
    candidate: {
      response: candidate.response,
      github: observations.candidate,
      sqlite: candidateSql,
      durable_object_instantiated: candidateHasCommandSchema,
      process_tree_kill: candidate.processTreeKill,
    },
    limits: {
      github: "loopback synthetic API; no live credentials or production mutations",
      worker: "wrangler dev --local; executor completion and public publication not exercised",
    },
  };
  fs.writeFileSync(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!comparisonPass) process.exitCode = 1;
} finally {
  await github.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function observation() {
  return {
    acknowledgements: 0,
    dispatchAttempts: 0,
    sourceCommentReads: 0,
    reactions: 0,
  };
}

async function runWorkerBoot({ label, checkout, persist, setActive }) {
  setActive();
  const port = await unusedPort();
  const stdoutPath = path.join(outputDir, `${label}-wrangler.stdout.log`);
  const stderrPath = path.join(outputDir, `${label}-wrangler.stderr.log`);
  const stdout = fs.openSync(stdoutPath, "w");
  const stderr = fs.openSync(stderrPath, "w");
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
      persist,
      "--config",
      "dashboard/wrangler.toml",
    ],
    {
      cwd: checkout,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  try {
    await waitForHealth(port, child);
    const response = await sendWebhook(port);
    await delay(1_500);
    return {
      response,
      processTreeKill: await stopProcessGroup(child),
    };
  } catch (error) {
    const processTreeKill = await stopProcessGroup(child);
    throw new Error(
      `${label} worker proof failed: ${error instanceof Error ? error.message : String(error)}; process_tree_kill=${JSON.stringify(processTreeKill)}`,
    );
  }
}

async function sendWebhook(port) {
  const body = JSON.stringify({
    action: "created",
    repository: {
      full_name: "openclaw/openclaw",
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    installation: { id: 123 },
    issue: {
      number: itemNumber,
      state: "open",
      user: { login: "contributor" },
      pull_request: { url: `https://api.github.com/repos/openclaw/openclaw/pulls/${itemNumber}` },
    },
    comment: {
      id: commandCommentId,
      body: commandBody,
      author_association: "CONTRIBUTOR",
      user: { login: "contributor" },
      created_at: commandUpdatedAt,
      updated_at: commandUpdatedAt,
      html_url: `https://github.com/openclaw/openclaw/pull/${itemNumber}#issuecomment-${commandCommentId}`,
    },
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": `proof-${port}`,
      "x-hub-signature-256": signature,
    },
    body,
  });
  const responseBody = await response.text();
  return {
    status: response.status,
    body: responseBody.slice(0, 500),
  };
}

async function startGithubLoopback(currentObservation) {
  const acknowledgements = new Map();
  let nextCommentId = 20_000;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const body = await readJson(request);
    const observed = currentObservation();
    if (url.pathname === `/repos/openclaw/openclaw/issues/comments/${commandCommentId}`) {
      observed.sourceCommentReads += 1;
      return sendJson(
        response,
        403,
        {
          message: "API rate limit exceeded for installation",
        },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 60),
        },
      );
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return sendJson(response, 200, { id: 777 });
    }
    if (/^\/app\/installations\/(?:123|777)\/access_tokens$/.test(url.pathname)) {
      return sendJson(response, 201, { token: "synthetic-loopback-token" });
    }
    if (url.pathname === `/repos/openclaw/openclaw/issues/${itemNumber}/comments`) {
      if (request.method === "GET") return sendJson(response, 200, [...acknowledgements.values()]);
      if (request.method === "POST") {
        const comment = {
          id: nextCommentId++,
          body: String(body.body || ""),
          created_at: new Date().toISOString(),
        };
        acknowledgements.set(comment.id, comment);
        observed.acknowledgements += 1;
        return sendJson(response, 201, comment);
      }
    }
    if (url.pathname === `/repos/openclaw/openclaw/issues/comments/${commandCommentId}/reactions`) {
      observed.reactions += 1;
      return sendJson(response, 201, { id: observed.reactions, content: "eyes" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      observed.dispatchAttempts += 1;
      return sendJson(response, 403, { message: "API rate limit exceeded for installation" });
    }
    return sendJson(response, 404, { message: `unhandled ${request.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server missing address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function inspectPersistence(rootDirectory) {
  const tables = new Set();
  const receiptOutcomes = [];
  let commandIntakes = 0;
  for (const file of walk(rootDirectory)) {
    let database;
    try {
      database = new DatabaseSync(file, { readOnly: true });
      const names = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      names.forEach((name) => tables.add(name));
      if (names.includes("exact_review_command_intakes")) {
        commandIntakes += Number(
          database.prepare("SELECT COUNT(*) AS count FROM exact_review_command_intakes").get()
            ?.count || 0,
        );
      }
      if (names.includes("exact_review_command_receipts")) {
        receiptOutcomes.push(
          ...database
            .prepare(
              "SELECT outcome FROM exact_review_command_receipts ORDER BY command_version_id",
            )
            .all()
            .map((row) => String(row.outcome)),
        );
      }
    } catch {
      // Wrangler persistence contains metadata alongside SQLite files.
    } finally {
      database?.close();
    }
  }
  return {
    tables: [...tables].sort(),
    commandIntakes,
    receiptOutcomes,
  };
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { signal: child.signalCode || "exited", confirmed: true };
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const graceful = await waitForExit(child, 5_000);
  if (graceful) return { signal: "SIGTERM", confirmed: true };
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return { signal: "SIGKILL", confirmed: await waitForExit(child, 5_000) };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Worker is still compiling.
    }
    await delay(250);
  }
  throw new Error("wrangler health check timed out");
}

function writeDevVars(checkout, githubOrigin, key) {
  const values = {
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23durable-command-intake-proof",
    CLAWSWEEPER_APP_PRIVATE_KEY: key,
    GITHUB_API_URL: githubOrigin,
  };
  const contents = `${Object.entries(values)
    .map(([name, value]) => `${name}=${value.includes("\n") ? `"${value}"` : value}`)
    .join("\n")}\n`;
  fs.writeFileSync(path.join(checkout, ".dev.vars"), contents);
  fs.writeFileSync(path.join(checkout, "dashboard", ".dev.vars"), contents);
}

function archive(ref, destination) {
  const result = spawnSync("git", ["archive", "--format=tar", ref], {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git archive ${ref} failed: ${result.stderr}`);
  const extracted = spawnSync("tar", ["-xf", "-", "-C", destination], {
    input: result.stdout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error(`tar extraction failed: ${extracted.stderr}`);
}

function cloneBaseline(ref, destination) {
  const parent = path.dirname(destination);
  const checkout = path.join(parent, "baseline-checkout");
  const cloned = spawnSync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/openclaw/clawsweeper.git",
      checkout,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (cloned.status !== 0) throw new Error(`baseline clone failed: ${cloned.stderr}`);
  const checkedOut = spawnSync("git", ["-C", checkout, "checkout", "--detach", ref], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (checkedOut.status !== 0) throw new Error(`baseline checkout failed: ${checkedOut.stderr}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(checkout, destination);
}

function copyCandidateTree(destination) {
  const sourceRoot = process.cwd();
  fs.cpSync(sourceRoot, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return ![".artifacts", ".crabbox", ".git", "coverage", "dist", "node_modules"].includes(
        first,
      );
    },
  });
}

function isGitRepository() {
  return (
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).status === 0
  );
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("port probe missing address"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
