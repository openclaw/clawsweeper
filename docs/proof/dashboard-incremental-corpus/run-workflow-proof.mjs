// Runs .github/workflows/dashboard-corpus.yml end to end under act against the local production
// Worker (fixture.mjs): real actions/checkout, setup-node and actions/cache restore/save (act's
// cache server), the workflow's own conditions, step outputs and shell, in a container.
//
//   pnpm run build && pnpm --dir dashboard-site install --frozen-lockfile
//   printf 'FROM docker.io/library/node:24-bookworm\nRUN apt-get update && apt-get install -y jq\n' |
//     docker build -t localhost/corpus-proof-runner:node24-jq -
//   DOCKER_HOST=unix:///path/to/docker-or-podman.sock ACT=/path/to/act \
//     node docs/proof/dashboard-incremental-corpus/run-workflow-proof.mjs
//
// The job image needs Node and jq, as GitHub's ubuntu-latest runners have (ACT_IMAGE overrides).
//
// Runs: a full dispatch and a site build from its aggregate; a busy hour of writes; an
// incremental dispatch that restores the sealed tree; a scheduled run whose refresh fails (wrong
// records secret) and a site build that still publishes the last good corpus; more writes and a
// scheduled run that retries from the last saved tree. The prune step's shell then runs against
// a stub gh serving a cache listing.
//
// The site job is the Dashboard site publish job with its own cache restore, corpus selection
// and build steps; build-data.ts (live GitHub and production API reads) is replaced by
// site-proof.mjs and the Cloudflare Pages step is removed, so nothing is published.
// The visibility check calls api.github.com read-only for the fixture repository names.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

import {
  busyHourWrites,
  record,
  recordWriter,
  repoRoot,
  secret,
  seedWrites,
  startWorker,
} from "./fixture.mjs";

const act = process.env.ACT || "act";
const image = process.env.ACT_IMAGE || "localhost/corpus-proof-runner:node24-jq";
const worker = await startWorker();
const { root, baseUrl } = worker;
const publishAll = recordWriter(worker.workerUrl);

// The job runs in a clean copy of the working tree (tracked and unignored files) so it neither
// sees local build output nor writes into the checkout.
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: repoRoot });
execFileSync("tar", ["--null", "-T", "-", "-cf", path.join(root, "workspace.tar")], { cwd: repoRoot, input: files });
execFileSync("tar", ["-xf", path.join(root, "workspace.tar"), "-C", workspace]);
const siteWorkflow = YAML.parse(readFileSync(path.join(repoRoot, ".github/workflows/dashboard-site.yml"), "utf8"));
const publishJob = siteWorkflow.jobs.publish;
const kept = ["Restore dashboard state", "Restore corpus aggregate", "Use the newest corpus", "Check corpus", "Build site"];
const siteSteps = [];
for (const step of publishJob.steps) {
  if (step.uses && !step.name) {
    siteSteps.push(step);
    continue;
  }
  if (!kept.includes(step.name)) continue;
  if (step.name === "Build site")
    siteSteps.push({
      name: "Build dashboard data from the fixture",
      if: step.if,
      "working-directory": "dashboard-site",
      run: "node ../docs/proof/dashboard-incremental-corpus/site-proof.mjs data ../.dashboard-state/corpus.json",
    });
  siteSteps.push(step);
  if (step.name === "Build site")
    siteSteps.push({
      name: "Check built pages",
      if: step.if,
      "working-directory": "dashboard-site",
      run: "node ../docs/proof/dashboard-incremental-corpus/site-proof.mjs check",
    });
}
writeFileSync(
  path.join(workspace, ".github/workflows/dashboard-site-proof.yml"),
  YAML.stringify({
    name: "Dashboard site (proof)",
    on: { workflow_dispatch: {} },
    permissions: siteWorkflow.permissions,
    jobs: { publish: { ...publishJob, env: {}, steps: siteSteps } },
  }),
);
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-q", "-m", "proof");

const cacheServer = path.join(root, "act-cache");
const actionCache = path.join(root, "act-actions");
function runAct(label, { event, payload, runId, recordsSecret = secret, workflow = "dashboard-corpus.yml", job = "refresh" }) {
  const eventFile = path.join(root, label + ".event.json");
  writeFileSync(eventFile, JSON.stringify(payload));
  const args = [
    event,
    "-W",
    ".github/workflows/" + workflow,
    "-j",
    job,
    "-e",
    eventFile,
    "-s",
    "CLAWSWEEPER_WEBHOOK_SECRET=" + recordsSecret,
    "--var",
    "CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL=" + baseUrl,
    "--env",
    "GITHUB_RUN_ID=" + runId,
    "-P",
    "ubuntu-latest=" + image,
    "--pull=false",
    "--network",
    "host",
    "--cache-server-path",
    cacheServer,
    "--cache-server-addr",
    "127.0.0.1",
    "--action-cache-path",
    actionCache,
    "--container-daemon-socket",
    "-",
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(act, args, { cwd: workspace, env: process.env });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    child.on("close", (code) => {
      // PROOF_LOG_DIR keeps each act run's log for inspection.
      if (process.env.PROOF_LOG_DIR) writeFileSync(path.join(process.env.PROOF_LOG_DIR, label + ".log"), log);
      resolve({ code, log, wallMs: Date.now() - started });
    });
  });
}
// act prints "Success/Failure - Main <step name>" per step and the JSON lines the CLIs print.
const stepResult = (log, name) => {
  if (log.includes("✅  Success - Main " + name)) return "success";
  if (log.includes("❌  Failure - Main " + name)) return "failure";
  return "skipped";
};
const jsonLine = (log, key) => {
  for (const line of log.split("\n").reverse()) {
    const start = line.indexOf("{");
    if (start < 0 || !line.includes('"' + key + '"')) continue;
    try {
      return JSON.parse(line.slice(start));
    } catch {}
  }
  return null;
};
const steps = [
  "Restore corpus aggregate",
  "Restore record tree",
  "Plan refresh",
  "Refresh changed records",
  "Rebuild every record",
  "Build corpus aggregate",
  "Seal record tree",
  "Save record tree",
  "Save corpus aggregate",
];
const summary = (run) => ({
  exit: run.code,
  wallMs: run.wallMs,
  steps: Object.fromEntries(steps.map((name) => [name, stepResult(run.log, name)])),
  plan: jsonLine(run.log, "reason"),
  refresh: jsonLine(run.log, "unchanged"),
  aggregate: jsonLine(run.log, "excludedRepositories"),
});
const site = async (label, runId) => {
  const run = await runAct(label, { event: "workflow_dispatch", payload: {}, runId, workflow: "dashboard-site-proof.yml", job: "publish" });
  assert.equal(run.code, 0, run.log.slice(-4000));
  for (const name of ["Use the newest corpus", "Build dashboard data from the fixture", "Build site", "Check built pages"])
    assert.equal(stepResult(run.log, name), "success", name);
  return {
    exit: run.code,
    wallMs: run.wallMs,
    restoredAggregate: /Cache restored from key: (dashboard-corpus-aggregate-[\w-]+)/.exec(run.log)?.[1] ?? null,
    data: jsonLine(run.log, "siteRecords"),
    check: jsonLine(run.log, "siteShowsRecords"),
  };
};
const runs = {};

try {
  // Production stores an R2 snapshot for every repository past the cold-journal bound.
  await publishAll(seedWrites());
  // (Asynchronous: the counting proxy runs in this process.)
  await promisify(execFile)(
    process.execPath,
    ["scripts/worker-records.ts", "snapshot-upload", "--repo-slug", "openclaw-openclaw", "--records-url", baseUrl],
    { cwd: repoRoot, env: { PATH: process.env.PATH, CLAWSWEEPER_RECORDS_SECRET: secret } },
  );

  // 1. Manual full rebuild: no cache yet.
  const full = await runAct("1-full", { event: "workflow_dispatch", payload: { inputs: { mode: "full" } }, runId: 101 });
  runs.full = summary(full);
  assert.equal(full.code, 0, full.log.slice(-4000));
  assert.equal(runs.full.plan.mode, "full");
  for (const name of ["Rebuild every record", "Build corpus aggregate", "Seal record tree", "Save record tree", "Save corpus aggregate"])
    assert.equal(runs.full.steps[name], "success", name);
  runs.siteAfterFull = await site("1-site", 201);
  assert.equal(runs.siteAfterFull.restoredAggregate, "dashboard-corpus-aggregate-101-1");
  assert.equal(runs.siteAfterFull.data.siteCorpusGeneratedAt, runs.full.aggregate.generatedAt);
  assert.equal(runs.siteAfterFull.data.siteRecords, 1900);

  // 2. A busy hour, then an incremental dispatch that restores the sealed tree from run 1.
  await publishAll(busyHourWrites());
  const incremental = await runAct("2-incremental", {
    event: "workflow_dispatch",
    payload: { inputs: { mode: "incremental" } },
    runId: 102,
  });
  runs.incremental = summary(incremental);
  assert.equal(incremental.code, 0, incremental.log.slice(-4000));
  assert.match(incremental.log, /Cache restored from key: dashboard-corpus-tree-101-1/);
  assert.match(incremental.log, /Cache restored from key: dashboard-corpus-aggregate-101-1/);
  assert.equal(runs.incremental.plan.mode, "incremental");
  assert.equal(runs.incremental.refresh.bootstrapped, 1);
  assert.equal(runs.incremental.refresh.refreshed, 3);
  assert.equal(runs.incremental.steps["Rebuild every record"], "skipped");
  assert.equal(runs.incremental.steps["Save record tree"], "success");

  // 3. Scheduled run whose refresh fails: the sealed tree cannot be opened with another secret.
  //    Nothing is aggregated, sealed or saved.
  const failed = await runAct("3-failure", {
    event: "schedule",
    payload: { schedule: "37 * * * *" },
    runId: 103,
    recordsSecret: "rotated-secret",
  });
  runs.failure = summary(failed);
  assert.notEqual(failed.code, 0);
  assert.match(failed.log, /Cache restored from key: dashboard-corpus-tree-102-1/);
  assert.equal(runs.failure.steps["Refresh changed records"], "failure");
  for (const name of ["Build corpus aggregate", "Seal record tree", "Save record tree", "Save corpus aggregate"])
    assert.equal(runs.failure.steps[name], "skipped", name);
  // The site still publishes the last good corpus: run 2's.
  runs.siteAfterFailure = await site("3-site", 202);
  assert.equal(runs.siteAfterFailure.restoredAggregate, "dashboard-corpus-aggregate-102-1");
  assert.equal(runs.siteAfterFailure.data.siteCorpusGeneratedAt, runs.incremental.aggregate.generatedAt);
  assert.equal(runs.siteAfterFailure.data.siteRecords, 1899);
  assert.equal(runs.siteAfterFailure.check.siteListsFsSafe, true);

  // 4. More writes; the next scheduled run retries from the last saved tree and catches up.
  await publishAll([
    ["openclaw-openclaw", 1, { items: record("openclaw/openclaw", 1, { version: 4 }) }],
    ["openclaw-fs-safe", 26, { items: record("openclaw/fs-safe", 26) }],
  ]);
  const retry = await runAct("4-retry", { event: "schedule", payload: { schedule: "37 * * * *" }, runId: 104 });
  runs.retry = summary(retry);
  assert.equal(retry.code, 0, retry.log.slice(-4000));
  assert.match(retry.log, /Cache restored from key: dashboard-corpus-tree-102-1/);
  assert.equal(runs.retry.plan.mode, "incremental");
  assert.equal(runs.retry.refresh.refreshed, 2);
  assert.equal(runs.retry.refresh.written, 2);
  assert.equal(runs.retry.steps["Save record tree"], "success");

  // 5. The prune step's shell, verbatim, against a stub gh serving a cache listing.
  const workflow = YAML.parse(readFileSync(path.join(repoRoot, ".github/workflows/dashboard-corpus.yml"), "utf8"));
  const prune = workflow.jobs.refresh.steps.find((step) => step.name === "Prune superseded corpus caches");
  const stub = path.join(root, "stub-bin");
  mkdirSync(stub);
  const listing = {
    actions_caches: [
      ...[105, 104, 103, 102, 101].map((run, index) => ({ id: 10 + index, key: "dashboard-corpus-tree-" + run + "-1" })),
      ...[105, 104, 103, 102, 101, 100].map((run, index) => ({ id: 20 + index, key: "dashboard-corpus-aggregate-" + run + "-1" })),
      { id: 99, key: "dashboard-corpus-treehouse-unrelated" },
    ],
  };
  writeFileSync(path.join(root, "caches.json"), JSON.stringify(listing));
  writeFileSync(
    path.join(stub, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$STUB_LOG"',
      'if [ "$3" = GET ]; then',
      '  prefix=$(printf "%s\\n" "$@" | sed -n "s/^key=//p")',
      '  jq --arg prefix "$prefix" "{actions_caches: [.actions_caches[] | select(.key | startswith(\\$prefix))]}" "$STUB_CACHES"',
      "fi",
    ].join("\n"),
  );
  chmodSync(path.join(stub, "gh"), 0o755);
  const stubLog = path.join(root, "gh.log");
  // PATH is set inside the shell: some hosts' bash wrappers prepend system directories.
  execFileSync("bash", ["-c", 'export PATH="$STUB_BIN:$PATH"; ' + prune.run], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      STUB_BIN: stub,
      STUB_LOG: stubLog,
      STUB_CACHES: path.join(root, "caches.json"),
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_REF: "refs/heads/main",
      GH_TOKEN: "stub",
    },
  });
  const deleted = readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((line) => line.includes("DELETE"))
    .map((line) => Number(line.split("/").at(-1)));
  // Both keep the newest two: tree ids 10 and 11, aggregate ids 20 and 21.
  assert.deepEqual(deleted, [12, 13, 14, 22, 23, 24, 25]);
  runs.prune = { deletedCacheIds: deleted };

  console.log(
    JSON.stringify(
      {
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
        act: execFileSync(act, ["--version"], { encoding: "utf8" }).trim(),
        image,
        runs,
        limits:
          "act's cache server stands in for the Actions cache service; GitHub-hosted runners, the real caches API and production were not used",
      },
      null,
      2,
    ),
  );
} finally {
  await worker.cleanup();
}
