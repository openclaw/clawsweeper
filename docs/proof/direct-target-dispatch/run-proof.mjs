// Before/after proof: target-dispatcher events reach the exact-review queue
// without a `repository_dispatch` relay run.
//
// Usage: node docs/proof/direct-target-dispatch/run-proof.mjs BASE_REF TOOLS_DIR FRESH_OUTPUT_DIR
// TOOLS_DIR must resolve miniflare and esbuild. FRESH_OUTPUT_DIR must not exist.
// Optional: PROOF_GH (native gh), PROOF_BASH (bash >= 4.4), PROOF_OPENSSL.
//
// Per variant (BASE_REF, then the committed HEAD) it runs, unmodified:
// - the variant's `Dispatch exact ClawSweeper review` step script from
//   .github/workflows/clawsweeper-dispatch.yml under bash with native curl/jq/gh;
// - the variant's real Worker (dashboard/worker.ts) and ExactReviewQueue Durable
//   Object in workerd/SQLite through Miniflare;
// - for every repository_dispatch the step sends, the variant's sweep.yml
//   `Queue legacy exact-review event` relay script (what that relay run executes).
// GitHub, the GitHub App, and the Actions OIDC issuer are local synthetic fixtures.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const [baseRef, toolsDir, output] = process.argv.slice(2);
assert.ok(baseRef && toolsDir && output, "expected BASE_REF TOOLS_DIR FRESH_OUTPUT_DIR");
const out = path.resolve(output);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out);
const require = createRequire(path.resolve(toolsDir, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const nativeGh = process.env.PROOF_GH || "/opt/homebrew/bin/gh";
const bash5 = process.env.PROOF_BASH || "/opt/homebrew/bin/bash";
const openssl =
  process.env.PROOF_OPENSSL ||
  (existsSync("/opt/homebrew/bin/openssl") ? "/opt/homebrew/bin/openssl" : "openssl");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const WEBHOOK_SECRET = "direct-target-dispatch-proof-secret";
const REQUEST_TOKEN = "synthetic-actions-id-token-request-token";
const PRODUCTION_HOST = "clawsweeper.openclaw.ai";
const REPO_IDS = { "openclaw/openclaw": "1000001", "openclaw/gogcli": "1000002" };
const FILES = [
  ".github/workflows/clawsweeper-dispatch.yml",
  ".github/workflows/sweep.yml",
  "dashboard/worker.ts",
  "dashboard/exact-review-queue.ts",
  "dashboard/target-dispatch-ingress.ts",
  "dashboard/github-actions-oidc.ts",
];

const scratch = mkdtempSync(path.join(os.tmpdir(), "direct-target-dispatch-"));
const { privateKey: appKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const oidcKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = {
  keys: [{ ...oidcKeys.publicKey.export({ format: "jwk" }), kid: "proof-oidc", alg: "RS256" }],
};

// Self-signed certificate so the step's curl reaches the local Worker under the
// production hostname through ~/.curlrc `connect-to`, without editing the step.
const tls = path.join(scratch, "tls");
mkdirSync(tls);
execFileSync(
  openssl,
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${PRODUCTION_HOST}`,
    "-addext",
    `subjectAltName=DNS:${PRODUCTION_HOST}`,
    "-keyout",
    path.join(tls, "key.pem"),
    "-out",
    path.join(tls, "cert.pem"),
  ],
  { stdio: "ignore" },
);

const bin = path.join(scratch, "bin");
mkdirSync(bin);
symlinkSync(nativeGh, path.join(bin, "gh"));

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server, ...args) {
  return new Promise((resolve) => server.listen(...args, resolve));
}

// ---- Synthetic GitHub API reached by native gh (records repository_dispatch).
const ghSocket = path.join(mkdtempSync(path.join(os.tmpdir(), "d-")), "s");
let ghDispatches = [];
const ghUnexpected = [];
const ghServer = http.createServer(async (request, response) => {
  const body = await readBody(request);
  const url = new URL(request.url, "http://api.github.com");
  if (request.method === "POST" && url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
    ghDispatches.push(JSON.parse(body));
    response.writeHead(204).end();
    return;
  }
  ghUnexpected.push(`${request.method} ${url.pathname}`);
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: "Not Found" }));
});
await listen(ghServer, ghSocket);
const ghConfig = path.join(scratch, "gh-config");
mkdirSync(ghConfig);
writeFileSync(path.join(ghConfig, "config.yml"), `http_unix_socket: ${ghSocket}\n`);

// ---- Synthetic GitHub Actions OIDC issuer (ACTIONS_ID_TOKEN_REQUEST_URL).
let oidcContext = null;
let oidcMints = [];
const issuer = http.createServer((request, response) => {
  const url = new URL(request.url, "http://issuer");
  const audience = url.searchParams.get("audience");
  if (
    url.pathname !== "/token" ||
    request.headers.authorization !== `bearer ${REQUEST_TOKEN}` ||
    !audience ||
    !oidcContext
  ) {
    response.writeHead(401).end();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const workflowRef = `${oidcContext.repository}/.github/workflows/clawsweeper-dispatch.yml@${oidcContext.ref}`;
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    sub: `repo:${oidcContext.repository}:ref:${oidcContext.ref}`,
    repository: oidcContext.repository,
    repository_id: REPO_IDS[oidcContext.repository],
    repository_owner: oidcContext.repository.split("/")[0],
    event_name: oidcContext.eventName,
    ref: oidcContext.ref,
    sha: "e".repeat(40),
    workflow_ref: workflowRef,
    job_workflow_ref: workflowRef,
    run_id: oidcContext.runId,
    run_attempt: "1",
    iat: now,
    nbf: now - 5,
    exp: now + 300,
  };
  oidcMints.push({ aud: audience, event_name: claims.event_name, ref: claims.ref });
  const encoded = [{ alg: "RS256", kid: "proof-oidc", typ: "JWT" }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  const token = `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), oidcKeys.privateKey).toString("base64url")}`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ count: 1, value: token }));
});
await listen(issuer, 0, "127.0.0.1");
const issuerUrl = `http://127.0.0.1:${issuer.address().port}/token?api-version=2.0`;

// ---- Worker egress fixture: GitHub API, App tokens, registry, and JWKS.
let egress = { jwks: 0, executorDispatches: 0, unexpected: [] };
let failVisibility = new Set();
let registryText = "";
const comments = new Map();
let nextCommentId = 7_000_000;
const pullHeads = new Map();
const egressServer = http.createServer(async (request, response) => {
  const body = await readBody(request);
  const url = new URL(request.url, "http://egress");
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const route = url.pathname;
  let match;
  if (route === "/.well-known/jwks") {
    egress.jwks += 1;
    return send(200, jwks);
  }
  if (route === "/openclaw/clawsweeper/main/config/target-repositories.json") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(registryText);
  }
  if ((match = route.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/)))
    return send(200, { id: 999 });
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(route)) {
    return send(201, { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" });
  }
  if ((match = route.match(/^\/repos\/([^/]+\/[^/]+)$/))) {
    if (failVisibility.has(match[1])) return send(500, { message: "synthetic outage" });
    return send(200, {
      full_name: match[1],
      private: false,
      visibility: "public",
      archived: false,
      fork: false,
      has_issues: true,
      default_branch: "main",
    });
  }
  if ((match = route.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
    const head = pullHeads.get(`${match[1]}#${match[2]}`);
    return send(200, {
      number: Number(match[2]),
      state: "open",
      draft: false,
      head: { sha: head },
      base: { sha: "b".repeat(40), ref: "main" },
    });
  }
  if ((match = route.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
    const key = `${match[1]}#${match[2]}`;
    const list = comments.get(key) ?? [];
    if (request.method === "POST") {
      const comment = {
        id: (nextCommentId += 1),
        body: JSON.parse(body).body,
        user: { login: "clawsweeper[bot]" },
        issue_url: `https://api.github.com/repos/${key.replace("#", "/issues/")}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      comments.set(key, [...list, comment]);
      return send(201, comment);
    }
    return send(200, list);
  }
  if (route === "/repos/openclaw/clawsweeper/dispatches") {
    egress.executorDispatches += 1;
    return send(204);
  }
  if (route === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
    return send(200, { state: "active" });
  }
  egress.unexpected.push(`${request.method} ${route}`);
  return send(404, { message: "Not Found" });
});
await listen(egressServer, 0, "127.0.0.1");
const egressAddress = `127.0.0.1:${egressServer.address().port}`;

// ---- Recording reverse proxies in front of Miniflare.
let workerOrigin = "";
const PROXIED_WORKER_ROUTES = new Map(
  [
    "/github/target-dispatch",
    "/internal/exact-review/enqueue",
    "/internal/exact-review/branch-authority",
    "/internal/exact-review/source-authority",
  ].map((route) => [route, route]),
);
function recordingProxy(records) {
  return async (request, response) => {
    const body = await readBody(request);
    // Forward only the routes the dispatcher and relay scripts call, built from constants,
    // so request data never selects the upstream URL.
    const route = PROXIED_WORKER_ROUTES.get(new URL(request.url, "http://proxy.invalid").pathname);
    if (!route) {
      records.push({ path: "<unproxied>", status: 404, body: null });
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "route is not proxied to the local Worker" }));
      return;
    }
    const upstream = await fetch(new URL(route, workerOrigin), {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !["host", "connection", "content-length", "transfer-encoding"].includes(name),
        ),
      ),
      ...(body ? { body } : {}),
    });
    const text = await upstream.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    records.push({
      path: new URL(request.url, "http://x").pathname,
      status: upstream.status,
      body: json,
    });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(text);
  };
}
let frontRecords = [];
let relayRecords = [];
const front = https.createServer(
  { key: readFileSync(path.join(tls, "key.pem")), cert: readFileSync(path.join(tls, "cert.pem")) },
  (request, response) => recordingProxy(frontRecords)(request, response),
);
await listen(front, 0, "127.0.0.1");
const relayFront = http.createServer((request, response) =>
  recordingProxy(relayRecords)(request, response),
);
await listen(relayFront, 0, "127.0.0.1");
const relayUrl = `http://127.0.0.1:${relayFront.address().port}`;
const closedPort = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

function curlHome(name, port) {
  const home = path.join(scratch, `home-${name}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, ".curlrc"),
    `connect-to = ${PRODUCTION_HOST}:443:127.0.0.1:${port}\ncacert = ${path.join(tls, "cert.pem")}\n`,
  );
  return home;
}
const reachableHome = curlHome("reachable", front.address().port);
const unreachableHome = curlHome("unreachable", closedPort);

function runScript(shell, script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-e", "-c", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function wranglerVars(text) {
  const start = text.indexOf("\n[vars]\n");
  assert.ok(start >= 0, "wrangler.toml has no [vars] section");
  const vars = {};
  for (const line of text.slice(start + "\n[vars]\n".length).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^([A-Z0-9_]+) = "([^"]*)"$/.exec(line.trim());
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function pullEvent({ repo, number, action = "opened", baseRef = "main", headSha }) {
  return {
    action,
    number,
    pull_request: {
      number,
      title: `Proof pull request ${number}`,
      body: `Synthetic body for ${number}.`,
      locked: false,
      draft: false,
      state: "open",
      labels: [],
      user: { login: "contributor" },
      updated_at: "2030-01-01T00:00:00Z",
      head: { sha: headSha, ref: `proof-${number}` },
      base: { sha: "b".repeat(40), ref: baseRef },
    },
    repository: {
      full_name: repo,
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    installation: { id: 999 },
    sender: { login: "contributor" },
  };
}

function issueEvent({ repo, number }) {
  return {
    action: "opened",
    issue: {
      number,
      title: `Proof issue ${number}`,
      body: "Synthetic issue body.",
      locked: false,
      state: "open",
      labels: [],
      user: { login: "reporter" },
      updated_at: "2030-01-01T00:00:01Z",
    },
    repository: {
      full_name: repo,
      default_branch: "main",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    installation: { id: 999 },
    sender: { login: "reporter" },
  };
}

const SCENARIOS = [
  {
    name: "pr_opened",
    kind: "pull_request",
    repo: "openclaw/openclaw",
    number: 900001,
    runId: "501",
  },
  {
    name: "same_run_replayed",
    kind: "pull_request",
    repo: "openclaw/openclaw",
    number: 900001,
    runId: "501",
  },
  { name: "issue_opened", kind: "issue", repo: "openclaw/openclaw", number: 900002, runId: "502" },
  {
    name: "app_webhook_first_then_dispatcher",
    kind: "pull_request",
    repo: "openclaw/openclaw",
    number: 900003,
    runId: "503",
    appWebhookFirst: true,
  },
  {
    name: "forced_enqueue_failure_falls_back",
    kind: "pull_request",
    repo: "openclaw/gogcli",
    number: 77,
    runId: "504",
    failVisibility: true,
  },
  {
    name: "worker_unreachable_falls_back",
    kind: "pull_request",
    repo: "openclaw/openclaw",
    number: 900005,
    runId: "505",
    workerUnreachable: true,
  },
  {
    name: "non_default_base_falls_back",
    kind: "pull_request",
    repo: "openclaw/openclaw",
    number: 900006,
    runId: "506",
    baseRef: "release",
  },
];

const receipt = {
  claim:
    "A target dispatcher issue/PR event is enqueued into the real exact-review queue without any repository_dispatch (so no `Review event item` relay run); a replay of the same run dedupes; any direct failure falls back to the unchanged repository_dispatch, whose relay still enqueues the event.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain")),
  node: process.version,
  miniflare: require("miniflare/package.json").version,
  workerd: require("workerd/package.json").version,
  gh: execFileSync(nativeGh, ["--version"], { encoding: "utf8" }).split("\n")[0],
  curl: execFileSync("curl", ["--version"], { encoding: "utf8" }).split("\n")[0].split(" (")[0],
  runtime:
    "workerd/SQLite (Miniflare) running the variant's dashboard/worker.ts and ExactReviewQueue; dispatcher and relay step scripts from the variant's workflows under bash; native gh over http_unix_socket",
  variants: {},
};

let relayRunId = 9000;
try {
  for (const variant of ["baseline", "candidate"]) {
    const ref = variant === "baseline" ? receipt.base : receipt.head;
    const dir = path.join(scratch, `src-${variant}`);
    mkdirSync(dir);
    execFileSync("tar", ["-x", "-C", dir], {
      input: execFileSync("git", ["archive", ref], { maxBuffer: 512 * 1024 * 1024 }),
    });
    const read = (file) => readFileSync(path.join(dir, file), "utf8");
    registryText = read("config/target-repositories.json");
    const dispatcher = parse(read(".github/workflows/clawsweeper-dispatch.yml"));
    const dispatchJob = dispatcher.jobs.dispatch;
    const dispatchStep = dispatchJob.steps.find(
      (step) => step.name === "Dispatch exact ClawSweeper review",
    );
    const relayStep = parse(read(".github/workflows/sweep.yml")).jobs[
      "legacy-event-queue-intake"
    ].steps.find((step) => step.name === "Enqueue legacy event through the durable control plane");
    assert.ok(dispatchStep?.run && relayStep?.run);
    // Actions exposes the OIDC request variables only to jobs granted id-token: write.
    const oidcGranted = dispatchJob.permissions?.["id-token"] === "write";
    const runnerTemp = path.join(scratch, `runner-${variant}`);
    mkdirSync(runnerTemp);
    copyFileSync(
      path.join(dir, "scripts/control-plane-curl.sh"),
      path.join(runnerTemp, "control-plane-curl.sh"),
    );
    // Newer relay steps also run the queue request command that the job downloads.
    const requestCommand = path.join(dir, "src/repair/exact-review-queue-request.ts");
    if (existsSync(requestCommand)) {
      copyFileSync(requestCommand, path.join(runnerTemp, "exact-review-queue-request.mts"));
    }

    const entry = path.join(scratch, `${variant}-entry.ts`);
    writeFileSync(
      entry,
      `
import worker, { ExactReviewQueue } from ${JSON.stringify(path.join(dir, "dashboard/worker.ts"))};
// Read-only inspection route; executor dispatch alarms are out of scope.
export class ProofExactReviewQueue extends ExactReviewQueue {
  async alarm() {}
  async fetch(request) {
    if (new URL(request.url).pathname !== "/__proof/state") return super.fetch(request);
    const state = this.readStateSync();
    return Response.json({
      items: Object.values(state.items).map((item) => ({
        key: item.key,
        state: item.state,
        revision: item.revision,
        source_action: item.decision.sourceAction,
        ingress_fingerprint: Boolean(item.ingressFingerprint),
      })).sort((a, b) => a.key.localeCompare(b.key)),
      deliveries: Array.from(this.storage.sql.exec(
        "SELECT delivery_id FROM exact_review_queue_deliveries ORDER BY delivery_id",
      )).map((row) => row.delivery_id),
      ingress: Array.from(this.storage.sql.exec(
        "SELECT route, admitted_at FROM exact_review_queue_ingress ORDER BY route",
      )).map((row) => ({ route: row.route, admitted: Number(row.admitted_at) > 0 })),
    });
  }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__proof/state") {
      return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
    }
    return worker.fetch(request, env, ctx);
  },
};
`,
    );
    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
      logLevel: "silent",
    });
    const mf = new Miniflare({
      name: `direct-target-dispatch-${variant}`,
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        EXACT_REVIEW_QUEUE: { className: "ProofExactReviewQueue", useSQLite: true },
      },
      bindings: {
        ...wranglerVars(read("dashboard/wrangler.toml")),
        CLAWSWEEPER_WEBHOOK_SECRET: WEBHOOK_SECRET,
        CLAWSWEEPER_APP_PRIVATE_KEY: appKey,
        CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "10",
      },
      outboundService: { external: { address: egressAddress, http: {} } },
    });
    workerOrigin = String(await mf.ready);
    const queueState = async () => (await mf.dispatchFetch("http://proof/__proof/state")).json();
    const scenarios = {};
    try {
      for (const scenario of SCENARIOS) {
        ghDispatches = [];
        frontRecords = [];
        relayRecords = [];
        oidcMints = [];
        egress = { jwks: 0, executorDispatches: 0, unexpected: egress.unexpected };
        failVisibility = new Set(scenario.failVisibility ? [scenario.repo] : []);
        const headSha = createHash("sha1")
          .update(`${scenario.repo}#${scenario.number}`)
          .digest("hex");
        pullHeads.set(`${scenario.repo}#${scenario.number}`, headSha);
        const event =
          scenario.kind === "issue" ? issueEvent(scenario) : pullEvent({ ...scenario, headSha });
        const eventPath = path.join(scratch, `${variant}-${scenario.name}.json`);
        writeFileSync(eventPath, JSON.stringify(event));

        let appWebhook = null;
        if (scenario.appWebhookFirst) {
          const bodyText = JSON.stringify(event);
          const response = await mf.dispatchFetch(`https://${PRODUCTION_HOST}/github/webhook`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-github-delivery": randomUUID(),
              "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(bodyText).digest("hex")}`,
            },
            body: bodyText,
          });
          appWebhook = { status: response.status, body: await response.json() };
        }

        oidcContext = {
          repository: scenario.repo,
          eventName: scenario.kind === "issue" ? "issues" : "pull_request_target",
          ref: `refs/heads/${scenario.baseRef ?? "main"}`,
          runId: scenario.runId,
        };
        const step = await runScript("bash", dispatchStep.run, {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: scenario.workerUnreachable ? unreachableHome : reachableHome,
          TMPDIR: os.tmpdir(),
          GH_CONFIG_DIR: ghConfig,
          GH_HOST: "github.com",
          GH_TOKEN: "synthetic-clawsweeper-app-token",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GITHUB_EVENT_PATH: eventPath,
          TARGET_REPO: scenario.repo,
          TARGET_BRANCH: "main",
          ITEM_NUMBER: String(scenario.number),
          ITEM_KIND: scenario.kind,
          SOURCE_EVENT: scenario.kind === "issue" ? "issues" : "pull_request_target",
          SOURCE_ACTION: "opened",
          SUPERSEDES_IN_PROGRESS: "false",
          REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "",
          ...(dispatchStep.env?.TARGET_DISPATCH_URL
            ? { TARGET_DISPATCH_URL: dispatchStep.env.TARGET_DISPATCH_URL }
            : {}),
          ...(oidcGranted
            ? {
                ACTIONS_ID_TOKEN_REQUEST_URL: issuerUrl,
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
              }
            : {}),
        });
        assert.equal(step.status, 0, `${variant}/${scenario.name} dispatcher step failed`);
        const relayDispatches = ghDispatches.filter(
          (dispatch) =>
            dispatch.event_type === "clawsweeper_item" && !dispatch.client_payload?.queue_lease_id,
        );

        // Execute exactly the relay run each repository_dispatch would start.
        failVisibility = new Set();
        const relays = [];
        for (const dispatch of relayDispatches) {
          relayRunId += 1;
          const relay = await runScript(bash5, relayStep.run, {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            HOME: scratch,
            TMPDIR: os.tmpdir(),
            RUNNER_TEMP: runnerTemp,
            CLIENT_PAYLOAD: JSON.stringify(dispatch.client_payload, null, 2),
            QUEUE_URL: relayUrl,
            CLAWSWEEPER_WEBHOOK_SECRET: WEBHOOK_SECRET,
            GITHUB_RUN_ID: String(relayRunId),
            GITHUB_RUN_ATTEMPT: "1",
          });
          relays.push({ status: relay.status });
        }
        const state = await queueState();
        const itemKey = `${scenario.repo}#${scenario.number}`;
        scenarios[scenario.name] = {
          app_webhook: appWebhook,
          oidc_tokens_minted: oidcMints.length,
          oidc_audiences: [...new Set(oidcMints.map((mint) => mint.aud))],
          direct_requests: frontRecords.map((record) => ({
            status: record.status,
            body: record.body,
          })),
          direct_unreachable: Boolean(scenario.workerUnreachable && oidcMints.length),
          repository_dispatches: relayDispatches.length,
          relay_runs: relays.length,
          relay_run_exit_codes: relays.map((relay) => relay.status),
          relay_queue_responses: relayRecords.map((record) => ({
            status: record.status,
            body: record.body,
          })),
          jwks_fetches: egress.jwks,
          queue_item: state.items.find((item) => item.key === itemKey) ?? null,
          queue_deliveries: state.deliveries.filter(
            (delivery) => delivery.startsWith("target-dispatch:") || delivery.startsWith("legacy:"),
          ),
        };
      }
      scenarios.final_queue = await queueState();
    } finally {
      await mf.dispose();
    }
    receipt.variants[variant] = {
      ref,
      dispatch_job_id_token_write: oidcGranted,
      source_sha256: Object.fromEntries(
        FILES.filter((file) => existsSync(path.join(dir, file))).map((file) => [
          file,
          sha256(read(file)),
        ]),
      ),
      scenarios,
      totals: {
        repository_dispatches: SCENARIOS.reduce(
          (sum, scenario) => sum + scenarios[scenario.name].repository_dispatches,
          0,
        ),
        relay_runs: SCENARIOS.reduce(
          (sum, scenario) => sum + scenarios[scenario.name].relay_runs,
          0,
        ),
        queue_items: scenarios.final_queue.items.length,
      },
    };
  }
  assert.deepEqual(ghUnexpected, [], "unexpected gh fixture route");
  assert.deepEqual(egress.unexpected, [], "unexpected Worker egress route");

  const candidate = receipt.variants.candidate.scenarios;
  const baseline = receipt.variants.baseline.scenarios;
  const checks = {
    baseline_relays_every_event: SCENARIOS.every(
      (scenario) => baseline[scenario.name].repository_dispatches === 1,
    ),
    baseline_relay_after_app_webhook_is_cross_route_dedupe:
      baseline.app_webhook_first_then_dispatcher.relay_queue_responses[0]?.body?.dedupe_scope ===
      "cross_route",
    direct_pr_queued_without_dispatch:
      candidate.pr_opened.repository_dispatches === 0 &&
      candidate.pr_opened.direct_requests[0]?.status === 202 &&
      candidate.pr_opened.direct_requests[0]?.body?.queued === true &&
      candidate.pr_opened.queue_item !== null,
    replay_dedupes_without_dispatch:
      candidate.same_run_replayed.repository_dispatches === 0 &&
      candidate.same_run_replayed.direct_requests[0]?.body?.deduped === true,
    direct_issue_queued_without_dispatch:
      candidate.issue_opened.repository_dispatches === 0 &&
      candidate.issue_opened.direct_requests[0]?.body?.queued === true,
    app_webhook_counterpart_is_cross_route_dedupe:
      candidate.app_webhook_first_then_dispatcher.repository_dispatches === 0 &&
      candidate.app_webhook_first_then_dispatcher.direct_requests[0]?.body?.dedupe_scope ===
        "cross_route",
    forced_enqueue_failure_falls_back_and_relay_queues:
      candidate.forced_enqueue_failure_falls_back.direct_requests[0]?.status === 503 &&
      candidate.forced_enqueue_failure_falls_back.repository_dispatches === 1 &&
      candidate.forced_enqueue_failure_falls_back.relay_queue_responses.at(-1)?.body?.queued ===
        true,
    worker_unreachable_falls_back_and_relay_queues:
      candidate.worker_unreachable_falls_back.direct_requests.length === 0 &&
      candidate.worker_unreachable_falls_back.repository_dispatches === 1 &&
      candidate.worker_unreachable_falls_back.relay_queue_responses.at(-1)?.body?.queued === true,
    non_default_base_refused_and_relay_queues:
      candidate.non_default_base_falls_back.direct_requests[0]?.status === 403 &&
      candidate.non_default_base_falls_back.repository_dispatches === 1 &&
      candidate.non_default_base_falls_back.relay_queue_responses.at(-1)?.body?.queued === true,
    same_queue_items_in_both_variants:
      JSON.stringify(baseline.final_queue.items.map((item) => item.key)) ===
      JSON.stringify(candidate.final_queue.items.map((item) => item.key)),
  };
  receipt.checks = checks;
  receipt.pass = Object.values(checks).every(Boolean);
  receipt.limits =
    "Synthetic GitHub API, GitHub App credential, and Actions OIDC issuer/JWKS (real GitHub OIDC signing and claim shapes are not exercised); the dispatcher and relay step scripts run under local bash, not a GitHub Actions runner; curl reaches the local Worker under the production hostname via ~/.curlrc connect-to with a proof-only certificate; queue alarms (executor dispatch) are disabled; the PR acknowledgement step is not exercised. Production relay volume drops only after each target repository adopts the updated dispatcher; openclaw/openclaw's own dispatcher is not part of this repository.";
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        pass: receipt.pass,
        checks,
        totals: {
          baseline: receipt.variants.baseline.totals,
          candidate: receipt.variants.candidate.totals,
        },
      },
      null,
      2,
    ),
  );
  if (!receipt.pass) process.exitCode = 1;
} finally {
  for (const server of [ghServer, issuer, egressServer, front, relayFront]) {
    server.closeAllConnections?.();
    server.close();
  }
  rmSync(scratch, { recursive: true, force: true });
  rmSync(path.dirname(ghSocket), { recursive: true, force: true });
}
