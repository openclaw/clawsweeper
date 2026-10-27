import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { implementedCloseReport, reportWithSyncedReviewComment } from "../../test/helpers.ts";
import { itemSourceRevisionSha256 } from "../../dist/clawsweeper-source-revision.js";
import { sha256 } from "../../dist/content-hash.js";
import { stableJson } from "../../dist/stable-json.js";
import { renderReviewStartStatusComment } from "../../dist/clawsweeper-review-comment-state.js";
import { terminateCodexProcessTree } from "../../dist/codex-spawn.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const issueCloseProofScenarios = [
  "no_drift",
  "owned_write",
  "late_lock",
  "same_second_lock",
  "same_review_second_lock",
  "late_closed",
  "reopened",
  "human_activity",
  "post_receipt_lock",
  "initially_locked",
  "same_review_second_activity",
  "legacy_owned_write",
  "legacy_late_lock",
  "legacy_human_activity",
  "legacy_missing_source",
  "legacy_missing_source_synced",
  "legacy_bot_source_edit",
];

// Each test owns one scenario instead of sharing an opaque whole-matrix timeout.
// The standalone proof still executes the complete matrix in one invocation.
export async function runIssueCloseProof({ artifactDir, scenario: selected, signal } = {}) {
  const retained = artifactDir !== undefined;
  const artifactRoot = retained ? resolve(artifactDir) : tmpdir();
  mkdirSync(artifactRoot, { recursive: true });
  const output = mkdtempSync(join(artifactRoot, retained ? "run-" : "issue-close-proof-"));
  const results = [];
  try {
    for (const scenario of issueCloseProofScenarios) {
      if (selected && selected !== scenario) continue;
      signal?.throwIfAborted();
      const startedAt = Date.now();
      console.error(`[issue-close-proof] start ${scenario}`);
      const dir = join(output, scenario);
      mkdirSync(dir, { recursive: true });
      for (const name of ["items", "closed", "plans"]) mkdirSync(join(dir, name));
      const title = "Preserve issue state during apply";
      const body = "The requested implementation is already on main.";
      const reviewed = new Date(Date.now() - 600_000).toISOString();
      const written = scenario.includes("same_review_second")
        ? reviewed
        : new Date(Date.now() - 120_000).toISOString();
      const changed = new Date(Date.now() - 119_000).toISOString();
      const source = itemSourceRevisionSha256({ title, body, labels: [] }, [], "issue");
      const leaseOwner = "issue-close-proof";
      const lease = {
        id: 77,
        user: { login: "clawsweeper[bot]", type: "Bot" },
        created_at: reviewed,
        updated_at: reviewed,
        body: renderReviewStartStatusComment({
          number: 321,
          kind: "issue",
          title,
          headSha: source,
          startedAt: reviewed,
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          leaseOwner,
        }),
      };
      let report = implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "issue",
        title,
        item_updated_at: reviewed,
        reviewed_at: reviewed,
        ...(scenario.startsWith("legacy_missing_source") ? {} : { item_source_revision: source }),
        ...(scenario.startsWith("legacy_")
          ? {}
          : { review_timeline_revision: sha256(stableJson([])) }),
        review_lease_owner: leaseOwner,
        review_lease_comment_id: "77",
        labels: "[]",
      });
      let initialComment = null;
      if (scenario === "legacy_missing_source_synced") {
        const synced = reportWithSyncedReviewComment(report, 321, "implemented_on_main");
        report = synced.report;
        initialComment = synced.comment;
      }
      writeFileSync(join(dir, "items/321.md"), report);
      writeFileSync(
        join(dir, "fixture.json"),
        JSON.stringify({
          scenario,
          title,
          body,
          reviewed,
          written,
          changed,
          lease,
          initialComment,
        }),
      );
      const boundary = spawn(
        process.execPath,
        ["scripts/e2e/apply-issue-close-freshness-server.mjs", dir],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
      );
      const boundaryExit = once(boundary, "close");
      let cli;
      let cliExit;
      let cliDeadline;
      let cliTimedOut = false;
      let cliWasStopped = false;
      const stopTimers = [];
      const stop = (child, group = false, force = false) => {
        if (!child?.pid || (!force && (child.exitCode !== null || child.signalCode !== null)))
          return;
        if (group) {
          cliWasStopped = true;
          const timer = terminateCodexProcessTree(child, force ? "SIGKILL" : "SIGTERM");
          if (timer) stopTimers.push(timer);
          return;
        }
        const kill = (signal) => {
          try {
            child.kill(signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        };
        if (force) {
          kill("SIGKILL");
          return;
        }
        kill("SIGTERM");
        const timer = setTimeout(() => kill("SIGKILL"), 1_000);
        timer.unref();
        stopTimers.push(timer);
      };
      const abort = () => {
        stop(cli, true);
        stop(boundary);
      };
      signal?.addEventListener("abort", abort, { once: true });
      let startup = "";
      boundary.stdout.setEncoding("utf8");
      boundary.stdout.on("data", (chunk) => {
        startup += chunk;
      });
      const deadline = setTimeout(() => boundary.kill(), 90_000);
      try {
        while (!startup.includes("\n")) {
          await Promise.race([
            once(boundary.stdout, "data"),
            boundaryExit.then(() => {
              throw new Error("controlled GitHub boundary exited before startup");
            }),
          ]);
        }
        const port = Number(startup.split("\n")[0]);
        assert.ok(port > 0);
        signal?.throwIfAborted();
        const shim = join(dir, "gh.mjs");
        writeFileSync(
          shim,
          [
            'import { readFileSync } from "node:fs";',
            'const args = process.argv.slice(2); const index = args.indexOf("--input");',
            'const input = index < 0 ? null : JSON.parse(readFileSync(args[index + 1], "utf8"));',
            'const response = await fetch("http://127.0.0.1:' +
              port +
              '/gh", {method:"POST",body:JSON.stringify({args,input})});',
            'const result = await response.json(); process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); process.exitCode = result.status ?? 0;',
          ].join("\n"),
        );
        cli = spawn(
          process.execPath,
          [
            "dist/clawsweeper.js",
            "apply-decisions",
            "--target-repo",
            "openclaw/openclaw",
            "--skip-dashboard",
            "--item-number",
            "321",
            "--items-dir",
            join(dir, "items"),
            "--closed-dir",
            join(dir, "closed"),
            "--plans-dir",
            join(dir, "plans"),
            "--report-path",
            join(dir, "apply-report.json"),
            "--close-delay-ms",
            "0",
            "--limit",
            "1",
            "--processed-limit",
            "10",
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: dir,
              TMPDIR: process.env.TMPDIR ?? tmpdir(),
              SYSTEMROOT: process.env.SYSTEMROOT,
              GH_BIN: process.execPath,
              GH_BIN_ARGS: JSON.stringify([shim]),
              CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
          },
        );
        cliExit = once(cli, "close");
        writeFileSync(
          join(dir, "processes.json"),
          JSON.stringify({ boundaryPid: boundary.pid, cliPid: cli.pid }),
        );
        cliDeadline = setTimeout(() => {
          cliTimedOut = true;
          stop(cli, true);
        }, 60_000);
        let stdout = "",
          stderr = "";
        cli.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        cli.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const [status] = await cliExit;
        clearTimeout(cliDeadline);
        writeFileSync(join(dir, "cli.stdout.log"), stdout);
        writeFileSync(join(dir, "cli.stderr.log"), stderr);
        signal?.throwIfAborted();
        assert.equal(
          status,
          0,
          `${scenario}: ${cliTimedOut ? "CLI timed out after 60000ms" : stderr}`,
        );
        const observed = await (await fetch("http://127.0.0.1:" + port + "/state")).json();
        const applied = JSON.parse(readFileSync(join(dir, "apply-report.json"), "utf8"));
        const result = {
          scenario,
          durationMs: Date.now() - startedAt,
          closePatchCount: observed.closePatchCount,
          lockReads: observed.lockReads,
          durableWrites: observed.durableWrites,
          archived: existsSync(join(dir, "closed/321.md")),
          results: applied,
        };
        results.push(result);
        writeFileSync(join(output, "result.json"), JSON.stringify(results, null, 2) + "\n");
        if (["no_drift", "owned_write", "legacy_owned_write"].includes(scenario)) {
          assert.equal(result.closePatchCount, 1, JSON.stringify(result));
          assert.equal(result.archived, true);
        } else {
          if (["initially_locked", "legacy_missing_source_synced"].includes(scenario))
            assert.equal(result.durableWrites, 0);
          else
            assert.ok(
              result.durableWrites > 0,
              "race must occur after actual durable review write",
            );
          assert.equal(result.closePatchCount, 0, JSON.stringify(result));
          assert.equal(result.archived, false);
          assert.ok(
            applied.some((entry) => entry.action.startsWith("skipped_")),
            JSON.stringify(applied),
          );
          assert.equal(
            existsSync(join(dir, "items/321.md")),
            true,
            "skipped report must not be archived",
          );
        }
      } catch (error) {
        writeFileSync(
          join(dir, "failure.json"),
          JSON.stringify({ scenario, durationMs: Date.now() - startedAt, error: error.message }),
        );
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        clearTimeout(cliDeadline);
        clearTimeout(deadline);
        stop(cli, true);
        if (cliExit) await cliExit.catch(() => {});
        if (cliWasStopped && process.platform !== "win32") stop(cli, true, true);
        stop(boundary);
        await boundaryExit.catch(() => {});
        for (const timer of stopTimers) clearTimeout(timer);
        console.error(`[issue-close-proof] finish ${scenario} ${Date.now() - startedAt}ms`);
      }
    }
    assert.ok(results.length > 0, "at least one recognized scenario must run");
    signal?.throwIfAborted();
    return results;
  } finally {
    if (!retained) rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(new Error(`proof interrupted by ${signal}`));
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => interrupt(signal);
    process.once(signal, handler);
    return [signal, handler];
  });
  try {
    const outputIndex = process.argv.indexOf("--artifact-dir");
    const results = await runIssueCloseProof({
      artifactDir: outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined,
      scenario: process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1],
      signal: controller.signal,
    });
    console.log(JSON.stringify(results, null, 2));
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
