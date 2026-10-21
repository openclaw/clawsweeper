import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

type Step = { name?: string; id?: string; run?: string; env?: Record<string, unknown> };
const untrusted =
  /client_payload|\binputs(?:\.|\[)|github\.event\.inputs|github\.head_ref|github\.event\.(?:comment|issue|pull_request|review)|\b(?:steps|needs)(?:\.[\w-]+|\[['"][^'"]+['"]\])(?:\.outputs|\[['"]outputs['"]\])/;
const repository = resolve(".");
const leaseId = "54ea52c2-c45e-40c9-9ddc-0923832e2a53";

function candidates() {
  const paths = [
    ...readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`),
    ...readdirSync(".github/actions")
      .map((name) => `.github/actions/${name}/action.yml`)
      .filter(existsSync),
  ];
  const sources = paths.map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const template = readFileSync("docs/target-dispatcher.md", "utf8").match(
    /```yaml\n(name: ClawSweeper Dispatch\n[\s\S]*?)\n```/g,
  );
  assert.equal(template?.length, 1, "expected one canonical dispatcher template");
  sources.push({
    file: "docs/target-dispatcher.md",
    source: template[0]!.slice("```yaml\n".length, -"\n```".length),
  });
  return sources.flatMap(({ file, source }) => {
    const doc = YAML.parse(source);
    const jobs: Record<string, { steps?: Step[]; env?: Record<string, unknown> }> = doc.jobs ?? {
      composite: doc.runs,
    };
    return Object.entries(jobs).flatMap(([job, definition]) =>
      (definition.steps ?? []).flatMap((rawStep) => {
        const step = { ...rawStep, env: { ...doc.env, ...definition.env, ...rawStep.env } };
        const variables = Object.entries(step.env ?? {})
          .filter(([, value]) => untrusted.test(String(value)))
          .map(([key]) => key);
        return step.run && variables.length ? [{ file, job, step, variables }] : [];
      }),
    );
  });
}

function valueFor(name: string): string {
  const values: Record<string, string> = {
    DISPATCH_PAYLOAD: JSON.stringify({
      target_repo: "openclaw/openclaw",
      target_branch: "release/1.2",
      item_number: 42,
      item_kind: "pull_request",
      source_event: "pull_request",
      source_action: "opened",
    }),
    DISPATCH_KEY: "dispatch-42",
    ITEM_KEY: "openclaw/openclaw#42",
    EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#42",
    TERMINAL_FINALIZATION_ITEM_KEY: "openclaw/openclaw#42",
    SUPERSEDES_IN_PROGRESS: "false",
    CRABBOX_ID: "fixture",
    CRABBOX_KEEP_ALIVE_MINUTES: "0",
    STEPS_TARGET_OUTPUTS_CODEX_TIMEOUT_MS: "120000",
    STEPS_TARGET_OUTPUTS_MEDIA_PROOF_TIMEOUT_MS: "120000",
    STEPS_TARGET_OUTPUTS_MEDIA_PREPROCESSING_RESERVE_SECONDS: "60",
    MEDIA_PROOF_TIMEOUT_MS: "120000",
    MEDIA_PREPROCESSING_RESERVE_SECONDS: "60",
    STEPS_PROOF_ARTIFACT_OUTPUTS_ACTION_LEDGER_NAME: "action-ledger-apply-proof-123-1",
    PRIMARY_TOKEN: "",
    PRODUCER_RUN_ID: "123",
    PRODUCER_RUN_ATTEMPT: "1",
    COMPLETION_COMPLETED_AT: "2026-10-18T00:00:00Z",
    PRIMARY_OUTCOME: "success",
    COMPLETION_KIND: "published",
    REASON_CODE: "publication_applied",
    ARTIFACT_NAME: "exact-review-123-1",
    DIRECT_OUTCOME: "direct-outcome.json",
    LIVE_PROCEEDED: "false",
    LIVE_TERMINAL_NOOP: "false",
    LIVE_TERMINAL_MISSING: "false",
    LIVE_GUARDED_OPEN: "false",
    RESERVATION_STATUS: "posted",
    REVIEW_EXIT_CODE: "0",
    CLASSIFICATION: "success",
    INPUTS_WORKTREE_PATH: ".",
    INPUTS_AUTH_MODE: "proxy",
    INPUTS_CODEX_VERSION: "0.162.1",
    INPUTS_PROXY_VERSION: "0.159.2",
    HYDRATE_STATE_BLOBS: "true",
    HYDRATE_RECORDS: "true",
    HYDRATE_GIT_STATE: "true",
    DIRECT_LIFECYCLE_PLAN: '{"kind":"router"}',
    DIRECT_LIFECYCLE_RECEIPT_OUTCOME: "accepted",
    INPUTS_WORKING_DIRECTORY: ".",
    INPUTS_TARGET_DIR: "target",
    INPUTS_STATE_PATH: "state with spaces",
    PIN_FILE: "target/extensions/codex/package.json",
    INPUTS_PNPM_VERSION: "12.15.0",
    INPUTS_CODEX_HOME: "codex home",
    INPUTS_OPENCLAW_SOURCE_REF: "a".repeat(40),
    STATE_COORDINATOR_URL: "https://queue.invalid",
    INPUTS_COORDINATOR_CLASS: "ordinary",
    COMMENT_BODY: "@clawsweeper review",
    QUESTION: "Explain the change\nand its tests.",
    MODE: "assist",
    LENS: "auto",
    AUTHOR: "fixture-user",
    COMMENT_URL: "https://github.com/openclaw/openclaw/issues/42#issuecomment-7",
    REGISTRY_REF: "main",
    REQUESTED: "true",
    MANUAL_EXPLICIT: "true",
    HOT_INTAKE: "false",
    CODEX_TIMEOUT_MS: "120000",
    TIMEOUT_MS: "120000",
    ALLOCATED_CANDIDATES: "2",
    METRICS_PATH: ".artifacts/metrics.jsonl",
    RATE_LIMIT_PATH: ".artifacts/rate-limit.jsonl",
    POOL_CLASS: "target_app",
    STAGE: "publication_apply",
    SOURCE_ACTION: "opened",
    CLAIM_GENERATION: "1",
    REPEAT_REVISION: "false",
    WORKFLOW_EVENT_PULL_REQUEST_DRAFT: "false",
    DISPATCH_TARGET_BRANCH: "release/1.2",
    INPUT_APPLY_KIND: "all",
    INPUT_APPLY_CLOSE_REASONS: "all",
    INPUT_APPLY_SYNC_COMMENTS_ONLY: "false",
    INPUT_APPLY_MIN_AGE_DAYS: "0",
    INPUT_APPLY_MIN_AGE_MINUTES: "5",
    INPUT_APPLY_STALE_MIN_AGE_DAYS: "60",
    INPUT_APPLY_LIMIT: "1",
    INPUT_APPLY_CLOSE_DELAY_MS: "0",
    INPUT_APPLY_CHECKPOINT_SIZE: "1",
    INPUT_APPLY_COMMENT_SYNC_MIN_AGE_DAYS: "7",
    STATUS_MARKER: "<!-- clawsweeper-command-status:42:review:fixture -->",
    COMMAND_STATUS_MARKER: "<!-- clawsweeper-command-status:42:review:fixture -->",
    STATUS_STATE: "Complete",
    STATUS_DETAIL: "Complete",
    FENCE_KEY: "fence-42",
    REVISION: "1",
    ATTEMPT_ID: "attempt-1",
    COMMAND_STATUS_REQUIRE_TERMINAL_FENCE: "true",
    CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS: String(Date.now()),
    EVENT_NAME: "workflow_dispatch",
    WORKFLOW_EVENT_SCHEDULE: "",
    SCHEDULED_COMMENT_SYNC: "false",
  };
  if (Object.hasOwn(values, name)) return values[name];
  if (/DECISION/.test(name))
    return JSON.stringify({
      targetRepo: "openclaw/openclaw",
      targetBranch: "release/1.2",
      itemNumber: 42,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "opened",
    });
  if (name.endsWith("SLUG")) return "openclaw-openclaw";
  if (/ITEM_KIND/.test(name)) return "pull_request";
  if (/BRANCH/.test(name)) return "release/1.2";
  if (/ITEM_KEY/.test(name)) return "openclaw/openclaw#42";
  if (/PROTOCOL_VERSION/.test(name)) return "2";
  if (/REPO|REPOSITORY/.test(name)) return "openclaw/openclaw";
  if (/LEASE_ID/.test(name)) return leaseId;
  if (/REVISION|GENERATION/.test(name)) return "1";
  if (/ITEM_NUMBERS|ITEM_NUMBER/.test(name)) return "42";
  if (/COMMENT_ID/.test(name)) return "7";
  if (/TOKEN|SECRET/.test(name)) return "fixture-token";
  if (/QUEUE_URL/.test(name)) return "https://queue.invalid";
  return "";
}

// Keep production parsers and Bash bodies intact. Only network/process boundaries
// are fixtures; an unknown external invocation fails instead of reaching live APIs.
function fixture(root: string) {
  for (const dir of [
    "bin",
    "scripts",
    "target/extensions/codex",
    "action",
    "runner",
    ".artifacts",
    "results",
    ".artifacts/exact-review-batch",
    "artifacts/event",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(join(repository, "src"), join(root, "src"), "dir");
  symlinkSync(join(repository, "dist"), join(root, "dist"), "dir");
  const write = (path: string, content: string) =>
    writeFileSync(join(root, path), content, { mode: 0o755 });
  const sourceRoot = "home/.clawsweeper-repair/openclaw-source";
  mkdirSync(join(root, sourceRoot, "checkout/dist"), { recursive: true });
  write(`${sourceRoot}/ref`, "a".repeat(40) + "\n");
  write(`${sourceRoot}/checkout/dist/index.js`, "process.stdout.write('fixture OpenClaw\\n');\n");
  for (const name of ["exact-review-queue-request", "exact-review-queue-response"])
    copyFileSync(`src/repair/${name}.ts`, join(root, `runner/${name}.mts`));
  copyFileSync(
    "scripts/github-egress-observer.sh",
    join(root, "scripts/github-egress-observer.sh"),
  );
  write(
    "target/extensions/codex/package.json",
    JSON.stringify({ dependencies: { "@openai/codex": "0.100.0" } }),
  );
  copyFileSync(
    ".github/actions/setup-openclaw-codex-source/validate-pin.mjs",
    join(root, "action/validate-pin.mjs"),
  );
  mkdirSync(join(root, "home/.crabbox/actions"), { recursive: true });
  write("home/.crabbox/actions/fixture.stop", "");
  write("event.json", "{}");
  write("artifacts/event/42.md", "fixture review\n");
  write(
    ".artifacts/direct-publication-outcome.json",
    '{"kind":"eligible","disposition":{"policyNoopExpected":true}}',
  );
  write("plan.json", "{}");
  write(".artifacts/exact-review-batch/manifest.json", '{"items":[]}');
  write("scripts/review-target-checkout.sh", "#!/bin/bash\nexit 0\n");
  for (const command of ["npm", "npx", "corepack", "openclaw", "setsid", "timeout"])
    write(`bin/${command}`, "#!/bin/bash\nexit 0\n");
  // `printenv KEY | codex login --with-api-key` runs under pipefail: the stub must drain
  // its pipe, or the writer can die with SIGPIPE (141) depending on scheduling.
  write("bin/codex", '#!/bin/bash\nif [ "$1" = login ]; then cat >/dev/null; fi\nexit 0\n');
  write("action/install.sh", "#!/bin/bash\nexit 0\n");
  write("scripts/dispatch-receipt-owner.sh", "#!/bin/bash\nprintf 'none\\n'\n");
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "release/1.2",
    itemNumber: 42,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "opened",
  };
  const publication = {
    ...decision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      producerDecision: decision,
      producerRunId: "123",
      producerRunAttempt: 1,
      leaseRevision: 1,
      itemKey: "openclaw/openclaw#42",
      artifactName: "review",
      sourceSha: "a".repeat(40),
      protocolVersion: 2,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      directLifecycle: { plan: { kind: "router" }, receiptOutcome: "accepted" },
    },
  };
  write(
    "response.json",
    JSON.stringify({
      claimed: true,
      queued: true,
      accepted: true,
      completed: true,
      requeued: true,
      protocol_version: 2,
      decision: publication,
      item_key: "openclaw/openclaw#42",
      lease_revision: 1,
      claim_generation: 1,
      repeat_revision: false,
      terminal_finalization: { statusState: "Complete", statusDetail: "Done", parkedCommand: true },
      lifecycle_projection: {
        canonicalTargetKey: "openclaw/openclaw#42",
        fenceKey: "fence-42",
        revision: 1,
      },
      ok: true,
      allowed: true,
      acknowledgement_state: "pending",
      attempt_id: "attempt-1",
    }),
  );
  write(
    "preload.mjs",
    `globalThis.fetch = async (url) => ({ status: 200, json: async () => String(url).includes('raw.githubusercontent') ? { schema_version: 1, repositories: [{target_repo:'openclaw/openclaw'}] } : {full_name:'openclaw/openclaw', private:false, visibility:'public'} });\n`,
  );
  const curl = `control_plane_curl() {
  local out="" code=false body="$FIXTURE_ROOT/response.json"
  case "$*" in
    *'/command-ack/observed'*) jq '.acknowledgement_state="observed"' "$body" > "$FIXTURE_ROOT/route.json"; body="$FIXTURE_ROOT/route.json" ;;
    *'/terminal-finalization/skip'*) jq '.acknowledgement_state="skipped_locked"' "$body" > "$FIXTURE_ROOT/route.json"; body="$FIXTURE_ROOT/route.json" ;;
  esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) out="$2"; shift ;;
      --write-out) code=true; shift ;;
    esac
    shift
  done
  if [ -n "$out" ]; then cp "$body" "$out"; fi
  if [ "$code" = true ]; then printf 200; elif [ -z "$out" ]; then cat "$body"; fi
}
control_plane_signed_post() { control_plane_curl "$@"; }
`;
  write("scripts/control-plane-curl.sh", curl);
  write("runner/control-plane-curl.sh", curl);
  write(
    "scripts/apply-workflow-helpers.sh",
    readFileSync("scripts/apply-workflow-helpers.sh", "utf8") +
      `\n# No remote publication in this fixture. Selection and serialization stay real.\npublish_status() { :; }\npublish_changes() { :; }\npublish_reconciled_records() { :; }\nbegin_canonical_record_mutation() { :; }\n`,
  );
  write(
    "bin/gh",
    `#!/bin/bash
case "$*" in
  *'actions/caches'*) echo '{"actions_caches":[]}' ;;
  *'.state'*) echo closed ;;
  *'.default_branch'*) echo main ;;
  *'--jq'*) : ;;
  *) printf '%s\\n' '[{"id":7,"user":{"login":"clawsweeper[bot]"},"body":"<!-- clawsweeper-pr-ack:opened item=42 -->"}]' ;;
esac
`,
  );
  write("bin/git", "#!/bin/bash\nprintf '%040d\\n' 1\n");
  write(
    "bin/curl",
    `#!/bin/bash
case "\${!#}" in
  https://oidc.invalid/token) printf '%s\\n' '{"value":"fixture-oidc-token"}' ;;
  https://queue.invalid/github/target-dispatch)
    output=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then output="$2"; shift; fi
      shift
    done
    [ -n "$output" ] || exit 97
    printf '%s\\n' '{"ok":true,"queued":true}' > "$output"
    printf 202
    ;;
  *) exit 97 ;;
esac
`,
  );
  write("bin/sleep", "#!/bin/bash\n/bin/sleep 0.01\n");
  write(
    "bin/pnpm",
    `#!/bin/bash
case " $* " in
  *' apply-decisions '*) printf '[]\\n' > apply-report.json ;;
  *' queue-pressure '*) printf '{"availableCandidateCapacity":2}\\n' ;;
  *' limit review_shards.hard_cap '*) printf '2\\n' ;;
  *' count-actions '*|*' count-report '*) printf '0\\n' ;;
  *' proposed-pr-close-coverage-item-numbers '*) printf '42\\n' ;;
  *' proposed-item-quality-summary '*) printf 'candidate_quality_summary=fixture\\n' ;;
  *' repair:update-command-status '*) printf 'fixture status updated\\n' ;;
  *' reserve-review-lease '*) echo '{"status":"posted","owner":"fixture","commentId":7,"queueOnly":true}' ;;
  *' repair:exact-review-bundle create '*) echo '{"manifest":{"artifactName":"review"}}' ;;
  *' exact-review-admission '*) echo 'proceed=true' ;;
  *' exact-review-live-item '*) echo '{"state":"open","locked":false}' ;;
  *' count-csv '*) echo 1 ;;
  *' merge-apply-reports '*) : ;;
  *' plan '*) echo '{}' > plan.json ;;
  *' plan-output '*) echo 'proceed=true' ;;
  *' repair:scheduled-review-enqueue '*) echo '{"offered":1,"attempted":1,"queued":1,"deduped":0,"shed":0,"rejected":0,"deferred":0}' ;;
  *' audit '*|*' repair:'*|*' finalize-action-events '*|*' target-fanout '*|*' install '*|*' build '*) : ;;
  *' reconcile '*|*' summarize-apply-report '*|*' status '*) printf '{}\\n' ;;
  *) echo "Unexpected pnpm invocation: $*" >&2; exit 97 ;;
esac
`,
  );
  write(
    "bin/node",
    `#!/bin/bash
case "$1" in
  --input-type=module|-e|"") exec "$REAL_NODE" --import "$FIXTURE_ROOT/preload.mjs" "$@" ;;
  "$FIXTURE_ROOT/home/.clawsweeper-repair/openclaw-source/checkout/dist/index.js") exec "$REAL_NODE" "$@" ;;
  dist/clawsweeper.js)
    if [ "$2" = assist-target ]; then exec "$REAL_NODE" "$SOURCE_ROOT/$1" "\${@:2}"; fi
    case "$2" in assist-generate|assist-validate|assist-publish|expire-review-lease) exit 0 ;; *) echo "Unexpected CLI invocation: $*" >&2; exit 97 ;; esac ;;
  dist/repair/exact-review-queue-request.js) shift; exec "$REAL_NODE" "$FIXTURE_ROOT/runner/exact-review-queue-request.mts" "$@" ;;
  "$FIXTURE_ROOT/runner/"*.mts|"$FIXTURE_ROOT/action/validate-pin.mjs"|src/repair/exact-review-queue-response.ts|src/repair/exact-review-queue-context.ts|src/workflow-bot-comments.ts) exec "$REAL_NODE" "$@" ;;
  "$FIXTURE_ROOT/action/validate-install.mjs"|"$FIXTURE_ROOT/action/configure-api-context.mjs"|dist/intake-triage-workflow.js|dist/github-egress-observer-cli.js|dist/review-placeholder-recovery.js|dist/repair/state-repo-size.js|dist/repair/manual-review-enqueue.js) exit 0 ;;
  scripts/build-data.ts|scripts/prepare-exact-review-batch.mjs|scripts/exact-review-dead-letter-operator.mjs|scripts/stuck-queued-run-remediation.mjs|scripts/queue-storage-census.mjs|scripts/canonical-record-verification.ts|scripts/review-usage-operator.mjs|scripts/publish-apply-observability.mjs|./scripts/prepare-worker-record-cache.ts|--max-old-space-size=12288) exit 0 ;;
  scripts/worker-records.ts) echo '{"ok":true}' ;;
  *) echo "Unexpected node invocation: $*" >&2; exit 97 ;;
esac
exit 0

`,
  );
}

// No exemptions: every matching workflow/action step is executed. A clean baseline
// is mandatory so missing fixtures or an early unrelated failure cannot fake safety.
test("untrusted env matching includes dot and bracket step/job outputs", () => {
  for (const expression of [
    "steps.target.outputs.value",
    "needs.build.outputs.value",
    "steps['target']['outputs']['value']",
    'needs["build"].outputs.value',
    "fromJSON(steps.claim.outputs.decision).itemNumber",
  ])
    assert.match(expression, untrusted);
});

test("arithmetic probe executes with the harness scalar present", () => {
  const root = mkdtempSync(join(tmpdir(), "arithmetic-control-"));
  const marker = join(root, "marker");
  try {
    execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-euo",
        "pipefail",
        "-c",
        'value=\'x[$(touch "$PROBE_MARKER")]\'; : "$((value + 1))"',
      ],
      {
        env: { PATH: process.env.PATH, x: "0", PROBE_MARKER: marker },
        timeout: 10_000,
      },
    );
    assert.ok(existsSync(marker), "the exploit must execute in the positive control");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow shell boundaries", { concurrency: 4 }, async (t) => {
  const rows = candidates();
  assert.ok(rows.length >= 30, "enumerate workflows and composite actions");
  assert.ok(rows.some((row) => row.file === "docs/target-dispatcher.md"));
  t.diagnostic(
    `${rows.length} steps; ${rows.reduce((count, row) => count + row.variables.length, 0)} untrusted variables; no exemptions`,
  );
  let arithmeticProbes = 0;
  let recordProbes = 0;
  let traversalProbes = 0;
  const checks: Promise<void>[] = [];
  for (const { file, job, step, variables } of rows) {
    const check = t.test(`${file}:${job}:${step.name ?? step.id}`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), "actions-output-"));
      const root = join(scratch, "workspace");
      try {
        mkdirSync(root);
        fixture(root);
        const base: Record<string, string> = {
          // With nounset, an undeclared x would stop before its subscript runs.
          x: "0",
          PATH: `${root}/bin:${process.env.PATH}`,
          HOME: join(root, "home"),
          REAL_NODE: process.execPath,
          SOURCE_ROOT: repository,
          FIXTURE_ROOT: root,
          CODEX_HOME: join(root, "home/codex"),
          GITHUB_SHA: "a".repeat(40),
          GITHUB_EVENT_PATH: join(root, "event.json"),
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          WORKFLOW_ACTION_PATH: join(root, "action"),
          OPENAI_API_KEY: "fixture",
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_ENV: join(root, "env"),
          GITHUB_PATH: join(root, "path"),
          GITHUB_WORKSPACE: root,
          GITHUB_ACTION_PATH: join(root, "action"),
          RUNNER_TEMP: join(root, "runner"),
          RUNNER_OS: "Linux",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
          WORKFLOW_RUN_ID: "123",
          WORKFLOW_REPOSITORY: "openclaw/clawsweeper",
          CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS: String(Date.now()),
          CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED: "false",
          CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED: "false",
          CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED: "false",
        };
        for (const [name, value] of Object.entries(step.env ?? {}))
          base[name] = String(value).includes("github.action_path")
            ? join(root, "action")
            : !String(value).includes("${{")
              ? String(value ?? "")
              : valueFor(name);
        if (
          file === ".github/workflows/clawsweeper-dispatch.yml" ||
          file === "docs/target-dispatcher.md"
        )
          base.TARGET_DISPATCH_URL = "https://queue.invalid/github/target-dispatch";
        const run = (env: Record<string, string>) => {
          writeFileSync(base.GITHUB_OUTPUT, "");
          writeFileSync(base.GITHUB_ENV, "");
          return new Promise<{
            status: number | null;
            stdout: string;
            stderr: string;
            error?: Error;
          }>((resolveRun) => {
            execFile(
              "bash",
              ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!],
              {
                cwd: root,
                env,
                encoding: "utf8",
                timeout: 120_000,
              },
              (error, stdout, stderr) =>
                resolveRun({
                  status: error ? (typeof error.code === "number" ? error.code : null) : 0,
                  stdout,
                  stderr,
                  error: error && typeof error.code !== "number" ? error : undefined,
                }),
            );
          });
        };
        const baseline = await run(base);
        if (process.env.ACTIONS_PROBE_DEBUG)
          console.error(
            `${file}:${job}:${step.name ?? step.id}: baseline ${baseline.status} ${baseline.stderr}`,
          );
        const expectedExit = [
          "Reject unknown Codex auth mode",
          "Restore failed-review retry outcome",
          "Fail unsuccessful exact review generation",
        ].includes(step.name ?? "")
          ? 1
          : 0;
        assert.equal(
          baseline.status,
          expectedExit,
          `baseline failed: ${baseline.stdout}\n${baseline.stderr}`,
        );
        const normalOutput = readFileSync(base.GITHUB_OUTPUT, "utf8");
        const normalEnv = readFileSync(base.GITHUB_ENV, "utf8");
        if (
          /GITHUB_(?:OUTPUT|ENV)/.test(step.run!) &&
          step.name !== "Update final command status once"
        ) {
          assert.ok(normalOutput || normalEnv, "baseline must reach output serialization");
        }
        if (step.id === "target" && normalOutput.includes("target_branch=")) {
          assert.match(normalOutput, /^target_branch=release\/1\.2$/m);
        }
        if (step.name === "Export state configuration") {
          assert.ok(normalEnv.includes(`CLAWSWEEPER_STATE_DIR=${root}/state with spaces\n`));
        }
        if (step.name === "Resolve Codex home") {
          assert.match(normalEnv, /^CODEX_HOME=codex home$/m);
          for (const home of ["", ".codex-home", "./relative home", join(root, "absolute home")]) {
            const result = await run({ ...base, INPUTS_CODEX_HOME: home });
            assert.equal(result.status, 0, result.stderr);
            const expected = home || `${base.HOME}/.clawsweeper-repair/codex-home/123-1`;
            assert.equal(readFileSync(base.GITHUB_ENV, "utf8"), `CODEX_HOME=${expected}\n`);
          }
        }
        if (step.name === "Install observer shim") {
          const optionalDefaults = await run({
            ...base,
            SOURCE_ACTION: "",
            CLAIM_GENERATION: "",
            REPEAT_REVISION: "",
          });
          assert.equal(optionalDefaults.status, 0, optionalDefaults.stderr);
        }
        const failures: string[] = [];
        for (const name of variables) {
          for (const probe of ['x[$(touch "$PROBE_MARKER")]', '$(touch "$PROBE_MARKER")']) {
            const marker = join(root, "probe-marker");
            rmSync(marker, { force: true });
            const result = await run({ ...base, PROBE_MARKER: marker, [name]: probe });
            arithmeticProbes += 1;
            assert.equal(result.error, undefined, `${name}: ${result.error}`);
            if (existsSync(marker)) failures.push(`${name}: executed ${probe}`);
          }
          if (!/GITHUB_(?:OUTPUT|ENV)/.test(step.run!) && !normalOutput && !normalEnv) continue;
          const result = await run({ ...base, [name]: `${base[name]}\nforged_key=x` });
          recordProbes += 1;
          assert.equal(result.error, undefined, `${name}: ${result.error}`);
          for (const destination of [base.GITHUB_OUTPUT, base.GITHUB_ENV]) {
            if (/^forged_key=/m.test(readFileSync(destination, "utf8")))
              failures.push(
                `${name} -> ${destination.endsWith("/env") ? "GITHUB_ENV" : "GITHUB_OUTPUT"}`,
              );
          }
        }
        const pathVariables: Record<string, string[]> = {
          "Install observer shim": ["METRICS_PATH", "RATE_LIMIT_PATH"],
          "Resolve Codex home": ["INPUTS_CODEX_HOME"],
          "Export state configuration": ["INPUTS_STATE_PATH"],
        };
        for (const name of pathVariables[step.name ?? ""] ?? []) {
          const validPath = /METRICS|RATE_LIMIT/.test(name)
            ? ".artifacts/nested/valid..jsonl"
            : "nested/path..with spaces";
          const valid = await run({ ...base, [name]: validPath });
          assert.equal(
            valid.status,
            0,
            `${name}: non-parent dot sequences stay valid: ${valid.stderr}`,
          );
          for (const path of [
            ".artifacts/../../runner/traversal.jsonl",
            "../runner/traversal.jsonl",
            ".artifacts/..",
            "..",
          ]) {
            const result = await run({ ...base, [name]: path });
            traversalProbes += 1;
            assert.equal(result.error, undefined, `${name}: ${result.error}`);
            if (result.status === 0) failures.push(`${name}: accepted traversal ${path}`);
          }
        }
        assert.deepEqual(failures, [], `unsafe inputs: ${failures.join(", ")}`);
        const budgetPrefix =
          step.name === "Reserve exact review lease"
            ? ""
            : step.name === "Review exact event item"
              ? "STEPS_TARGET_OUTPUTS_"
              : null;
        if (budgetPrefix !== null) {
          for (const [field, max, min] of [
            ["CODEX_TIMEOUT_MS", 2_700_000, 1],
            ["MEDIA_PROOF_TIMEOUT_MS", 480_000, 0],
            ["MEDIA_PREPROCESSING_RESERVE_SECONDS", 480, 1],
          ] as const) {
            const name = `${budgetPrefix}${field}`;
            for (const valid of [String(min), String(max)]) {
              const result = await run({ ...base, [name]: valid });
              assert.equal(result.status, 0, `${name}=${valid}: ${result.stderr}`);
            }
            for (const invalid of ["-1", String(max + 1), "9".repeat(30), "08"]) {
              const result = await run({ ...base, [name]: invalid });
              assert.equal(result.status, 1, `${name}=${invalid}: must reject before arithmetic`);
            }
          }
        }
        if (step.name === "Export uploaded apply proof action ledger identity") {
          for (const invalid of [
            "review-123-1",
            "action-ledger-apply-proof-0-1",
            "action-ledger-apply-proof-123-1/suffix",
          ]) {
            const result = await run({
              ...base,
              STEPS_PROOF_ARTIFACT_OUTPUTS_ACTION_LEDGER_NAME: invalid,
            });
            assert.equal(result.status, 1, `${invalid}: must reject a different artifact shape`);
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    checks.push(check);
  }
  await Promise.all(checks);
  assert.equal(
    arithmeticProbes,
    rows.reduce((count, row) => count + row.variables.length * 2, 0),
  );
  t.diagnostic(
    `${arithmeticProbes} arithmetic probes; ${recordProbes} newline probes; ${traversalProbes} traversal probes`,
  );
});
