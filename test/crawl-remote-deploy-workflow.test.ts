import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/deploy-crawl-remote.yml";
const cloudflareAccountId = "1".repeat(32);
const d1DatabaseId = "22222222-2222-4222-8222-222222222222";
const mergedCrawlRemoteMain = "d6bb9b7a9c7eff0704dab4845a00e1863b7b8ef1";
const source = readFileSync(workflowPath, "utf8");
const workflow = parse(source);
const preflight = workflow.jobs.preflight;
const deploy = workflow.jobs.deploy;

interface WorkflowStep {
  name: string;
  id?: string;
  if?: string;
  "continue-on-error"?: boolean;
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

function exactFences(
  observationState: "dormant" | "active",
  snapshotState: "dormant" | "active" = observationState,
  includeSnapshot = true,
) {
  const fence = (capability: string, state: "dormant" | "active") => ({
    capability,
    migration_ready: 1,
    cutover_enabled: state === "active" ? 1 : 0,
    activated_at: state === "active" ? "2026-07-12T07:00:00.000Z" : "",
  });
  return [
    {
      success: true,
      results: [
        fence("gitcrawl.observation-order.v1", observationState),
        ...(includeSnapshot ? [fence("gitcrawl.snapshot.provenance.v1", snapshotState)] : []),
      ],
    },
  ];
}

function apiErrorFailure({
  accountTag = cloudflareAccountId,
  code = 7500,
  note = "D1_ERROR: no such table: remote_capability_fences: SQLITE_ERROR [code: 7500]",
  text = `A request to the Cloudflare API (/accounts/${cloudflareAccountId}/d1/database/${d1DatabaseId}/query) failed.`,
}: {
  accountTag?: string;
  code?: number;
  note?: string;
  text?: string;
} = {}) {
  return {
    error: {
      text,
      notes: [{ text: note }],
      kind: "error",
      name: "APIError",
      code,
      accountTag,
    },
  };
}

test("crawl-remote release is maintainer-bound across two fresh runners", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "confirmation",
    "main_sha",
    "observation_order_state",
    "snapshot_provenance_state",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.observation_order_state, {
    description: "Expected Gitcrawl observation-order rollout state",
    required: true,
    default: "dormant",
    type: "choice",
    options: ["dormant", "active"],
  });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.snapshot_provenance_state, {
    description: "Expected Gitcrawl snapshot-provenance rollout state",
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
  assert.equal(
    deploy.env.SNAPSHOT_PROVENANCE_STATE,
    "${{ needs.preflight.outputs.snapshot_provenance_state }}",
  );
  assert.deepEqual(deploy.environment, {
    name: "crawl-remote-production",
    url: "https://crawl-remote.services-91b.workers.dev",
  });
  assert.equal(deploy.env.DEPLOY_AUTHORITY, undefined);
  assert.equal(deploy.env.CLOUDFLARE_TOKEN_SHA256, undefined);
  assert.equal(deploy.env.CUSTOM_ROUTE_PROOF, undefined);
  assert.equal(deploy.env.WORKERS_DEV_URL, "https://crawl-remote.services-91b.workers.dev");
  assert.equal(deploy.env.PRODUCTION_ROUTE_URL, "https://reports.openclaw.ai/crawl-remote");
  const authority = step(deploy, "Verify central deployment authority");
  assert.equal(steps(deploy).indexOf(authority), 0);
  assert.equal(authority.env?.DEPLOY_AUTHORITY, "${{ vars.CRAWL_REMOTE_DEPLOY_AUTHORITY }}");
  assert.equal(authority.env?.CUSTOM_ROUTE_PROOF, "${{ vars.CRAWL_REMOTE_CUSTOM_ROUTE_PROOF }}");
  assert.match(authority.run ?? "", /DEPLOY_AUTHORITY.*clawsweeper-v1/s);
  assert.match(authority.run ?? "", /disabled.*access-service-token/s);
  assert.equal(preflight["timeout-minutes"], 25);
  assert.equal(deploy["timeout-minutes"], 25);
});

test("protected environment must explicitly own the deployment authority", () => {
  const run = step(deploy, "Verify central deployment authority").run ?? "";
  function verify(authority: string, customRouteProof: string) {
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CUSTOM_ROUTE_PROOF: customRouteProof,
        DEPLOY_AUTHORITY: authority,
      },
    });
  }

  assert.equal(verify("clawsweeper-v1", "disabled").status, 0);
  assert.equal(verify("clawsweeper-v1", "access-service-token").status, 0);
  assert.notEqual(verify("", "disabled").status, 0);
  assert.notEqual(verify("crawl-remote-v1", "disabled").status, 0);
  assert.notEqual(verify("clawsweeper-v1", "").status, 0);
  assert.notEqual(verify("clawsweeper-v1", "public").status, 0);
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
  assert.match(
    authorize.run ?? "",
    /SNAPSHOT_PROVENANCE_STATE.*"dormant".*SNAPSHOT_PROVENANCE_STATE.*"active"/s,
  );
  assert.doesNotMatch(authorize.run ?? "", /compare\/|comparison_status|ancestor|"ahead"/);
  assert.match(
    authorize.run ?? "",
    /crawl-remote-release-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{REQUESTED_SHA\}-\$\{OBSERVATION_ORDER_STATE\}-\$\{SNAPSHOT_PROVENANCE_STATE\}/,
  );
  assert.match(
    authorize.run ?? "",
    /crawl-remote-release-receipt-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{REQUESTED_SHA\}-\$\{OBSERVATION_ORDER_STATE\}-\$\{SNAPSHOT_PROVENANCE_STATE\}\.json/,
  );
  assert.match(authorize.run ?? "", /observation_order_state=\$OBSERVATION_ORDER_STATE/);
  assert.match(authorize.run ?? "", /snapshot_provenance_state=\$SNAPSHOT_PROVENANCE_STATE/);

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
  const consumedReceiptPath = `${receiptPath}.consumed`;
  writeFileSync(ghPath, '#!/bin/sh\nprintf "%s\\n" "$CURRENT_MAIN_SHA"\n');
  chmodSync(ghPath, 0o755);
  writeFileSync(receiptPath, "{}\n");
  writeFileSync(consumedReceiptPath, "{}\n");

  function runScript(script: string, deploySha: string, authorize: boolean) {
    writeFileSync(outputPath, "");
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONSUMED_RECEIPT_PATH: consumedReceiptPath,
        CURRENT_MAIN_SHA: mergedCrawlRemoteMain,
        DEPLOY_SHA: deploySha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456",
        OBSERVATION_ORDER_STATE: "dormant",
        PATH: `${directory}:${process.env.PATH}`,
        RECEIPT_PATH: receiptPath,
        REQUESTED_SHA: deploySha,
        SNAPSHOT_PROVENANCE_STATE: "dormant",
        TARGET_REPOSITORY: "openclaw/crawl-remote",
        ...(authorize ? {} : { GH_TOKEN: "test" }),
      },
    });
  }

  const authorize = step(preflight, "Authorize immutable main release").run ?? "";
  const reauthorizeBeforeD1 = step(deploy, "Reauthorize current main before D1 mutation").run ?? "";
  const reauthorizeBeforeWorker =
    step(deploy, "Reauthorize current main immediately before Worker deploy").run ?? "";
  const reauthorizeAfterWorker =
    step(deploy, "Reauthorize current main after Worker deploy").run ?? "";

  try {
    assert.equal(runScript(authorize, mergedCrawlRemoteMain, true).status, 0);
    assert.equal(runScript(reauthorizeBeforeD1, mergedCrawlRemoteMain, false).status, 0);
    assert.equal(runScript(reauthorizeBeforeWorker, mergedCrawlRemoteMain, false).status, 0);
    assert.equal(runScript(reauthorizeAfterWorker, mergedCrawlRemoteMain, false).status, 0);
    assert.notEqual(runScript(authorize, "a".repeat(40), true).status, 0);
    assert.notEqual(runScript(reauthorizeBeforeD1, "a".repeat(40), false).status, 0);
    assert.notEqual(runScript(reauthorizeBeforeWorker, "a".repeat(40), false).status, 0);
    assert.notEqual(runScript(reauthorizeAfterWorker, "a".repeat(40), false).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Worker deploy reauthorization rejects main moving after D1 migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-moving-main-"));
  const consumedReceiptPath = join(directory, "receipt.json.consumed");
  const counterPath = join(directory, "gh-calls");
  const ghPath = join(directory, "gh");
  const receiptPath = join(directory, "receipt.json");
  writeFileSync(
    ghPath,
    `#!/bin/sh
count=0
if test -f "$GH_COUNTER"; then
  count="$(cat "$GH_COUNTER")"
fi
if test "$count" -eq 0; then
  printf '%s\\n' "$DEPLOY_SHA"
else
  printf '%s\\n' "$MOVED_MAIN_SHA"
fi
printf '%s\\n' "$((count + 1))" > "$GH_COUNTER"
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(receiptPath, "{}\n");

  function runScript(script: string) {
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONSUMED_RECEIPT_PATH: consumedReceiptPath,
        DEPLOY_SHA: mergedCrawlRemoteMain,
        GH_COUNTER: counterPath,
        GH_TOKEN: "test",
        MOVED_MAIN_SHA: "a".repeat(40),
        PATH: `${directory}:${process.env.PATH}`,
        RECEIPT_PATH: receiptPath,
        TARGET_REPOSITORY: "openclaw/crawl-remote",
      },
    });
  }

  const reauthorizeBeforeD1 = step(deploy, "Reauthorize current main before D1 mutation").run ?? "";
  const reauthorizeBeforeWorker =
    step(deploy, "Reauthorize current main immediately before Worker deploy").run ?? "";
  const reauthorizeAfterWorker =
    step(deploy, "Reauthorize current main after Worker deploy").run ?? "";

  try {
    assert.equal(runScript(reauthorizeBeforeD1).status, 0);
    writeFileSync(consumedReceiptPath, "{}\n");
    const moved = runScript(reauthorizeBeforeWorker);
    assert.notEqual(moved.status, 0);
    assert.match(moved.stdout + moved.stderr, /no longer the current main tip/);
    rmSync(counterPath, { force: true });
    assert.equal(runScript(reauthorizeBeforeWorker).status, 0);
    const movedAfterDeploy = runScript(reauthorizeAfterWorker);
    assert.notEqual(movedAfterDeploy.status, 0);
    assert.match(movedAfterDeploy.stdout + movedAfterDeploy.stderr, /advanced during deployment/);
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
  assert.match(packaging, /snapshot_provenance_state: snapshotProvenanceState/);
  assert.match(packaging, /run_attempt: runAttempt/);
  assert.match(packaging, /entry\.isFile\(\)/);
  assert.match(packaging, /isSymbolicLink\(\)/);
  assert.match(packaging, /source Wrangler config has an unexpected deployment identity/);
  assert.match(packaging, /sourceConfig\.vars\?\.CRAWL_REMOTE_RELEASE_SHA/);
  assert.match(packaging, /source Wrangler config targets unexpected production resources/);
  assert.match(packaging, /allowedBundleEntries/);
  assert.match(packaging, /README\.md.*index\.js.*index\.js\.map/s);
  assert.match(
    packaging,
    /Wrangler dry-run output must contain index\.js and only known metadata files/,
  );
  assert.match(packaging, /approvedMigrations/);
  assert.match(packaging, /migrationEntries\.length !== approvedMigrations\.length/);
  assert.match(packaging, /migration \$\{entry\.name\} differs from its reviewed content/);
  assert.match(packaging, /release artifact migrations do not match the reviewed migration set/);
  for (const sha256 of [
    "bfb2ee56d01c7547a644f48b5c493cb9d971646ce331acc10c6bfd78d9b7d066",
    "f984199bef0406ce91724e9ac83a97f41928b1560a51974deb841596f1e403e2",
    "5daa6e14364f7bd4eba3cc5f61ec266b0559962e7345a65080cc9ef26b084e46",
    "e6c4a8edb300ebbf93a2e2449d180408f23be7eac1ef05733045b6ed496eb396",
    "5964adcb0807448d937fed38ac9588a1063bf4f490a82b54f15f0e700374ae0c",
    "a0ebfbb5c40c85df5eaba6772a01a68910fa5f1327d4701d25c5dfde16f77d1a",
    "8b1ef863087eccf41a7c9e5cf1e72f905613adea55df1840f9c96c3cfb2b7ad5",
  ]) {
    assert.match(packaging, new RegExp(sha256));
  }

  const upload = step(preflight, "Upload immutable release artifact");
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(upload.with?.name, "${{ steps.authorize.outputs.artifact_name }}");
  assert.equal(upload.with?.overwrite, false);
  assert.equal(upload.with?.["if-no-files-found"], "error");
  assert.equal(upload.with?.["include-hidden-files"], false);
  assert.equal(upload.with?.["retention-days"], 31);

  const download = step(deploy, "Download immutable release artifact");
  assert.equal(download.uses, "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
  assert.equal(download.with?.name, "${{ needs.preflight.outputs.artifact_name }}");

  const verify = step(deploy, "Verify bounded release artifact").run ?? "";
  assert.match(verify, /assertExactKeys\([\s\S]*'release manifest'/);
  assert.match(verify, /\$\{label\} has unexpected fields/);
  assert.match(verify, /release manifest is not canonical/);
  assert.match(verify, /manifest\.observation_order_state !== observationOrderState/);
  assert.match(verify, /manifest\.snapshot_provenance_state !== snapshotProvenanceState/);
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

test("release packaging accepts Wrangler metadata and rejects unsupported output or migrations", () => {
  const run = step(preflight, "Package bounded release artifact").run ?? "";
  const packager = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(packager, "missing inline release artifact packager");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-packaging-proof-"));
  const bundleDir = join(directory, "bundle");
  const artifactRoot = join(directory, "artifact");
  const runId = "123456";
  const runAttempt = 1;
  const state = "dormant";
  const snapshotState = "dormant";
  const targetSha = mergedCrawlRemoteMain;
  const artifactName = `crawl-remote-release-${runId}-${runAttempt}-${targetSha}-${state}-${snapshotState}`;
  const receiptName = `crawl-remote-release-receipt-${runId}-${runAttempt}-${targetSha}-${state}-${snapshotState}.json`;

  const fixtureMigrations = [
    ["0001_remote_archives.sql", "create table one(id integer);\n"],
    ["0002_gitcrawl_enrichment_snapshots.sql", "create table two(id integer);\n"],
    ["0003_gitcrawl_snapshot_hardening.sql", "alter table two add column name text;\n"],
    ["0004_gitcrawl_snapshot_cutover.sql", "create table four(id integer);\n"],
    ["0005_discrawl_cursor_state.sql", "create table five(id integer);\n"],
    ["0006_gitcrawl_observation_order.sql", "insert into five(id) values (1);\n"],
    ["0007_gitcrawl_snapshot_provenance.sql", "alter table five add column source text;\n"],
  ] as const;
  const fixtureApprovals = fixtureMigrations.map(([name, contents]) => ({
    name,
    sha256: createHash("sha256").update(contents).digest("hex"),
  }));
  const executablePackager = packager.replace(
    /const approvedMigrations = \[[\s\S]*?\n\];\nconst migrationEntries/,
    `const approvedMigrations = ${JSON.stringify(fixtureApprovals)};\nconst migrationEntries`,
  );
  assert.notEqual(executablePackager, packager, "failed to replace migration approvals");

  mkdirSync(join(directory, "migrations"), { recursive: true });
  for (const [name, contents] of fixtureMigrations) {
    writeFileSync(join(directory, "migrations", name), contents);
  }
  writeFileSync(
    join(directory, "wrangler.jsonc"),
    JSON.stringify({
      $schema: "node_modules/wrangler/config-schema.json",
      name: "crawl-remote",
      main: "src/index.ts",
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
    }),
  );

  function packageBundle(mutate?: () => void) {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "index.js"), "export default {};\n");
    writeFileSync(join(bundleDir, "index.js.map"), "{}\n");
    writeFileSync(join(bundleDir, "README.md"), "Generated by Wrangler 4.107.1.\n");
    mutate?.();
    return spawnSync(process.execPath, ["--input-type=module"], {
      cwd: directory,
      input: executablePackager,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_NAME: artifactName,
        ARTIFACT_ROOT: artifactRoot,
        BUNDLE_DIR: bundleDir,
        DEPLOY_SHA: targetSha,
        GITHUB_RUN_ATTEMPT: String(runAttempt),
        GITHUB_RUN_ID: runId,
        OBSERVATION_ORDER_STATE: state,
        RECEIPT_NAME: receiptName,
        SNAPSHOT_PROVENANCE_STATE: snapshotState,
      },
    });
  }

  try {
    assert.equal(packageBundle().status, 0);

    rmSync(join(directory, "migrations", "0007_gitcrawl_snapshot_provenance.sql"));
    const missingMigration = packageBundle();
    assert.notEqual(missingMigration.status, 0);
    assert.match(
      missingMigration.stdout + missingMigration.stderr,
      /release artifact migrations do not match the reviewed migration set/,
    );
    writeFileSync(
      join(directory, "migrations", "0007_gitcrawl_snapshot_provenance.sql"),
      fixtureMigrations[6][1],
    );

    const extraModule = packageBundle(() => {
      writeFileSync(join(bundleDir, "module.wasm"), "unsupported module\n");
    });
    assert.notEqual(extraModule.status, 0);
    assert.match(
      extraModule.stdout + extraModule.stderr,
      /Wrangler dry-run output must contain index\.js and only known metadata files/,
    );

    const extraAsset = packageBundle(() => {
      mkdirSync(join(bundleDir, "assets"));
      writeFileSync(join(bundleDir, "assets", "logo.svg"), "<svg />\n");
    });
    assert.notEqual(extraAsset.status, 0);
    assert.match(
      extraAsset.stdout + extraAsset.stderr,
      /Wrangler dry-run output must contain index\.js and only known metadata files/,
    );

    writeFileSync(
      join(directory, "migrations", "0003_gitcrawl_snapshot_hardening.sql"),
      "DELETE/**/FROM production;\n",
    );
    const alteredMigration = packageBundle();
    assert.notEqual(alteredMigration.status, 0);
    assert.match(
      alteredMigration.stdout + alteredMigration.stderr,
      /differs from its reviewed content/,
    );

    writeFileSync(join(directory, "migrations", "0007_unreviewed.sql"), "select 7;\n");
    const unreviewedMigration = packageBundle();
    assert.notEqual(unreviewedMigration.status, 0);
    assert.match(
      unreviewedMigration.stdout + unreviewedMigration.stderr,
      /release artifact migrations do not match the reviewed migration set/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    const snapshotState = "dormant";
    const artifactName = `crawl-remote-release-${runId}-${runAttempt}-${targetSha}-${state}-${snapshotState}`;
    const receiptName = `crawl-remote-release-receipt-${runId}-${runAttempt}-${targetSha}-${state}-${snapshotState}.json`;
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
      snapshot_provenance_state: snapshotState,
      files,
    };
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      artifactName,
      receiptName,
      receiptPath: join(directory, `${label}.receipt.json`),
      root,
      snapshotState,
      state,
    };
  }

  function validate(
    artifact: ReturnType<typeof fixture>,
    state = artifact.state,
    snapshotState = artifact.snapshotState,
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
        SNAPSHOT_PROVENANCE_STATE: snapshotState,
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
    assert.notEqual(validate(fixture("cross-snapshot-state"), "dormant", "active").status, 0);

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
  assert.doesNotMatch(deployRuns, /(?:^|\n)\s*source\s|\beval\b|bash -c|sh -c/);
  assert.equal(deployRuns.match(/\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/g)?.length, 3);
  assert.equal(deployRuns.match(/\.\/node_modules\/\.bin\/wrangler/g)?.length, 1);
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

test("deploy executes the committed exact Node and Wrangler toolchain install before credentials", () => {
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
  assert.match(install.run ?? "", /cd "\$TOOLCHAIN_ROOT"/);
  assert.match(install.run ?? "", /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(install.run ?? "", /--prefix/);
  assert.doesNotMatch(install.run ?? "", /npm install|wrangler@/);
  assert.match(install.run ?? "", /actual_version=.*--version/);
  assert.equal(install.env?.CLOUDFLARE_API_TOKEN, undefined);

  const workspace = mkdtempSync(join(tmpdir(), "crawl-remote-toolchain-install-"));
  const toolchainRoot = join(workspace, ".github", "deploy", "crawl-remote-toolchain");
  mkdirSync(toolchainRoot, { recursive: true });
  writeFileSync(
    join(toolchainRoot, "package.json"),
    readFileSync(".github/deploy/crawl-remote-toolchain/package.json"),
  );
  writeFileSync(
    join(toolchainRoot, "package-lock.json"),
    readFileSync(".github/deploy/crawl-remote-toolchain/package-lock.json"),
  );
  try {
    const installed = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", install.run ?? ""],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          TOOLCHAIN_ROOT: toolchainRoot,
          WRANGLER_VERSION: "4.107.1",
        },
        timeout: 120_000,
      },
    );
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(
      JSON.parse(
        readFileSync(join(toolchainRoot, "node_modules", "wrangler", "package.json"), "utf8"),
      ).version,
      "4.107.1",
    );
    const fixtureRoot = join(workspace, "wrangler-fixture");
    const bundleRoot = join(fixtureRoot, "bundle");
    mkdirSync(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "index.ts"),
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    writeFileSync(
      join(fixtureRoot, "wrangler.json"),
      JSON.stringify({
        name: "crawl-remote-packaging-fixture",
        main: "index.ts",
        compatibility_date: "2026-07-12",
      }),
    );
    const dryRun = spawnSync(
      join(toolchainRoot, "node_modules", ".bin", "wrangler"),
      ["deploy", "--dry-run", "--outdir", bundleRoot],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
    const bundleEntries = readdirSync(bundleRoot).sort();
    assert.ok(bundleEntries.includes("index.js"));
    assert.deepEqual(
      bundleEntries.filter((entry) => !["README.md", "index.js", "index.js.map"].includes(entry)),
      [],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  const credentialSteps = steps(deploy).filter(
    (candidate) => candidate.env?.CLOUDFLARE_API_TOKEN !== undefined,
  );
  assert.deepEqual(
    credentialSteps.map((candidate) => candidate.name),
    [
      "Apply and verify D1 migrations",
      "Deploy verified Worker bundle",
      "Roll back failed Worker release",
    ],
  );
  for (const credentialStep of credentialSteps) {
    assert.ok(steps(deploy).indexOf(install) < steps(deploy).indexOf(credentialStep));
    assert.equal(
      credentialStep.env?.CLOUDFLARE_API_TOKEN,
      "${{ secrets.CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN }}",
    );
    assert.equal(
      credentialStep.env?.CLOUDFLARE_TOKEN_SHA256,
      "${{ vars.CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256 }}",
    );
    assert.match(credentialStep.run ?? "", /CLOUDFLARE_TOKEN_SHA256.*sha256sum/s);
  }
  assert.doesNotMatch(source, /OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN/);
  assert.doesNotMatch(source, /secrets\.CRAWL_REMOTE_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /\|\|\s*secrets\./);
  assert.doesNotMatch(source, /CRAWL_REMOTE_CUSTOM_ROUTE_PROOF\s*\|\|/);
  assert.equal(source.match(/CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN/g)?.length, 3);
});

test("deploy reauthorizes exact current main before and after privileged mutations", () => {
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

  const reauthorizeBeforeD1 = step(deploy, "Reauthorize current main before D1 mutation");
  const migration = step(deploy, "Apply and verify D1 migrations");
  const reauthorizeBeforeWorker = step(
    deploy,
    "Reauthorize current main immediately before Worker deploy",
  );
  const workerDeploy = step(deploy, "Deploy verified Worker bundle");
  const reauthorizeAfterWorker = step(deploy, "Reauthorize current main after Worker deploy");
  for (const reauthorize of [
    reauthorizeBeforeD1,
    reauthorizeBeforeWorker,
    reauthorizeAfterWorker,
  ]) {
    assert.match(reauthorize.run ?? "", /\[\[ "\$DEPLOY_SHA" != "\$current_main_sha" \]\]/);
    assert.doesNotMatch(reauthorize.run ?? "", /compare\/|comparison_status|ancestor|"ahead"/);
    assert.equal(reauthorize.env?.CLOUDFLARE_API_TOKEN, undefined);
  }

  assert.equal(steps(deploy).indexOf(reauthorizeBeforeD1) + 1, steps(deploy).indexOf(migration));
  assert.equal(
    steps(deploy).indexOf(migration) + 1,
    steps(deploy).indexOf(reauthorizeBeforeWorker),
  );
  assert.equal(
    steps(deploy).indexOf(reauthorizeBeforeWorker) + 1,
    steps(deploy).indexOf(workerDeploy),
  );
  assert.equal(
    steps(deploy).indexOf(workerDeploy) + 1,
    steps(deploy).indexOf(reauthorizeAfterWorker),
  );
  assert.match(migration.run ?? "", /test ! -e "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(migration.run ?? "", /mv -- "\$RECEIPT_PATH" "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(reauthorizeBeforeWorker.run ?? "", /test -f "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(workerDeploy.run ?? "", /test -f "\$CONSUMED_RECEIPT_PATH"/);
  assert.equal(workerDeploy["continue-on-error"], true);
  assert.equal(reauthorizeAfterWorker["continue-on-error"], true);
  assert.equal(reauthorizeAfterWorker.if, "${{ steps.worker-deploy.outcome == 'success' }}");
});

test("privileged mutations use only verified files and prove the selected D1 fence state", () => {
  const migration = step(deploy, "Apply and verify D1 migrations").run ?? "";
  const workerDeploy = step(deploy, "Deploy verified Worker bundle").run ?? "";
  assert.match(migration, /\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/);
  assert.match(migration, /deployments status/);
  assert.match(migration, /versions\.length !== 1/);
  assert.match(migration, /versions\[0\]\?\.percentage !== 100/);
  assert.match(migration, /PREVIOUS_VERSION_PATH/);
  assert.match(migration, /d1 migrations apply crawl-remote/);
  assert.match(migration, /--cwd "\$RELEASE_ROOT"/);
  assert.match(migration, /--config wrangler\.json/);
  assert.match(migration, /d1 execute crawl-remote/);
  assert.match(
    migration,
    /select capability, migration_ready, cutover_enabled, activated_at from remote_capability_fences/,
  );
  assert.match(migration, /'gitcrawl\.observation-order\.v1'/);
  assert.match(migration, /'gitcrawl\.snapshot\.provenance\.v1'/);
  assert.match(migration, /executions\.length !== 1/);
  assert.match(migration, /rows\.length !== expectedStates\.size/);
  assert.match(migration, /fence\?\.migration_ready !== 1|fence\.migration_ready !== 1/);
  assert.match(migration, /expectedState === 'active' \? 1 : 0/);
  assert.match(
    migration,
    /fence\?\.cutover_enabled !== expectedCutover|fence\.cutover_enabled !== expectedCutover/,
  );
  assert.match(migration, /fence\.activated_at\.trim\(\)\.length === 0/);
  assert.match(migration, /expectedState === 'dormant'.*fence(?:\?)?\.activated_at !== ''/s);
  assert.match(migration, /PRE_FENCE_STATUS="\$pre_fence_status"/);
  assert.match(migration, /apiError\.name !== 'APIError'/);
  assert.match(migration, /apiError\.code !== 7500/);
  assert.match(migration, /apiError\.accountTag !== expectedAccountId/);
  assert.match(migration, /missingTableNotes/);
  assert.match(migration, /errorOutput\.length !== 0/);
  assert.match(migration, /state !== 'dormant'/);
  assert.match(migration, /pre-migration query failed/);
  assert.match(workerDeploy, /deploy bundle\/index\.js/);
  assert.match(workerDeploy, /--no-bundle/);
  assert.match(workerDeploy, /--strict/);
  assert.match(workerDeploy, /--var "CRAWL_REMOTE_RELEASE_SHA:\$DEPLOY_SHA"/);
  assert.match(workerDeploy, /--message "main \$\{DEPLOY_SHA\}"/);

  const preQueryIndex = migration.indexOf('> "$PRE_FENCE_RESPONSE"');
  const migrationIndex = migration.indexOf('"$wrangler" d1 migrations apply');
  const postQueryIndex = migration.indexOf('> "$FENCE_RESPONSE"');
  assert.ok(preQueryIndex >= 0);
  assert.ok(preQueryIndex < migrationIndex);
  assert.ok(migrationIndex < postQueryIndex);
});

test("failed Worker release rolls back the exact previously stable version", () => {
  const workerDeploy = step(deploy, "Deploy verified Worker bundle");
  const postDeployMain = step(deploy, "Reauthorize current main after Worker deploy");
  const proof = step(deploy, "Poll exact production release");
  const rollback = step(deploy, "Roll back failed Worker release");
  const finalGate = step(deploy, "Require successful release and proof");
  const run = rollback.run ?? "";

  assert.equal(workerDeploy.id, "worker-deploy");
  assert.equal(postDeployMain.id, "post-deploy-main");
  assert.equal(proof.id, "production-proof");
  assert.equal(proof["continue-on-error"], true);
  assert.match(rollback.if ?? "", /always\(\)/);
  assert.match(rollback.if ?? "", /steps\.worker-deploy\.outcome != 'success'/);
  assert.match(rollback.if ?? "", /steps\.post-deploy-main\.outcome != 'success'/);
  assert.match(rollback.if ?? "", /steps\.production-proof\.outcome != 'success'/);
  assert.match(run, /wrangler" rollback "\$previous_version"/);
  assert.match(run, /--yes/);
  assert.match(run, /deployments status/);
  assert.match(run, /versions\[0\]\?\.version_id !== process\.env\.PREVIOUS_VERSION/);
  assert.match(run, /versions\[0\]\?\.percentage !== 100/);
  assert.equal(finalGate.if, "${{ always() }}");
  assert.match(finalGate.run ?? "", /WORKER_DEPLOY_OUTCOME.*POST_DEPLOY_MAIN_OUTCOME/s);
  assert.match(finalGate.run ?? "", /PRODUCTION_PROOF_OUTCOME.*success/s);
  assert.match(finalGate.run ?? "", /rollback outcome/);
});

test("pre-migration fence validator rejects mismatch and gates missing-table bootstrap", () => {
  const run = step(deploy, "Apply and verify D1 migrations").run ?? "";
  const validator = run.match(
    /node --input-type=module <<'PRE_FENCE_NODE'\n([\s\S]*?)\nPRE_FENCE_NODE/,
  )?.[1];
  assert.ok(validator, "missing inline pre-migration D1 fence validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-pre-fence-proof-"));
  const responsePath = join(directory, "fence.json");
  const errorPath = join(directory, "fence.err");
  const releaseRoot = join(directory, "release");
  mkdirSync(releaseRoot);
  writeFileSync(
    join(releaseRoot, "wrangler.json"),
    JSON.stringify({
      d1_databases: [
        {
          database_name: "crawl-remote",
          database_id: d1DatabaseId,
        },
      ],
    }),
  );

  function validate(
    observationState: "dormant" | "active",
    snapshotState: "dormant" | "active",
    options: {
      status?: number;
      response?: unknown;
      error?: string;
    },
  ) {
    const response = options.response ?? exactFences(observationState, snapshotState);
    writeFileSync(responsePath, typeof response === "string" ? response : JSON.stringify(response));
    writeFileSync(errorPath, options.error ?? "");
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
        OBSERVATION_ORDER_STATE: observationState,
        PRE_FENCE_ERROR: errorPath,
        PRE_FENCE_RESPONSE: responsePath,
        PRE_FENCE_STATUS: String(options.status ?? 0),
        RELEASE_ROOT: releaseRoot,
        SNAPSHOT_PROVENANCE_STATE: snapshotState,
      },
    });
  }

  try {
    assert.equal(validate("dormant", "dormant", {}).status, 0);
    assert.equal(validate("active", "active", {}).status, 0);
    assert.equal(
      validate("active", "dormant", {
        response: exactFences("active", "dormant", false),
      }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", "dormant", { response: exactFences("active", "dormant") }).status,
      0,
    );
    assert.notEqual(
      validate("active", "active", { response: exactFences("dormant", "active") }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", "active", {
        response: exactFences("dormant", "dormant", false),
      }).status,
      0,
    );
    assert.equal(
      validate("dormant", "dormant", {
        status: 1,
        response: apiErrorFailure(),
      }).status,
      0,
    );
    assert.notEqual(
      validate("active", "dormant", {
        status: 1,
        response: apiErrorFailure(),
      }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", "dormant", {
        status: 1,
        response: apiErrorFailure({
          code: 10000,
          note: "Authentication error [code: 10000]",
        }),
      }).status,
      0,
    );
    assert.notEqual(
      validate("dormant", "dormant", {
        status: 1,
        response: apiErrorFailure(),
        error: "unexpected stderr",
      }).status,
      0,
    );
    const extraField = apiErrorFailure();
    Object.assign(extraField.error, { meta: { diagnostic: "unexpected" } });
    assert.notEqual(
      validate("dormant", "dormant", {
        status: 1,
        response: extraField,
      }).status,
      0,
    );
    assert.notEqual(validate("dormant", "dormant", { response: [] }).status, 0);
    assert.notEqual(validate("dormant", "dormant", { response: "not json" }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-migration D1 fence validator accepts only the selected state", () => {
  const run = step(deploy, "Apply and verify D1 migrations").run ?? "";
  const validator = run.match(
    /node --input-type=module <<'POST_FENCE_NODE'\n([\s\S]*?)\nPOST_FENCE_NODE/,
  )?.[1];
  assert.ok(validator, "missing inline post-migration D1 fence validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-post-fence-proof-"));
  const responsePath = join(directory, "fence.json");

  function validate(
    observationState: "dormant" | "active",
    snapshotState: "dormant" | "active",
    response: unknown = exactFences(observationState, snapshotState),
  ) {
    writeFileSync(responsePath, JSON.stringify(response));
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        FENCE_RESPONSE: responsePath,
        OBSERVATION_ORDER_STATE: observationState,
        SNAPSHOT_PROVENANCE_STATE: snapshotState,
      },
    });
  }

  try {
    assert.equal(validate("dormant", "dormant").status, 0);
    assert.equal(validate("active", "active").status, 0);
    assert.equal(validate("active", "dormant").status, 0);
    assert.notEqual(validate("dormant", "active", exactFences("active", "active")).status, 0);
    assert.notEqual(validate("active", "active", exactFences("active", "dormant")).status, 0);
    assert.notEqual(
      validate("dormant", "dormant", exactFences("dormant", "dormant", false)).status,
      0,
    );
    const malformed = exactFences("dormant", "dormant");
    malformed[0].results[0].migration_ready = "1" as unknown as number;
    assert.notEqual(validate("dormant", "dormant", malformed).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production proof polls semantic state and binds both responses to the release", () => {
  const verify = step(deploy, "Poll exact production release");
  const run = verify.run ?? "";
  assert.equal(verify.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(verify.env?.CUSTOM_ROUTE_PROOF, "${{ vars.CRAWL_REMOTE_CUSTOM_ROUTE_PROOF }}");
  assert.match(run, /while \(\( SECONDS < deadline \)\)/);
  assert.match(run, /fetch_endpoint\(\)/);
  assert.match(run, /timeout="\$remaining"/);
  assert.match(run, /--max-filesize 1048576/);
  assert.match(run, /sleep "\$sleep_for"/);
  assert.match(run, /\$WORKERS_DEV_URL\/health/);
  assert.match(run, /\$WORKERS_DEV_URL\/v1\/contract/);
  assert.match(run, /\$PRODUCTION_ROUTE_URL\/health/);
  assert.match(run, /\$PRODUCTION_ROUTE_URL\/v1\/contract/);
  assert.match(run, /CF-Access-Client-Id/);
  assert.match(run, /CF-Access-Client-Secret/);
  assert.match(run, /CUSTOM_ROUTE_PROOF.*access-service-token/s);
  assert.match(run, /label: 'workers\.dev'/);
  assert.match(run, /label: 'production route'/);
  assert.match(run, /for \(const endpoint of endpoints\) validateEndpoint\(endpoint\)/);
  assert.match(run, /health\.release_sha !== expectedSha/);
  assert.match(run, /contract\.release_sha !== expectedSha/);
  assert.match(
    run,
    /Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated\./,
  );
  assert.match(run, /notes\.includes\(observationFenceNote\)/);
  assert.match(
    run,
    /Gitcrawl content-addressed snapshots bind manifest\.source_sha256, status, queries, and SQLite bundle manifests to one source image\./,
  );
  assert.match(run, /notes\.includes\(snapshotProvenanceNote\)/);
  assert.match(run, /expectedObservationOrderState/);
  assert.match(run, /expectedSnapshotProvenanceState/);
  assert.match(run, /\$\{label\} Gitcrawl capabilities are malformed/);
  assert.match(run, /gitcrawl\.capabilities\.includes\(\s*'gitcrawl\.observation-order\.v1'/);
  assert.match(run, /expectedObservationOrderState === 'active'.*!observationOrderActive/s);
  assert.match(run, /expectedObservationOrderState === 'dormant'.*observationOrderActive/s);
  assert.match(run, /gitcrawl\.capabilities\.includes\(\s*'gitcrawl\.snapshot\.provenance\.v1'/);
  assert.match(run, /expectedSnapshotProvenanceState === 'active'.*!snapshotProvenanceActive/s);
  assert.match(run, /expectedSnapshotProvenanceState === 'dormant'.*snapshotProvenanceActive/s);
  assert.match(run, /process\.exit\(1\)/);
  assert.match(run, /required production endpoints did not converge to release \$DEPLOY_SHA/);
  assert.doesNotMatch(run, /curl .*--retry/s);
});

test("production semantic validator always requires workers.dev and gates the Access route", () => {
  const run = step(deploy, "Poll exact production release").run ?? "";
  const validator = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(validator, "missing inline production semantic validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-production-proof-"));
  const workersDevHealthPath = join(directory, "workers-dev-health.json");
  const workersDevContractPath = join(directory, "workers-dev-contract.json");
  const productionRouteHealthPath = join(directory, "production-route-health.json");
  const productionRouteContractPath = join(directory, "production-route-contract.json");
  const releaseSha = mergedCrawlRemoteMain;
  const observationCapability = "gitcrawl.observation-order.v1";
  const snapshotProvenanceCapability = "gitcrawl.snapshot.provenance.v1";
  const observationFenceNote =
    "Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated.";
  const snapshotProvenanceNote =
    "Gitcrawl content-addressed snapshots bind manifest.source_sha256, status, queries, and SQLite bundle manifests to one source image.";

  interface EndpointResponse {
    healthSha?: string;
    contractSha?: string;
    capabilities?: unknown;
  }

  function validate(
    observationState: "dormant" | "active",
    snapshotState: "dormant" | "active",
    workersDev: EndpointResponse = {},
    productionRoute: EndpointResponse = {},
    customRouteProof: "disabled" | "access-service-token" = "disabled",
  ) {
    const defaultCapabilities = [
      ...(observationState === "active" ? [observationCapability] : []),
      ...(snapshotState === "active" ? [snapshotProvenanceCapability] : []),
    ];
    function writeEndpoint(healthPath: string, contractPath: string, response: EndpointResponse) {
      const capabilities = Object.hasOwn(response, "capabilities")
        ? response.capabilities
        : defaultCapabilities;
      writeFileSync(
        healthPath,
        JSON.stringify({ ok: true, release_sha: response.healthSha ?? releaseSha }),
      );
      writeFileSync(
        contractPath,
        JSON.stringify({
          service: "crawl-remote",
          protocol_version: "v1",
          release_sha: response.contractSha ?? releaseSha,
          notes: [observationFenceNote, snapshotProvenanceNote],
          routes: [
            { method: "GET", path: "/health" },
            { method: "GET", path: "/v1/contract" },
          ],
          apps: [{ app: "gitcrawl", capabilities }],
        }),
      );
    }
    writeEndpoint(workersDevHealthPath, workersDevContractPath, workersDev);
    writeEndpoint(productionRouteHealthPath, productionRouteContractPath, productionRoute);
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        CUSTOM_ROUTE_PROOF: customRouteProof,
        DEPLOY_SHA: releaseSha,
        OBSERVATION_ORDER_STATE: observationState,
        PRODUCTION_ROUTE_CONTRACT_RESPONSE: productionRouteContractPath,
        PRODUCTION_ROUTE_HEALTH_RESPONSE: productionRouteHealthPath,
        WORKERS_DEV_CONTRACT_RESPONSE: workersDevContractPath,
        WORKERS_DEV_HEALTH_RESPONSE: workersDevHealthPath,
        SNAPSHOT_PROVENANCE_STATE: snapshotState,
      },
    });
  }

  try {
    assert.equal(validate("dormant", "dormant").status, 0);
    assert.equal(validate("active", "active").status, 0);
    assert.equal(validate("active", "dormant").status, 0);
    assert.notEqual(validate("dormant", "dormant", { healthSha: "b".repeat(40) }).status, 0);
    assert.equal(validate("dormant", "dormant", {}, { contractSha: "b".repeat(40) }).status, 0);
    assert.notEqual(
      validate("dormant", "dormant", {}, { contractSha: "b".repeat(40) }, "access-service-token")
        .status,
      0,
    );
    assert.equal(validate("dormant", "dormant", {}, {}, "access-service-token").status, 0);
    assert.notEqual(validate("active", "dormant", { capabilities: [] }).status, 0);
    assert.notEqual(validate("dormant", "active", { capabilities: [] }).status, 0);
    assert.notEqual(
      validate(
        "dormant",
        "dormant",
        {},
        { capabilities: [observationCapability] },
        "access-service-token",
      ).status,
      0,
    );
    assert.notEqual(
      validate("dormant", "dormant", {}, { capabilities: null }, "access-service-token").status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
