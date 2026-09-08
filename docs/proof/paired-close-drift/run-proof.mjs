import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { createReviewedPrActivityCursorV2 } from "../../../dist/review-activity-cursor.js";
import { workPlanCandidateReport, reportWithSyncedReviewComment } from "../../../test/helpers.ts";

const source = process.cwd();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pair-proof-")));
const output = path.resolve(process.argv[2] || ".artifacts/paired-close-drift");
fs.mkdirSync(output, { recursive: true });
const transport = fileURLToPath(new URL("./api-server.cjs", import.meta.url));
const nativeGh = process.env.PAIR_NATIVE_GH || "/opt/homebrew/bin/gh";
let server;
async function stopServer() {
  const child = server;
  server = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }
}

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
const socketDirs = [];
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
      ...(pr
        ? {
            pull_head_sha: state.head,
            review_activity_cursor: createReviewedPrActivityCursorV2({
              reviews: [],
              inlineComments: [],
              reviewThreads: [],
            }),
          }
        : {}),
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
      const portFile = path.join(root, "port");
      const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-"));
      socketDirs.push(socketDir);
      const socketPath = path.join(socketDir, "s");
      server = spawn(process.execPath, [transport], {
        env: {
          PAIR_PROOF_ROOT: root,
          PAIR_SOCKET: socketPath,
          PAIR_PORT_FILE: portFile,
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      for (let i = 0; i < 100 && !fs.existsSync(portFile); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fs.existsSync(portFile), "local HTTP socket server started");
      fs.mkdirSync(path.join(root, "gh-config"));
      fs.writeFileSync(
        path.join(root, "gh-config/config.yml"),
        "telemetry: disabled\nhttp_unix_socket: " + socketPath + "\n",
      );
      const env = {
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR,
        HOME: root,
        XDG_STATE_HOME: path.join(root, "gh-state"),
        GH_BIN: nativeGh,
        GH_HOST: "github.com",
        GH_TOKEN: "synthetic-pair-proof-token",
        GH_CONFIG_DIR: path.join(root, "gh-config"),
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      };
      if (variant === "baseline")
        console.log(
          JSON.stringify({
            client: execFileSync(nativeGh, ["--version"], {
              encoding: "utf8",
              env,
              cwd: root,
            }).split("\n")[0],
            transport: "native gh HTTP over Unix socket",
            scenario,
            baseline: execFileSync("git", ["rev-parse", "origin/main"], {
              encoding: "utf8",
            }).trim(),
          }),
        );
      if (scenario === "stable" && variant === "baseline") {
        const before = fs.readFileSync(path.join(root, "state.json"), "utf8");
        for (const input of [
          { labelableId: "UNKNOWN_TARGET", labelIds: [] },
          { labelableId: "PR_321", labelIds: ["L_UNKNOWN_LABEL"] },
        ]) {
          const file = path.join(root, "invalid-label.json");
          fs.writeFileSync(
            file,
            JSON.stringify({
              query:
                "mutation LabelAdd($input:AddLabelsToLabelableInput!){addLabelsToLabelable(input:$input){__typename}}",
              variables: { input },
            }),
          );
          const rejected = spawnSync(nativeGh, ["api", "graphql", "--input", file], {
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
          assert.equal(rejected.status, 1, "native gh must reject invalid mutation IDs");
          assert.equal(
            fs.readFileSync(path.join(root, "state.json"), "utf8"),
            before,
            "invalid IDs must not mutate fixture state",
          );
        }
        const wrongMethod = spawnSync(
          nativeGh,
          ["api", "--method", "POST", "search/issues?q=fixture"],
          { env, cwd: root, encoding: "utf8", timeout: 10_000 },
        );
        assert.equal(wrongMethod.status, 1, "read-only route must reject native POST");
        assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), before);
        console.log(
          JSON.stringify({
            invalidGraphqlTargetsAndLabels: "rejected without state mutation",
            wrongReadMethod: "rejected without state mutation",
          }),
        );
      }
      const result = spawnSync(process.execPath, args, {
        cwd: runtime,
        env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      await stopServer();
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
        assert.match(result.stderr, /synthetic counterpart refresh failure/);
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
        wireRequests: trace.filter((x) => x.method).length,
        graphqlCloseRequests: trace.filter(
          (x) => x.event === "graphql" && x.query.includes("closePullRequest"),
        ).length,
      });
    }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
} finally {
  await stopServer();
  for (const dir of socketDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
