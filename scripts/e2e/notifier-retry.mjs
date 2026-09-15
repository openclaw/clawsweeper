import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
const root = process.cwd();
const baseline = process.argv.includes("--baseline");
assert.ok(process.argv.slice(2).every((arg) => arg === "--baseline"));
const receipts = [];
for (const scenario of ["transient-success", "exhausted", "permanent"]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notifier-retry-"));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (x) => (body += x));
    req.on("end", () => {
      requests.push({ key: req.headers["idempotency-key"], body });
      const status =
        scenario === "permanent"
          ? 401
          : scenario === "exhausted" || requests.length === 1
            ? 503
            : 200;
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(
        status === 200
          ? JSON.stringify({ ok: true, runId: "synthetic-run" })
          : "synthetic HTTP failure",
      );
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const input = path.join(dir, "input.json"),
      ledger = path.join(dir, "ledger.json"),
      report = path.join(dir, "report.json");
    writeFileSync(
      input,
      JSON.stringify([
        {
          repo: "example/retry-fixture",
          target: 1,
          action: "merge_candidate",
          status: "executed",
          merge_commit_sha: "a".repeat(40),
        },
      ]),
    );
    const child = spawn(
      process.execPath,
      [
        path.join(root, "dist/repair/notify-merge.js"),
        "--input",
        input,
        "--ledger",
        ledger,
        "--report",
        report,
        "--strict",
      ],
      {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          TMPDIR: os.tmpdir(),
          CLAWSWEEPER_OPENCLAW_HOOK_URL: `http://127.0.0.1:${server.address().port}/hooks`,
          CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "synthetic-fixture",
          CLAWSWEEPER_DISCORD_TARGET: "synthetic-target",
          CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "2",
          CLAWSWEEPER_OPENCLAW_HOOK_TIMEOUT_SECONDS: "1",
        },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));
    const observed = {
      scenario,
      exitCode,
      requests: requests.length,
      reportWritten: existsSync(report),
      ledgerEntries: existsSync(ledger)
        ? JSON.parse(readFileSync(ledger, "utf8")).notifications.length
        : 0,
      summary: stdout.trim() ? JSON.parse(stdout) : null,
    };
    if (baseline && scenario !== "permanent") {
      assert.equal(exitCode, 0);
      assert.equal(requests.length, 1);
      assert.equal(observed.reportWritten, false);
      assert.equal(observed.summary, null);
    } else {
      assert.equal(exitCode, scenario === "transient-success" ? 0 : 1, stderr);
      assert.equal(requests.length, scenario === "permanent" ? 1 : 2);
      assert.equal(observed.reportWritten, true);
      assert.equal(observed.ledgerEntries, scenario === "transient-success" ? 1 : 0);
      assert.equal(observed.summary.failed, scenario === "transient-success" ? 0 : 1);
      assert.ok(requests.every((x) => x.key === requests[0].key && x.body === requests[0].body));
    }
    receipts.push(observed);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      mode: baseline ? "baseline" : "candidate",
      node: process.version,
      ownerSha256: createHash("sha256")
        .update(readFileSync(path.join(root, "dist/repair/openclaw-hook.js")))
        .digest("hex"),
      surface: "built merge notifier CLI, real loopback HTTP and temporary filesystem",
      receipts,
      limits: "Synthetic Gateway responses only; no external message or live notification sent.",
    },
    null,
    2,
  ),
);
