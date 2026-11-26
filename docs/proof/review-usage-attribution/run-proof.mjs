import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { closeDecision } from "../../../test/helpers.ts";
import { writeFakeScanner } from "../../../test/agent-input-scan-helpers.ts";
import { readReviewUsageReport } from "../../../dist/review-usage-report.js";

const repository = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] || ".artifacts/review-usage-attribution/proof.json");
const baselineIndex = process.argv.indexOf("--baseline-root");
const baseline = baselineIndex !== -1;
if (baseline)
  assert.ok(process.argv[baselineIndex + 1], "--baseline-root requires a built source tree");
const cliSource = baseline ? resolve(process.argv[baselineIndex + 1]) : repository;
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "review-usage-proof-")));
const counts = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 30,
  output_tokens: 10,
  reasoning_output_tokens: 5,
};
const results = [];
const issue = {
  id: 42,
  node_id: "I_fixture",
  number: 42,
  title: "Synthetic usage receipt proof",
  body: "A controlled issue used to exercise token receipt attribution.",
  html_url: "https://github.com/openclaw/clawsweeper/issues/42",
  created_at: "2026-11-26T00:00:00Z",
  updated_at: "2026-11-26T00:00:00Z",
  state: "open",
  locked: false,
  active_lock_reason: null,
  author_association: "CONTRIBUTOR",
  user: { login: "fixture-author" },
  labels: [],
  comments: 0,
  pull_request: null,
};
const decision = closeDecision({
  decision: "keep_open",
  closeReason: "none",
  confidence: "medium",
  summary: "Keep this synthetic issue open.",
  closeComment: "",
  bestSolution: "Maintainer review of the controlled fixture.",
  workCandidate: "none",
});
function directory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
function executable(path, source) {
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
}
function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function paths(root, prefix = "ledger/v1/events") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? paths(root, prefix + "/" + entry.name) : [prefix + "/" + entry.name],
  );
}
try {
  for (const [index, scenario] of ["known", "unknown", "failed"].entries()) {
    const root = directory(join(temporary, scenario));
    writeFileSync(join(root, "package.json"), '{"type":"commonjs"}');
    const cliRoot = directory(join(root, "cli"));
    cpSync(join(cliSource, "dist"), join(cliRoot, "dist"), { recursive: true });
    for (const entry of [
      "config",
      "node_modules",
      "package.json",
      "prompts",
      "schema",
      "instructions",
    ]) {
      if (existsSync(join(cliSource, entry)))
        symlinkSync(join(cliSource, entry), join(cliRoot, entry));
    }
    const target = directory(join(root, "target"));
    git(target, "init", "-b", "main");
    writeFileSync(join(target, "tracked.txt"), "controlled tracked content\n");
    git(target, "add", "tracked.txt");
    git(target, "commit", "-m", "fixture");
    git(target, "remote", "add", "origin", ".");
    git(target, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(target, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const bin = directory(join(root, "bin"));
    const calls = join(root, "calls.jsonl");
    writeFakeScanner(bin);
    executable(
      join(bin, "gh"),
      `
const fs = require('node:fs'); const raw = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({tool:'gh',args:raw})+'\\n');
const args = raw[0] === '--repo' ? raw.slice(2) : raw;
const endpoint = args.find(x => x.startsWith('repos/')) || '';
const emit = value => { console.log(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'release') emit([]);
if (args[0] === 'issue' && args[1] === 'view') emit({closedByPullRequestsReferences:[]});
if (args.includes('graphql')) emit({data:{repository:{issue:null}}});
if (endpoint.includes('/pulls/42')) { process.stderr.write('HTTP 404 fixture issue\\n'); process.exit(1); }
if (endpoint.includes('/issues/42/timeline')) { process.stdout.write('HTTP/2 200\\n\\n[]'); process.exit(0); }
if (endpoint.includes('/issues/42/comments')) emit(args.includes('--slurp') ? [[]] : []);
if (endpoint.split('?')[0] === 'repos/openclaw/clawsweeper/issues/42') emit(${JSON.stringify(issue)});
process.stderr.write('Unexpected fixture gh call: '+JSON.stringify(args)); process.exit(2);
`,
    );
    executable(
      join(bin, "codex"),
      `
const fs = require('node:fs'); const path = require('node:path'); const child = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({tool:'codex',kind:args[0]})+'\\n');
if (args[0] === 'sandbox') {
  process.stdout.write(child.execFileSync('git',['hash-object','--no-filters','--',args.at(-1)],{encoding:'utf8'}));
  process.exit(0);
}
fs.readFileSync(0,'utf8');
if (${JSON.stringify(scenario)} !== 'unknown') {
  const directory = path.join(process.env.CODEX_HOME,'sessions','2026','11','26');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'rollout-fixture.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:${JSON.stringify(counts)}}}})+'\\n');
}
if (${JSON.stringify(scenario)} === 'failed') { process.stderr.write('Synthetic inference failure\\n'); process.exit(1); }
process.stdout.write(${JSON.stringify(JSON.stringify(decision) + "\n")});
`,
    );
    const ledger = directory(join(root, "ledger-output"));
    const runId = String(80000 + index);
    const env = {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      CI: "1",
      CODEX_HOME: directory(join(root, "codex-home")),
      CLAWSWEEPER_REVIEW_USAGE_PATH: join(root, "usage.jsonl"),
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-11-26",
      CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: ledger,
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
      CLAWSWEEPER_REFERENCING_PR_SEARCH: "0",
      CLAWSWEEPER_RELATED_GITHUB_SEARCH: "0",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW: "usage-fixture",
      GITHUB_JOB: "review",
      GITHUB_SHA: "a".repeat(40),
    };
    const child = spawnSync(
      process.execPath,
      [
        join(cliRoot, "dist/clawsweeper.js"),
        "review",
        "--local-only",
        "--verbose",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        target,
        "--item-number",
        "42",
        "--artifact-dir",
        directory(join(root, "artifacts")),
        "--items-dir",
        directory(join(root, "items")),
        "--output-retention",
        "debug",
        "--result-format",
        "json",
        "--codex-model",
        "model-test",
        "--codex-timeout-ms",
        "10000",
      ],
      { cwd: cliRoot, env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(child.error, undefined, child.error?.message);
    const diagnostic = JSON.stringify({
      scenario,
      exit: child.status,
      stdout: child.stdout.slice(-6000),
      stderr: child.stderr.slice(-6000),
      calls: existsSync(calls)
        ? readFileSync(calls, "utf8").split("\n").filter(Boolean).slice(-10)
        : [],
    });
    assert.equal(child.status, scenario === "failed" ? 1 : 0, diagnostic);
    assert.ok(existsSync(join(ledger, "ledger/v1/events")), child.stderr);
    const selected = paths(ledger).sort();
    const report = readReviewUsageReport(ledger, selected);
    assert.equal(report.rows.length, 1, child.stderr);
    const row = report.rows[0];
    assert.equal(row.producer.run_id, runId);
    assert.equal(row.producer.run_attempt, 2);
    assert.equal(row.subject.repository, "openclaw/clawsweeper");
    assert.equal(row.subject.number, 42);
    assert.ok(row.operation_id && row.attempt_id && row.subject.source_revision);
    assert.equal(report.coverage.actual_billing, "unavailable");
    if (scenario === "unknown" || baseline) assert.equal(row.usage, null);
    else assert.deepEqual(row.usage, { input_tokens: 100, output_tokens: 10 });
    assert.equal(row.outcome, scenario === "failed" ? "failed" : "completed", child.stderr);
    const handoff = readFileSync(join(root, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(handoff.length, 1);
    assert.deepEqual(handoff[0].usage, scenario === "unknown" ? null : counts);
    const recorded = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(
      recorded.filter((call) => call.tool === "codex" && call.kind === "exec").length,
      1,
    );
    assert.ok(
      !recorded.some(
        (call) =>
          call.tool === "gh" &&
          call.args.some((arg) => ["PATCH", "POST", "PUT", "DELETE"].includes(arg)),
      ),
    );
    const offline = spawnSync(
      process.execPath,
      [join(repository, "dist/review-usage-report.js"), ledger, ...selected],
      { cwd: repository, encoding: "utf8", env: { PATH: env.PATH, HOME: root } },
    );
    assert.equal(offline.status, 0, offline.stderr);
    assert.deepEqual(JSON.parse(offline.stdout), report);
    results.push({
      baseline,
      scenario,
      cli_exit: child.status,
      outcome: row.outcome,
      operation_id: row.operation_id,
      attempt_id: row.attempt_id,
      source_revision: row.subject.source_revision,
      run_id: runId,
      run_attempt: 2,
      usage: row.usage,
      shard_sha256: selected.map((path) =>
        createHash("sha256")
          .update(readFileSync(join(ledger, path)))
          .digest("hex"),
      ),
      billing: "unavailable",
    });
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        scenarios: results,
        limits:
          "Synthetic GitHub, scanner and Codex process boundaries; no model, production API, queue committed-start or billing proof.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ scenarios: results, output_written: true }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
