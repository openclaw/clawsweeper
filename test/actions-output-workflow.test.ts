import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  /client_payload|\binputs\.|github\.event\.inputs|github\.head_ref|github\.event\.(?:comment|issue|pull_request|review)/;
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
  return paths.flatMap((file) => {
    const doc = YAML.parse(readFileSync(file, "utf8"));
    const jobs: Record<string, { steps?: Step[] }> = doc.jobs ?? { composite: doc.runs };
    return Object.entries(jobs).flatMap(([job, definition]) =>
      (definition.steps ?? []).flatMap((step) => {
        const variables = Object.entries(step.env ?? {})
          .filter(([, value]) => untrusted.test(String(value)))
          .map(([key]) => key);
        return step.run && /GITHUB_(?:OUTPUT|ENV)/.test(step.run) && variables.length
          ? [{ file, job, step, variables }]
          : [];
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
    INPUTS_WORKING_DIRECTORY: ".",
    INPUTS_TARGET_DIR: "target",
    INPUTS_STATE_PATH: "state with spaces",
    PIN_FILE: "target/extensions/codex/package.json",
    INPUTS_PNPM_VERSION: "12.4.1",
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
  if (/REPO|REPOSITORY/.test(name)) return "openclaw/openclaw";
  if (/LEASE_ID/.test(name)) return leaseId;
  if (/REVISION|GENERATION/.test(name)) return "1";
  if (/ITEM_NUMBERS|ITEM_NUMBER/.test(name)) return "42";
  if (/COMMENT_ID/.test(name)) return "7";
  if (/TOKEN/.test(name)) return "fixture-token";
  if (/QUEUE_URL/.test(name)) return "https://queue.invalid";
  return "";
}

// Keep production parsers and Bash bodies intact. Only network/process boundaries
// are fixtures; an unknown external invocation fails instead of reaching live APIs.
function fixture(root: string) {
  for (const dir of ["bin", "scripts", "target/extensions/codex", "action", "runner"])
    mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(join(repository, "src"), join(root, "src"), "dir");
  const write = (path: string, content: string) =>
    writeFileSync(join(root, path), content, { mode: 0o755 });
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
  const curl = `control_plane_curl() {\n  local out=""\n  while [ "$#" -gt 0 ]; do\n    if [ "$1" = --output ]; then out="$2"; shift; fi\n    shift\n  done\n  [ -z "$out" ] || cp "$FIXTURE_ROOT/response.json" "$out"\n  printf 200\n}\ncontrol_plane_signed_post() { return 0; }\n`;
  write("scripts/control-plane-curl.sh", curl);
  write("runner/control-plane-curl.sh", curl);
  write(
    "scripts/apply-workflow-helpers.sh",
    readFileSync("scripts/apply-workflow-helpers.sh", "utf8") +
      `\n# No remote publication in this fixture. Selection and serialization stay real.\npublish_status() { :; }\npublish_changes() { :; }\npublish_reconciled_records() { :; }\nbegin_canonical_record_mutation() { :; }\n`,
  );
  write(
    "bin/gh",
    `#!/bin/bash\nprintf '%s\\n' '[{"id":7,"user":{"login":"clawsweeper[bot]"},"body":"<!-- clawsweeper-pr-ack:opened item=42 -->"}]'\n`,
  );
  write("bin/git", "#!/bin/bash\nprintf '%040d\\n' 1\n");
  write("bin/curl", "#!/bin/bash\nexit 97\n");
  write("bin/sleep", "#!/bin/bash\nexit 0\n");
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
  *' merge-apply-reports '*) : ;;
  *' reconcile '*|*' summarize-apply-report '*|*' status '*) printf '{}\\n' ;;
  *) echo "Unexpected pnpm invocation: $*" >&2; exit 97 ;;
esac
`,
  );
  write(
    "bin/node",
    `#!/bin/bash
case "$1" in
  --input-type=module) exec "$REAL_NODE" --import "$FIXTURE_ROOT/preload.mjs" "$@" ;;
  dist/clawsweeper.js)
    if [ "$2" = assist-target ]; then exec "$REAL_NODE" "$SOURCE_ROOT/$1" "\${@:2}"; fi
    if [ "$2" = assist-generate ]; then exit 0; fi ;;
  dist/repair/exact-review-queue-request.js) shift; exec "$REAL_NODE" "$FIXTURE_ROOT/runner/exact-review-queue-request.mts" "$@" ;;
  "$FIXTURE_ROOT/runner/"*.mts|"$FIXTURE_ROOT/action/validate-pin.mjs") exec "$REAL_NODE" "$@" ;;
esac
echo "Unexpected node invocation: $*" >&2
exit 97
`,
  );
}

// No exemptions: every matching workflow/action step is executed. A clean baseline
// is mandatory so missing fixtures or an early unrelated failure cannot fake safety.
test("workflow output files cannot acquire records from untrusted env values", async (t) => {
  const rows = candidates();
  assert.ok(rows.length >= 30, "enumerate workflows and composite actions");
  t.diagnostic(
    `${rows.length} steps; ${rows.reduce((count, row) => count + row.variables.length, 0)} untrusted variables; no exemptions`,
  );
  for (const { file, job, step, variables } of rows) {
    await t.test(`${file}:${job}:${step.name ?? step.id}`, () => {
      const root = mkdtempSync(join(tmpdir(), "actions-output-"));
      try {
        fixture(root);
        const base: Record<string, string> = {
          PATH: `${root}/bin:${process.env.PATH}`,
          REAL_NODE: process.execPath,
          SOURCE_ROOT: repository,
          FIXTURE_ROOT: root,
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_ENV: join(root, "env"),
          GITHUB_PATH: join(root, "path"),
          GITHUB_WORKSPACE: root,
          GITHUB_ACTION_PATH: join(root, "action"),
          RUNNER_TEMP: join(root, "runner"),
          RUNNER_OS: "Linux",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          WORKFLOW_RUN_ID: "123",
          WORKFLOW_REPOSITORY: "openclaw/clawsweeper",
          CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS: String(Date.now()),
          CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED: "false",
          CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED: "false",
          CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED: "false",
        };
        for (const name of Object.keys(step.env ?? {})) base[name] = valueFor(name);
        const run = (env: Record<string, string>) => {
          writeFileSync(base.GITHUB_OUTPUT, "");
          writeFileSync(base.GITHUB_ENV, "");
          return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
            cwd: root,
            env,
            encoding: "utf8",
            timeout: 120_000,
          });
        };
        const baseline = run(base);
        assert.equal(baseline.status, 0, `baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
        const normalOutput = readFileSync(base.GITHUB_OUTPUT, "utf8");
        const normalEnv = readFileSync(base.GITHUB_ENV, "utf8");
        if (step.name !== "Update final command status once") {
          assert.ok(normalOutput || normalEnv, "baseline must reach output serialization");
        }
        if (step.id === "target" && normalOutput.includes("target_branch=")) {
          assert.match(normalOutput, /^target_branch=release\/1\.2$/m);
        }
        if (step.name === "Export state configuration") {
          assert.ok(normalEnv.includes(`CLAWSWEEPER_STATE_DIR=${root}/state with spaces\n`));
        }
        const failures: string[] = [];
        for (const name of variables) {
          const result = run({ ...base, [name]: `${base[name]}\nforged_key=x` });
          assert.equal(result.error, undefined, `${name}: ${result.error}`);
          for (const destination of [base.GITHUB_OUTPUT, base.GITHUB_ENV]) {
            if (/^forged_key=/m.test(readFileSync(destination, "utf8")))
              failures.push(
                `${name} -> ${destination.endsWith("/env") ? "GITHUB_ENV" : "GITHUB_OUTPUT"}`,
              );
          }
        }
        assert.deepEqual(failures, [], `forged records: ${failures.join(", ")}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
