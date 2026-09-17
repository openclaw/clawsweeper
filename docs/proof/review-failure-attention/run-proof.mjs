import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { bayHtml } from "../../../dashboard/bay-page.ts";
import { publicStatusProjection } from "../../../dashboard/worker.ts";
import { exactReviewSourceRevisionMaterial } from "../../../dashboard/exact-review-source-revision.ts";
import { directReReviewIntake } from "../../../src/repair/direct-re-review-admission.ts";
// Run from repository root, inside the owner's isolated proof container.
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24+ required");
const baseline = process.env.PROOF_EXPECT_BASELINE === "1";
const config = path.resolve("docs/proof/review-failure-attention");
const dir = path.resolve(
  process.env.PROOF_OUTPUT_DIR ||
    ".artifacts/review-failure-attention/" + (baseline ? "baseline-" : "candidate-") + Date.now(),
);
fs.mkdirSync(dir, { recursive: true });
assert.ok(!fs.existsSync(path.join(dir, "result.json")), "use a fresh artifact directory");
assert.ok(
  fs.existsSync("dist/repair/update-command-status.js"),
  "compile production CLI with pnpm run build:all",
);
// Fail before starting fixtures if this is not an attributable Git checkout.
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const wrangler = path.resolve(process.env.WRANGLER_PATH || "node_modules/wrangler/bin/wrangler.js");
assert.match(
  execFileSync(process.execPath, [wrangler, "--version"], { encoding: "utf8" }),
  /4\.131\.1/,
  "Wrangler 4.131.1 required; proof never installs dependencies",
);
const secret = "synthetic-review-attention-proof",
  nonce = randomUUID(),
  head = "a".repeat(40);
const targets = new Map(),
  comments = new Map(),
  dispatches = [],
  trace = [],
  results = [],
  receipts = [];
const subprocesses = new Set();
let child,
  browser,
  pageServer,
  origin,
  githubOrigin,
  privateRepository = false,
  raceOnLookup,
  writes = 0,
  phase = "setup";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonFile = (name, value) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
const budgets = (item) => ({
  attempts: item.attempts,
  failures: item.reviewFailureAttempts,
  recoveries: item.parkedRecoveryAttempts,
});
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port));
  });
const freePort = async () => {
  const s = createServer();
  const address = await listen(s);
  await new Promise((r) => s.close(r));
  return new URL(address).port;
};
const stub = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, githubOrigin || "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    trace.push({ boundary: "github-stub", phase, method: req.method, path: u.pathname });
    const reply = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? undefined : JSON.stringify(value));
    };
    if (u.pathname.endsWith("/installation")) return reply({ id: 999 });
    if (u.pathname === "/app/installations/999/access_tokens")
      return reply({ token: "synthetic-token", expires_at: "2099-01-01T00:00:00Z" });
    if (u.pathname.endsWith("/actions/workflows/sweep.yml")) return reply({ state: "active" });
    if (u.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatches.push({ phase, ...JSON.parse(raw) });
      return reply({}, 204);
    }
    const exact = u.pathname.match(/^\/repos\/openclaw\/openclaw\/issues\/comments\/(\d+)$/);
    const list = u.pathname.match(/^\/repos\/openclaw\/openclaw\/issues\/(\d+)\/comments$/);
    if (exact || list) {
      if (raceOnLookup && req.method === "GET") {
        const race = raceOnLookup;
        raceOnLookup = null;
        const target = targets.get(Number(race.key.split("#").pop()));
        if (race.mode === "body") target.body = "Changed before PATCH without a queue webhook";
        else if (race.mode === "base") target.base = { sha: "c".repeat(40) };
        else if (race.mode === "draft") target.draft = true;
        else if (race.mode === "labels") target.labels = [{ name: "bug" }];
        else if (race.mode === "locked") target.locked = true;
        else await call("/__proof/race", race);
      }
      if (exact) {
        const comment = comments.get(Number(exact[1]));
        if (!comment) return reply({ message: "missing fixture comment" }, 404);
        if (req.method === "PATCH") {
          writes++;
          comment.body = JSON.parse(raw).body;
          comment.updated_at = new Date().toISOString();
          const target = targets.get(Number(comment.issue_url.split("/").pop()));
          if (target) target.updated_at = comment.updated_at;
        }
        return reply(comment);
      }
      if (req.method === "POST") {
        const n = Number(list[1]);
        const comment = {
          id: n + 100,
          body: JSON.parse(raw).body,
          user: { login: "clawsweeper[bot]" },
          issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/" + n,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        comments.set(comment.id, comment);
        return reply(comment, 201);
      }
      return reply([...comments.values()].filter((c) => c.issue_url.endsWith("/" + list[1])));
    }
    if (u.pathname.endsWith("/reactions") && req.method === "POST")
      return reply({ id: 1, content: "eyes" }, 201);
    const item = u.pathname.match(/^\/repos\/openclaw\/openclaw\/(pulls|issues)\/(\d+)$/);
    if (item)
      return reply(
        targets.get(Number(item[2])) || { message: "missing" },
        targets.has(Number(item[2])) ? 200 : 404,
      );
    if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname))
      return reply({
        full_name: u.pathname.slice(7),
        private: privateRepository,
        visibility: privateRepository ? "private" : "public",
        archived: false,
        disabled: false,
        default_branch: "main",
      });
    if (u.pathname.includes("/actions/runs/"))
      return reply({ id: 990003, run_attempt: 1, status: "in_progress" });
    return reply({ message: "unhandled fixture route" }, 404);
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(error) }));
  }
});
async function call(route, body, expected = 200) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    "x-proof-nonce": nonce,
    ...(raw
      ? {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature":
            "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
        }
      : {}),
  };
  const response = await fetch(origin + route, {
    method: raw ? "POST" : "GET",
    headers,
    body: raw,
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  trace.push({
    boundary: "worker-http",
    phase,
    route,
    status: response.status,
    request: body,
    response: value,
  });
  assert.equal(response.status, expected, JSON.stringify({ route, value }));
  return value;
}
const state = () => call("/__proof/state");
const reasonPattern = (reason) =>
  ({
    review_history_unavailable: /history|ancestry/i,
    review_commit_fetch_failed: /fetch|commit/i,
    timeout: /timed out|timeout|time limit/i,
    unknown: /unknown|unavailable|not recorded|unspecified/i,
  })[reason];
async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {}
  await Promise.race([once(proc, "exit"), sleep(4000)]);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    await Promise.race([once(proc, "exit"), sleep(2000)]);
  }
}
async function stop() {
  const p = child;
  child = null;
  await stopProcess(p);
}
async function start() {
  const log = fs.openSync(path.join(dir, "worker.log"), "a");
  child = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      path.join(config, "wrangler.toml"),
      "--local",
      "--persist-to",
      path.join(dir, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      new URL(origin).port,
      "--inspector-port",
      await freePort(),
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  fs.closeSync(log);
  child.on("error", (error) => {
    jsonFile("worker-spawn-error.json", { error: String(error) });
  });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error("Worker exited; inspect worker.log");
    try {
      const r = await fetch(origin + "/__proof/identity", {
        headers: { "x-proof-nonce": nonce },
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok && (await r.json()).nonce === nonce) return;
    } catch {}
    await sleep(500);
  }
  throw Error("Worker readiness timeout");
}
async function seed(n, label, command = true) {
  const key = "openclaw/openclaw#" + n,
    marker = "<!-- clawsweeper-command-status:" + n + ":re_review:synthetic -->";
  targets.set(n, {
    number: n,
    node_id: "PR_synthetic_" + n,
    state: "open",
    closed_at: null,
    updated_at: "2026-09-17T00:00:00Z",
    head: { sha: head },
    merged: false,
    base: { sha: "b".repeat(40) },
    draft: false,
    title: "Controlled source " + n,
    body: "Controlled review body",
    labels: [],
    locked: false,
  });
  await call(
    "/internal/exact-review/enqueue",
    {
      delivery_id: nonce + "-" + n,
      decision: {
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        itemNumber: n,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "legacy_dispatch",
        sourceHeadSha: head,
        sourceBaseSha: "b".repeat(40),
        sourceIsDraft: false,
        sourceContentRevision: createHash("sha256")
          .update(JSON.stringify(exactReviewSourceRevisionMaterial(targets.get(n))))
          .digest("hex"),
        supersedesInProgress: false,
        ...(command ? { commandStatusMarker: marker } : {}),
      },
    },
    202,
  );
  comments.set(n + 100, {
    id: n + 100,
    body: [
      "<!-- clawsweeper-command-ack:" + (n + 1000) + " -->",
      marker,
      "<!-- clawsweeper-command-progress:start -->",
      "- State: Failed",
      "- Detail: The durable queue will retry automatically.",
      "<!-- clawsweeper-command-progress:end -->",
    ].join("\n"),
    user: { login: "clawsweeper[bot]" },
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/" + n,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { n, key, label, address: { status_marker: marker } };
}
async function claim(item) {
  const claimed = await call("/internal/exact-review/claim", {
    item_key: item.key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: "990003",
    run_attempt: 1,
  });
  assert.equal(claimed.claimed, true);
  const row = (await state()).items[item.key];
  return {
    item_key: row.key,
    lease_id: row.leaseId,
    lease_revision: row.leaseRevision,
    claim_generation: row.claimGeneration,
    run_id: row.claimedRunId,
    run_attempt: row.claimedRunAttempt,
  };
}
async function waitDispatch(key, driver = false) {
  for (let i = 0; i < 12; i++) {
    const items = Object.values((await state()).items);
    const item = driver
      ? items.find((x) => x.terminalFinalization?.parkedCommand?.itemKey === key)
      : items.find((x) => x.key === key);
    if (item?.state === "dispatching") return item;
    if (item?.state === "pending") await call("/__proof/ready", { key: item.key });
    await call("/__proof/alarm", {});
    await sleep(100);
  }
  throw Error("No dispatch for " + key);
}
async function completeFailure(f, failure, invalid = false) {
  phase = "completion-fixture";
  const tuple = await claim(await waitDispatch(f.key));
  if (invalid)
    await call(
      "/internal/exact-review/complete",
      {
        ...tuple,
        outcome: "failure",
        review_failure: {
          stage: "source_preparation",
          reason_code: "PRIVATE_DIAGNOSTIC_SENTINEL https://private.invalid/token",
          retryable: true,
        },
      },
      400,
    );
  const completion = await call("/internal/exact-review/complete", {
    ...tuple,
    outcome: "failure",
    review_failure: failure,
  });
  receipts.push({ scenario: f.label, kind: "real-review-completion", tuple, failure, completion });
  await call("/__proof/park", { key: f.key });
}
async function statusCli(f, tuple, attempt, race) {
  if (race) raceOnLookup = { key: f.key, mode: race };
  const output = path.join(dir, "cli-" + f.n + ".outputs");
  fs.rmSync(output, { force: true });
  const args = [
    "dist/repair/update-command-status.js",
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    String(f.n),
    "--marker",
    f.address.status_marker,
    "--state",
    attempt.status_state,
    "--detail",
    attempt.status_detail,
    "--require-mutation",
    "--verify-terminal-status-receipt",
    "--require-terminal-finalization-fence",
  ];
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: path.join(dir, "bin") + ":" + process.env.PATH,
      HOME: process.env.HOME,
      PROOF_GITHUB_ORIGIN: githubOrigin,
      CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
      GITHUB_OUTPUT: output,
      QUEUE_URL: origin,
      GITHUB_RUN_ID: tuple.run_id,
      GITHUB_RUN_ATTEMPT: String(tuple.run_attempt),
      TERMINAL_FINALIZATION_ITEM_KEY: tuple.item_key,
      TERMINAL_FINALIZATION_LEASE_ID: tuple.lease_id,
      TERMINAL_FINALIZATION_LEASE_REVISION: String(tuple.lease_revision),
      TERMINAL_FINALIZATION_CLAIM_GENERATION: String(tuple.claim_generation),
      ATTEMPT_ID: attempt.attempt_id,
    },
  });
  subprocesses.add(proc);
  let logs = "";
  proc.stdout.on("data", (x) => (logs += x));
  proc.stderr.on("data", (x) => (logs += x));
  const timeout = setTimeout(() => {
    void stopProcess(proc);
  }, 45000);
  try {
    const [code] = await once(proc, "exit");
    fs.writeFileSync(path.join(dir, "cli-" + f.n + ".log"), logs);
    assert.equal(code, 0, logs);
  } finally {
    clearTimeout(timeout);
    subprocesses.delete(proc);
  }
  return fs.existsSync(output)
    ? Object.fromEntries(
        fs
          .readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      )
    : {};
}
async function settle(f, race) {
  phase = "acknowledgement-settlement";
  const producer = (await state()).items[f.key],
    before = budgets(producer);
  await call("/__proof/park", { key: f.key });
  if (baseline) {
    await call("/__proof/alarm", {});
    await call("/__proof/alarm", {});
    assert.equal(
      Object.values((await state()).items).some(
        (x) => x.terminalFinalization?.parkedCommand?.itemKey === f.key,
      ),
      false,
    );
    results.push({ scenario: f.label, baseline_no_open_ack_driver: true });
    return;
  }
  const tuple = await claim(await waitDispatch(f.key, true));
  const attempt = await call("/internal/exact-review/terminal-finalization/attempt", {
    ...tuple,
    ...f.address,
  });
  assert.equal(attempt.allowed, true);
  assert.equal(attempt.status_state, "Failed");
  assert.match(attempt.status_detail, /^Stopped:/);
  assert.match(attempt.status_detail, /exhaust|stopped/i);
  if (f.expected) assert.match(attempt.status_detail, reasonPattern(f.expected.reason));
  else if (f.label.startsWith("LEGACY"))
    assert.match(attempt.status_detail, /historical|unavailable|unknown/i);
  assert.doesNotMatch(attempt.status_detail, /will retry|retrying|try again automatically/i);
  const initialWrites = writes,
    result = await statusCli(f, tuple, attempt, race);
  assert.equal(writes - initialWrites, race ? 0 : 1);
  if (!race) {
    assert.equal(result.terminal_status_verified, "true");
    if (f.n === 120887) {
      // The PATCH is durable but the queue receipt has not arrived yet.
      const replay = await statusCli(f, tuple, attempt);
      assert.equal(replay.terminal_status_verified, "true");
      assert.equal(writes - initialWrites, 1);
      assert.equal((await state()).items[f.key].revision, producer.revision);
      results.push({
        scenario: "lost receipt after bot-comment timestamp churn",
        same_revision: true,
        duplicate_patches: 0,
      });
    }
    const receipt = {
      canonical_target_key: f.key,
      fence_key: f.key,
      revision: producer.revision,
      ...f.address,
      command_comment_id: Number(result.command_comment_id),
      completion_comment_id: Number(result.completion_comment_id),
      completed_at: result.completion_completed_at,
      completion_outcome: "failure",
      observed_at: Date.now(),
    };
    await call("/internal/exact-review/lifecycle/command-ack/observed", receipt);
    await call("/internal/exact-review/lifecycle/command-ack/observed", receipt);
    receipts.push({ scenario: f.label, tuple, attempt, result, receipt });
    assert.match(comments.get(f.n + 100).body, /Stopped/);
    if (f.expected) assert.match(comments.get(f.n + 100).body, reasonPattern(f.expected.reason));
    assert.doesNotMatch(comments.get(f.n + 100).body, /will retry|retrying/i);
  }
  const retained = (await state()).items[f.key];
  assert.equal(retained.state, "parked");
  assert.deepEqual(budgets(retained), before);
  results.push({
    scenario: f.label,
    race: race || null,
    patches: writes - initialWrites,
    retained_operator_attention: true,
    budgets_unchanged: true,
  });
}

function browserSnapshot(queue) {
  // Queue rows/counts come unchanged from the real Worker, not handwritten
  // stopped-review JSON. Only the separate live workflow census is controlled.
  const now = new Date().toISOString(),
    projection = queue.bay_projection;
  assert.equal(projection.complete, true);
  const zero = Object.fromEntries(Object.keys(projection.stages).map((k) => [k, 0]));
  const live = {
    repository: "openclaw/openclaw",
    item_number: 990099,
    stage: "repairing",
    source: "live",
    activity_kind: "repair",
    legacy_batch_path: false,
    timing: { kind: "run", started_at: now },
    action: {
      repository: "openclaw/clawsweeper",
      run_id: 990099,
      status: "in_progress",
      started_at: now,
      steps_complete: true,
      steps: [],
    },
  };
  const rows = projection.items.map((row) => ({ ...row, source: "queue" }));
  const stages = { ...projection.stages, repairing: projection.stages.repairing + 1 };
  const raw = {
    schema_version: 1,
    fleet: {},
    automatic_work: [],
    bay: {
      metrics_state: "complete",
      timing_coverage_complete: true,
      active_census_complete: true,
      active_stages: { ...zero, repairing: 1 },
      tide_generation: 0,
      tide_threshold: 20,
      terminal_count: 0,
      terminal_buffer: [],
      recently_washed: [],
      last_tide_at: null,
      washed_at: null,
      timings: {
        window_minutes: 60,
        window_ended_at: now,
        overall: { samples: 0, average_ms: null, median_ms: null },
        history: { bucket_minutes: 5, points: [] },
        including_legacy_batch: {
          overall: { samples: 0, average_ms: null, median_ms: null },
          history: { bucket_minutes: 5, points: [] },
        },
      },
    },
    diagnostics: { errors: [], error_count: 0 },
    health: { sampled_runs: 0 },
    generated_at: now,
    public_projection_complete: true,
    workers: [],
    pipeline: [],
    freshness: {
      state: "fresh",
      generated_at: now,
      age_ms: 0,
      maximum_age_ms: 60000,
      cache_state: "fresh",
    },
    exact_review_queue: {
      ...queue,
      bay_projection: {
        ...projection,
        total: projection.total + 1,
        stages,
        items: [...rows, live],
        activity: {
          complete: true,
          total: projection.total + 1,
          queue_stages: projection.stages,
          live_stages: { ...zero, repairing: 1 },
          queue_legacy_batch_stages: projection.legacy_batch_stages || zero,
          live_legacy_batch_stages: zero,
          items: [...rows, live],
        },
      },
    },
  };
  const allowed = new Set(["openclaw/openclaw", "openclaw/clawsweeper"]);
  const projected = publicStatusProjection(raw, allowed);
  assert.equal(projected.exact_review_queue.collection.state, "complete");
  const privateView = publicStatusProjection(raw, new Set());
  assert.doesNotMatch(
    JSON.stringify(privateView.exact_review_queue.bay_projection),
    /openclaw\/openclaw|review_history_unavailable|review_commit_fetch_failed/,
  );
  const unsafe = structuredClone(raw);
  for (const collection of [
    unsafe.exact_review_queue.bay_projection.items,
    unsafe.exact_review_queue.bay_projection.activity.items,
  ])
    collection[0].review_failure = { stage: "workflow", reason: "PRIVATE_DIAGNOSTIC_SENTINEL" };
  assert.doesNotMatch(
    JSON.stringify(publicStatusProjection(unsafe, allowed)),
    /PRIVATE_DIAGNOSTIC_SENTINEL/,
  );
  jsonFile("private-projection.json", privateView);
  jsonFile("browser-input.json", raw);
  jsonFile("browser-snapshot.json", projected);
  return projected;
}
async function browserProof(snapshot) {
  phase = "browser";
  pageServer = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const json = (value) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    trace.push({ boundary: "bay-http", method: req.method, path: u.pathname });
    if (
      /^\/bay-assets\/[A-Za-z0-9._-]+\.(webp|png)$/.test(u.pathname) &&
      fs.existsSync("dashboard/public" + u.pathname)
    ) {
      res.setHeader("content-type", u.pathname.endsWith(".png") ? "image/png" : "image/webp");
      res.end(fs.readFileSync("dashboard/public" + u.pathname));
      return;
    }
    if (u.pathname === "/bay") {
      res.setHeader("content-type", "text/html");
      return res.end(bayHtml());
    }
    if (u.pathname === "/api/status") return json(snapshot);
    if (u.pathname === "/api/durable-lifecycle-bay")
      return json({
        schema_version: 1,
        generated_at: snapshot.generated_at,
        complete: true,
        total: 0,
        items: [],
        lanes: [],
      });
    if (u.pathname === "/api/health-history")
      return json({
        schema_version: 1,
        range: u.searchParams.get("range") || "6h",
        generated_at: snapshot.generated_at,
        samples: [],
        coverage: { state: "empty" },
        freshness: { state: "fresh" },
      });
    if (u.pathname === "/api/github-egress-observability")
      return json({
        version: 2,
        generated_at: snapshot.generated_at,
        window: { hours: 6, bucket_minutes: 5 },
        rows: [],
        rate_limit_observations: [],
        completeness: { query_complete: true, rate_limit_rows_truncated: false },
      });
    if (u.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    json({ error: "unhandled_local_bay_route" });
  });
  const address = await listen(pageServer),
    external = [],
    errors = [];
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-background-networking"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== address) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  // Exercise the real keyboard action; dense hover labels can cover adjacent pointer targets.
  const openReference = async (number) => {
    await page.mouse.move(0, 0);
    const control = page.locator('[data-number="' + number + '"]');
    await control.focus();
    await control.press("Enter");
  };
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(address + "/bay");
  await page.waitForSelector('[data-number="120887"]');
  const text = await page.locator("body").innerText();
  assert.match(text, baseline ? /Repair cove/i : /Repair & attention/i);
  for (const n of [120887, 131455, 131604, 131464]) {
    // Dense cards show only their number until interaction; the accessible
    // name and actual drawer carry the full status in both layouts.
    const label = await page.locator('[data-number="' + n + '"]').getAttribute("aria-label");
    assert.match(label, baseline ? /Retry exhausted/i : /Review stopped/i);
  }
  assert.match(
    await page.locator('[data-number="990098"]').getAttribute("aria-label"),
    /Retry scheduled/i,
  );
  await openReference(990098);
  const scheduled = await page.locator("#drawer-body").innerText();
  assert.match(scheduled, /Retry scheduled/i);
  assert.doesNotMatch(scheduled, /Stopped review|Review stopped|Retries exhausted/);
  await page.keyboard.press("Escape");
  await openReference(990099);
  const live = await page.locator("#drawer-body").innerText();
  assert.doesNotMatch(live, /Stopped review|Review stopped|Retries exhausted/);
  if (!baseline) {
    assert.match(live, /Code repair/);
    assert.match(live, /Running/);
  }
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(dir, "bay-desktop.png") });
  await openReference(120887);
  const legacy = await page.locator("#drawer-body").innerText();
  if (!baseline) assert.match(legacy, /Detailed historical reason unavailable/);
  assert.doesNotMatch(legacy, /Last recorded review failure:/);
  await page.screenshot({ path: path.join(dir, "drawer-legacy-desktop.png") });
  await page.keyboard.press("Escape");
  await openReference(990081);
  const known = await page.locator("#drawer-body").innerText();
  if (!baseline) {
    assert.match(known, /Last recorded review failure:/);
    assert.match(known, /history|ancestry/i);
  } else assert.doesNotMatch(known, /Last recorded review failure:/);
  await page.screenshot({ path: path.join(dir, "drawer-known-desktop.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(dir, "bay-mobile.png") });
  await openReference(990081);
  await page.screenshot({ path: path.join(dir, "drawer-known-mobile.png") });
  await page.keyboard.press("Escape");
  await openReference(120887);
  await page.screenshot({ path: path.join(dir, "drawer-legacy-mobile.png") });
  assert.deepEqual(external, [], "Bay attempted non-loopback traffic");
  assert.deepEqual(errors, [], "browser runtime errors");
  jsonFile("browser-observations.json", {
    legacy,
    known,
    live,
    scheduled,
    external,
    errors,
    viewport_sizes: [
      [1440, 1000],
      [390, 844],
    ],
  });
  results.push({
    scenario: "production Bay / real projected queue / controlled live repair workflow",
    desktop_mobile_and_drawers: true,
    no_external_requests: true,
  });
}
let createdVars = false,
  succeeded = false;
// A normal termination signal closes owned resources and records interruption.
const terminate = () => {
  void (async () => {
    if (browser) await browser.close().catch(() => {});
    for (const proc of subprocesses) await stopProcess(proc);
    await stop();
    await closeServer(pageServer);
    await closeServer(stub);
    if (createdVars) fs.rmSync(path.join(config, ".dev.vars"), { force: true });
    jsonFile("interrupted.json", { phase, passed: false });
    process.exit(130);
  })();
};
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
const closeServer = async (server) => {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
try {
  // Exclusive .dev.vars creation: never clobber another proof's secret/config.
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  githubOrigin = await listen(stub);
  origin = "http://127.0.0.1:" + (await freePort());
  fs.writeFileSync(
    path.join(config, ".dev.vars"),
    "CLAWSWEEPER_APP_PRIVATE_KEY=" +
      JSON.stringify(privateKey) +
      "\nPROOF_NONCE=" +
      nonce +
      "\nGITHUB_API_URL=" +
      githubOrigin +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  createdVars = true;
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(path.join(config, "gh-fixture.mjs"), path.join(dir, "bin/gh"));
  fs.chmodSync(path.join(dir, "bin/gh"), 0o755);
  await start();
  const legacy = [];
  for (const n of [120887, 131455, 131604, 131464]) {
    const f = await seed(n, "LEGACY32-failure3-recovery cause unknown " + n);
    await call("/__proof/park", { key: f.key });
    legacy.push(f);
  }
  const known = [];
  for (const [n, stage, reason] of [
    [990081, "source_preparation", "review_history_unavailable"],
    [990082, "source_preparation", "review_commit_fetch_failed"],
    [990083, "timeout", "timeout"],
    [990084, "workflow", "unknown"],
  ]) {
    const f = await seed(n, "CONTROLLED " + stage + "/" + reason);
    await completeFailure(f, { stage, reason_code: reason, retryable: true }, n === 990081);
    known.push({
      ...f,
      expected: { stage: stage === "timeout" ? "provider_or_model" : stage, reason },
    });
  }
  jsonFile("state-after-completion.json", await state());
  await stop();
  await start();
  const queueAfterRestart = await call("/api/exact-review-queue");
  for (const f of [...legacy, ...known]) {
    const row = queueAfterRestart.bay_projection.items.find((x) => x.item_number === f.n);
    assert.ok(row, "missing actual queue projection " + f.n);
    if (f.expected && !baseline) assert.deepEqual(row.review_failure, f.expected);
    else assert.equal(row.review_failure, undefined);
    assert.deepEqual(budgets((await state()).items[f.key]), {
      attempts: 8,
      failures: 8,
      recoveries: 3,
    });
  }
  results.push({
    scenario: "signed failure completion survives SQLite Worker restart",
    candidate_preserved_cause: !baseline,
    invalid_reason_rejected: true,
    legacy_cause_unknown: true,
  });
  for (const f of [...legacy, ...known]) await settle(f);
  // Replay after restart must neither PATCH again nor schedule another driver.
  const settledWrites = writes,
    settledDispatches = dispatches.length;
  await stop();
  await start();
  phase = "acknowledgement-settlement";
  for (const f of [...legacy, ...known]) {
    await call("/__proof/park", { key: f.key });
    await call("/__proof/alarm", {});
  }
  assert.equal(writes, settledWrites);
  assert.equal(dispatches.length, settledDispatches);
  results.push({
    scenario: "observed acknowledgement replay plus Worker restart",
    no_duplicate_patch_or_dispatch: true,
  });
  const retry = await seed(990098, "scheduled review retry", false);
  await call("/__proof/park", { key: retry.key });
  await call("/__proof/retry-control", { key: retry.key });
  const queue = await call("/api/exact-review-queue");
  jsonFile("queue-http.json", queue);
  jsonFile("state-final.json", await state());
  assert.equal(
    queue.bay_projection.items.find((x) => x.item_number === retry.n).queue_disposition,
    "retry_scheduled",
  );
  await browserProof(browserSnapshot(queue));
  // No source identity is supplied by this client. The real intake owner must
  // fetch and capture it before the command can later settle as stopped.
  phase = "completion-fixture";
  const intakeNumber = 990080,
    sourceCommentId = intakeNumber + 1000;
  const intakeBody = "@clawsweeper re-review",
    sourceCommentUpdatedAt = "2026-09-17T00:00:00Z";
  targets.set(intakeNumber, {
    ...structuredClone(targets.get(120887)),
    number: intakeNumber,
    node_id: "PR_synthetic_intake",
    title: "Controlled command intake",
  });
  comments.set(sourceCommentId, {
    id: sourceCommentId,
    body: intakeBody,
    user: { login: "fixture-author" },
    issue_url: "https://api.github.com/repos/openclaw/openclaw/issues/" + intakeNumber,
    created_at: sourceCommentUpdatedAt,
    updated_at: sourceCommentUpdatedAt,
  });
  const intake = directReReviewIntake({
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: intakeNumber,
    itemKind: "pull_request",
    installationId: 999,
    sourceCommentId,
    sourceCommentUpdatedAt,
    commandBodyDigest: createHash("sha256").update(intakeBody).digest("hex"),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  assert.equal(Object.hasOwn(intake.decision, "sourceContentRevision"), false);
  assert.equal(Object.hasOwn(intake.decision, "sourceBaseSha"), false);
  assert.equal(Object.hasOwn(intake.decision, "sourceIsDraft"), false);
  await call("/internal/exact-review/command-intake", intake, 202);
  await call("/__proof/alarm", {});
  const intakeKey = "openclaw/openclaw#" + intakeNumber;
  const captured = (await state()).items[intakeKey];
  assert.ok(captured, "real command intake did not enqueue");
  if (!baseline) {
    assert.equal(
      captured.decision.sourceContentRevision,
      createHash("sha256")
        .update(JSON.stringify(exactReviewSourceRevisionMaterial(targets.get(intakeNumber))))
        .digest("hex"),
    );
    assert.equal(captured.decision.sourceBaseSha, "b".repeat(40));
    assert.equal(captured.decision.sourceIsDraft, false);
  } else assert.equal(captured.decision.sourceContentRevision, undefined);
  const intakeFixture = {
    n: intakeNumber,
    key: intakeKey,
    label: "production command intake captures source identity",
    address: { status_marker: intake.decision.commandStatusMarker },
    expected: { stage: "workflow", reason: "unknown" },
  };
  await completeFailure(intakeFixture, {
    stage: "workflow",
    reason_code: "unknown",
    retryable: true,
  });
  await stop();
  await start();
  if (!baseline)
    assert.equal(
      (await state()).items[intakeKey].decision.sourceContentRevision,
      captured.decision.sourceContentRevision,
    );
  await settle(intakeFixture);
  results.push({
    scenario: "production intake captures source identity before stopped settlement",
    client_supplied_source_identity: false,
    source_identity_persisted: !baseline,
  });
  if (!baseline)
    for (const [i, race] of [
      "command",
      "revision",
      "head",
      "body",
      "base",
      "draft",
      "labels",
      "locked",
    ].entries()) {
      const f = await seed(990180 + i, "lookup race " + race);
      await call("/__proof/park", { key: f.key });
      await settle(f, race);
    }
  if (!baseline) {
    const f = await seed(990089, "stopped acknowledgement followed by closure");
    await call("/__proof/park", { key: f.key });
    await settle(f);
    const retained = (await state()).items[f.key];
    const originalBudgets = budgets(retained);
    Object.assign(targets.get(f.n), {
      state: "closed",
      closed_at: "2026-09-17T10:00:00Z",
      updated_at: "2026-09-17T10:00:00Z",
    });
    await call("/__proof/park", { key: f.key });
    const tuple = await claim(await waitDispatch(f.key, true));
    assert.ok(tuple.lease_revision > retained.revision);
    assert.deepEqual(budgets((await state()).items[f.key]), originalBudgets);
    const attempt = await call("/internal/exact-review/terminal-finalization/attempt", {
      ...tuple,
      ...f.address,
    });
    assert.equal(attempt.allowed, true);
    assert.equal(attempt.terminal_disposition, "target_closed");
    const before = writes;
    const result = await statusCli(f, tuple, attempt);
    assert.equal(writes - before, 1);
    const receipt = {
      canonical_target_key: f.key,
      fence_key: f.key,
      revision: tuple.lease_revision,
      ...f.address,
      command_comment_id: Number(result.command_comment_id),
      completion_comment_id: Number(result.completion_comment_id),
      completed_at: result.completion_completed_at,
      completion_outcome: "failure",
      observed_at: Date.now(),
    };
    await call("/internal/exact-review/lifecycle/command-ack/observed", receipt);
    assert.equal((await state()).items[f.key], undefined);
    receipts.push({ scenario: f.label, tuple, attempt, receipt });
    results.push({
      scenario: f.label,
      fresh_fenced_cleanup: true,
      unchanged_budgets_before_receipt: true,
      review_restarts: 0,
    });
  }
  const privateFixture = await seed(990097, "repository visibility revoked");
  await call("/__proof/park", { key: privateFixture.key });
  privateRepository = true;
  const privateDispatches = dispatches.length;
  await call("/__proof/alarm", {});
  assert.equal(dispatches.length, privateDispatches);
  assert.equal((await state()).items[privateFixture.key].state, "parked");
  privateRepository = false;
  const settlement = dispatches.filter((d) => d.phase !== "completion-fixture");
  assert.ok(
    settlement.every(
      (d) => d.client_payload?.source_action === "exact_review_command_acknowledgement",
    ),
    "settlement dispatched real review/repair/merge",
  );
  const preliminary = dispatches.filter((d) => d.phase === "completion-fixture");
  const allowedFixtureNumbers = new Set([990080, 990081, 990082, 990083, 990084]);
  assert.ok(
    dispatches.every(
      (d) =>
        d.client_payload?.source_action === "exact_review_command_acknowledgement" ||
        (d.phase === "completion-fixture" &&
          ["legacy_dispatch", "re_review"].includes(d.client_payload?.source_action) &&
          allowedFixtureNumbers.has(d.client_payload?.item_number)),
    ),
    "unexpected review/repair/merge dispatch",
  );
  assert.ok(
    preliminary.filter(
      (d) => d.client_payload?.source_action !== "exact_review_command_acknowledgement",
    ).length === 5,
    "exactly five controlled review completion dispatches",
  );
  results.push({
    scenario: "dispatch isolation",
    preliminary_completion_dispatches: preliminary.length,
    acknowledgement_only_settlement_dispatches: settlement.length,
    settlement_review_repair_merge_dispatches: 0,
  });
  succeeded = true;
} catch (error) {
  jsonFile("failure.json", { phase, error: String(error), stack: error.stack });
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(dir, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const proc of subprocesses) await stopProcess(proc);
  await stop();
  await closeServer(pageServer);
  await closeServer(stub);
  if (createdVars) fs.rmSync(path.join(config, ".dev.vars"), { force: true });
  jsonFile("http-trace.json", trace);
  jsonFile("receipts.json", receipts);
  jsonFile("dispatches.json", dispatches);
  jsonFile("comments.json", [...comments.values()]);
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "src",
      "dashboard",
      ".github/workflows/sweep.yml",
      "package.json",
      "pnpm-lock.yaml",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of [
    "src/review-failure-explanation.ts",
    "dashboard/bay-review-status.ts",
    "dashboard/bay-activity-kind.ts",
    ...fs
      .readdirSync(config)
      .filter((f) => !f.startsWith("."))
      .map((f) => "docs/proof/review-failure-attention/" + f),
  ])
    if (!files.includes(file) && fs.existsSync(file)) files.push(file);
  const manifest = Object.fromEntries(
    files
      .filter((f) => fs.statSync(f).isFile())
      .sort()
      .map((f) => [f, createHash("sha256").update(fs.readFileSync(f)).digest("hex")]),
  );
  jsonFile("source-manifest.json", manifest);
  jsonFile("result.json", {
    passed: succeeded,
    mode: baseline ? "baseline" : "candidate",
    source_head: sourceHead,
    source_diff_sha256: createHash("sha256")
      .update(execFileSync("git", ["diff", "HEAD"]))
      .digest("hex"),
    node: process.version,
    wrangler: "4.131.1",
    verified_at: new Date().toISOString(),
    runtime:
      "real local workerd SQLite / signed production HTTP / compiled production CLI / Chromium",
    results,
    status_patches: writes,
    limits:
      "Controlled seed exhaustion and external GitHub responses. Five preliminary fixture reviews are counted separately; no deployed Worker, real GitHub write, hosted Actions job, live repair execution or claim about historical failure causes. Screenshots require parent visual inspection.",
  });
}
console.log(
  "REVIEW_FAILURE_ATTENTION_PROOF_PASS " + (baseline ? "baseline" : "candidate") + " " + dir,
);
