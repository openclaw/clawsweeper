import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import {
  recordWorkflowActionEvent,
  flushWorkflowActionEvents,
} from "../../../dist/action-ledger-runtime.js";
import { ACTION_EVENT_TYPES } from "../../../dist/action-ledger.js";

const repo = resolve(import.meta.dirname, "../../..");
const baseline = process.argv.includes("--baseline");
const original = "c6ead2181a5c958c37fb717c7186d48613caeeb0";
const workflowText = baseline
  ? execFileSync("git", ["show", `${original}:.github/workflows/sweep.yml`], {
      cwd: repo,
      encoding: "utf8",
    })
  : readFileSync(join(repo, ".github/workflows/sweep.yml"), "utf8");
const workflow = YAML.parse(workflowText);
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ledger-isolation-")));
const transport = join(import.meta.dirname, "local-transport.mjs");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const secret = "synthetic-proof-only";
const now = "2026-09-08T08:00:00.000Z";
const issue = {
  number: 42,
  title: "Publication isolation proof",
  body: "Synthetic issue",
  html_url: "https://github.com/openclaw/clawsweeper/issues/42",
  created_at: now,
  updated_at: now,
  closed_at: null,
  state: "open",
  locked: false,
  active_lock_reason: null,
  author_association: "CONTRIBUTOR",
  user: { login: "reporter" },
  labels: [],
  comments: 0,
  pull_request: null,
};
const report = `---
repository: openclaw/clawsweeper
number: 42
type: issue
title: Publication isolation proof
url: https://github.com/openclaw/clawsweeper/issues/42
author: reporter
author_association: CONTRIBUTOR
reviewed_at: ${now}
item_updated_at: ${now}
item_snapshot_hash: synthetic-proof-snapshot
labels: []
review_status: complete
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
decision: keep_open
action_taken: kept_open
close_reason: none
confidence: high
work_candidate: none
work_status: none
---

# Publication isolation proof

## Summary

Synthetic retained review.
`;
const receipt = {
  source_sha: sha,
  workflow_sha256: digest(workflowText),
  baseline,
  fixture_sha256: digest(report),
  scenarios: [],
};
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function directory(path) {
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}
function step(job, name) {
  const result = job.steps.find((value) => value.name === name);
  assert.ok(result, name);
  return result;
}
function child(root, args, env) {
  const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { proc, done };
}
async function checked(root, args, env) {
  const result = await child(root, args, env).done;
  assert.equal(result.code, 0, result.stderr);
  return result;
}
function commandBlock(root, value, env) {
  const cli =
    'pnpm() { shift; [ "$1" = "--silent" ] && shift; local command="$1"; shift; [ "${1:-}" = "--" ] && shift; node dist/clawsweeper.js "$command" "$@"; }';
  const proc = spawn("bash", ["-e", "-o", "pipefail", "-c", `${cli}\n${value.run}`], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { proc, done };
}
async function seed(root, output, env, job, retryable = false) {
  root = directory(join(root, `seed-${job}`));
  const producerEnv = { ...env, GITHUB_JOB: job, CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "fixture" };
  recordWorkflowActionEvent(
    root,
    {
      scope: "review.completed",
      identity: { number: 42 },
      type: ACTION_EVENT_TYPES.reviewCompleted,
      component: "review",
      subject: { repository: "openclaw/clawsweeper", kind: "issue", number: 42 },
      action: { name: "review", status: "completed", retryable, mutation: false },
      occurredAt: now,
    },
    { env: producerEnv },
  );
  await flushWorkflowActionEvents(root, { env: producerEnv, outputRoot: output });
}
async function scenario(kind) {
  const root = directory(join(temporary, kind));
  for (const path of ["dist", "config", "schema", "prompts", "package.json"]) {
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  for (const name of ["yaml", "yauzl"]) {
    cpSync(
      realpathSync(join(repo, "node_modules", name)),
      join(directory(join(root, "node_modules")), name),
      { recursive: true },
    );
  }
  const producer = directory(join(root, "publisher"));
  const review = directory(join(root, ".clawsweeper-repair/action-ledger-download"));
  directory(join(root, "artifacts"));
  directory(join(root, ".artifacts"));
  const markers = [];
  const timeline = [];
  const mark = (name) => {
    markers.push(name);
    timeline.push({ name, milliseconds: Number(performance.now().toFixed(3)) });
  };
  const comments = [];
  const blobs = new Map();
  let pending, acknowledgeHold, rejectUnexpected, unexpectedFailure;
  const held = new Promise((resolve) => {
    acknowledgeHold = resolve;
  });
  const unexpected = new Promise((_, reject) => {
    rejectUnexpected = reject;
  });
  unexpected.catch(() => {});
  let hold = kind === "held" || kind === "cancelled";
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      const send = (value, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/gh") {
        const args = body.args[0] === "--repo" ? body.args.slice(2) : body.args;
        const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : (args[1] ?? "");
        const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
        let value;
        if (args[0] === "api" && /\/issues\/42$/.test(path))
          value = { ...issue, comments: comments.length };
        else if (args[0] === "api" && /\/issues\/42\/comments(?:\?|$)/.test(path)) {
          if (method === "POST") {
            value = {
              id: 9042,
              body: body.payload.body,
              user: { login: "clawsweeper[bot]" },
              created_at: now,
              updated_at: now,
              html_url: "https://github.com/openclaw/clawsweeper/issues/42#issuecomment-9042",
            };
            comments.push(value);
            mark("comment-accepted");
          } else value = args.includes("--slurp") ? [comments] : comments;
        } else if (args[0] === "api" && /\/issues\/42\/timeline(?:\?|$)/.test(path))
          value = args.includes("--slurp") ? [[]] : [];
        else if (args[0] === "api" && path.startsWith("search/issues?"))
          value = { total_count: 0, items: [] };
        else if (args[0] === "api" && /\/collaborators\/reporter\/permission$/.test(path))
          value = { permission: "read" };
        else if (args[0] === "issue" && args[1] === "view")
          value = { closedByPullRequestsReferences: [] };
        else if (args[0] === "label" && args[1] === "create") value = { name: args[2] };
        else if (args[0] === "issue" && args[1] === "edit") value = "";
        else throw new Error(`Unexpected synthetic gh command: ${JSON.stringify(args)}`);
        send({ stdout: typeof value === "string" ? value : JSON.stringify(value) });
        return;
      }
      const signature = `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;
      assert.equal(request.headers["x-clawsweeper-exact-review-signature"], signature);
      if (
        [
          "/internal/state/github-read-model/item",
          "/internal/state/github-read-model/repair",
        ].includes(request.url)
      ) {
        send({ error: "synthetic_read_model_unavailable" }, 404);
      } else if (request.url === "/internal/state/records/tuples") {
        mark("record-accepted");
        send({ ok: true, revision: 1, deduped: false });
      } else if (
        ["/internal/state/blobs/put", "/optional/internal/state/blobs/put"].includes(request.url)
      ) {
        assert.equal(digest(Buffer.from(body.contentBase64, "base64")), body.digest);
        const respond = () => {
          if (kind === "failed" && request.url.startsWith("/optional/"))
            return send({ error: "synthetic_unavailable" }, 400);
          const old = blobs.get(body.path);
          assert.ok(!old || old === body.digest, "immutable blob conflict");
          blobs.set(body.path, body.digest);
          send({ unchanged: old === body.digest });
        };
        if (hold && request.url.startsWith("/optional/")) {
          pending = respond;
          acknowledgeHold();
        } else respond();
      } else throw new Error(`Unexpected local route: ${request.url}`);
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: "proof_failed" }));
      unexpectedFailure = error;
      rejectUnexpected(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: `${dirname(process.execPath)}:/opt/homebrew/opt/bash/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    HOME: directory(join(root, "home")),
    LANG: "C.UTF-8",
    PROOF_ENDPOINT: endpoint,
    NODE_OPTIONS: `--import=${pathToFileURL(transport)}`,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([transport]),
    GH_TOKEN: "synthetic",
    QUEUE_URL: endpoint,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: directory(join(root, ".artifacts/baseline")),
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: producer,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-09-08",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_JOB: "publish",
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
    GITHUB_WORKFLOW: "ClawSweeper Sweep",
    GITHUB_OUTPUT: join(root, ".artifacts/output"),
  };
  let upload;
  try {
    if (kind !== "empty") {
      await seed(root, review, env, "review");
      await seed(root, producer, env, "publish");
      writeFileSync(join(root, "artifacts/42.md"), report);
    }
    const publish = async () => {
      cpSync(producer, join(root, ".clawsweeper-repair/action-ledger-publisher"), {
        recursive: true,
      });
      const job = baseline ? workflow.jobs.publish : workflow.jobs["publish-review-action-ledger"];
      const importName = baseline
        ? "Import immutable review action events"
        : "Import immutable action events";
      const uploadName = baseline
        ? "Publish immutable review action ledger"
        : "Publish immutable action ledger";
      const optionalEnv = {
        ...env,
        QUEUE_URL: `${endpoint}/optional`,
        GITHUB_JOB: baseline ? "publish" : "publish-review-action-ledger",
      };
      const imported = await commandBlock(root, step(job, importName), optionalEnv).done;
      assert.equal(imported.code, 0, imported.stderr);
      const manifest = readFileSync(join(root, ".artifacts/action-ledger-paths.txt"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      if (!manifest.length) {
        const result = await commandBlock(root, step(job, uploadName), optionalEnv).done;
        assert.match(result.stdout, /No immutable/);
        return result;
      }
      for (const kind of [
        "events/",
        "import-bindings/events/",
        "import-bindings/producer-runs/",
        "import-bindings/shard-sets/",
        "import-bindings/completed-shard-sets/",
      ]) {
        assert.ok(
          manifest.some((path) => path.startsWith(`ledger/v1/${kind}`)),
          kind,
        );
      }
      upload = commandBlock(root, step(job, uploadName), optionalEnv);
      return upload.done;
    };
    const requiredReceipt = async (name) => {
      const result = await commandBlock(root, step(workflow.jobs.publish, name), env).done;
      assert.equal(result.code, 0, result.stderr);
      mark(name);
    };
    const critical = async () => {
      if (kind === "cancelled") return;
      if (kind === "empty") {
        mark("primary-empty");
        return;
      }
      const applied = await child(
        root,
        [
          "dist/clawsweeper.js",
          "apply-artifacts",
          "--target-repo",
          kind === "primary-failed" ? "invalid" : "openclaw/clawsweeper",
          "--artifact-dir",
          "artifacts",
          "--skip-dashboard",
          "--skip-reconcile",
        ],
        env,
      ).done;
      if (kind === "primary-failed") {
        assert.notEqual(applied.code, 0);
        mark("primary-failed");
        return;
      }
      assert.equal(applied.code, 0, applied.stderr);
      mark("apply-completed");
      await requiredReceipt("Publish review artifact action ledger");
      await checked(
        root,
        [
          "dist/repair/publish-main.js",
          "--message",
          "proof records",
          "--path",
          "records/openclaw-clawsweeper",
          "--rebase-strategy",
          "normal",
        ],
        env,
      );
      mark("record-completed");
      const sync = await checked(
        root,
        [
          "dist/clawsweeper.js",
          "apply-decisions",
          "--target-repo",
          "openclaw/clawsweeper",
          "--skip-dashboard",
          "--item-numbers",
          "42",
          "--sync-comments-only",
          "--apply-kind",
          "all",
          "--limit",
          "0",
          "--processed-limit",
          "1",
          "--comment-sync-min-age-days",
          "0",
        ],
        env,
      );
      assert.equal(
        comments.length,
        1,
        `${sync.stdout}\n${sync.stderr}\n${readFileSync(join(root, "apply-report.json"), "utf8")}`,
      );
      mark("comment-completed");
      await requiredReceipt("Publish selected review comment action ledger");
    };
    const oldStep = workflow.jobs.publish.steps.find(
      (value) => value.name === "Publish immutable review action ledger",
    );
    assert.equal(
      Boolean(oldStep),
      baseline,
      "workflow must match the requested baseline/candidate mode",
    );
    if (baseline) {
      assert.ok(
        workflow.jobs.publish.steps.indexOf(oldStep) <
          workflow.jobs.publish.steps.indexOf(
            step(workflow.jobs.publish, "Apply review artifacts"),
          ),
      );
      const publishing = publish();
      if (hold) {
        await Promise.race([
          held,
          unexpected,
          publishing.then((result) => {
            throw new Error(`Upload ended before hold: ${result.stderr}`);
          }),
        ]);
        assert.deepEqual(markers, []);
        mark("critical-blocked-by-ledger");
        hold = false;
        mark("ledger-released");
        pending();
      }
      await publishing;
      await critical();
    } else {
      const optional = workflow.jobs["publish-review-action-ledger"];
      assert.ok(optional);
      assert.ok(optional.needs.includes("publish"));
      assert.equal(optional.concurrency, undefined);
      for (const job of Object.values(workflow.jobs)) {
        assert.ok(![job.needs].flat().includes("publish-review-action-ledger"));
      }
      assert.equal(
        step(workflow.jobs.publish, "Retain publisher action events")["continue-on-error"],
        true,
      );
      await critical();
      if (kind === "failed") {
        const summary = join(root, "retention-summary.md");
        const report = await commandBlock(
          root,
          step(workflow.jobs.publish, "Report publisher ledger retention failure"),
          { ...env, RETENTION_OUTCOME: "failure", GITHUB_STEP_SUMMARY: summary },
        ).done;
        assert.equal(report.code, 0, report.stderr);
        assert.match(report.stdout, /::warning::.*retention: failure/);
        assert.match(readFileSync(summary, "utf8"), /retention: failure/);
        mark("retention-failure-visible");
      }
      const publishing = publish();
      if (hold) {
        await Promise.race([
          held,
          unexpected,
          publishing.then((result) => {
            throw new Error(`Upload ended before hold: ${result.stderr}`);
          }),
        ]);
        assert.equal(markers.includes("comment-completed"), kind !== "cancelled");
        if (kind === "cancelled") {
          process.kill(-upload.proc.pid, "SIGTERM");
          assert.notEqual((await publishing).code, 0);
          mark("optional-cancelled");
        } else {
          mark("critical-finished-before-ledger-release");
          hold = false;
          mark("ledger-released");
          pending();
          assert.equal((await publishing).code, 0);
        }
      } else {
        const result = await publishing;
        assert.equal(result.code === 0, kind !== "failed");
        mark(
          kind === "failed"
            ? "optional-failed"
            : kind === "empty"
              ? "optional-empty"
              : "optional-completed",
        );
      }
    }
    if (unexpectedFailure) throw unexpectedFailure;
    if (kind === "success") {
      const importArgs = (source, destination, job) => [
        "dist/clawsweeper.js",
        "publish-action-events",
        "--source-root",
        source,
        "--state-root",
        destination,
        "--expected-producer-job",
        job,
      ];
      const replay = await checked(root, importArgs(review, root, "review"), env);
      assert.equal(JSON.parse(replay.stdout).unchanged, 1);
      const wrongProducer = await child(
        root,
        importArgs(review, directory(join(root, "wrong-producer")), "publish"),
        env,
      ).done;
      assert.notEqual(wrongProducer.code, 0);
      assert.match(wrongProducer.stderr, /producer provenance mismatch for job/);
      const conflict = directory(join(root, "conflict"));
      await seed(directory(join(root, "conflict-writer")), conflict, env, "review", true);
      const conflictingImport = await child(root, importArgs(conflict, root, "review"), env).done;
      assert.notEqual(conflictingImport.code, 0);
      assert.match(conflictingImport.stderr, /conflict/);
      mark("exact-replay-retained");
      mark("wrong-producer-rejected");
      mark("conflicting-bytes-rejected");
    }
    receipt.scenarios.push({
      kind,
      markers,
      timeline,
      blob_paths: blobs.size,
      comments: comments.length,
    });
  } finally {
    if (upload?.proc.exitCode === null && upload.proc.signalCode === null) {
      process.kill(-upload.proc.pid, "SIGTERM");
      await upload.done;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
try {
  for (const kind of baseline
    ? ["held"]
    : ["held", "success", "failed", "empty", "primary-failed", "cancelled"])
    await scenario(kind);
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const path = resolve(process.argv[outputIndex + 1]);
    directory(dirname(path));
    writeFileSync(path, output);
  }
  console.log(output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
