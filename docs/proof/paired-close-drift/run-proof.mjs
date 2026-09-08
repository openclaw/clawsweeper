import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { workPlanCandidateReport, reportWithSyncedReviewComment } from "../../../test/helpers.ts";

const source = process.cwd();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pair-proof-")));
const output = path.resolve(process.argv[2] || ".artifacts/paired-close-drift");
fs.mkdirSync(output, { recursive: true });
const transport = fileURLToPath(new URL("./gh.cjs", import.meta.url));
const owners = [
  "clawsweeper-apply-close-policies",
  "clawsweeper-apply-candidate-guards",
  "clawsweeper-apply-close-guards",
  "clawsweeper-context-hydration",
  "clawsweeper-apply-dependencies",
  "clawsweeper-apply-decision-workflow",
  "clawsweeper-apply-close-execution",
];
const runtimes = {};
const summary = [];
function initialize(root, scenario) {
  for (const name of ["items", "closed", "plans", "baselines", "artifacts"])
    fs.mkdirSync(path.join(root, name), { recursive: true });
  const state = {
    scenario,
    triggered: false,
    head: "1".repeat(40),
    base: "2".repeat(40),
    items: {},
    comments: {},
    labels: {},
    nextComment: 10000,
  };
  for (const number of [321, 322]) {
    const pr = number === 321;
    const title = pr ? "Synthetic pair PR" : "Synthetic pair issue";
    let report = workPlanCandidateReport({
      repository: "openclaw/openclaw",
      number,
      type: pr ? "pull_request" : "issue",
      title,
      author: "fixture-author",
      author_association: "CONTRIBUTOR",
      labels: "[]",
      decision: "close",
      action_taken: "proposed_close",
      close_reason: "not_actionable_in_repo",
      confidence: "high",
      work_candidate: "none",
      work_status: "none",
      item_snapshot_hash: "reviewed-snapshot",
      item_created_at: "2026-01-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      reviewed_at: "2026-09-08T00:00:00Z",
      ...(pr ? { pull_head_sha: state.head } : {}),
    });
    report = report.replace(
      "The dashboard has queue_fix_pr candidates but no generated coding plan.",
      "These synthetic requests cannot be acted on within this repository.",
    );
    report +=
      "\n## Evidence\n\n- **repository boundary:** synthetic request targets behavior outside this repository.\n\n## Close Comment\n\nClosing this synthetic request because it is not actionable in this repository.\n";
    const synced = reportWithSyncedReviewComment(report, number, "not_actionable_in_repo");
    fs.writeFileSync(
      path.join(root, "items", number + ".md"),
      synced.report.replaceAll(
        "github.com/openclaw/clawsweeper/issues/",
        "github.com/openclaw/openclaw/issues/",
      ),
    );
    const closed = number === 322 && scenario === "reopened";
    state.items[number] = {
      number,
      title,
      body: pr ? "Related issue #322." : "Related PR #321.",
      html_url: `https://github.com/openclaw/openclaw/${pr ? "pull" : "issues"}/${number}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      state: closed ? "closed" : "open",
      closed_at: closed ? "2026-05-01T00:00:00Z" : null,
      locked: false,
      active_lock_reason: null,
      user: { login: "fixture-author", type: "User" },
      author_association: "CONTRIBUTOR",
      labels: [],
      comments: 1,
      ...(pr
        ? { pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" } }
        : {}),
    };
    state.comments[number] = [
      {
        id: 9000 + number,
        html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9000 + number}`,
        created_at: "2026-05-01T01:00:00Z",
        updated_at: "2026-05-01T01:00:00Z",
        user: { login: "clawsweeper[bot]", type: "Bot" },
        body: synced.comment,
      },
    ];
  }
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
}
try {
  for (const variant of ["baseline", "candidate"]) {
    const runtime = path.join(scratch, variant);
    runtimes[variant] = runtime;
    fs.mkdirSync(runtime);
    for (const name of ["dist", "config", "schema", "prompts", "package.json"])
      fs.cpSync(path.join(source, name), path.join(runtime, name), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    fs.symlinkSync(path.join(source, "node_modules"), path.join(runtime, "node_modules"), "dir");
    if (variant === "baseline")
      for (const name of owners) {
        const src = execFileSync("git", ["show", `origin/main:src/${name}.ts`], {
          encoding: "utf8",
        });
        fs.writeFileSync(path.join(runtime, "dist", name + ".js"), stripTypeScriptTypes(src));
      }
  }
  const scenarios = process.argv[3]
    ? [process.argv[3]]
    : ["stable", "locked", "read-failure", "reopened"];
  for (const scenario of scenarios)
    for (const variant of ["baseline", "candidate"]) {
      const root = path.join(scratch, variant + "-" + scenario);
      fs.mkdirSync(root);
      initialize(root, scenario);
      const runtime = runtimes[variant];
      const args = [
        path.join(runtime, "dist/clawsweeper.js"),
        "apply-decisions",
        "--target-repo",
        "openclaw/openclaw",
        "--apply-kind",
        "all",
        "--apply-close-reasons",
        "not_actionable_in_repo",
        "--item-numbers",
        "321,322",
        "--cursor-trace",
        path.join(root, "cursor.json"),
        "--limit",
        "2",
        "--processed-limit",
        "6",
        "--min-age-days",
        "0",
        "--close-delay-ms",
        "0",
        "--skip-dashboard",
        "--record-root",
        runtime,
        "--items-dir",
        path.join(root, "items"),
        "--closed-dir",
        path.join(root, "closed"),
        "--plans-dir",
        path.join(root, "plans"),
        "--report-path",
        path.join(root, "apply-report.json"),
        "--artifact-dir",
        path.join(root, "artifacts"),
        "--canonical-record-baseline-dir",
        path.join(root, "baselines"),
      ];
      const env = {
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR,
        GH_BIN: process.execPath,
        GH_BIN_ARGS: JSON.stringify([transport]),
        PAIR_PROOF_ROOT: root,
      };
      const result = spawnSync(process.execPath, args, {
        cwd: runtime,
        env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const tag = variant + "-" + scenario;
      fs.writeFileSync(path.join(output, tag + ".stdout.log"), result.stdout || "");
      fs.writeFileSync(path.join(output, tag + ".stderr.log"), result.stderr || "");
      const reportPath = path.join(root, "apply-report.json");
      const report = fs.existsSync(reportPath)
        ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
        : null;
      const tracePath = path.join(root, "trace.jsonl");
      const trace = fs.existsSync(tracePath)
        ? fs.readFileSync(tracePath, "utf8").trim().split("\n").map(JSON.parse)
        : [];
      fs.writeFileSync(
        path.join(output, tag + ".json"),
        JSON.stringify({ exit: result.status, report, trace }, null, 2),
      );
      const closes = trace.filter((x) => x.event === "close").map((x) => x.number);
      const note = trace.some((x) => x.event === "parent-closeout-note");
      const refreshed = trace.some(
        (x) => x.afterNote && x.method === "GET" && x.path === "repos/openclaw/openclaw/issues/322",
      );
      console.log(
        JSON.stringify({ variant, scenario, exit: result.status, note, refreshed, closes, report }),
      );
      assert.equal(result.status, scenario === "read-failure" ? 1 : 0, `${tag}: ${result.stderr}`);
      if (scenario === "read-failure")
        assert.match(result.stderr, /HTTP 422: synthetic counterpart refresh failure/);
      assert.equal(note, true, `${tag}: must reach the parent closeout note`);
      assert.equal(
        closes.includes(321),
        variant === "baseline" || scenario === "stable",
        `${tag}: parent close`,
      );
      if (variant === "candidate")
        assert.equal(refreshed, true, `${tag}: fresh counterpart read after note`);
      if (scenario === "stable") assert.deepEqual(closes, [321, 322]);
      summary.push({
        variant,
        scenario,
        exit: result.status,
        closes,
        postNoteCounterpartRead: refreshed,
      });
    }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
