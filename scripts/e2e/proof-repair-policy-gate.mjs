#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const source = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-repair-policy-proof-"));
const fakeBin = path.join(temporary, "bin");
const statusOwner = path.join(source, "dist/repair/issue-implementation-status.js");
const controlItem = 2_147_483_001;
const controlPayload = path.join(
  source,
  ".clawsweeper-repair/payloads",
  `issue-implementation-status-openclaw-openclaw-${controlItem}.json`,
);

fs.mkdirSync(fakeBin, { recursive: true });
writeFakeGh();

const workflow = parse(fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8"));
const protectedOwners = assertProductionOwnersAreRuntimeGuarded(workflow);
const enterpriseJob = writeJob(
  "enterprise.md",
  "openclaw/openclaw-enterprise",
  "openclaw/openclaw-enterprise",
  670,
);
const openclawJob = writeJob("openclaw.md", "openclaw/openclaw", "openclaw/openclaw", controlItem);

try {
  const receipts = [
    runFinalStatusOwner(enterpriseJob, "queued"),
    runFinalStatusOwner(enterpriseJob, "replayed-with-prior-execute-permission"),
    runFinalStatusOwner(openclawJob, "allowed-control"),
  ];

  assert.deepEqual(
    receipts.map(({ delivery, allowed, targetWriteCalls }) => ({
      delivery,
      allowed,
      targetWriteCalls,
    })),
    [
      { delivery: "queued", allowed: false, targetWriteCalls: 0 },
      {
        delivery: "replayed-with-prior-execute-permission",
        allowed: false,
        targetWriteCalls: 0,
      },
      { delivery: "allowed-control", allowed: true, targetWriteCalls: 1 },
    ],
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime: "compiled repair-policy-run and issue-implementation-status CLIs",
        workflow: ".github/workflows/repair-cluster-worker.yml",
        protectedOwners,
        boundary: "production repair final-I/O wrapper and GitHub status-comment owner",
        receipts,
        limits:
          "Controlled loopback with a fake gh transport; production workflow commands and compiled final-I/O owner are exercised, but no live GitHub credential or target mutation is used.",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(controlPayload, { force: true });
  fs.rmSync(temporary, { recursive: true, force: true });
}

function assertProductionOwnersAreRuntimeGuarded(document) {
  const ownerNames = [
    "Publish automatic implementation planning status",
    "Publish automatic implementation build status",
    "Execute credited fix artifact",
    "Publish deferred fix outcome",
    "Apply safe closure actions",
    "Post-flight finalize fix PRs",
    "Apply post-flight closeouts",
    "Tag ClawSweeper targets",
    "Publish automatic implementation completion status",
    "Requeue source-head repair races",
  ];
  const steps = Object.values(document.jobs).flatMap((job) => job.steps ?? []);
  for (const name of ownerNames) {
    const step = steps.find((candidate) => candidate.name === name);
    assert.ok(step, `missing production workflow owner: ${name}`);
    assert.match(step.run, /pnpm run repair:policy-run -- "\$CLUSTER_JOB_PATH" --/);
  }
  return ownerNames;
}

function runFinalStatusOwner(jobPath, delivery) {
  const logPath = path.join(temporary, `${delivery}.gh.jsonl`);
  const result = spawnSync(
    "pnpm",
    [
      "run",
      "--silent",
      "repair:policy-run",
      "--",
      jobPath,
      "--",
      process.execPath,
      statusOwner,
      "--job",
      jobPath,
      "--state",
      "Building",
      "--detail",
      "repair policy final-I/O proof",
      "--run-url",
      "https://github.com/openclaw/clawsweeper/actions/runs/1",
    ],
    {
      cwd: source,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_TOKEN: "controlled-loopback-token",
        GITHUB_TOKEN: "",
        CLAWSWEEPER_PUBLIC_GH_TOKEN: "",
        CLAWSWEEPER_STATUS_INGEST_TOKEN: "",
        PROOF_GH_LOG: logPath,
        // A replay can retain stale permission in the job environment. The
        // repository check must remain authoritative over those prior values.
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOW_FIX_PR: "1",
        CLAWSWEEPER_ALLOW_MERGE: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = readJsonLines(logPath);
  const targetWrites = calls.filter(
    (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
  );
  return {
    delivery,
    allowed: /"status":"created"/.test(result.stdout),
    targetWriteCalls: targetWrites.length,
    targetWrites,
    notice: result.stdout.trim().split("\n")[0] ?? "",
  };
}

function writeJob(name, repo, sourceIssueRepo, sourceIssueNumber) {
  const jobPath = path.join(temporary, name);
  fs.writeFileSync(
    jobPath,
    [
      "---",
      `repo: ${repo}`,
      "source: issue_implementation",
      "trigger_source: review_viable_issue",
      `source_issue_repo: ${sourceIssueRepo}`,
      `source_issue_number: ${sourceIssueNumber}`,
      "---",
      "fixture",
      "",
    ].join("\n"),
  );
  return jobPath;
}

function writeFakeGh() {
  const file = path.join(fakeBin, "gh");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const apiPath = args[0] === "api" ? args[1] : "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
fs.appendFileSync(process.env.PROOF_GH_LOG, JSON.stringify({ apiPath, method }) + "\\n");
if (args.includes("--slurp")) process.stdout.write("[[]]");
else if (method === "POST") process.stdout.write('{"id":9001}');
else process.stdout.write('{"title":"Controlled loopback issue"}');
`,
  );
  fs.chmodSync(file, 0o755);
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
