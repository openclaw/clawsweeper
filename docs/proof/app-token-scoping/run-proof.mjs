import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import worker, { githubJsonForTest } from "../../../dashboard/worker.ts";
import { guardedDeadLetterFixture, MemoryDurableNamespace } from "../../../test/dashboard-worker-harness.ts";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] || join(root, ".artifacts/app-token-scoping/worker-proof.json"));
const scratch = await mkdtemp(join(tmpdir(), "worker-token-proof-"));
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const grants = new Map();
const trace = [];
const mutations = [];
const scenarios = [];
const secret = "synthetic-local-recovery-secret";
let recovery;
let denyCanonical = false;
let origin;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url, origin).pathname;
    const method = req.method;
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const grant = grants.get(bearer);
    const event = { method, path, bearer: grant?.id || (bearer ? "app-jwt" : null), status: 0 };
    trace.push(event);
    const send = (status, data) => {
      event.status = status;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path.startsWith("/internal/")) {
      const result = await worker.fetch(new Request(origin + req.url, {
        method, headers: req.headers, ...(body ? { body } : {}),
      }), { EXACT_REVIEW_OPERATOR_SECRET: secret, EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(recovery.queue) });
      if (path.endsWith("/recover-fresh")) mutations.push({ path, status: result.status });
      return send(result.status, await result.json());
    }
    if (path.endsWith("/installation") || path === "/app/installations/999/access_tokens") {
      const [header, claims, signature] = bearer.split(".");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
      assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, "Iv23worker-proof");
      if (path.endsWith("/installation")) return send(200, { id: 999 });
      assert.equal(method, "POST");
      const scope = JSON.parse(body);
      assert.ok(scope.repositories.length > 0);
      const token = randomUUID();
      grants.set(token, { id: `token-${grants.size + 1}`, ...scope, revoked: false });
      return send(201, { token, expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    assert.ok(match, `unexpected route ${path}`);
    const [, owner, repo, suffix = ""] = match;
    assert.equal(owner, "openclaw");
    if (!grant || grant.revoked) return send(401, { message: "Bad credentials" });
    if (!grant.repositories.includes(repo.toLowerCase())) return send(404, { message: "Not Found" });
    const permission = suffix.startsWith("/actions") ? "actions" : suffix.startsWith("/pulls") ? "pull_requests" : "issues";
    if ((method !== "GET" && grant.permissions[permission] !== "write") || !grant.permissions[permission]) {
      return send(403, { message: "Resource not accessible by integration" });
    }
    if (repo === "canonical-target" && denyCanonical) return send(403, { message: "Resource not accessible by integration" });
    if (repo === "openclaw" || repo === "canonical-target") {
      return send(200, { node_id: "PR_canonical", number: 321, state: "open", pull_request: {},
        repository_url: "https://api.github.com/repos/openclaw/canonical-target", head: { sha: "a".repeat(40) } });
    }
    return send(200, { ok: true });
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const env = { GITHUB_API_URL: origin, CLAWSWEEPER_APP_CLIENT_ID: "Iv23worker-proof",
  CLAWSWEEPER_APP_PRIVATE_KEY: privateKey, CLAWSWEEPER_APP_INSTALLATION_ID: "999" };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, origin, "non-loopback fetch blocked");
  return nativeFetch(input, init);
};
const read = async (path) => assert.deepEqual(await githubJsonForTest(env, path), { ok: true });
try {
  await read("/repos/openclaw/alpha/issues/1");
  const alpha = [...grants.keys()][0];
  await read("/repos/openclaw/alpha/issues/2");
  await read("/repos/openclaw/beta/issues/1");
  assert.equal(grants.size, 2);
  assert.deepEqual(trace.filter((e) => e.path.includes("/issues/")).map((e) => e.bearer), ["token-1", "token-1", "token-2"]);
  scenarios.push({ name: "repository-isolation", result: "PASS", reads: [200, 200, 200], mints: 2 });
  await read("/repos/openclaw/alpha/actions/runs");
  assert.equal(grants.size, 3);
  assert.deepEqual([...grants.values()][2].permissions, { actions: "read" });
  scenarios.push({ name: "permission-isolation", result: "PASS", bearer: trace.at(-1).bearer, status: 200 });
  const controls = [];
  for (const [path, method, expected] of [["/repos/openclaw/beta/issues/1", "GET", 404], ["/repos/openclaw/alpha/issues/1", "POST", 403]]) {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${alpha}` } });
    await response.text();
    assert.equal(response.status, expected);
    controls.push(response.status);
  }
  scenarios.push({ name: "scope-enforcement-controls", result: "PASS", statuses: controls });
  grants.get(alpha).revoked = true;
  const beforeRevocation = trace.length;
  await read("/repos/openclaw/alpha/issues/3");
  await read("/repos/openclaw/alpha/issues/4");
  const revocationReads = trace.slice(beforeRevocation).filter((e) => e.path.includes("/issues/"));
  assert.deepEqual(revocationReads.map((e) => e.status), [401, 200, 200]);
  assert.deepEqual(revocationReads.map((e) => e.bearer), ["token-1", "token-4", "token-4"]);
  assert.equal(grants.size, 4);
  scenarios.push({ name: "cached-token-revocation", result: "PASS", reads: revocationReads });
  for (const denied of [true, false]) {
    recovery = await guardedDeadLetterFixture(321);
    denyCanonical = denied;
    const start = trace.length;
    const before = mutations.length;
    const child = spawn(process.execPath, ["scripts/exact-review-dead-letter-operator.mjs", "--action", "recover-fresh",
      "--ids", recovery.id, "--idempotency-key", "proof:canonical", "--execute", "--output", join(scratch, "inventory.json")], {
      cwd: root, env: { ...env, PATH: dirname(process.execPath), HOME: scratch, TMPDIR: scratch,
        EXACT_REVIEW_QUEUE_URL: origin, CLAWSWEEPER_WEBHOOK_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }).finally(() => clearTimeout(timer));
    assert.equal(code, denied ? 1 : 0, stderr);
    const canonicalRead = trace.slice(start).find((e) => e.path === "/repos/openclaw/canonical-target/pulls/321");
    assert.ok(canonicalRead);
    const canonicalGrant = [...grants.values()].find((g) => g.id === canonicalRead.bearer);
    const sourceRead = trace.slice(start).find((e) => e.path === "/repos/openclaw/openclaw/issues/321");
    assert.notEqual(sourceRead.bearer, canonicalRead.bearer);
    assert.deepEqual([...grants.values()].find((g) => g.id === sourceRead.bearer).repositories, ["openclaw"]);
    assert.deepEqual(canonicalGrant.repositories, ["canonical-target"]);
    assert.deepEqual(canonicalGrant.permissions, { issues: "read", pull_requests: "read" });
    assert.equal(canonicalRead.status, denied ? 403 : 200);
    assert.equal(mutations.length - before, denied ? 0 : 1);
    const state = await recovery.storage.get("exact-review-queue");
    assert.equal(Boolean(state.items["openclaw/openclaw#321"]), !denied);
    if (!denied) {
      assert.equal(state.items["openclaw/openclaw#321"].state, "pending");
      assert.ok(trace.indexOf(canonicalRead) < trace.findLastIndex((e) => e.path.endsWith("/recover-fresh")));
    }
    const listed = await recovery.queue.fetch(new Request("https://queue/dead-letters/list", { method: "POST", body: "{}" }));
    assert.equal((await listed.json()).dead_letters.length, denied ? 1 : 0);
    if (!denied) assert.equal(JSON.parse(stdout).result.recovered, 1);
    scenarios.push({ name: denied ? "canonical-target-denied" : "canonical-target-recovery", result: "PASS",
      exit: code, canonical_read: canonicalRead, recovery_mutations: mutations.length - before,
      queued_source_item: !denied, open_dead_letters: denied ? 1 : 0 });
  }
  const summary = { result: "PASS", head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()),
    runtime: process.version, provider: "local-node", image: null, lease: null, scenarios,
    bearer_scopes: [...grants.values()], trace, mutations, production_mutations: 0,
    limits: "Real Worker reader and recovery HTTP routing, real operator CLI, SQLite-backed queue via existing test storage adapter. Synthetic loopback GitHub; no deployed Cloudflare or live GitHub coverage. Direct recover-fresh queues the original source identity after canonical authorization." };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
