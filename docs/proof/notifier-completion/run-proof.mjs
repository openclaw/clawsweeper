import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "notifier-completion-proof-"));
const date = "2026-09-11";
const results = [];
const responses = {
  delivered: { status: "ok", delivered: true, deliveryAttempted: true, replyDisposition: "visible" },
  suppressed: { status: "error", delivered: false, deliveryAttempted: false, replyDisposition: "silent" },
  "channel-transform": { status: "ok", delivered: false, deliveryAttempted: true, replyDisposition: "visible", deliverySuppressionReason: "channel_transform" },
  failed: { status: "error", delivered: false, deliveryAttempted: true, deliveryError: "synthetic delivery failure" },
  unknown: { status: "skipped", delivered: false },
  "unacknowledged-empty": { status: "ok", delivered: false, deliveryAttempted: true, replyDisposition: "empty" },
  "unacknowledged-visible": { status: "ok", delivered: false, deliveryAttempted: true, replyDisposition: "visible" },
  "missing-flags": { status: "ok", replyDisposition: "empty" },
  "missing-attempted": { status: "ok", delivered: false, replyDisposition: "empty" },
  "missing-delivered": { status: "ok", deliveryAttempted: false, replyDisposition: "empty" },
  "not-requested": { status: "ok", delivered: false, deliveryAttempted: false, replyDisposition: "empty" },
};

async function scenario(surface, outcome) {
  const root = join(scratch, `${surface}-${outcome}`);
  mkdirSync(root);
  const hooks = [];
  const dashboard = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      let result;
      if (request.url === "/hooks/agent") {
        assert.equal(request.headers.authorization, "Bearer synthetic-hook-proof");
        const payload = JSON.parse(body);
        assert.equal(payload.waitForCompletion, true);
        assert.equal(request.headers["idempotency-key"], payload.idempotencyKey);
        hooks.push(payload);
        result = { ok: true, runId: "synthetic-hook-run", ...(outcome === "admitted" ? {} : { completion: responses[outcome] }) };
      } else if (request.url === "/events") {
        dashboard.push(JSON.parse(body));
        result = { ok: true };
      } else if (request.url === "/reports/index.json") {
        const entry = { period: "day", key: date, href: `day/${date}/`, data: `day/${date}/data.json` };
        result = { latest: { day: entry }, entries: [entry] };
      } else if (request.url === `/reports/day/${date}/data.json`) {
        result = { period: { period: "day", key: date, title: "Synthetic report" }, totals: { github: { commits: 1, prsMerged: 1, issueComments: 1 }, discord: { messages: 1 } }, maintainerCount: 1, activeMaintainers: 1, summary: { highlights: ["Synthetic local proof"] }, maintainers: [] };
      } else throw new Error("Unexpected proof request");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const input = join(root, "input.json");
    const ledger = join(root, "ledger.json");
    const report = join(root, "report.json");
    const stepSummary = join(root, "summary.md");
    const ledgered = surface === "merge" || surface === "events";
    writeFileSync(input, JSON.stringify(surface === "github-activity" ? {
      action: "opened", repository: { full_name: "openclaw/clawsweeper" }, sender: { login: "synthetic-contributor" },
      issue: { number: 123, title: "Synthetic proof", body: "Synthetic local issue", state: "open", html_url: "https://github.com/openclaw/clawsweeper/issues/123", labels: [] },
    } : [{ repo: "openclaw/clawsweeper", target: "#123", action: "merge_canonical", status: "executed", reason: "merged by clawsweeper-repair", title: "Synthetic proof", merge_commit_sha: "a".repeat(40), run_id: "987", published_at: date+"T10:00:00Z" }]));
    const args = ["--write-report", "--report", report];
    if (ledgered) args.push("--input", input, "--ledger", ledger, "--run-id", "987");
    else if (surface === "maintainer-report") args.push("--base-url", origin+"/reports/", "--public-base-url", origin+"/reports/", "--date", date);
    else args.push("--input", input, "--event", "issues");
    const env = {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
      CLAWSWEEPER_OPENCLAW_HOOK_URL: origin+"/hooks", CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "synthetic-hook-proof",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123", CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "1",
      CLAWSWEEPER_MAINTAINER_REPORT_DELIVER: "0", CLAWSWEEPER_GITHUB_ACTIVITY_DELIVER: "0",
      CLAWSWEEPER_STATUS_INGEST_URL: origin+"/events", CLAWSWEEPER_STATUS_INGEST_TOKEN: "synthetic-status-proof",
      GITHUB_STEP_SUMMARY: stepSummary,
    };
    const execute = async () => {
      const child = spawn(process.execPath, [join(repo, `dist/repair/notify-${surface}.js`), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      let output = "";
      child.stdout.on("data", chunk => output += chunk);
      child.stderr.on("data", chunk => output += chunk);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, output);
      assert.ok(existsSync(report), output);
      return JSON.parse(readFileSync(report, "utf8"));
    };
    const first = await execute();
    const expected = outcome.startsWith("unacknowledged-") || outcome.startsWith("missing-") ? "unknown" : outcome === "channel-transform" ? "suppressed" : outcome === "not-requested" && ledgered ? "unknown" : outcome;
    const actual = ledgered ? first.actions[0].delivery.status : first.delivery.status;
    assert.equal(actual, expected, `${surface}/${outcome}`);
    assert.equal(hooks.length, 1);
    if (surface === "events") assert.equal(dashboard.length, 1, "dashboard publication survives inconclusive hook completion");
    if (surface === "github-activity") assert.ok(readFileSync(stepSummary, "utf8").includes(expected));
    const conclusive = ["delivered", "admitted", "suppressed", "not-requested"].includes(expected);
    if (ledgered) {
      const entries = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")).notifications.length : 0;
      assert.equal(entries, conclusive ? 1 : 0);
      const second = await execute();
      assert.equal(hooks.length, conclusive ? 1 : 2);
      if (conclusive) assert.equal(second.skipped, 1);
      else {
        assert.equal(hooks[0].idempotencyKey, hooks[1].idempotencyKey);
        assert.equal(second.actions[0].delivery.status, expected);
        assert.equal(existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")).notifications.length : 0, 0);
        if (surface === "events") assert.equal(dashboard.length, 2);
      }
    }
    assert.deepEqual(failures, []);
    results.push({ surface, scenario: outcome, outcome: expected, hook_requests: hooks.length, dashboard_requests: dashboard.length, persisted_ledger: ledgered ? conclusive : null, rerun: ledgered ? (conclusive ? "deduped" : "retryable with same key") : "gateway owns idempotency" });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

try {
  for (const surface of ["merge", "events", "maintainer-report", "github-activity"])
    for (const outcome of ["delivered", "suppressed", "channel-transform", "failed", "unknown", "unacknowledged-empty", "unacknowledged-visible", "missing-flags", "missing-attempted", "missing-delivered", "admitted", "not-requested"])
      await scenario(surface, outcome);
  const receipt = { runtime: process.version, source_sha256: createHash("sha256").update(readFileSync(join(repo, "src/repair/openclaw-hook.ts"))).digest("hex"), real_built_clis: 4, scenarios: results.length, results, production_mutations: 0, limits: "Synthetic Gateway responses over real loopback HTTP; deployed OpenClaw compatibility and Discord delivery are not established." };
  mkdirSync(join(repo, ".artifacts"), { recursive: true });
  writeFileSync(join(repo, ".artifacts/notifier-completion-proof.json"), JSON.stringify(receipt, null, 2)+"\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
