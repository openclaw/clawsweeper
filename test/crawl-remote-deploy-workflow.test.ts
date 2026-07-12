import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/deploy-crawl-remote.yml";
const mergedCrawlRemoteMain = "d6bb9b7a9c7eff0704dab4845a00e1863b7b8ef1";
const source = readFileSync(workflowPath, "utf8");
const workflow = parse(source);
const preflight = workflow.jobs.preflight;
const deploy = workflow.jobs.deploy;

interface WorkflowStep {
  name: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
}

function steps(job: { steps: WorkflowStep[] }): WorkflowStep[] {
  return job.steps;
}

function step(job: { steps: WorkflowStep[] }, name: string): WorkflowStep {
  const match = steps(job).find((candidate) => candidate.name === name);
  assert.ok(match, `missing workflow step: ${name}`);
  return match;
}

function exactFence(state: "dormant" | "active") {
  return [
    {
      success: true,
      results: [
        {
          capability: "gitcrawl.observation-order.v1",
          migration_ready: 1,
          cutover_enabled: state === "active" ? 1 : 0,
          activated_at: state === "active" ? "2026-07-12T07:00:00.000Z" : "",
        },
      ],
    },
  ];
}

test("crawl-remote release is maintainer-bound across two fresh runners", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "confirmation",
    "main_sha",
    "observation_order_state",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.observation_order_state, {
    description: "Expected Gitcrawl observation-order rollout state",
    required: true,
    default: "dormant",
    type: "choice",
    options: ["dormant", "active"],
  });
  for (const job of [preflight, deploy]) {
    assert.match(job.if, /github\.actor == 'vincentkoc'/);
    assert.match(job.if, /github\.actor_id == '25068'/);
    assert.match(job.if, /github\.triggering_actor == 'vincentkoc'/);
    assert.match(job.if, /github\.run_attempt == 1/);
    assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
    assert.match(job.if, /inputs\.confirmation == 'deploy crawl-remote production'/);
    assert.equal(job["runs-on"], "ubuntu-latest");
  }

  assert.equal(preflight.environment, undefined);
  assert.equal(deploy.needs, "preflight");
  assert.deepEqual(deploy.permissions, { contents: "read" });
  assert.match(deploy.if, /needs\.preflight\.result == 'success'/);
  assert.equal(
    deploy.env.OBSERVATION_ORDER_STATE,
    "${{ needs.preflight.outputs.observation_order_state }}",
  );
  assert.deepEqual(deploy.environment, {
    name: "crawl-remote-production",
    url: "https://crawl-remote.services-91b.workers.dev",
  });
  assert.equal(preflight["timeout-minutes"], 25);
  assert.equal(deploy["timeout-minutes"], 25);
});

test("preflight authorizes and checks out only the exact current main SHA", () => {
  const token = step(preflight, "Create exact-repository read token");
  assert.equal(
    token.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(token.with?.owner, "openclaw");
  assert.equal(token.with?.repositories, "crawl-remote");
  assert.equal(token.with?.["permission-contents"], "read");
  assert.equal(
    Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")).length,
    1,
  );

  const authorize = step(preflight, "Authorize immutable main release");
  assert.match(authorize.run ?? "", /\^\[0-9a-f\]\{40\}\$/);
  assert.match(authorize.run ?? "", /repos\/\$TARGET_REPOSITORY\/commits\/main/);
  assert.match(authorize.run ?? "", /\[\[ "\$REQUESTED_SHA" != "\$current_main_sha" \]\]/);
  assert.match(
    authorize.run ?? "",
    /OBSERVATION_ORDER_STATE.*"dormant".*OBSERVATION_ORDER_STATE.*"active"/s,
  );
  assert.doesNotMatch(authorize.run ?? "", /compare\/|comparison_status|ancestor|"ahead"/);
  assert.match(
    authorize.run ?? "",
    /crawl-remote-release-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{REQUESTED_SHA\}-\$\{OBSERVATION_ORDER_STATE\}/,
  );
  assert.match(
    authorize.run ?? "",
    /crawl-remote-release-receipt-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{REQUESTED_SHA\}-\$\{OBSERVATION_ORDER_STATE\}\.json/,
  );
  assert.match(authorize.run ?? "", /observation_order_state=\$OBSERVATION_ORDER_STATE/);

  const checkout = step(preflight, "Checkout approved crawl-remote release");
  assert.equal(checkout.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(checkout.with?.repository, "openclaw/crawl-remote");
  assert.equal(checkout.with?.ref, "${{ steps.authorize.outputs.deploy_sha }}");
  assert.equal(checkout.with?.token, "${{ steps.target-token.outputs.token }}");
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(checkout.with?.["fetch-depth"], 1);
  assert.match(step(preflight, "Verify checked-out release SHA").run ?? "", /git rev-parse HEAD/);

  assert.equal(
    step(preflight, "Setup Node").uses,
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  );
  assert.equal(step(preflight, "Install dependencies").run, "npm ci");
  assert.equal(step(preflight, "Typecheck").run, "npm run typecheck");
  assert.equal(step(preflight, "Test").run, "npm test");
  assert.match(step(preflight, "Build deploy bundle").run ?? "", /npm run deploy -- --dry-run/);
});

test("authorization scripts reject every SHA except the current crawl-remote main", () => {
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-main-authorization-"));
  const ghPath = join(directory, "gh");
  const outputPath = join(directory, "output");
  const receiptPath = join(directory, "receipt.json");
  writeFileSync(ghPath, '#!/bin/sh\nprintf "%s\\n" "$CURRENT_MAIN_SHA"\n');
  chmodSync(ghPath, 0o755);
  writeFileSync(receiptPath, "{}\n");

  function runScript(script: string, deploySha: string, authorize: boolean) {
    writeFileSync(outputPath, "");
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CURRENT_MAIN_SHA: mergedCrawlRemoteMain,
        DEPLOY_SHA: deploySha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456",
        OBSERVATION_ORDER_STATE: "dormant",
        PATH: `${directory}:${process.env.PATH}`,
        RECEIPT_PATH: receiptPath,
        REQUESTED_SHA: deploySha,
        TARGET_REPOSITORY: "openclaw/crawl-remote",
        ...(authorize ? {} : { GH_TOKEN: "test" }),
      },
    });
  }

  const authorize = step(preflight, "Authorize immutable main release").run ?? "";
  const reauthorize =
    step(deploy, "Reauthorize current main immediately before mutation").run ?? "";

  try {
    assert.equal(runScript(authorize, mergedCrawlRemoteMain, true).status, 0);
    assert.equal(runScript(reauthorize, mergedCrawlRemoteMain, false).status, 0);
    assert.notEqual(runScript(authorize, "a".repeat(40), true).status, 0);
    assert.notEqual(runScript(reauthorize, "a".repeat(40), false).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release artifact is immutable, bounded, canonical, and hash verified", () => {
  const packageArtifact = step(preflight, "Package bounded release artifact");
  const packaging = packageArtifact.run ?? "";
  assert.match(packaging, /bundle\/index\.js/);
  assert.match(packaging, /wrangler\.json/);
  assert.match(packaging, /migrations\/\$\{entry\.name\}/);
  assert.match(packaging, /createHash\('sha256'\)/);
  assert.match(packaging, /target_sha: targetSha/);
  assert.match(packaging, /artifact_name: artifactName/);
  assert.match(packaging, /observation_order_state: observationOrderState/);
  assert.match(packaging, /receipt_name: receiptName/);
  assert.match(packaging, /run_attempt: runAttempt/);
  assert.match(packaging, /entry\.isFile\(\)/);
  assert.match(packaging, /isSymbolicLink\(\)/);
  assert.match(packaging, /source Wrangler config has an unexpected deployment identity/);
  assert.match(packaging, /sourceConfig\.vars\?\.CRAWL_REMOTE_RELEASE_SHA/);
  assert.match(packaging, /source Wrangler config targets unexpected production resources/);

  const upload = step(preflight, "Upload immutable release artifact");
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(upload.with?.name, "${{ steps.authorize.outputs.artifact_name }}");
  assert.equal(upload.with?.overwrite, false);
  assert.equal(upload.with?.["if-no-files-found"], "error");
  assert.equal(upload.with?.["include-hidden-files"], false);
  assert.equal(upload.with?.["retention-days"], 1);

  const download = step(deploy, "Download immutable release artifact");
  assert.equal(download.uses, "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
  assert.equal(download.with?.name, "${{ needs.preflight.outputs.artifact_name }}");

  const verify = step(deploy, "Verify bounded release artifact").run ?? "";
  assert.match(verify, /assertExactKeys\([\s\S]*'release manifest'/);
  assert.match(verify, /\$\{label\} has unexpected fields/);
  assert.match(verify, /release manifest is not canonical/);
  assert.match(verify, /manifest\.observation_order_state !== observationOrderState/);
  assert.match(verify, /artifact contains symlink/);
  assert.match(verify, /files outside the manifest allowlist/);
  assert.match(verify, /release artifact hash mismatch/);
  assert.match(verify, /release artifact file exceeds its size limit/);
  assert.match(verify, /file\.path === 'bundle\/index\.js'/);
  assert.match(verify, /file\.path === 'wrangler\.json'/);
  assert.match(verify, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(verify, /bundle\/index\.js/);
  assert.match(verify, /wrangler\.json/);
  assert.match(verify, /\^migrations\\\/\[0-9\]\{4\}/);
  assert.match(verify, /deployment Wrangler config has unsafe execution fields/);
  assert.match(verify, /config\.vars\?\.CRAWL_REMOTE_RELEASE_SHA/);
  assert.match(verify, /Object\.hasOwn\(config, 'build'\)/);
  assert.match(verify, /deployment Wrangler config targets unexpected resources/);
  assert.match(verify, /flag: 'wx'/);
  assert.match(verify, /release receipt already exists/);
});

test("artifact verifier rejects tampering, extras, cross-state reuse, and oversized files", () => {
  const run = step(deploy, "Verify bounded release artifact").run ?? "";
  const validator = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(validator, "missing inline release artifact verifier");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-artifact-proof-"));
  const runId = "123456";
  const runAttempt = 1;
  const targetSha = mergedCrawlRemoteMain;

  function hash(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  function fixture(label: string, bundle = Buffer.from("export default {};\n")) {
    const state = "dormant";
    const artifactName = `crawl-remote-release-${runId}-${runAttempt}-${targetSha}-${state}`;
    const receiptName = `crawl-remote-release-receipt-${runId}-${runAttempt}-${targetSha}-${state}.json`;
    const root = join(directory, label);
    mkdirSync(join(root, "bundle"), { recursive: true });
    mkdirSync(join(root, "migrations"), { recursive: true });

    const config = `${JSON.stringify(
      {
        name: "crawl-remote",
        compatibility_date: "2026-05-27",
        workers_dev: true,
        observability: { enabled: true },
        vars: {},
        routes: [
          {
            pattern: "reports.openclaw.ai/crawl-remote/*",
            zone_name: "openclaw.ai",
          },
        ],
        d1_databases: [
          {
            binding: "DB",
            database_name: "crawl-remote",
            database_id: "42baacd3-c917-400f-a12f-e0fada21e11f",
          },
        ],
        r2_buckets: [
          {
            binding: "ARCHIVES",
            bucket_name: "crawl-remote-archives",
          },
        ],
      },
      null,
      2,
    )}\n`;
    const migration = "select 1;\n";
    const payloads = new Map<string, Buffer>([
      ["bundle/index.js", bundle],
      ["migrations/0001_test.sql", Buffer.from(migration)],
      ["wrangler.json", Buffer.from(config)],
    ]);
    for (const [path, content] of payloads) {
      writeFileSync(join(root, path), content);
    }
    const files = [...payloads.entries()]
      .map(([path, content]) => ({
        path,
        sha256: hash(content),
        bytes: content.byteLength,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      schema_version: 1,
      target_repository: "openclaw/crawl-remote",
      target_sha: targetSha,
      run_id: runId,
      run_attempt: runAttempt,
      artifact_name: artifactName,
      observation_order_state: state,
      receipt_name: receiptName,
      files,
    };
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      artifactName,
      receiptName,
      receiptPath: join(directory, `${label}.receipt.json`),
      root,
      state,
    };
  }

  function validate(
    artifact: ReturnType<typeof fixture>,
    state = artifact.state,
  ): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_NAME: artifact.artifactName,
        DEPLOY_SHA: targetSha,
        GITHUB_RUN_ATTEMPT: String(runAttempt),
        GITHUB_RUN_ID: runId,
        OBSERVATION_ORDER_STATE: state,
        RECEIPT_NAME: artifact.receiptName,
        RECEIPT_PATH: artifact.receiptPath,
        RELEASE_ROOT: artifact.root,
      },
    });
  }

  try {
    assert.equal(validate(fixture("valid")).status, 0);

    const tampered = fixture("tampered");
    writeFileSync(join(tampered.root, "bundle", "index.js"), "tampered\n");
    assert.notEqual(validate(tampered).status, 0);

    const extra = fixture("extra");
    writeFileSync(join(extra.root, "unexpected.txt"), "unexpected\n");
    assert.notEqual(validate(extra).status, 0);

    assert.notEqual(validate(fixture("cross-state"), "active").status, 0);

    const oversized = fixture("oversized", Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.notEqual(validate(oversized).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("protected deploy never executes target lifecycle code", () => {
  const deployRuns = steps(deploy)
    .map((candidate) => candidate.run ?? "")
    .join("\n");
  assert.equal(deployRuns.match(/\bnpm ci\b/g)?.length, 1);
  assert.doesNotMatch(deployRuns, /\bnpm (test|run|exec)\b/);
  assert.doesNotMatch(deployRuns, /\bnpx\b/);
  assert.doesNotMatch(deployRuns, /\$RELEASE_ROOT\/package\.json|src\/index/);
  assert.doesNotMatch(deployRuns, /\bsource\b|\beval\b|bash -c|sh -c/);
  assert.equal(deployRuns.match(/\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/g)?.length, 2);
  assert.equal(
    steps(deploy).filter((candidate) => candidate.uses?.startsWith("actions/checkout@")).length,
    1,
  );
  const checkout = step(deploy, "Checkout trusted deployment toolchain");
  assert.equal(checkout.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(checkout.with?.repository, "openclaw/clawsweeper");
  assert.equal(checkout.with?.ref, "${{ github.sha }}");
  assert.equal(checkout.with?.["sparse-checkout"], ".github/deploy/crawl-remote-toolchain");
  assert.equal(checkout.with?.["sparse-checkout-cone-mode"], false);
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(checkout.with?.["fetch-depth"], 1);
  assert.equal(checkout.with?.token, undefined);
  assert.equal(deploy.defaults.run.shell, "bash --noprofile --norc -euo pipefail {0}");
  assert.equal(deploy.env.BASH_ENV, "");
  assert.equal(deploy.env.ENV, "");
  assert.equal(deploy.env.NODE_OPTIONS, "");
  for (const candidate of steps(deploy).filter((item) => item.run)) {
    assert.match(candidate.run ?? "", /unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS/);
  }
});

test("deploy installs the committed exact Node and Wrangler toolchain before credentials", () => {
  assert.equal(
    step(deploy, "Setup trusted Node runtime").uses,
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  );
  assert.equal(step(deploy, "Setup trusted Node runtime").with?.["node-version"], "24.18.0");
  assert.equal(deploy.env.WRANGLER_VERSION, "4.107.1");
  assert.equal(
    deploy.env.TOOLCHAIN_ROOT,
    "${{ github.workspace }}/.github/deploy/crawl-remote-toolchain",
  );

  const toolchainPackage = JSON.parse(
    readFileSync(".github/deploy/crawl-remote-toolchain/package.json", "utf8"),
  );
  const toolchainLock = JSON.parse(
    readFileSync(".github/deploy/crawl-remote-toolchain/package-lock.json", "utf8"),
  );
  assert.deepEqual(toolchainPackage, {
    name: "crawl-remote-deployment-toolchain",
    version: "1.0.0",
    private: true,
    engines: { node: "24.18.0" },
    dependencies: { wrangler: "4.107.1" },
  });
  assert.equal(toolchainLock.lockfileVersion, 3);
  assert.equal(toolchainLock.packages[""].dependencies.wrangler, "4.107.1");
  assert.equal(toolchainLock.packages[""].engines.node, "24.18.0");
  assert.equal(toolchainLock.packages["node_modules/wrangler"].version, "4.107.1");
  assert.match(toolchainLock.packages["node_modules/wrangler"].integrity, /^sha512-/);

  const install = step(deploy, "Install exact trusted Wrangler");
  assert.match(
    install.run ?? "",
    /npm ci --ignore-scripts --no-audit --no-fund --prefix "\$TOOLCHAIN_ROOT"/,
  );
  assert.doesNotMatch(install.run ?? "", /npm install|wrangler@/);
  assert.match(install.run ?? "", /actual_version=.*--version/);
  assert.equal(install.env?.CLOUDFLARE_API_TOKEN, undefined);

  const credentialSteps = steps(deploy).filter(
    (candidate) => candidate.env?.CLOUDFLARE_API_TOKEN !== undefined,
  );
  assert.deepEqual(
    credentialSteps.map((candidate) => candidate.name),
    ["Apply migrations and deploy verified bundle"],
  );
  const credentialStep = credentialSteps[0];
  assert.ok(credentialStep);
  assert.ok(steps(deploy).indexOf(install) < steps(deploy).indexOf(credentialStep));
  assert.equal(
    credentialStep.env?.CLOUDFLARE_API_TOKEN,
    "${{ secrets.CRAWL_REMOTE_CLOUDFLARE_API_TOKEN }}",
  );
  assert.doesNotMatch(source, /OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN/);
  assert.doesNotMatch(source, /\|\|\s*secrets\./);
  assert.equal(source.match(/CRAWL_REMOTE_CLOUDFLARE_API_TOKEN/g)?.length, 1);
});

test("deploy reauthorizes exact current main and consumes one receipt before mutation", () => {
  const token = step(deploy, "Create exact-repository reauthorization token");
  assert.equal(
    token.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(token.with?.repositories, "crawl-remote");
  assert.equal(token.with?.["permission-contents"], "read");
  assert.equal(
    Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")).length,
    1,
  );

  const reauthorize = step(deploy, "Reauthorize current main immediately before mutation");
  assert.match(reauthorize.run ?? "", /\[\[ "\$DEPLOY_SHA" != "\$current_main_sha" \]\]/);
  assert.doesNotMatch(reauthorize.run ?? "", /compare\/|comparison_status|ancestor|"ahead"/);

  const reauthorizeIndex = steps(deploy).indexOf(reauthorize);
  const mutation = step(deploy, "Apply migrations and deploy verified bundle");
  const mutationIndex = steps(deploy).indexOf(mutation);
  assert.equal(reauthorizeIndex + 1, mutationIndex);
  assert.match(mutation.run ?? "", /test ! -e "\$consumed_receipt"/);
  assert.match(mutation.run ?? "", /mv -- "\$RECEIPT_PATH" "\$consumed_receipt"/);
});

test("privileged mutation uses only verified files and proves the selected D1 fence state", () => {
  const mutation = step(deploy, "Apply migrations and deploy verified bundle").run ?? "";
  assert.match(mutation, /\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/);
  assert.match(mutation, /d1 migrations apply crawl-remote/);
  assert.match(mutation, /--cwd "\$RELEASE_ROOT"/);
  assert.match(mutation, /--config wrangler\.json/);
  assert.match(mutation, /d1 execute crawl-remote/);
  assert.match(
    mutation,
    /select capability, migration_ready, cutover_enabled, activated_at from remote_capability_fences/,
  );
  assert.match(mutation, /capability = 'gitcrawl\.observation-order\.v1'/);
  assert.match(mutation, /executions\.length !== 1/);
  assert.match(mutation, /rows\.length !== 1/);
  assert.match(mutation, /fence\?\.migration_ready !== 1/);
  assert.match(mutation, /expectedState === 'active' \? 1 : 0/);
  assert.match(mutation, /fence\?\.cutover_enabled !== expectedCutover/);
  assert.match(mutation, /expectedState === 'active'/);
  assert.match(mutation, /fence\.activated_at\.trim\(\)\.length === 0/);
  assert.match(mutation, /expectedState === 'dormant'.*fence\?\.activated_at !== ''/s);
  assert.match(mutation, /PRE_FENCE_STATUS="\$pre_fence_status"/);
  assert.match(mutation, /no such table: remote_capability_fences: SQLITE_ERROR/);
  assert.match(mutation, /JSON\.stringify\(failureKeys\).*JSON\.stringify\(\['error'\]\)/s);
  assert.match(mutation, /errorOutput\.length !== 0/);
  assert.match(mutation, /expectedState !== 'dormant'/);
  assert.match(mutation, /pre-migration query failed/);
  assert.match(mutation, /deploy bundle\/index\.js/);
  assert.match(mutation, /--no-bundle/);
  assert.match(mutation, /--strict/);
  assert.match(mutation, /--var "CRAWL_REMOTE_RELEASE_SHA:\$DEPLOY_SHA"/);
  assert.match(mutation, /--message "main \$\{DEPLOY_SHA\}"/);

  const preQueryIndex = mutation.indexOf('> "$PRE_FENCE_RESPONSE"');
  const migrationIndex = mutation.indexOf('"$wrangler" d1 migrations apply');
  const postQueryIndex = mutation.indexOf('> "$FENCE_RESPONSE"');
  const deployIndex = mutation.indexOf('"$wrangler" deploy bundle/index.js');
  assert.ok(preQueryIndex >= 0);
  assert.ok(preQueryIndex < migrationIndex);
  assert.ok(migrationIndex < postQueryIndex);
  assert.ok(postQueryIndex < deployIndex);
});

test("pre-migration fence validator rejects mismatch and gates missing-table bootstrap", () => {
  const run = step(deploy, "Apply migrations and deploy verified bundle").run ?? "";
  const validator = run.match(
    /node --input-type=module <<'PRE_FENCE_NODE'\n([\s\S]*?)\nPRE_FENCE_NODE/,
  )?.[1];
  assert.ok(validator, "missing inline pre-migration D1 fence validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-pre-fence-proof-"));
  const responsePath = join(directory, "fence.json");
  const errorPath = join(directory, "fence.err");

  function validate(
    state: "dormant" | "active",
    options: {
      status?: number;
      response?: unknown;
      error?: string;
    },
  ) {
    const response = options.response ?? exactFence(state);
    writeFileSync(responsePath, typeof response === "string" ? response : JSON.stringify(response));
    writeFileSync(errorPath, options.error ?? "");
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        OBSERVATION_ORDER_STATE: state,
        PRE_FENCE_ERROR: errorPath,
        PRE_FENCE_RESPONSE: responsePath,
        PRE_FENCE_STATUS: String(options.status ?? 0),
      },
    });
  }

  try {
    assert.equal(validate("dormant", {}).status, 0);
    assert.equal(validate("active", {}).status, 0);
    assert.notEqual(validate("dormant", { response: exactFence("active") }).status, 0);
    assert.notEqual(validate("active", { response: exactFence("dormant") }).status, 0);
    assert.equal(
      validate("dormant", {
        status: 1,
        response: {
          error: {
            text: "no such table: remote_capability_fences: SQLITE_ERROR",
          },
        },
      }).status,
      0,
    );
    assert.notEqual(
      validate("active", {
        status: 1,
        response: {
          error: {
            text: "D1_ERROR: no such table: remote_capability_fences: SQLITE_ERROR",
          },
        },
      }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", {
        status: 1,
        response: { error: { text: "authentication failed" } },
      }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", {
        status: 1,
        response: {
          error: {
            text: "no such table: remote_capability_fences: SQLITE_ERROR",
          },
        },
        error: "unexpected stderr",
      }).status,
      0,
    );
    assert.notEqual(validate("dormant", { response: [] }).status, 0);
    assert.notEqual(validate("dormant", { response: "not json" }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-migration D1 fence validator accepts only the selected state", () => {
  const run = step(deploy, "Apply migrations and deploy verified bundle").run ?? "";
  const validator = run.match(
    /node --input-type=module <<'POST_FENCE_NODE'\n([\s\S]*?)\nPOST_FENCE_NODE/,
  )?.[1];
  assert.ok(validator, "missing inline post-migration D1 fence validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-post-fence-proof-"));
  const responsePath = join(directory, "fence.json");

  function validate(
    state: "dormant" | "active",
    cutoverEnabled: unknown,
    activatedAt: string,
    migrationReady: unknown = 1,
  ) {
    writeFileSync(
      responsePath,
      JSON.stringify([
        {
          success: true,
          results: [
            {
              capability: "gitcrawl.observation-order.v1",
              migration_ready: migrationReady,
              cutover_enabled: cutoverEnabled,
              activated_at: activatedAt,
            },
          ],
        },
      ]),
    );
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        FENCE_RESPONSE: responsePath,
        OBSERVATION_ORDER_STATE: state,
      },
    });
  }

  try {
    assert.equal(validate("dormant", 0, "").status, 0);
    assert.equal(validate("active", 1, "2026-07-12T07:00:00.000Z").status, 0);
    assert.notEqual(validate("dormant", 1, "2026-07-12T07:00:00.000Z").status, 0);
    assert.notEqual(validate("active", 0, "").status, 0);
    assert.notEqual(validate("active", 1, "").status, 0);
    assert.notEqual(validate("active", 1, "   ").status, 0);
    assert.notEqual(validate("dormant", "0", "").status, 0);
    assert.notEqual(validate("dormant", 0, "", "1").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production proof polls semantic state and binds both responses to the release", () => {
  const verify = step(deploy, "Poll exact production release");
  const run = verify.run ?? "";
  assert.equal(verify.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.match(run, /while \(\( SECONDS < deadline \)\)/);
  assert.match(run, /fetch_endpoint\(\)/);
  assert.match(run, /timeout="\$remaining"/);
  assert.match(run, /--max-filesize 1048576/);
  assert.match(run, /sleep "\$sleep_for"/);
  assert.match(run, /\$PRODUCTION_URL\/health/);
  assert.match(run, /\$PRODUCTION_URL\/v1\/contract/);
  assert.match(run, /health\.release_sha !== expectedSha/);
  assert.match(run, /contract\.release_sha !== expectedSha/);
  assert.match(
    run,
    /Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated\./,
  );
  assert.match(run, /notes\.includes\(observationFenceNote\)/);
  assert.match(run, /expectedObservationOrderState/);
  assert.match(run, /production Gitcrawl capabilities are malformed/);
  assert.match(run, /capabilities\.includes\(\s*'gitcrawl\.observation-order\.v1'/);
  assert.match(run, /expectedObservationOrderState === 'active'.*!observationOrderActive/s);
  assert.match(run, /expectedObservationOrderState === 'dormant'.*observationOrderActive/s);
  assert.match(run, /process\.exit\(1\)/);
  assert.match(run, /did not converge to release \$DEPLOY_SHA/);
  assert.doesNotMatch(run, /curl .*--retry/s);
});

test("production semantic validator accepts only the selected observation-order state", () => {
  const run = step(deploy, "Poll exact production release").run ?? "";
  const validator = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(validator, "missing inline production semantic validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-production-proof-"));
  const healthPath = join(directory, "health.json");
  const contractPath = join(directory, "contract.json");
  const releaseSha = mergedCrawlRemoteMain;
  const observationCapability = "gitcrawl.observation-order.v1";
  const observationFenceNote =
    "Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated.";

  function validate(state: "dormant" | "active", capabilities: unknown, responseSha = releaseSha) {
    writeFileSync(healthPath, JSON.stringify({ ok: true, release_sha: responseSha }));
    writeFileSync(
      contractPath,
      JSON.stringify({
        service: "crawl-remote",
        protocol_version: "v1",
        release_sha: responseSha,
        notes: [observationFenceNote],
        routes: [
          { method: "GET", path: "/health" },
          { method: "GET", path: "/v1/contract" },
        ],
        apps: [{ app: "gitcrawl", capabilities }],
      }),
    );
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        CONTRACT_RESPONSE: contractPath,
        DEPLOY_SHA: releaseSha,
        HEALTH_RESPONSE: healthPath,
        OBSERVATION_ORDER_STATE: state,
      },
    });
  }

  try {
    assert.equal(validate("dormant", []).status, 0);
    assert.equal(validate("active", [observationCapability]).status, 0);
    assert.notEqual(validate("dormant", [observationCapability]).status, 0);
    assert.notEqual(validate("active", []).status, 0);
    assert.notEqual(validate("dormant", [], "b".repeat(40)).status, 0);
    assert.notEqual(validate("dormant", null).status, 0);
    assert.notEqual(validate("dormant", "gitcrawl.observation-order.v1").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
