#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = process.cwd();
const [mode, base, expected] = process.argv.slice(2);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
function sourceIdentity() {
  const files = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "dashboard",
    "scripts",
    "config",
    ".github",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig*.json",
    "schemas",
    "schema",
    "prompts",
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const manifest = files.map((file) => [
    file,
    existsSync(file) ? digest(readFileSync(file)) : "deleted",
  ]);
  return {
    baseCommit: git("rev-parse", "HEAD"),
    baseTree: git("rev-parse", "HEAD^{tree}"),
    candidateSourceSha256: digest(JSON.stringify(manifest)),
    manifest,
  };
}
const identity = sourceIdentity();
if (mode === "source-id") {
  console.log(identity.candidateSourceSha256);
  process.exit(0);
}
assert.match(base || "", /^[0-9a-f]{40}$/);
assert.equal(git("cat-file", "-t", base), "commit");
assert.equal(identity.baseCommit, base, "base commit differs from checkout HEAD");
assert.equal(identity.candidateSourceSha256, expected, "candidate source manifest differs");
if (mode === "verify-source") {
  console.log(JSON.stringify(identity));
  process.exit(0);
}
assert.equal(mode, "run");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
const wrangler = process.env.MANUAL_PUBLICATION_WRANGLER;
const githubCli = process.env.MANUAL_PUBLICATION_GH;
assert.ok(
  githubCli?.startsWith("/"),
  "absolute path to stock GitHub CLI required (no credential wrappers)",
);
for (const name of ["PROVIDER", "LEASE", "IMAGE"])
  assert.ok(process.env[`MANUAL_PUBLICATION_${name}`], `${name} is required`);
assert.ok(wrangler?.startsWith("/"), "installed Wrangler path required");
assert.match(execFileSync(wrangler, ["--version"], { encoding: "utf8" }), /4\.107\.0/);
const output = resolve(
  process.env.MANUAL_PUBLICATION_OUTPUT || ".artifacts/manual-review-publication",
);
const classification =
  process.env.MANUAL_PUBLICATION_PROVIDER === "local-smoke"
    ? "LOCAL SMOKE ONLY — NOT AWS; not final live proof"
    : "isolated provider proof; not production";
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, "runtime-"));
const socketRoot = mkdtempSync(join(tmpdir(), "manual-publication-socket-"));
const secret = "synthetic-manual-publication-hmac";
const repo = "openclaw/openclaw";
const producerRepo = "openclaw/clawsweeper";
const trace = [];
const commands = [];
const dispatches = [];
const bundles = new Map();
const reviewCounts = new Map();
const requestReviewCounts = new Map();
const children = new Set();
const observations = [];
let workerLog = "";
let failure;
let workerError;
let interrupted;
const redact = (value) =>
  String(value)
    .replace(
      /env\.CLAWSWEEPER_APP_PRIVATE_KEY[\s\S]*?Environment Variable[^\n]*/g,
      "env.CLAWSWEEPER_APP_PRIVATE_KEY [synthetic key omitted]",
    )
    .replace(
      /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,
      "[synthetic key omitted]",
    )
    .replace(
      /synthetic-(?:app-token|only-token|manual-publication-hmac)/g,
      "[synthetic credential omitted]",
    )
    .replace(/\bgpt-[a-zA-Z0-9_.-]+\b/g, "Codex");
const items = new Map(
  [71, 72, 73, 74, 75, 76, 99].map((number) => [
    number,
    {
      number,
      title: `Synthetic manual publication ${number}`,
      body: "A bounded synthetic existing-behavior bug.",
      html_url: `https://github.com/${repo}/issues/${number}`,
      state: "open",
      locked: false,
      user: { login: "fixture-author" },
      author_association: "CONTRIBUTOR",
      labels: [{ name: "bug" }],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      comments: 0,
      pull_request: null,
    },
  ]),
);
const comments = new Map([...items.keys()].map((number) => [number, []]));
const pulls = new Map(
  [73, 76].map((number) => {
    items.get(number).pull_request = {
      url: `https://api.github.com/repos/${repo}/pulls/${number}`,
    };
    items.get(number).html_url = `https://github.com/${repo}/pull/${number}`;
    return [
      number,
      {
        ...items.get(number),
        draft: false,
        merged: false,
        merged_at: null,
        mergeable: true,
        mergeable_state: "clean",
        head: {
          sha: (number === 73 ? "a" : "d").repeat(40),
          ref: `fixture-${number}`,
          repo: { full_name: repo },
        },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: repo } },
      },
    ];
  }),
);
const pull = pulls.get(73);
const commentWrites = () =>
  trace.filter(
    (entry) =>
      entry.body &&
      ["POST", "PATCH", "DELETE"].includes(entry.method) &&
      /\/comments(?:\/|$)/.test(entry.path),
  ).length;
let nextComment = 100;
let commentFailure = 71;
let lostAcknowledgement = 0;
let workerPort;
let worker;
const interrupt = (signal) => {
  interrupted = signal;
  for (const child of [...children, ...(worker ? [worker] : [])]) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
};
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
let canonicalFailure = false;
let authorityOutage = null;
let initialDispatchOutage = true;
let initialDispatchFailures = 0;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const url = new URL(req.url, "http://fixture");
    const path = url.pathname.replace(/^\/api\/v3/, "");
    const send = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let body = {};
    if (bytes.length) {
      try {
        body = JSON.parse(bytes);
      } catch {
        body = { binarySha256: digest(bytes) };
      }
    }
    trace.push({
      method: req.method,
      path,
      body: body.decision
        ? { decision: body.decision }
        : body.body
          ? { commentBodySha256: digest(body.body) }
          : body,
    });
    if (path.startsWith("/queue/")) {
      if (authorityOutage && path.endsWith("/publication-authority")) {
        if (authorityOutage.allowedChecks > 0) authorityOutage.allowedChecks--;
        else {
          authorityOutage.rejectedChecks++;
          return send({ error: "synthetic_authority_unavailable" }, 503);
        }
      }
      if (canonicalFailure && /publication-(?:batch-)?results$/.test(path))
        return send({ error: "synthetic_state_contention" }, 503);
      const response = await fetch(`http://127.0.0.1:${workerPort}${path.slice(6)}${url.search}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            ([key]) => !["host", "connection", "content-length", "transfer-encoding"].includes(key),
          ),
        ),
        ...(bytes.length ? { body: bytes } : {}),
      });
      const responseBytes = Buffer.from(await response.arrayBuffer());
      trace.push({
        method: req.method,
        path,
        status: response.status,
        response: responseBytes.toString("utf8"),
      });
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") || "application/json",
      });
      res.end(responseBytes);
      return;
    }
    const target = path.match(/\/(?:issues|pulls)\/(\d+)(?:\/|$)/);
    if (path === "/api/graphql" && req.method === "POST") {
      const query = String(body.query).replace(/\s+/g, " ").trim();
      if (query.startsWith("query ReviewedPrActivityCursorV2")) {
        const number = Number(query.match(/pr_(\d+): pullRequest/)?.[1]);
        assert.ok(pulls.has(number), "unselected PR activity query");
        assert.equal(
          query.replaceAll(`pr_${number}`, "pr_73").replaceAll(`number: ${number}`, "number: 73"),
          'query ReviewedPrActivityCursorV2 { repository(owner: "openclaw", name: "openclaw") { pr_73: pullRequest(number: 73) { reviews(first: 100) { totalCount pageInfo { hasNextPage } nodes { fullDatabaseId author { login } state body submittedAt commit { oid } } } reviewThreads(first: 100) { totalCount pageInfo { hasNextPage } nodes { id isResolved comments(first: 100) { totalCount pageInfo { hasNextPage } nodes { fullDatabaseId pullRequestReview { fullDatabaseId } replyTo { fullDatabaseId } author { login } body createdAt updatedAt path line startLine originalLine originalCommit { oid } commit { oid } } } } } } } }',
        );
        trace.at(-1).readOnlyGraphql = true;
        const emptyConnection = { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] };
        return send({
          data: {
            repository: {
              [`pr_${number}`]: {
                reviews: emptyConnection,
                reviewThreads: emptyConnection,
              },
            },
          },
        });
      }
      assert.equal(
        query,
        "query IssueByNumber($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { hasIssuesEnabled issue: issueOrPullRequest(number: $number) { __typename ...on Issue{closedByPullRequestsReferences(first: 100) {nodes {id,number,url,repository {id,name,owner {id,login}}}pageInfo{hasNextPage,endCursor}},id} ...on PullRequest{id} } } }",
      );
      assert.equal(`${body.variables.owner}/${body.variables.repo}`, repo);
      const number = body.variables.number;
      assert.ok(items.has(number) && number !== 99, "unselected GraphQL item");
      trace.at(-1).readOnlyGraphql = true;
      return send({
        data: {
          repository: {
            hasIssuesEnabled: true,
            issue: pulls.has(number)
              ? { __typename: "PullRequest", id: `PR_fixture${number}` }
              : {
                  __typename: "Issue",
                  id: `I_fixture${number}`,
                  closedByPullRequestsReferences: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
          },
        },
      });
    }
    if (path === "/registry" && req.method === "GET")
      return send({ schema_version: 2, repositories: [{ target_repo: repo }] });
    if (target && Number(target[1]) === 99) throw new Error("unselected sibling was accessed");
    if (path === `/repos/${producerRepo}/dispatches` && req.method === "POST") {
      assert.equal(body.event_type, "clawsweeper_item");
      assert.ok([71, 72, 73, 74, 75, 76].includes(body.client_payload.item_number));
      if (initialDispatchOutage) {
        initialDispatchFailures++;
        return send({ message: "synthetic dispatch outage" }, 503);
      }
      dispatches.push(body.client_payload);
      return send({}, 204);
    }
    if (path.endsWith("/installation") && req.method === "GET") return send({ id: 999 });
    if (path === "/app/installations/999/access_tokens" && req.method === "POST")
      return send({
        token: "synthetic-app-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if ((path === `/repos/${repo}` || path === `/repos/${producerRepo}`) && req.method === "GET")
      return send({
        full_name: path.slice("/repos/".length),
        private: false,
        visibility: "public",
        default_branch: "main",
      });
    if (path.endsWith("/actions/workflows/sweep.yml") && req.method === "GET")
      return send({ state: "active" });
    if (
      path.endsWith("/actions/workflows/exact-review-batch-publish.yml/dispatches") &&
      req.method === "POST"
    )
      return send({}, 204);
    const run = path.match(/\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/);
    if (run && req.method === "GET")
      return send({
        id: Number(run[1]),
        run_attempt: 1,
        status: "in_progress",
        head_sha: base,
        repository: { full_name: repo },
      });
    const artifacts = path.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (artifacts && req.method === "GET")
      return send({
        artifacts: bundles.has(artifacts[1])
          ? [
              {
                id: Number(artifacts[1]),
                name: `exact-review-${artifacts[1]}-1`,
                expired: false,
                size_in_bytes: bundles.get(artifacts[1])?.length || 0,
                archive_download_url: `https://proof.invalid/api/v3/repos/${producerRepo}/actions/artifacts/${artifacts[1]}/zip`,
              },
            ]
          : [],
      });
    const archive = path.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (archive && req.method === "GET") {
      const zip = bundles.get(archive[1]);
      if (!zip) return send({ message: "artifact absent" }, 404);
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(zip);
      return;
    }
    const item = path.match(new RegExp(`^/repos/${repo}/issues/(\\d+)$`));
    if (item && req.method === "GET") return send(items.get(Number(item[1])));
    const requestedPull = target && pulls.get(Number(target[1]));
    if (
      requestedPull &&
      path === `/repos/${repo}/pulls/${requestedPull.number}` &&
      req.method === "GET"
    )
      return send(requestedPull);
    if (
      requestedPull &&
      ["reviews", "files", "commits", "comments"].some(
        (kind) => path === `/repos/${repo}/pulls/${requestedPull.number}/${kind}`,
      ) &&
      req.method === "GET"
    )
      return send([]);
    const commit = path.match(
      new RegExp(`^/repos/${repo}/commits/([a-f0-9]{40})/(check-runs|status)$`),
    );
    const knownHead = commit && [...pulls.values()].some((entry) => entry.head.sha === commit[1]);
    if (knownHead && commit[2] === "check-runs" && req.method === "GET")
      return send({ total_count: 0, check_runs: [] });
    if (knownHead && commit[2] === "status" && req.method === "GET")
      return send({ state: "pending", sha: commit[1], total_count: 0, statuses: [] });
    const list = path.match(new RegExp(`^/repos/${repo}/issues/(\\d+)/comments$`));
    const comment = path.match(new RegExp(`^/repos/${repo}/issues/comments/(\\d+)$`));
    if (list && req.method === "GET") return send(comments.get(Number(list[1])));
    if ((list && req.method === "POST") || (comment && req.method === "PATCH")) {
      const number = list
        ? Number(list[1])
        : [...comments].find(([, entries]) =>
            entries.some((entry) => entry.id === Number(comment[1])),
          )?.[0];
      assert.ok(number && number !== 99);
      const completed = body.body.includes("clawsweeper-review-version");
      if (completed && commentFailure === number)
        return send({ message: "synthetic transient failure" }, 503);
      let entry = comment
        ? comments.get(number).find((entry) => entry.id === Number(comment[1]))
        : null;
      if (!entry) {
        entry = {
          id: nextComment++,
          user: { login: "clawsweeper[bot]", type: "Bot" },
          created_at: new Date().toISOString(),
          issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
        };
        comments.get(number).push(entry);
      }
      Object.assign(entry, {
        body: body.body,
        updated_at: new Date().toISOString(),
        html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${entry.id}`,
      });
      if (completed && lostAcknowledgement === number) {
        lostAcknowledgement = 0;
        return send({});
      }
      return send(entry, list ? 201 : 200);
    }
    if (comment && req.method === "GET")
      return send([...comments.values()].flat().find((entry) => entry.id === Number(comment[1])));
    if (comment && req.method === "DELETE") {
      for (const [number, entries] of comments)
        comments.set(
          number,
          entries.filter((entry) => entry.id !== Number(comment[1])),
        );
      return send({}, 204);
    }
    if (req.method !== "GET")
      throw new Error(`forbidden synthetic upstream effect: ${req.method} ${path}`);
    if (path.endsWith("/timeline")) return send([]);
    if (path === "/search/issues") return send({ items: [], total_count: 0 });
    if (path === "/rate_limit")
      return send({
        resources: { core: { remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } },
      });
    throw new Error(`unsupported synthetic upstream read: ${path}`);
  } catch (error) {
    trace.push({ forbidden: error.message, cause: error.cause?.message });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ message: error.message }));
  }
});
const unix = createServer((req, res) => server.emit("request", req, res));
let baseUrl;
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function waitUntil(deadline, label) {
  while (Date.now() < deadline) {
    assert.ok(!interrupted, `proof interrupted by ${interrupted}`);
    console.log(`proof waiting: ${label}`);
    await wait(Math.min(15000, deadline - Date.now()));
  }
}
async function command(name, args, env = {}, cwd = source, allowFailure = false) {
  assert.ok(!interrupted, `proof interrupted by ${interrupted}`);
  console.log(`proof command: ${[name, ...args].join(" ")}`);
  const child = spawn(name, args, {
    cwd,
    env: { ...runtimeEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  const timeout = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }, 180000);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      children.delete(child);
      reject(error);
    });
    child.once("close", resolveExit);
  });
  children.delete(child);
  clearTimeout(timeout);
  commands.push({ command: [name, ...args], code, stdout, stderr });
  if (!allowFailure) assert.equal(code, 0, stderr + stdout);
  return { code, stdout, stderr };
}
async function post(route, body) {
  const text = JSON.stringify(body);
  const response = await fetch(`${baseUrl}/queue/internal/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
    },
    body: text,
  });
  const value = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(value)}`);
  return value;
}
let runtimeEnv;
try {
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const socket = join(socketRoot, "gh.sock");
  await new Promise((ready) => unix.listen(socket, ready));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(githubCli, join(bin, "gh"));
  const transport = join(source, "scripts/e2e/manual-review-publication-transport.mjs");
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
args=()
for arg in "$@"; do
  if [[ "$arg" == --data ]]; then arg=--data-binary; fi
  args+=("$arg")
done
exec '${process.execPath}' '${transport}' curl "\${args[@]}"
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  runtimeEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    CI: "true",
    TMPDIR: root,
    GH_CONFIG_DIR: join(root, "gh-config"),
    GH_HOST: "proof.invalid",
    GH_ENTERPRISE_TOKEN: "synthetic-only-token",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    NODE_OPTIONS: `--import=${transport}`,
    MANUAL_PUBLICATION_LOOPBACK: baseUrl,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE_URL: "https://manual-queue.invalid",
    QUEUE_URL: "https://manual-queue.invalid",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
    CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
    GH_TOKEN: "synthetic-only-token",
    REPO_TOKEN: "synthetic-only-token",
    GITHUB_REPOSITORY: producerRepo,
    GITHUB_SHA: base,
    GITHUB_RUN_ATTEMPT: "1",
    CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES: "1",
    EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
  };
  await command("gh", ["config", "set", "http_unix_socket", socket]);
  const githubProbe = await command("gh", ["api", `repos/${repo}/issues/71`]);
  assert.equal(
    JSON.parse(githubProbe.stdout).title,
    items.get(71).title,
    "GitHub CLI must read the isolated fixture before any admission",
  );
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const entry = readFileSync(
    join(source, "scripts/e2e/manual-review-publication-worker.ts"),
    "utf8",
  )
    .replace('"../../dashboard/worker.ts"', JSON.stringify(join(source, "dashboard/worker.ts")))
    .replace("MANUAL_PUBLICATION_SYNTHETIC_UPSTREAM", baseUrl);
  writeFileSync(join(root, "worker.ts"), entry);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), "{}");
  const probe = createServer();
  await new Promise((ready) => probe.listen(0, "127.0.0.1", ready));
  workerPort = probe.address().port;
  await new Promise((done) => probe.close(done));
  writeFileSync(
    join(root, "wrangler.json"),
    JSON.stringify({
      name: "manual-publication-isolated-proof",
      main: "worker.ts",
      compatibility_date: "2026-05-11",
      durable_objects: {
        bindings: [
          { name: "EXACT_REVIEW_QUEUE", class_name: "ExactReviewQueue" },
          { name: "STATUS_STORE", class_name: "StatusStore" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ExactReviewQueue", "StatusStore"] }],
      r2_buckets: [{ binding: "STATE_SNAPSHOTS", bucket_name: "synthetic-manual-publication" }],
      vars: {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_OPERATOR_SECRET: secret,
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23synthetic",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_REPO: producerRepo,
        EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
        EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "8",
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "8",
        EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "300000",
        EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
        PUBLIC_BAY_REPOS: repo,
      },
    }),
  );
  worker = spawn(
    wrangler,
    [
      "dev",
      "--config",
      join(root, "wrangler.json"),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--persist-to",
      join(root, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: root,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
        WRANGLER_LOG: "info",
        XDG_CONFIG_HOME: join(root, "xdg"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const logWorker = (chunk) => {
    workerLog += chunk;
    writeFileSync(join(output, "wrangler.log"), redact(workerLog));
  };
  worker.stdout.on("data", logWorker);
  worker.stderr.on("data", logWorker);
  worker.once("error", (error) => {
    workerError = error;
  });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    assert.ok(!interrupted, `proof interrupted by ${interrupted}`);
    assert.equal(workerError, undefined);
    if (i % 15 === 0) console.log(`proof waiting for isolated Wrangler (${i}s)`);
    if (
      await fetch(`http://127.0.0.1:${workerPort}/api/health`)
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    assert.equal(worker.exitCode, null, redact(workerLog));
    await wait(1000);
  }
  assert.ok(ready, redact(workerLog));
  const { default: YAML } = await import("yaml");
  const sweep = YAML.parse(readFileSync(join(source, ".github/workflows/sweep.yml"), "utf8"));
  const admissionStep = sweep.jobs.plan.steps.find(
    (step) => step.name === "Admit explicit manual reviews",
  );
  const directStep = Object.values(sweep.jobs)
    .flatMap((job) => job.steps || [])
    .find((step) => step.name === "Deliver GitHub effects and prepare direct state mutation");
  assert.equal(admissionStep.env.TARGET_BRANCH, "${{ steps.target.outputs.target_branch }}");
  const publicationArtifactDir = directStep.env.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR;
  assert.equal(publicationArtifactDir, ".artifacts/exact-review-bundle/review");
  const selectedBranch = "release/proof";
  const selectedTimeoutMs = 2_400_000;
  const selectedPrompt = "-- Inspect only the selected behavior.\nKeep publication restricted.";
  const admissionWork = join(root, "manual-admission");
  mkdirSync(join(admissionWork, ".artifacts"), { recursive: true });
  cpSync(join(source, "dist"), join(admissionWork, "dist"), { recursive: true });
  for (const name of ["config", "node_modules"])
    symlinkSync(join(source, name), join(admissionWork, name));
  const admissionEnv = {
    TARGET_REPO: repo,
    TARGET_BRANCH: selectedBranch,
    CODEX_TIMEOUT_MS: String(selectedTimeoutMs),
    ADDITIONAL_PROMPT: selectedPrompt,
    ITEM_NUMBER: "71",
    ITEM_NUMBERS: "72",
    GITHUB_RUN_ID: "1000",
  };
  const admission = await command("bash", ["-c", admissionStep.run], admissionEnv, admissionWork);
  assert.equal(JSON.parse(admission.stdout).accepted, 2);
  await command("bash", ["-c", admissionStep.run], admissionEnv, admissionWork);
  let beforeCoalescing;
  for (let i = 0; i < 60; i++) {
    beforeCoalescing = await fetch(`${baseUrl}/queue/api/exact-review-queue`).then((r) => r.json());
    if (
      initialDispatchFailures > 0 &&
      beforeCoalescing.lanes.review.pending === 2 &&
      beforeCoalescing.lanes.review.dispatching === 0
    )
      break;
    await wait(250);
  }
  assert.ok(initialDispatchFailures > 0);
  assert.equal(beforeCoalescing.lanes.review.pending, 2);
  assert.equal(beforeCoalescing.lanes.review.dispatching, 0);
  assert.equal(
    dispatches.length,
    0,
    "ordinary refresh must arrive while manual reviews are pending",
  );
  const coalescedSourceUpdatedAt = new Date().toISOString();
  items.get(71).body = "Updated synthetic issue facts before the selected manual review.";
  items.get(71).updated_at = coalescedSourceUpdatedAt;
  await post("exact-review/enqueue", {
    delivery_id: "ordinary-refresh-during-manual-review",
    decision: {
      targetRepo: repo,
      targetBranch: "main",
      itemNumber: 71,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "edited",
      codexTimeoutMs: 600_000,
      additionalPrompt: "Ordinary event instructions must not replace the manual request.",
      sourceUpdatedAt: coalescedSourceUpdatedAt,
      supersedesInProgress: false,
    },
  });
  initialDispatchOutage = false;
  for (let i = 0; i < 120 && dispatches.length < 2; i++) await wait(1000);
  assert.equal(dispatches.length, 2, workerLog);
  const records = [];
  const extraRecords = [];
  async function admit(number, requestId = `extra-${number}`) {
    const previous = dispatches.filter((entry) => entry.item_number === number).length;
    await command(process.execPath, [
      join(source, "dist/repair/manual-review-enqueue.js"),
      "--target-repo",
      repo,
      "--target-branch",
      "main",
      "--item-numbers",
      String(number),
      "--request-id",
      requestId,
      "--codex-timeout-ms",
      "1200000",
      "--queue-url",
      "https://manual-queue.invalid",
    ]);
    for (
      let i = 0;
      i < 60 && dispatches.filter((entry) => entry.item_number === number).length === previous;
      i++
    )
      await wait(1000);
    const matching = dispatches.filter((entry) => entry.item_number === number);
    assert.equal(
      matching.length,
      previous + 1,
      "new request must receive an actual coordinator dispatch",
    );
    return matching.at(-1);
  }
  const { itemSourceRevisionSha256ForTest } = await import(
    pathToFileURL(join(source, "dist/clawsweeper.js"))
  );
  async function reviewedRecord(number, repeatRunId) {
    const dispatch = dispatches.findLast((d) => d.item_number === number);
    assert.ok(dispatch);
    const runId = repeatRunId || String(1000 + number);
    const tuple = {
      item_key: dispatch.queue_claim.item_key,
      lease_id: dispatch.queue_lease_id,
      lease_revision: dispatch.queue_claim.lease_revision,
      run_id: runId,
      run_attempt: 1,
    };
    const claim = await post("exact-review/claim", tuple);
    assert.equal(claim.claimed, true);
    tuple.claim_generation = claim.claim_generation;
    const claimDecision = claim.decision;
    assert.equal(claimDecision.publicationPolicy, "record_comment_only");
    if ([71, 72].includes(number) && !repeatRunId) {
      assert.equal(claimDecision.targetBranch, selectedBranch);
      assert.equal(claimDecision.codexTimeoutMs, selectedTimeoutMs);
      assert.equal(claimDecision.additionalPrompt, selectedPrompt);
      const targetOutput = join(output, `manual-target-${number}.txt`);
      const targetStep = sweep.jobs["event-review-apply"].steps.find(
        (step) => step.id === "target",
      );
      await command("bash", ["-c", targetStep.run], {
        CLAIM_DECISION: JSON.stringify(claimDecision),
        CONFIGURED_CODEX_TIMEOUT_MS: "1200000",
        GITHUB_OUTPUT: targetOutput,
      });
      assert.match(readFileSync(targetOutput, "utf8"), /^codex_timeout_ms=2400000$/m);
      observations.push({
        scenario: "manual workflow preserves the selected non-default branch",
        number,
        requestedBranch: selectedBranch,
        claimedBranch: claimDecision.targetBranch,
        codexTimeoutMs: claimDecision.codexTimeoutMs,
        additionalPromptSha256: digest(claimDecision.additionalPrompt),
      });
    }
    if (number === 71) {
      assert.equal(claimDecision.sourceUpdatedAt, coalescedSourceUpdatedAt);
      assert.ok(tuple.lease_revision > 1);
      observations.push({
        scenario: "ordinary refresh preserves pending manual branch and updates source facts",
        targetBranch: claimDecision.targetBranch,
        sourceUpdatedAt: claimDecision.sourceUpdatedAt,
        revision: tuple.lease_revision,
        initialDispatchFailures,
      });
    }
    const work = join(root, repeatRunId ? `${number}-${runId}` : String(number));
    mkdirSync(join(work, "artifacts/event"), { recursive: true });
    const env = {
      GITHUB_RUN_ID: runId,
      EXACT_REVIEW_ITEM_KEY: tuple.item_key,
      EXACT_REVIEW_LEASE_ID: tuple.lease_id,
      EXACT_REVIEW_LEASE_REVISION: String(tuple.lease_revision),
      EXACT_REVIEW_CLAIM_GENERATION: String(tuple.claim_generation),
      EXACT_REVIEW_DECISION: JSON.stringify(claimDecision),
      TARGET_REPO: repo,
      ITEM_NUMBER: String(number),
      EXACT_REVIEW_WORK_ROOT: work,
      CLAWSWEEPER_CODE_ROOT: source,
      EXACT_EVENT_PUBLICATION: "true",
      EXACT_REVIEW_BATCH_ITEM_KEY: tuple.item_key,
      EXACT_REVIEW_BATCH_REVISION: String(tuple.lease_revision),
      EXACT_REVIEW_BATCH_CLAIM_GENERATION: String(tuple.claim_generation),
      EXACT_REVIEW_BATCH_MUTATION_OUTPUT: join(work, "direct.json"),
    };
    const reserved = await command(
      process.execPath,
      [
        join(source, "dist/clawsweeper.js"),
        "reserve-review-lease",
        "--target-repo",
        repo,
        "--item-number",
        String(number),
        "--review-timeout-ms",
        "60000",
      ],
      env,
      work,
    );
    const lease = JSON.parse(reserved.stdout.trim());
    assert.equal(lease.status, "posted");
    const reviewedAt = new Date().toISOString();
    const sourceRevision = itemSourceRevisionSha256ForTest(items.get(number), comments.get(number));
    let reviewActivityCursor;
    if (number === 76) {
      const { reviewedPrActivityCursorV2Query, reviewedPrActivityCursorsV2FromGraphql } =
        await import(pathToFileURL(join(source, "dist/review-activity-cursor.js")));
      const [owner, name] = repo.split("/");
      for (let read = 0; read < 2; read++) {
        const activity = await command(
          "gh",
          [
            "api",
            "graphql",
            "-f",
            `query=${reviewedPrActivityCursorV2Query(owner, name, [number])}`,
          ],
          env,
          work,
        );
        const parsed = reviewedPrActivityCursorsV2FromGraphql(JSON.parse(activity.stdout), [
          number,
        ]);
        assert.deepEqual(parsed.failures, {});
        const cursor = parsed.cursors[String(number)];
        assert.ok(cursor, "the synthetic PR requires actual bounded review-activity context");
        if (read > 0) assert.equal(cursor, reviewActivityCursor);
        reviewActivityCursor = cursor;
      }
    }
    const fields = {
      number,
      repository: repo,
      type: claimDecision.itemKind,
      title: items.get(number).title,
      reviewed_at: reviewedAt,
      item_updated_at: items.get(number).updated_at,
      state_at_review: "open",
      review_status: "complete",
      local_checkout_access: "verified",
      local_checkout_access_source: "runner_preflight_v1",
      decision: "keep_open",
      close_reason: "none",
      action_taken: "kept_open",
      confidence: "high",
      triage_priority: "P2",
      labels: '["bug"]',
      item_source_revision: sourceRevision,
      ...(reviewActivityCursor ? { review_activity_cursor: reviewActivityCursor } : {}),
      item_snapshot_hash: "synthetic-reviewed-snapshot",
      ...(claimDecision.itemKind === "pull_request"
        ? { pull_head_sha: pulls.get(number).head.sha }
        : {}),
      review_lease_owner: lease.owner,
      review_lease_comment_id: lease.commentId,
      publication_policy: "record_comment_only",
      work_candidate: "queue_fix_pr",
      work_confidence: "high",
      work_validation: '["pnpm run check"]',
      work_likely_files: '["src/clawsweeper.ts"]',
      work_cluster_refs: `["${repo}#99"]`,
      item_category: "bug",
      reproduction_status: "reproduced",
      reproduction_confidence: "high",
      requires_new_feature: "false",
      requires_new_config_option: "false",
      requires_product_decision: "false",
    };
    const report = `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(
        "\n",
      )}\n---\n\n## Summary\n\nSynthetic reviewed existing-behavior bug.\n\n## Repair Work Prompt\n\nImplement the focused fix.\n`;
    reviewCounts.set(number, (reviewCounts.get(number) || 0) + 1);
    requestReviewCounts.set(runId, (requestReviewCounts.get(runId) || 0) + 1);
    const reportPath = join(work, `artifacts/event/${number}.md`);
    writeFileSync(reportPath, report);
    writeFileSync(
      join(work, "artifacts/event/review-cache-metrics.json"),
      JSON.stringify({ structural_cache_hits: 0, content_cache_hits: 0 }),
    );
    writeFileSync(
      join(work, "artifacts/event/selection.json"),
      JSON.stringify({ selected: [number] }),
    );
    for (const directory of ["codex", "review-trees"]) {
      mkdirSync(join(work, "artifacts/event", directory));
      writeFileSync(
        join(work, "artifacts/event", directory, "synthetic.txt"),
        "producer diagnostic\n",
      );
    }
    if (number === 71) writeFileSync(join(work, "artifacts/event/99.md"), "Unselected report\n");
    writeFileSync(
      join(output, repeatRunId ? `review-${number}-${runId}.md` : `review-${number}.md`),
      report,
    );
    if (number === 71) {
      for (const [scenario, content] of [
        [
          "unknown report policy",
          report.replace("publication_policy: record_comment_only", "publication_policy: unknown"),
        ],
        [
          "ambiguous report policy",
          report.replace(
            "publication_policy: record_comment_only",
            "publication_policy: record_comment_only\npublication_policy: record_comment_only",
          ),
        ],
        [
          "missing manual provenance",
          report.replace("publication_policy: record_comment_only\n", ""),
        ],
      ]) {
        const writesBefore = commentWrites();
        writeFileSync(reportPath, content);
        const rejected = await command(
          process.execPath,
          [join(source, "dist/repair/publish-event-result.js")],
          env,
          work,
          true,
        );
        assert.equal(rejected.code, 1, scenario);
        assert.match(rejected.stderr, /publication policy/, scenario);
        assert.equal(commentWrites(), writesBefore, scenario);
        observations.push({ scenario, rejected: true, commentWrites: 0 });
      }
      writeFileSync(reportPath, report);
      const writesBefore = commentWrites();
      const rawRejected = await command(
        process.execPath,
        [join(source, "dist/repair/publish-event-result.js")],
        env,
        work,
        true,
      );
      assert.equal(rawRejected.code, 1);
      assert.match(rawRejected.stderr, /artifact directory must contain only the selected report/);
      assert.equal(commentWrites(), writesBefore);
      observations.push({ scenario: "raw producer inventory remains rejected", commentWrites: 0 });
    }
    const bundleDir = join(work, ".artifacts/exact-review-bundle");
    await command(
      process.execPath,
      [join(source, "dist/repair/exact-review-bundle-cli.js"), "create"],
      {
        ...env,
        EXACT_REVIEW_BUNDLE_DIR: bundleDir,
        EXACT_REVIEW_REPORT_PATH: reportPath,
        EXACT_REVIEW_GENERATION_ATTEMPT: "1",
        EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
        EXACT_REVIEW_PROTOCOL_VERSION: "2",
        EXACT_REVIEW_TARGET_REPO: repo,
        EXACT_REVIEW_TARGET_BRANCH: claimDecision.targetBranch,
        EXACT_REVIEW_ITEM_NUMBER: String(number),
        EXACT_REVIEW_ITEM_KIND: claimDecision.itemKind,
        EXACT_REVIEW_LIVE_PROCEEDED: "true",
        EXACT_REVIEW_LIVE_TERMINAL_NOOP: "false",
        EXACT_REVIEW_LIVE_TERMINAL_MISSING: "false",
        EXACT_REVIEW_LIVE_GUARDED_OPEN: "false",
      },
    );
    const zip = join(work, "bundle.zip");
    execFileSync("python3", [
      "-c",
      "import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file(): z.write(p,p.relative_to(r))",
      bundleDir,
      zip,
    ]);
    bundles.set(runId, readFileSync(zip));
    assert.deepEqual(readdirSync(join(bundleDir, "review")), [`${number}.md`]);
    env.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR = publicationArtifactDir;
    return {
      number,
      runId,
      tuple,
      bundleDir,
      bundleManifestSha256: digest(readFileSync(join(bundleDir, "manifest.json"))),
      env,
      work,
      report,
      reportPath,
      reviewedAt,
      sourceRevision,
      claimDecision,
      lease,
    };
  }
  for (const number of [71, 72]) {
    const record = await reviewedRecord(number);
    const { env, work, tuple, claimDecision } = record;
    if (number === 71) {
      for (const [name, create] of [
        ["99.md", (path) => writeFileSync(path, "Unselected report\n")],
        ["diagnostics", (path) => mkdirSync(path)],
        ["linked.md", (path) => symlinkSync(record.reportPath, path)],
      ]) {
        const unexpected = join(work, publicationArtifactDir, name);
        const writesBefore = commentWrites();
        create(unexpected);
        const rejected = await command("bash", ["-c", directStep.run], env, source, true);
        assert.equal(rejected.code, 1);
        assert.match(
          rejected.stderr + rejected.stdout,
          /artifact directory must contain only the selected report/,
        );
        assert.equal(commentWrites(), writesBefore);
        rmSync(unexpected, { recursive: true });
        observations.push({ scenario: `staged publication rejects ${name}`, commentWrites: 0 });
      }
      for (const allowedChecks of [0, 1, 2]) {
        const outage = { allowedChecks, rejectedChecks: 0 };
        const writesBefore = commentWrites();
        const githubOutput = join(work, `authority-outage-${allowedChecks}.output`);
        authorityOutage = outage;
        const unavailable = await command(
          "bash",
          ["-c", directStep.run],
          { ...env, GITHUB_OUTPUT: githubOutput },
          source,
          true,
        );
        authorityOutage = null;
        assert.equal(unavailable.code, 1, unavailable.stderr + unavailable.stdout);
        const outcome = JSON.parse(readFileSync(env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8"));
        assert.equal(outcome.kind, "retryable_failure");
        assert.equal(outcome.reasonCode, "state_contention");
        assert.equal(Object.hasOwn(outcome, "rateLimitScope"), false);
        assert.match(readFileSync(githubOutput, "utf8"), /^reason_code=state_contention$/m);
        const guardedCleanup = allowedChecks === 2;
        if (guardedCleanup)
          assert.match(unavailable.stderr, /could not delete owned review lease comment/);
        assert.equal(
          outage.rejectedChecks,
          guardedCleanup ? 2 : 1,
          "only the failed operation and its guarded lease cleanup may recheck authority",
        );
        assert.equal(commentWrites(), writesBefore);
        observations.push({
          scenario: "authority-service outage retains coordinator retry classification",
          allowedChecks,
          rejectedChecks: outage.rejectedChecks,
          guardedCleanup,
          reasonCode: outcome.reasonCode,
          completionKind: outcome.kind,
          commentWrites: 0,
        });
      }
    }
    if (number === 72) lostAcknowledgement = 72;
    const direct = await command("bash", ["-c", directStep.run], env, source, true);
    assert.equal(direct.code, number === 71 ? 1 : 0, direct.stderr);
    records.push(record);
    if (number === 71) {
      const originalBody = items.get(number).body;
      items.get(number).body = "A changed source body invalidates the old review.";
      await command(
        process.execPath,
        [join(source, "dist/repair/publish-event-result.js")],
        env,
        work,
      );
      assert.equal(
        JSON.parse(readFileSync(env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8")).kind,
        "superseded",
      );
      items.get(number).body = originalBody;
      observations.push({ scenario: "body drift refused", number });
    }
    if (number === 72) {
      const githubOutput = join(work, "canonical-output");
      await command(
        process.execPath,
        [join(source, "dist/repair/exact-review-direct-publication.js")],
        {
          ...env,
          EXACT_REVIEW_DIRECT_MUTATION_OUTPUT: join(work, "direct.json"),
          EXACT_REVIEW_DIRECT_REVISION: String(tuple.lease_revision),
          EXACT_REVIEW_DIRECT_SOURCE_ACTION: claimDecision.sourceAction,
          GITHUB_OUTPUT: githubOutput,
        },
      );
      const receipt = readFileSync(githubOutput, "utf8");
      assert.match(receipt, /^accepted=true$/m, receipt);
      assert.match(receipt, /^superseded=false$/m, receipt);
      observations.push({ scenario: "independent direct canonical acceptance", number, receipt });
      await post("exact-review/lifecycle/router-receipt", {
        canonical_target_key: tuple.item_key,
        fence_key: tuple.item_key,
        revision: tuple.lease_revision,
        receipt_id: `manual-proof:${number}`,
        outcome: "not_required",
      });
    }
  }
  // A distinct current-head PR must produce its own trusted completion, with no seeded receipt.
  const prTraceStart = trace.length;
  const prDispatch = await admit(76);
  assert.equal(prDispatch.item_kind, "pull_request");
  const currentPr = await reviewedRecord(76);
  extraRecords.push(currentPr);
  assert.equal(currentPr.claimDecision.itemKind, "pull_request");
  assert.ok(!currentPr.report.includes("<!-- clawsweeper-review"));
  assert.equal(
    comments.get(76).filter((entry) => entry.body.includes("clawsweeper-review-version")).length,
    0,
  );
  const prPublisher = await command(
    process.execPath,
    [join(source, "dist/repair/publish-event-result.js")],
    currentPr.env,
    currentPr.work,
  );
  const prMutation = JSON.parse(
    readFileSync(currentPr.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8"),
  );
  assert.equal(prMutation.kind, "eligible", JSON.stringify(prMutation));
  const prCompletions = comments
    .get(76)
    .filter((entry) => entry.body.includes("clawsweeper-review-version"));
  assert.equal(prCompletions.length, 1);
  const prComment = prCompletions[0];
  assert.deepEqual(prComment.user, { login: "clawsweeper[bot]", type: "Bot" });
  assert.ok(Number.isSafeInteger(prComment.id) && prComment.id > 0);
  assert.ok(
    Number.isSafeInteger(Number(currentPr.lease.commentId)) &&
      Number(currentPr.lease.commentId) > 0,
  );
  assert.match(currentPr.lease.owner, /^[A-Za-z0-9._:-]{1,200}$/);
  const trailingMarkers = prComment.body.match(
    /(<!-- clawsweeper-review-version ([^>]+) -->)\s+(<!-- clawsweeper-review item=76 -->)\s*$/,
  );
  assert.ok(trailingMarkers, prComment.body);
  const version = Object.fromEntries(
    trailingMarkers[2]
      .trim()
      .split(/\s+/)
      .map((entry) => entry.split("=")),
  );
  assert.deepEqual(version, {
    item: "76",
    reviewed_at: currentPr.reviewedAt,
    sha: pulls.get(76).head.sha,
    source_revision: currentPr.sourceRevision,
    lease_owner: currentPr.lease.owner,
    lease_comment_id: String(currentPr.lease.commentId),
    v: "1",
  });
  assert.match(version.sha, /^[a-f0-9]{40}$/);
  assert.match(version.source_revision, /^[a-f0-9]{64}$/);
  assert.ok(
    !/clawsweeper-(?:action|verdict|repair|security|review-state|close-applied):?/.test(
      prComment.body,
    ),
  );
  writeFileSync(join(output, "current-head-pr-76-comment.md"), prComment.body);
  writeFileSync(
    join(output, "current-head-pr-76-mutation.json"),
    JSON.stringify(prMutation, null, 2),
  );
  const prGithubOutput = join(currentPr.work, "canonical-output");
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-direct-publication.js")],
    {
      ...currentPr.env,
      EXACT_REVIEW_DIRECT_MUTATION_OUTPUT: currentPr.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT,
      EXACT_REVIEW_DIRECT_REVISION: String(currentPr.tuple.lease_revision),
      EXACT_REVIEW_DIRECT_SOURCE_ACTION: currentPr.claimDecision.sourceAction,
      GITHUB_OUTPUT: prGithubOutput,
    },
  );
  const prReceipt = readFileSync(prGithubOutput, "utf8");
  assert.match(prReceipt, /^accepted=true$/m);
  assert.match(prReceipt, /^superseded=false$/m);
  assert.match(prReceipt, /^fallback=false$/m);
  // Execute the checked-in workflow's lifecycle step; do not fabricate its receipt.
  const lifecycleSteps = Object.values(sweep.jobs)
    .flatMap((job) => job.steps || [])
    .filter((step) => step.id === "finalize-direct-exact-review-lifecycle");
  assert.equal(lifecycleSteps.length, 1);
  const prLifecycleScript = join(output, "current-head-pr-76-lifecycle.sh");
  writeFileSync(prLifecycleScript, lifecycleSteps[0].run);
  await command(
    "bash",
    [prLifecycleScript],
    {
      ...currentPr.env,
      TARGET_BRANCH: "main",
      FENCE_KEY: currentPr.tuple.item_key,
      REVISION: String(currentPr.tuple.lease_revision),
      CLAIM_DECISION: JSON.stringify(currentPr.claimDecision),
      DIRECT_PUBLICATION_SUPERSEDED: "false",
      DIRECT_OUTCOME: currentPr.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT,
      GITHUB_OUTPUT: join(currentPr.work, "lifecycle-output"),
    },
    currentPr.work,
  );
  const prCanonicalResponse = await fetch(
    `${baseUrl}/queue/internal/state/records/openclaw-openclaw/items/76`,
    {
      headers: {
        "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update("").digest("hex")}`,
      },
    },
  );
  assert.equal(prCanonicalResponse.status, 200);
  const prCanonical = await prCanonicalResponse.json();
  for (const line of [
    "type: pull_request",
    "publication_policy: record_comment_only",
    `reviewed_at: ${currentPr.reviewedAt}`,
    `pull_head_sha: ${version.sha}`,
    `item_source_revision: ${version.source_revision}`,
    `review_lease_owner: ${version.lease_owner}`,
    `review_lease_comment_id: ${version.lease_comment_id}`,
    `review_comment_id: ${prComment.id}`,
  ])
    assert.ok(prCanonical.content.split("\n").includes(line), line);
  writeFileSync(join(output, "current-head-pr-76-canonical.md"), prCanonical.content);
  const prTrace = trace.slice(prTraceStart);
  const allowedPrQueueWrites = new Set([
    "/queue/internal/exact-review/enqueue",
    "/queue/internal/exact-review/claim",
    "/queue/internal/exact-review/publication-authority",
    "/queue/internal/exact-review/publication-results",
    "/queue/internal/exact-review/github-etag-cache/lookup",
  ]);
  const prEffects = prTrace.filter((entry) => {
    if (entry.forbidden) return true;
    if (!["POST", "PATCH", "DELETE", "PUT"].includes(entry.method) || "status" in entry)
      return false;
    if (entry.readOnlyGraphql || allowedPrQueueWrites.has(entry.path)) return false;
    if (entry.path === "/queue/internal/exact-review/lifecycle/router-receipt") {
      assert.deepEqual(entry.body, {
        canonical_target_key: currentPr.tuple.item_key,
        fence_key: currentPr.tuple.item_key,
        revision: currentPr.tuple.lease_revision,
        outcome: "not_required",
        receipt_id: `router-direct-not-required:${currentPr.runId}:1`,
      });
      return false;
    }
    if (entry.path === "/queue/internal/state/github-read-model/item") {
      assert.deepEqual(entry.body, { repository: repo, number: 76 });
      return false;
    }
    if (entry.path === "/queue/internal/state/github-read-model/repair") {
      // Production read-cache population from the upstream item, not repair automation.
      assert.equal(entry.body.repository, repo);
      assert.equal(entry.body.repair_kind, "items");
      assert.equal(entry.body.objects.length, 1);
      assert.equal(entry.body.objects[0].kind, "item");
      assert.equal(entry.body.objects[0].number, 76);
      assert.deepEqual(entry.body.objects[0].snapshot, items.get(76));
      return false;
    }
    if (entry.path === "/queue/internal/exact-review/heartbeat") {
      assert.deepEqual(entry.body, { ...currentPr.tuple, source_head_sha: version.sha });
      return false;
    }
    if (entry.path === "/app/installations/999/access_tokens") return false;
    if (
      entry.path === `/repos/${producerRepo}/dispatches` &&
      entry.body.client_payload?.item_number === 76
    )
      return false;
    return !/^\/repos\/openclaw\/openclaw\/issues\/(?:76\/comments|comments\/\d+)$/.test(
      entry.path,
    );
  });
  assert.deepEqual(
    prEffects,
    [],
    "PR completion must not mutate labels, repair, merge, router or close state",
  );
  assert.deepEqual(items.get(76).labels, [{ name: "bug" }]);
  assert.equal(items.get(76).state, "open");
  assert.equal(pulls.get(76).merged, false);
  const prObservation = {
    scenario: "current-head PR completion under publication-only policy",
    number: 76,
    tuple: currentPr.tuple,
    publicationPolicy: currentPr.claimDecision.publicationPolicy,
    version,
    identityMarker: trailingMarkers[3],
    commentId: prComment.id,
    commentAuthor: prComment.user,
    canonicalAccepted: true,
    receipt: prReceipt,
    forbiddenEffects: prEffects.length,
    publisher: prPublisher,
  };
  observations.push(prObservation);
  writeFileSync(
    join(output, "current-head-pr-completion.json"),
    JSON.stringify(prObservation, null, 2),
  );
  // The successful review's exact retained artifact now enters the existing fallback queue.
  const first = records[0];
  const publication = {
    artifactName: `exact-review-${first.runId}-1`,
    producerRunId: first.runId,
    producerRunAttempt: 1,
    sourceSha: base,
    itemKey: first.tuple.item_key,
    protocolVersion: 2,
    leaseRevision: first.tuple.lease_revision,
    claimGeneration: first.tuple.claim_generation,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
    producerDecision: first.claimDecision,
  };
  const widened = { ...first.claimDecision, sourceAction: "opened" };
  delete widened.publicationPolicy;
  await assert.rejects(
    post("exact-review/enqueue", {
      delivery_id: "manual-proof-policy-collision",
      decision: {
        ...widened,
        sourceAction: "exact_review_artifact_publish",
        publication: { ...publication, producerDecision: widened },
      },
    }),
    /exact_review_delivery_conflict/,
  );
  await post("exact-review/enqueue", {
    delivery_id: "manual-proof-fallback",
    decision: {
      ...first.claimDecision,
      sourceAction: "exact_review_artifact_publish",
      supersedesInProgress: false,
      publication,
    },
  });
  await post("exact-review/complete", { ...first.tuple, outcome: "success" });
  commentFailure = 0;
  lostAcknowledgement = 71;
  const workspace = join(root, "batch");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "records/openclaw-openclaw/items"), { recursive: true });
  // CLI entry guards compare import.meta.url with argv[1]; a symlink is not a checkout.
  cpSync(join(source, "dist"), join(workspace, "dist"), { recursive: true });
  for (const name of ["scripts", "config", "schemas", "prompts"])
    if (existsSync(join(source, name))) symlinkSync(join(source, name), join(workspace, name));
  const manifestPath = join(workspace, ".artifacts/exact-review-batch/manifest.json");
  const batchEnv = {
    GITHUB_WORKSPACE: workspace,
    GITHUB_RUN_ID: "2000",
    EXACT_REVIEW_BATCH_RUNNER_STARTED_AT: new Date().toISOString(),
    EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
    EXACT_REVIEW_BATCH_ID: "manual-proof-batch",
    EXACT_REVIEW_BATCH_LEASE_OWNER: "synthetic-proof-worker",
    EXACT_REVIEW_BATCH_MAX_ITEMS: "1",
  };
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-batch-cli.js"), "claim"],
    batchEnv,
    workspace,
  );
  assert.ok(existsSync(manifestPath), "coordinator did not grant batch claim");
  const batchOutage = { allowedChecks: 0, rejectedChecks: 0 };
  const writesBeforeBatchOutage = commentWrites();
  authorityOutage = batchOutage;
  await command(
    process.execPath,
    [join(source, "scripts/prepare-exact-review-batch.mjs")],
    batchEnv,
    workspace,
  );
  authorityOutage = null;
  const outageManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(outageManifest.items.length, 1);
  const outageOutcome = JSON.parse(readFileSync(outageManifest.items[0].outcomePath, "utf8"));
  assert.equal(outageOutcome.kind, "retryable_failure");
  assert.equal(outageOutcome.reasonCode, "state_contention");
  assert.equal(batchOutage.rejectedChecks, 1);
  assert.equal(commentWrites(), writesBeforeBatchOutage);
  observations.push({
    scenario: "batch authority outage preserves coordinator retry classification",
    completionKind: outageOutcome.kind,
    reasonCode: outageOutcome.reasonCode,
    commentWrites: 0,
  });
  await command(
    process.execPath,
    [join(source, "scripts/prepare-exact-review-batch.mjs")],
    batchEnv,
    workspace,
  );
  let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.items.length, 1);
  const outcome = JSON.parse(readFileSync(manifest.items[0].outcomePath, "utf8"));
  observations.push({ scenario: "first batch preparation", manifest, outcome });
  assert.equal(outcome.kind, "eligible", JSON.stringify(outcome));
  await admit(73);
  const headDrift = await reviewedRecord(73);
  extraRecords.push(headDrift);
  const beforeHeadDrift = commentWrites();
  pull.head.sha = "c".repeat(40);
  const headResult = await command(
    process.execPath,
    [join(source, "dist/repair/publish-event-result.js")],
    headDrift.env,
    headDrift.work,
  );
  const headOutcome = JSON.parse(
    readFileSync(headDrift.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8"),
  );
  assert.equal(headOutcome.kind, "superseded", JSON.stringify(headOutcome));
  assert.match(headResult.stdout, /skipped_changed_since_review/);
  assert.equal(commentWrites(), beforeHeadDrift, "head drift must not write comments");
  observations.push({
    scenario: "PR head drift refused",
    outcome: headOutcome,
    result: headResult.stdout,
  });

  await admit(74);
  const olderOwner = await reviewedRecord(74);
  extraRecords.push(olderOwner);
  await post("exact-review/complete", { ...olderOwner.tuple, outcome: "success" });
  const newDispatch = await admit(74, "independent-new-owner-74");
  const newerTuple = {
    item_key: newDispatch.queue_claim.item_key,
    lease_id: newDispatch.queue_lease_id,
    lease_revision: newDispatch.queue_claim.lease_revision,
    run_id: "2074",
    run_attempt: 1,
  };
  const newerOwner = await post("exact-review/claim", newerTuple);
  assert.equal(newerOwner.claimed, true);
  const beforeNewOwner = commentWrites();
  const staleOwner = await command(
    process.execPath,
    [join(source, "dist/repair/publish-event-result.js")],
    olderOwner.env,
    olderOwner.work,
    true,
  );
  const ownerObservation = {
    scenario: "independently newer coordinator owner",
    older: olderOwner.tuple,
    newer: newerTuple,
    newerClaim: newerOwner,
    publisher: staleOwner,
    commentWritesBefore: beforeNewOwner,
    commentWritesAfter: commentWrites(),
    mutation: JSON.parse(readFileSync(olderOwner.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8")),
  };
  observations.push(ownerObservation);
  writeFileSync(
    join(output, "newer-owner-reproduction.json"),
    JSON.stringify(ownerObservation, null, 2),
  );
  assert.equal(staleOwner.code, 1);
  assert.match(staleOwner.stderr, /manual publication fence is unavailable or expired/);
  assert.equal(commentWrites(), beforeNewOwner);
  observations.push({
    scenario: "independently newer coordinator owner refused old publisher",
    older: olderOwner.tuple,
    newerOwner,
  });

  // Real expiry, with no clock override, seeded state, or heartbeat extension.
  await waitUntil(Date.parse(manifest.leaseExpiresAt) + 1500, "actual batch lease expiry");
  const oldMember = manifest.items[0];
  await assert.rejects(
    post("exact-review/publication-authority", {
      owner: {
        batchId: manifest.batchId,
        leaseOwner: manifest.leaseOwner,
        runId: batchEnv.GITHUB_RUN_ID,
        runAttempt: 1,
      },
      canonicalTargetKey: first.tuple.item_key,
      fenceKey: oldMember.itemKey,
      revision: oldMember.revision,
      identity: {
        canonicalTargetKey: first.tuple.item_key,
        fenceKey: oldMember.itemKey,
        revision: oldMember.revision,
        claimGeneration: oldMember.claimGeneration,
      },
    }),
    /publication_fence_not_active/,
  );
  batchEnv.EXACT_REVIEW_BATCH_ID = "manual-proof-batch-retry";
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-batch-cli.js"), "claim"],
    batchEnv,
    workspace,
  );
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.notEqual(manifest.items[0].claimGeneration, oldMember.claimGeneration);
  await command(
    process.execPath,
    [join(source, "scripts/prepare-exact-review-batch.mjs")],
    batchEnv,
    workspace,
  );
  canonicalFailure = true;
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-batch-cli.js"), "commit"],
    batchEnv,
    workspace,
    true,
  );
  canonicalFailure = false;
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-batch-cli.js"), "commit"],
    batchEnv,
    workspace,
  );
  const member = manifest.items[0];
  const batchReceipt = JSON.parse(
    readFileSync(join(workspace, ".artifacts/exact-review-batch/state-receipt.json"), "utf8"),
  );
  assert.equal(batchReceipt.outcomes.length, 1);
  assert.ok(
    ["accepted", "deduped"].includes(batchReceipt.outcomes[0].outcome),
    JSON.stringify(batchReceipt),
  );
  observations.push({ scenario: "batch canonical acceptance", receipt: batchReceipt });
  await post("exact-review/lifecycle/router-receipt", {
    canonical_target_key: first.tuple.item_key,
    fence_key: member.itemKey,
    revision: member.revision,
    receipt_id: "manual-proof-batch-71",
    outcome: "not_required",
  });
  const completedOutcome = JSON.parse(readFileSync(member.outcomePath, "utf8"));
  completedOutcome.postEffectsComplete = true;
  writeFileSync(member.outcomePath, JSON.stringify(completedOutcome));
  await command(
    process.execPath,
    [join(source, "dist/repair/exact-review-batch-cli.js"), "complete"],
    batchEnv,
    workspace,
  );
  const listing = await post("state/records/list", {
    repoSlug: "openclaw-openclaw",
    section: "items",
    limit: 100,
  });
  assert.ok(JSON.stringify(listing).includes("71") && JSON.stringify(listing).includes("72"));
  const reportDir = join(workspace, "records/openclaw-openclaw/items");
  mkdirSync(reportDir, { recursive: true });
  for (const { number, reviewedAt } of records) {
    const response = await fetch(
      `${baseUrl}/queue/internal/state/records/openclaw-openclaw/items/${number}`,
      {
        headers: {
          "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update("").digest("hex")}`,
        },
      },
    );
    assert.equal(response.status, 200);
    const canonical = await response.json();
    assert.match(canonical.content, /^publication_policy: record_comment_only$/m);
    assert.ok(canonical.content.includes(`reviewed_at: ${reviewedAt}`));
    writeFileSync(join(reportDir, `${number}.md`), canonical.content);
  }
  const discovery = await command(
    process.execPath,
    [
      join(source, "dist/repair/issue-implementation-intake.js"),
      "candidates",
      "--enabled",
      "true",
      "--candidate-kind",
      "strict_bug",
      "--target-repo",
      repo,
      "--artifact-dir",
      reportDir,
      "--report-dir",
      reportDir,
    ],
    {},
    workspace,
  );
  assert.equal(JSON.parse(discovery.stdout).count, 0);
  observations.push({ scenario: "restricted implementation discovery", count: 0 });
  const controlDir = join(workspace, "ordinary-control");
  mkdirSync(controlDir);
  const restricted = readFileSync(join(reportDir, "71.md"), "utf8");
  for (const [scenario, content, count] of [
    [
      "ordinary implementation discovery",
      restricted.replace(/^publication_policy: record_comment_only\n/m, ""),
      1,
    ],
    [
      "ambiguous implementation provenance",
      restricted.replace(
        /^publication_policy: record_comment_only/m,
        "publication_policy: record_comment_only\npublication_policy: record_comment_only",
      ),
      0,
    ],
  ]) {
    writeFileSync(join(controlDir, "71.md"), content);
    const result = await command(
      process.execPath,
      [
        join(source, "dist/repair/issue-implementation-intake.js"),
        "candidates",
        "--enabled",
        "true",
        "--candidate-kind",
        "strict_bug",
        "--target-repo",
        repo,
        "--artifact-dir",
        controlDir,
        "--report-dir",
        controlDir,
      ],
      {},
      workspace,
    );
    assert.equal(JSON.parse(result.stdout).count, count, result.stdout);
    observations.push({ scenario, count });
  }

  const lifecycle = await post("exact-review/lifecycle-audit/inventory", { page_size: 100 });
  const inventory = lifecycle.exact_review_lifecycle_audit_inventory;
  assert.equal(inventory.collection.state, "complete", JSON.stringify(lifecycle));
  for (const number of [71, 72, 76]) {
    const current = inventory.page.records.filter(
      (entry) => entry.target.number === number && entry.current_revision,
    );
    assert.ok(current.length > 0);
    assert.ok(
      current.some(
        (entry) =>
          entry.state === "completed" &&
          entry.facts.canonical_receipts.includes("accepted") &&
          entry.facts.router_receipt === "not_required",
      ),
      JSON.stringify(current),
    );
  }
  const coalescedJourney = inventory.page.records.filter(
    (entry) => entry.target.number === 71 && entry.revision === first.tuple.lease_revision,
  );
  assert.ok(coalescedJourney.length > 0);
  assert.ok(
    coalescedJourney.every((entry) => entry.current_revision && entry.state === "completed"),
  );
  const bayResponse = await fetch(`${baseUrl}/queue/api/durable-lifecycle-bay`);
  assert.equal(bayResponse.status, 200);
  const bay = (await bayResponse.json()).durable_lifecycle_bay;
  assert.equal(bay.collection.state, "complete", JSON.stringify(bay));
  for (const number of [71, 72, 76]) {
    assert.ok(
      bay.sample.cards.some(
        (card) =>
          card.item_number === number && card.current_revision && card.state === "completed",
      ),
      JSON.stringify(bay),
    );
  }
  assert.doesNotMatch(JSON.stringify(bay), /producerLineage|fenceKey|claimGeneration|leaseOwner/);
  observations.push({ scenario: "actual lifecycle and Bay projection", lifecycle, bay });

  await admit(75);
  const lostArtifact = await reviewedRecord(75);
  extraRecords.push(lostArtifact);
  bundles.delete(lostArtifact.runId);
  await post("exact-review/enqueue", {
    delivery_id: "manual-proof-artifact-loss",
    decision: {
      ...lostArtifact.claimDecision,
      sourceAction: "exact_review_artifact_publish",
      supersedesInProgress: false,
      publication: {
        ...publication,
        artifactName: `exact-review-${lostArtifact.runId}-1`,
        producerRunId: lostArtifact.runId,
        itemKey: lostArtifact.tuple.item_key,
        leaseRevision: lostArtifact.tuple.lease_revision,
        claimGeneration: lostArtifact.tuple.claim_generation,
        producerDecision: lostArtifact.claimDecision,
      },
    },
  });
  await post("exact-review/complete", { ...lostArtifact.tuple, outcome: "success" });
  const beforeArtifactLoss = commentWrites();
  for (let attempt = 1; attempt <= 3; attempt++) {
    batchEnv.EXACT_REVIEW_BATCH_ID = `manual-proof-artifact-loss-${attempt}`;
    rmSync(manifestPath, { force: true });
    await command(
      process.execPath,
      [join(source, "dist/repair/exact-review-batch-cli.js"), "claim"],
      batchEnv,
      workspace,
    );
    assert.ok(existsSync(manifestPath), "artifact retry requires a real batch claim");
    const lostManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(lostManifest.items.length, 1);
    assert.equal(lostManifest.items[0].decision.itemNumber, 75);
    await command(
      process.execPath,
      [join(source, "scripts/prepare-exact-review-batch.mjs")],
      batchEnv,
      workspace,
    );
    const lostOutcome = JSON.parse(readFileSync(lostManifest.items[0].outcomePath, "utf8"));
    assert.equal(lostOutcome.kind, "retryable_failure", JSON.stringify(lostOutcome));
    assert.equal(lostOutcome.reasonCode, "artifact_unavailable", JSON.stringify(lostOutcome));
    await command(
      process.execPath,
      [join(source, "dist/repair/exact-review-batch-cli.js"), "commit"],
      batchEnv,
      workspace,
    );
    await command(
      process.execPath,
      [join(source, "dist/repair/exact-review-batch-cli.js"), "complete"],
      batchEnv,
      workspace,
    );
    const pending = await post("exact-review/publications/list", {});
    observations.push({ scenario: "artifact loss retry", attempt, outcome: lostOutcome, pending });
    if (attempt < 3) {
      assert.ok(
        pending.publications.some(
          (entry) => entry.decision.itemNumber === 75 && entry.attempts === attempt,
        ),
      );
      // Actual production delay plus its bounded jitter; no clock overrides or shortened policy.
      await waitUntil(
        Date.now() + (attempt === 1 ? 75000 : 145000),
        "actual artifact retry backoff",
      );
    }
  }
  const deadLetters = await post("exact-review/dead-letters/list", {});
  const parkedArtifact = deadLetters.dead_letters.find((entry) => entry.item_number === 75);
  assert.ok(parkedArtifact, JSON.stringify(deadLetters));
  assert.equal(parkedArtifact.reason_code, "artifact_unavailable");
  assert.equal(parkedArtifact.attempts, 3);
  assert.equal(parkedArtifact.fresh_recovery.eligible, false);
  assert.equal(dispatches.filter((entry) => entry.item_number === 75).length, 1);
  assert.equal(commentWrites(), beforeArtifactLoss);
  observations.push({ scenario: "artifact exhaustion refused fresh review", deadLetters });
  for (const record of records) {
    const bodies = comments
      .get(record.number)
      .filter((entry) => entry.body.includes("clawsweeper-review-version"));
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].body.includes(record.reviewedAt));
    assert.ok(!/clawsweeper-(?:action|verdict|repair|security):/.test(bodies[0].body));
  }
  assert.equal(
    trace.filter((entry) => entry.forbidden).length,
    0,
    JSON.stringify(trace.filter((entry) => entry.forbidden)),
  );
  assert.deepEqual(Object.fromEntries(reviewCounts), { 71: 1, 72: 1, 73: 1, 74: 1, 75: 1, 76: 1 });
  // A second explicit request after completion must not adopt the old receipt.
  // The original per-item and per-report assertions above still apply unchanged.
  const prior = records.find((entry) => entry.number === 72);
  await post("exact-review/complete", {
    ...prior.tuple,
    outcome: "success",
    completion_kind: "published",
    reason_code: "publication_applied",
  });
  await admit(72, "repeat-explicit-72");
  const repeated = await reviewedRecord(72, "3072");
  assert.ok(
    repeated.tuple.lease_revision > prior.tuple.lease_revision,
    "the existing publication head must advance a request after successful publication",
  );
  const laterJourney = (
    await post("exact-review/lifecycle-audit/inventory", { page_size: 100 })
  ).exact_review_lifecycle_audit_inventory.page.records.filter(
    (entry) => entry.target.number === 72 && entry.current_revision,
  );
  assert.ok(laterJourney.length > 0);
  assert.ok(
    laterJourney.every(
      (entry) => entry.revision === repeated.tuple.lease_revision && entry.state === "pending",
    ),
  );
  observations.push({
    scenario: "prior publication cannot complete a later producer journey",
    laterJourney,
  });
  const { prepareDirectPublicationPayload } = await import(
    pathToFileURL(join(source, "dist/repair/exact-review-direct-publication.js"))
  );
  const oldPlan = JSON.parse(
    readFileSync(prior.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8"),
  ).plan;
  const staleCanonical = prepareDirectPublicationPayload({
    revision: prior.tuple.lease_revision,
    sourceSha: base,
    plan: oldPlan,
    lifecycle: { kind: "router_not_required" },
  });
  await assert.rejects(
    post("exact-review/publication-results", staleCanonical),
    /direct_publication_fence_not_owned/,
  );
  await command(
    process.execPath,
    [join(source, "dist/repair/publish-event-result.js")],
    repeated.env,
    repeated.work,
  );
  const repeatedPlan = JSON.parse(
    readFileSync(repeated.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, "utf8"),
  ).plan;
  const repeatedReceipt = await post(
    "exact-review/publication-results",
    prepareDirectPublicationPayload({
      revision: repeated.tuple.lease_revision,
      sourceSha: base,
      plan: repeatedPlan,
      lifecycle: { kind: "router_not_required" },
    }),
  );
  assert.equal(repeatedReceipt.accepted, true);
  const repeatedCanonical = await fetch(
    `${baseUrl}/queue/internal/state/records/openclaw-openclaw/items/72`,
    {
      headers: {
        "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update("").digest("hex")}`,
      },
    },
  );
  assert.equal(repeatedCanonical.status, 200);
  const repeatedRecord = await repeatedCanonical.json();
  assert.ok(repeatedRecord.content.includes(`reviewed_at: ${repeated.reviewedAt}`));
  assert.notEqual(repeated.reviewedAt, prior.reviewedAt);
  assert.equal(
    comments.get(72).filter((entry) => entry.body.includes("clawsweeper-review-version")).length,
    1,
  );
  assert.equal(reviewCounts.get(72), 2);
  assert.deepEqual(Object.fromEntries(requestReviewCounts), {
    1071: 1,
    1072: 1,
    1073: 1,
    1074: 1,
    1075: 1,
    1076: 1,
    3072: 1,
  });
  assert.ok([...requestReviewCounts.values()].every((count) => count === 1));
  assert.equal(trace.filter((entry) => entry.forbidden).length, 0);
  observations.push({
    scenario: "repeated authorized manual request after completion",
    prior: prior.tuple,
    current: repeated.tuple,
    receipt: repeatedReceipt,
    reviewedAt: repeated.reviewedAt,
    requestReviewCounts: Object.fromEntries(requestReviewCounts),
  });
  const produced = [...records, ...extraRecords, repeated];
  for (const record of produced) {
    assert.deepEqual(readdirSync(join(record.bundleDir, "review")), [`${record.number}.md`]);
    assert.equal(
      readFileSync(join(record.bundleDir, "review", `${record.number}.md`), "utf8"),
      record.report,
    );
    assert.equal(
      digest(readFileSync(join(record.bundleDir, "manifest.json"))),
      record.bundleManifestSha256,
    );
    assert.ok(existsSync(join(record.work, "artifacts/event/selection.json")));
    for (const directory of ["codex", "review-trees"]) {
      assert.equal(
        readFileSync(join(record.work, "artifacts/event", directory, "synthetic.txt"), "utf8"),
        "producer diagnostic\n",
      );
    }
  }
  observations.push({
    scenario: "selected bundles and producer diagnostics remain unchanged",
    bundles: produced.length,
    publicationArtifactDir,
  });
  assert.equal(sourceIdentity().candidateSourceSha256, expected);
  writeFileSync(
    join(output, "proof.json"),
    JSON.stringify(
      {
        identity,
        provider: process.env.MANUAL_PUBLICATION_PROVIDER,
        lease: process.env.MANUAL_PUBLICATION_LEASE,
        image: process.env.MANUAL_PUBLICATION_IMAGE,
        runtime: "Wrangler local Durable Object/SQLite/R2",
        reviewCounts: Object.fromEntries(reviewCounts),
        requestReviewCounts: Object.fromEntries(requestReviewCounts),
        reviewedAt: [...records, ...extraRecords].map(({ number, reviewedAt }) => ({
          number,
          reviewedAt,
        })),
        canonical: listing,
        forbiddenEffects: 0,
        observations,
        classification,
        claimOnlyControls: [
          { item: 74, requestId: "independent-new-owner-74", syntheticReviews: 0 },
        ],
        limits: [
          "Synthetic GitHub/Actions HTTP service and synthetic review output; actual built CLI, coordinator claims, bundle, publisher and canonical store.",
          "No production permissions, Actions scheduling/provenance, model quality, or Cloudflare production durability claim.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(redact(error.stack));
} finally {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
    await new Promise((done) =>
      child.exitCode !== null || child.signalCode !== null ? done() : child.once("close", done),
    );
  }
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    process.kill(-worker.pid, "SIGTERM");
    const forcedStop = setTimeout(() => {
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, 5000);
    await new Promise((done) => worker.once("close", done));
    clearTimeout(forcedStop);
  }
  server.closeAllConnections();
  unix.closeAllConnections();
  await Promise.all([
    new Promise((done) => server.close(done)),
    new Promise((done) => unix.close(done)),
  ]);
  writeFileSync(join(output, "trace.json"), redact(JSON.stringify(trace, null, 2)));
  writeFileSync(join(output, "commands.json"), redact(JSON.stringify(commands, null, 2)));
  writeFileSync(join(output, "wrangler.log"), redact(workerLog));
  writeFileSync(
    join(output, "result.json"),
    redact(
      JSON.stringify(
        {
          identity,
          observations,
          failure,
          provider: process.env.MANUAL_PUBLICATION_PROVIDER,
          lease: process.env.MANUAL_PUBLICATION_LEASE,
          image: process.env.MANUAL_PUBLICATION_IMAGE,
          classification,
          reviewCounts: Object.fromEntries(reviewCounts),
        },
        null,
        2,
      ),
    ),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(socketRoot, { recursive: true, force: true });
  const cleanup = {
    temporaryStateRemoved: !existsSync(root) && !existsSync(socketRoot),
    workerStopped: !worker || worker.exitCode !== null || worker.signalCode !== null,
  };
  writeFileSync(join(output, "cleanup.json"), JSON.stringify(cleanup));
  const staleOwner = observations.find(
    (entry) => entry.scenario === "independently newer coordinator owner",
  );
  const currentPr = observations.find(
    (entry) => entry.scenario === "current-head PR completion under publication-only policy",
  );
  const repeated = observations.find(
    (entry) => entry.scenario === "repeated authorized manual request after completion",
  );
  const coalesced = observations.find(
    (entry) =>
      entry.scenario ===
      "ordinary refresh preserves pending manual branch and updates source facts",
  );
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        exitCode: process.exitCode || 0,
        candidateSourceSha256: identity.candidateSourceSha256,
        provider: process.env.MANUAL_PUBLICATION_PROVIDER,
        lease: process.env.MANUAL_PUBLICATION_LEASE,
        image: process.env.MANUAL_PUBLICATION_IMAGE,
        forbiddenRequests: trace.filter((entry) => entry.forbidden).length,
        siblingRequests: trace.filter(
          (entry) =>
            /\/(?:issues|pulls)\/99(?:\/|$)/.test(entry.path || "") ||
            entry.body?.variables?.number === 99 ||
            /pullRequest\(number:\s*99\)/.test(entry.body?.query || ""),
        ).length,
        stalePublisherExit: staleOwner?.publisher.code,
        staleWritesBefore: staleOwner?.commentWritesBefore,
        staleWritesAfter: staleOwner?.commentWritesAfter,
        reviewCounts: Object.fromEntries(reviewCounts),
        requestReviewCounts: Object.fromEntries(requestReviewCounts),
        repeatedRequestRevision: repeated?.current.lease_revision,
        completedCurrentJourneys: observations
          .find((entry) => entry.scenario === "actual lifecycle and Bay projection")
          ?.lifecycle.exact_review_lifecycle_audit_inventory.page.records.filter(
            (entry) => entry.current_revision && entry.state === "completed",
          )
          .map(({ target, revision }) => ({ number: target.number, revision })),
        publicBayCompletedCards: observations
          .find((entry) => entry.scenario === "actual lifecycle and Bay projection")
          ?.bay.sample.cards.filter((card) => card.current_revision && card.state === "completed"),
        coalescedManualBranch: coalesced && {
          targetBranch: coalesced.targetBranch,
          sourceUpdatedAt: coalesced.sourceUpdatedAt,
          revision: coalesced.revision,
          initialDispatchFailures: coalesced.initialDispatchFailures,
        },
        manualBranchSelections: observations
          .filter(
            (entry) =>
              entry.scenario === "manual workflow preserves the selected non-default branch",
          )
          .map(({ number, requestedBranch, claimedBranch }) => ({
            number,
            requestedBranch,
            claimedBranch,
          })),
        preservedProducerBundles: observations.find(
          (entry) =>
            entry.scenario === "selected bundles and producer diagnostics remain unchanged",
        )?.bundles,
        authorityOutageClassifications: observations
          .filter(
            (entry) =>
              entry.reasonCode === "state_contention" && entry.scenario.includes("authority"),
          )
          .map((entry) => ({
            stage: entry.scenario.startsWith("batch") ? "batch" : "direct",
            ...(entry.allowedChecks === undefined
              ? {}
              : {
                  allowedChecks: entry.allowedChecks,
                  rejectedChecks: entry.rejectedChecks,
                  guardedCleanup: entry.guardedCleanup,
                }),
            completionKind: entry.completionKind,
            reasonCode: entry.reasonCode,
            commentWrites: entry.commentWrites,
          })),
        currentHeadPrCompletion: currentPr && {
          number: currentPr.number,
          canonicalAccepted: currentPr.canonicalAccepted,
          version: currentPr.version,
          identityMarker: currentPr.identityMarker,
          commentId: currentPr.commentId,
          forbiddenEffects: currentPr.forbiddenEffects,
        },
        scenarios: observations.map((entry) => entry.scenario),
        failure,
        cleanup,
      },
      null,
      2,
    ),
  );
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
