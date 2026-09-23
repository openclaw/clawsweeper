import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parse } from "yaml";

// Run the actual workflow shell and curl helper against an isolated HTTP peer.
// Only expensive review/GitHub commands are replaced by harmless process fixtures.
const root = resolve(".artifacts/exact-review-start");
mkdirSync(root, { recursive: true });
const runRoot = mkdtempSync(join(root, "run-"));
const baselineRef = process.argv[2];
const workflowText = baselineRef
  ? execFileSync("git", ["show", baselineRef + ":.github/workflows/sweep.yml"], {
      encoding: "utf8",
    })
  : readFileSync(".github/workflows/sweep.yml", "utf8");
const steps = parse(workflowText).jobs["event-review-apply"].steps;
const step = steps.find((entry) => entry.id === "review-exact-event-item");
const guarded = step.run.includes("prepare_heartbeat\n");
const results = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const scenarios = baselineRef
  ? ["stale", "stale-oversized", "revoked-during-oversized-setup"]
  : [
      "stale",
      "stale-oversized",
      "revoked-during-oversized-setup",
      "inactive",
      "unknown-conflict",
      "service-failure",
      "transport-failure",
      "retry-current",
      "invalid-tuple",
      "current",
      "current-oversized",
      "revoked-after-start",
    ];
for (const scenario of scenarios) {
  const cwd = join(runRoot, scenario);
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  mkdirSync(join(cwd, "bin"));
  symlinkSync(resolve("dist"), join(cwd, "dist"), "dir");
  writeFileSync(
    join(cwd, "scripts/control-plane-curl.sh"),
    readFileSync("scripts/control-plane-curl.sh"),
  );
  writeFileSync(join(cwd, "output"), "");
  const oversized = scenario.includes("oversized");
  const pull = {
    number: 1,
    state: "open",
    additions: 50001,
    deletions: 0,
    changed_files: 1,
    head: { sha: "a".repeat(40) },
    labels: [],
    updated_at: "2026-09-23T00:00:00Z",
    comments: 0,
  };
  writeFileSync(join(cwd, "pull.json"), JSON.stringify(pull));
  writeFileSync(join(cwd, "admission.json"), JSON.stringify({ repo: "example/project", pull }));
  writeFileSync(
    join(cwd, "bin/gh"),
    `#!/bin/sh
: > "$PROOF_ROOT/refreshed"
cat "$PROOF_ROOT/pull.json"
`,
    { mode: 0o700 },
  );
  writeFileSync(join(cwd, "bin/pnpm"), templateFixture(), { mode: 0o700 });
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    requests.push(payload);
    assert.equal(request.url, "/internal/exact-review/heartbeat");
    assert.equal(request.method, "POST");
    assert.deepEqual(
      { ...payload, phase: undefined },
      {
        item_key: "example/project#1",
        lease_id: "synthetic-lease",
        lease_revision: 1,
        claim_generation: 2,
        run_id: "123",
        run_attempt: 1,
        source_head_sha: "a".repeat(40),
        phase: undefined,
      },
    );
    let status = 200;
    let error;
    if (scenario.startsWith("stale")) {
      status = 409;
      error = "lease_superseded";
    }
    if (scenario === "revoked-during-oversized-setup" && existsSync(join(cwd, "refreshed"))) {
      status = 409;
      error = "lease_superseded";
    }
    if (scenario === "inactive") {
      status = 409;
      error = "lease_not_active";
    }
    if (scenario === "unknown-conflict") {
      status = 409;
      error = "unrecognized_conflict";
    }
    if (scenario === "service-failure" || (scenario === "retry-current" && requests.length === 1))
      status = 503;
    if (scenario === "transport-failure") {
      request.socket.destroy();
      return;
    }
    // Hold the baseline's first rejection until its expensive process has started.
    if ((!guarded && !oversized) || (scenario === "revoked-after-start" && requests.length > 1)) {
      for (let n = 0; n < 500 && !existsSync(join(cwd, "descendant")); n++) await pause(10);
      assert.ok(existsSync(join(cwd, "descendant")), "fixture process tree started");
      status = 409;
      error = "lease_superseded";
    }
    response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
    response.end(JSON.stringify(error ? { error } : { ok: status === 200 }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const replacements = {
    target_repo: "example/project",
    item_number: "1",
    target_checkout_dir: "target",
    codex_timeout_ms: "10000",
    media_proof_timeout_ms: "0",
  };
  const shell = step.run.replace(/\$\{\{ steps.target.outputs.(\w+) \}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(replacements, key), key);
    return replacements[key];
  });
  assert.ok(!shell.includes("${{"));
  const log = openSync(join(cwd, "shell.log"), "w");
  let child;
  try {
    child = spawn("bash", ["-c", shell], {
      cwd,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...Object.fromEntries(Object.keys(step.env).map((key) => [key, ""])),
        PATH: join(cwd, "bin") + ":" + process.env.PATH,
        HOME: cwd,
        TMPDIR: cwd,
        GH_TOKEN: "synthetic-unused-token",
        PROOF_ROOT: cwd,
        PROOF_WAIT: scenario === "revoked-after-start" || (!guarded && !oversized) ? "1" : "0",
        RUNNER_TEMP: cwd,
        GITHUB_OUTPUT: join(cwd, "output"),
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        EXACT_REVIEW_ITEM_KEY: "example/project#1",
        EXACT_REVIEW_LEASE_ID: "synthetic-lease",
        EXACT_REVIEW_LEASE_REVISION: scenario === "invalid-tuple" ? "0" : "1",
        EXACT_REVIEW_CLAIM_GENERATION: "2",
        EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
        QUEUE_URL: "http://127.0.0.1:" + server.address().port,
        REVIEW_LEASE_OWNER: "reserved",
        REVIEW_LEASE_COMMENT_ID: "1000",
        OVERSIZED_PR: String(oversized),
        PR_ADMISSION_FILE: oversized ? join(cwd, "admission.json") : "",
      },
    });
    const code = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("workflow proof timeout: " + scenario)),
        45000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
    const outputs = Object.fromEntries(
      readFileSync(join(cwd, "output"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    );
    const launched = existsSync(join(cwd, "started"));
    const superseded =
      scenario.startsWith("stale") ||
      scenario === "inactive" ||
      scenario === "revoked-during-oversized-setup" ||
      scenario === "revoked-after-start";
    const allowed =
      scenario.startsWith("current") ||
      scenario === "retry-current" ||
      scenario === "revoked-after-start";
    assert.equal(launched, guarded ? allowed : true, scenario);
    assert.equal(code, superseded || allowed ? 0 : 1, readFileSync(join(cwd, "shell.log"), "utf8"));
    assert.equal(outputs.superseded === "true", superseded);
    assert.equal(requests.length === 0, scenario === "invalid-tuple");
    if (scenario === "service-failure" || scenario === "transport-failure")
      assert.equal(requests.length, 4);
    if (launched) {
      for (const file of ["started", "descendant"]) {
        const pid = Number(readFileSync(join(cwd, file), "utf8"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "fixture process was reaped");
      }
    }
    const mayPublish = code === 0 && outputs.exit_code === "0" && outputs.superseded !== "true";
    assert.equal(mayPublish, allowed && !superseded);
    assert.match(
      steps.find((entry) => entry.id === "create-exact-review-bundle").if,
      /review-exact-event-item.outputs.superseded != 'true'/,
    );
    results.push({
      scenario,
      code,
      launched,
      requests: requests.length,
      superseded: outputs.superseded === "true",
      mayPublish,
      processesReaped: true,
    });
  } finally {
    // Also clean the detached review group if a failed assertion or deadline
    // interrupts the harness before the workflow can finish its own cleanup.
    const reviewGroup = existsSync(join(cwd, "review-group"))
      ? Number(readFileSync(join(cwd, "review-group"), "utf8"))
      : 0;
    for (const group of [reviewGroup, child?.pid]) {
      if (!group) continue;
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error("Proof process cleanup failed", error);
          process.exitCode = 1;
        }
      }
    }
    closeSync(log);
    await new Promise((done) => server.close(done));
  }
}
const result = {
  provider: "local-shell-loopback-http",
  node: process.version,
  sourceCommit:
    baselineRef ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTree: !baselineRef,
  workflowSha256: createHash("sha256").update(workflowText).digest("hex"),
  guarded,
  cases: results,
  limits:
    "Actual workflow shell, curl, process groups and harmless review process fixtures; synthetic queue responses, no model, hosted Actions, production queue or GitHub publication.",
};
writeFileSync(join(runRoot, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));

function templateFixture() {
  return `#!/bin/bash
set -eu
echo $$ > "$PROOF_ROOT/started"
ps -o pgid= -p $$ > "$PROOF_ROOT/review-group"
sleep 300 &
child=$!
echo "$child" > "$PROOF_ROOT/descendant"
trap 'kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0' TERM
if [ "$PROOF_WAIT" = "1" ]; then wait "$child"; else sleep 0.2; kill "$child"; wait "$child" 2>/dev/null || true; fi
mkdir -p artifacts/event
printf "synthetic process receipt\\n" > artifacts/event/1.md
`;
}
