import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/deploy-crawl-remote.yml";
const ciWorkflowPath = ".github/workflows/ci.yml";
const cloudflareAccountId = "1".repeat(32);
const d1DatabaseId = "22222222-2222-4222-8222-222222222222";
const mergedCrawlRemoteMain = "d6bb9b7a9c7eff0704dab4845a00e1863b7b8ef1";
const source = readFileSync(workflowPath, "utf8");
const workflow = parse(source);
const ciSource = readFileSync(ciWorkflowPath, "utf8");
const ciWorkflow = parse(ciSource);
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
  "working-directory"?: string;
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
  assert.equal(deploy.env.SOURCE_REPOSITORY, "${{ github.repository }}");
  assert.equal(deploy.env.WORKFLOW_SHA, "${{ github.sha }}");
  assert.equal(deploy.env.WORKERS_DEV_URL, "https://crawl-remote.services-91b.workers.dev");
  assert.equal(deploy.env.PRODUCTION_ROUTE_URL, "https://reports.openclaw.ai/crawl-remote");
  assert.equal(deploy.env.DEPLOYMENT_STATUS_ATTEMPTS, "60");
  assert.equal(deploy.env.DEPLOYMENT_STATUS_DELAY_SECONDS, "5");
  assert.equal(deploy.env.DEPLOYMENT_STATUS_TIMEOUT_SECONDS, "300");
  assert.equal(deploy.env.WRANGLER_DEPLOY_TIMEOUT_SECONDS, "480");
  assert.equal(deploy.env.WRANGLER_READ_TIMEOUT_SECONDS, "45");
  assert.equal(deploy.env.WRANGLER_ROLLBACK_TIMEOUT_SECONDS, "300");
  assert.equal(deploy.env.PRODUCTION_ENVIRONMENT, "crawl-remote-production");
  const environmentToken = step(deploy, "Create protected-environment audit token");
  const environmentAudit = step(deploy, "Audit protected production environment");
  const sourceAuthorization = step(deploy, "Reauthorize current ClawSweeper workflow");
  const authority = step(deploy, "Verify central deployment authority");
  const proofCredentials = step(deploy, "Validate protected production proof credentials");
  const token = step(deploy, "Create exact-repository reauthorization token");
  const canonicalAuthority = step(deploy, "Verify canonical crawl-remote mutator is retired");
  const checkout = step(deploy, "Checkout trusted deployment toolchain");
  assert.equal(steps(deploy).indexOf(environmentToken), 0);
  assert.equal(steps(deploy).indexOf(environmentAudit), 1);
  assert.equal(steps(deploy).indexOf(sourceAuthorization), 2);
  assert.equal(steps(deploy).indexOf(authority), 3);
  assert.equal(steps(deploy).indexOf(proofCredentials), 4);
  assert.equal(steps(deploy).indexOf(token), 5);
  assert.equal(steps(deploy).indexOf(canonicalAuthority), 6);
  assert.equal(steps(deploy).indexOf(checkout), 7);
  assert.equal(
    environmentToken.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(environmentToken.with?.owner, "openclaw");
  assert.equal(environmentToken.with?.repositories, "clawsweeper");
  // GitHub maps branch-policy reads to Actions and the remaining audit reads to Environments.
  assert.equal(environmentToken.with?.["permission-actions"], "read");
  assert.equal(environmentToken.with?.["permission-environments"], "read");
  assert.equal(
    Object.keys(environmentToken.with ?? {}).filter((key) => key.startsWith("permission-")).length,
    2,
  );
  assert.equal(environmentAudit.env?.GH_TOKEN, "${{ steps.source-admin-token.outputs.token }}");
  assert.match(
    environmentAudit.run ?? "",
    /environments\/\$PRODUCTION_ENVIRONMENT\/variables\?per_page=100/,
  );
  assert.match(
    environmentAudit.run ?? "",
    /environments\/\$PRODUCTION_ENVIRONMENT\/secrets\?per_page=100/,
  );
  assert.match(environmentAudit.run ?? "", /deployment-branch-policies\?per_page=100/);
  assert.equal(environmentAudit.run?.match(/--paginate --slurp/g)?.length, 3);
  assert.equal(sourceAuthorization.env?.GH_TOKEN, "${{ github.token }}");
  assert.match(sourceAuthorization.run ?? "", /repos\/\$SOURCE_REPOSITORY\/commits\/main/);
  assert.match(sourceAuthorization.run ?? "", /\[\[ "\$WORKFLOW_SHA" != "\$current_main_sha" \]\]/);
  assert.equal(authority.env?.DEPLOY_AUTHORITY, "${{ vars.CRAWL_REMOTE_DEPLOY_AUTHORITY }}");
  assert.equal(authority.env?.CUSTOM_ROUTE_PROOF, "${{ vars.CRAWL_REMOTE_CUSTOM_ROUTE_PROOF }}");
  assert.match(authority.run ?? "", /DEPLOY_AUTHORITY.*clawsweeper-v1/s);
  assert.match(authority.run ?? "", /CUSTOM_ROUTE_PROOF.*access-service-token/s);
  assert.doesNotMatch(authority.run ?? "", /disabled/);
  assert.equal(
    proofCredentials.env?.CF_ACCESS_CLIENT_ID,
    "${{ secrets.CRAWL_REMOTE_ACCESS_CLIENT_ID }}",
  );
  assert.equal(
    proofCredentials.env?.CF_ACCESS_CLIENT_SECRET,
    "${{ secrets.CRAWL_REMOTE_ACCESS_CLIENT_SECRET }}",
  );
  assert.equal(
    proofCredentials.env?.CUSTOM_ROUTE_PROOF,
    "${{ vars.CRAWL_REMOTE_CUSTOM_ROUTE_PROOF }}",
  );
  assert.equal(canonicalAuthority.env?.GH_TOKEN, "${{ steps.target-token.outputs.token }}");
  assert.equal(canonicalAuthority.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(preflight["timeout-minutes"], 25);
  assert.equal(deploy["timeout-minutes"], 25);
});

test("protected deploy audits exact environment-owned authority inputs", () => {
  const audit = step(deploy, "Audit protected production environment");
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-environment-audit-"));
  const ghPath = join(directory, "gh");
  const environmentFixture = join(directory, "environment-fixture.json");
  const variablesFixture = join(directory, "variables-fixture.json");
  const secretsFixture = join(directory, "secrets-fixture.json");
  const branchPoliciesFixture = join(directory, "branch-policies-fixture.json");
  const environmentResponse = join(directory, "environment-response.json");
  const variablesResponse = join(directory, "variables-response.json");
  const secretsResponse = join(directory, "secrets-response.json");
  const branchPoliciesResponse = join(directory, "branch-policies-response.json");
  const validEnvironment = {
    name: "crawl-remote-production",
    protection_rules: [
      {
        type: "required_reviewers",
        reviewers: [
          {
            type: "User",
            reviewer: { id: 25068, login: "vincentkoc" },
          },
        ],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const validVariables = [
    { name: "CRAWL_REMOTE_DEPLOY_AUTHORITY" },
    { name: "CRAWL_REMOTE_CLOUDFLARE_TOKEN_SHA256" },
    { name: "CRAWL_REMOTE_CUSTOM_ROUTE_PROOF" },
  ];
  const validSecrets = [
    { name: "CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN" },
    { name: "CRAWL_REMOTE_ACCESS_CLIENT_ID" },
    { name: "CRAWL_REMOTE_ACCESS_CLIENT_SECRET" },
  ];
  const validBranchPolicies = [{ name: "main", type: "branch" }];

  writeFileSync(
    ghPath,
    `#!/bin/sh
endpoint=
for argument in "$@"; do
  endpoint="$argument"
done
case "$endpoint" in
  */variables?per_page=100) cat "$MOCK_VARIABLES_FIXTURE" ;;
  */secrets?per_page=100) cat "$MOCK_SECRETS_FIXTURE" ;;
  */deployment-branch-policies?per_page=100) cat "$MOCK_BRANCH_POLICIES_FIXTURE" ;;
  */environments/crawl-remote-production) cat "$MOCK_ENVIRONMENT_FIXTURE" ;;
  *) exit 97 ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);

  function runAudit({
    environment = validEnvironment,
    variables = validVariables,
    secrets = validSecrets,
    branchPolicies = validBranchPolicies,
  }: {
    environment?: unknown;
    variables?: Array<{ name: string }>;
    secrets?: Array<{ name: string }>;
    branchPolicies?: Array<{ name: string; type: string }>;
  } = {}) {
    writeFileSync(environmentFixture, JSON.stringify(environment));
    writeFileSync(variablesFixture, JSON.stringify([{ total_count: variables.length, variables }]));
    writeFileSync(secretsFixture, JSON.stringify([{ total_count: secrets.length, secrets }]));
    writeFileSync(
      branchPoliciesFixture,
      JSON.stringify([{ total_count: branchPolicies.length, branch_policies: branchPolicies }]),
    );
    for (const path of [
      environmentResponse,
      variablesResponse,
      secretsResponse,
      branchPoliciesResponse,
    ]) {
      rmSync(path, { force: true });
    }
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", audit.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        BRANCH_POLICIES_RESPONSE: branchPoliciesResponse,
        ENVIRONMENT_RESPONSE: environmentResponse,
        ENVIRONMENT_SECRETS_RESPONSE: secretsResponse,
        ENVIRONMENT_VARIABLES_RESPONSE: variablesResponse,
        GH_TOKEN: "environment-audit-token",
        MOCK_BRANCH_POLICIES_FIXTURE: branchPoliciesFixture,
        MOCK_ENVIRONMENT_FIXTURE: environmentFixture,
        MOCK_SECRETS_FIXTURE: secretsFixture,
        MOCK_VARIABLES_FIXTURE: variablesFixture,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        PRODUCTION_ENVIRONMENT: "crawl-remote-production",
        SOURCE_REPOSITORY: "openclaw/clawsweeper",
      },
    });
  }

  try {
    const valid = runAudit();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);

    const missingVariable = runAudit({ variables: validVariables.slice(1) });
    assert.notEqual(missingVariable.status, 0);
    assert.match(missingVariable.stderr, /missing variable CRAWL_REMOTE_DEPLOY_AUTHORITY/);

    const missingSecret = runAudit({ secrets: validSecrets.slice(1) });
    assert.notEqual(missingSecret.status, 0);
    assert.match(
      missingSecret.stderr,
      /missing secret CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN/,
    );

    const missingReviewer = runAudit({
      environment: {
        ...validEnvironment,
        protection_rules: [{ type: "required_reviewers", reviewers: [] }],
      },
    });
    assert.notEqual(missingReviewer.status, 0);
    assert.match(missingReviewer.stderr, /protection is not the reviewed shape/);

    const wrongBranch = runAudit({
      branchPolicies: [{ name: "release", type: "branch" }],
    });
    assert.notEqual(wrongBranch.status, 0);
    assert.match(wrongBranch.stderr, /must allow only the main branch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

  assert.equal(verify("clawsweeper-v1", "access-service-token").status, 0);
  assert.notEqual(verify("clawsweeper-v1", "disabled").status, 0);
  assert.notEqual(verify("", "access-service-token").status, 0);
  assert.notEqual(verify("crawl-remote-v1", "access-service-token").status, 0);
  assert.notEqual(verify("clawsweeper-v1", "").status, 0);
  assert.notEqual(verify("clawsweeper-v1", "public").status, 0);
});

test("protected preflight validates Access proof secrets before deployment setup", () => {
  const proofCredentials = step(deploy, "Validate protected production proof credentials");
  const run = proofCredentials.run ?? "";
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-access-preflight-"));
  const curlPath = join(directory, "curl");
  const healthPath = join(directory, "health.json");
  const contractPath = join(directory, "contract.json");
  writeFileSync(
    curlPath,
    `#!/bin/sh
output=
url=
client_id_header=
client_secret_header=
while test "$#" -gt 0; do
  case "$1" in
    --header)
      case "$2" in
        CF-Access-Client-Id:*) client_id_header="$2" ;;
        CF-Access-Client-Secret:*) client_secret_header="$2" ;;
      esac
      shift 2
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    http*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
test "$client_id_header" = "CF-Access-Client-Id: $EXPECTED_CLIENT_ID" || exit 22
test "$client_secret_header" = "CF-Access-Client-Secret: $EXPECTED_CLIENT_SECRET" || exit 22
case "$url" in
  */health?*)
    printf '{"ok":true,"release_sha":"%s"}\\n' "$RELEASE_SHA" > "$output"
    ;;
  */v1/contract?*)
    printf '{"service":"crawl-remote","protocol_version":"v1","release_sha":"%s","routes":[{"method":"GET","path":"/health"},{"method":"GET","path":"/v1/contract"}]}\\n' "$RELEASE_SHA" > "$output"
    ;;
  *)
    exit 23
    ;;
esac
`,
  );
  chmodSync(curlPath, 0o755);

  function verify(customRouteProof: string, clientId = "", clientSecret = "") {
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        ACCESS_PREFLIGHT_CONTRACT_RESPONSE: contractPath,
        ACCESS_PREFLIGHT_HEALTH_RESPONSE: healthPath,
        CF_ACCESS_CLIENT_ID: clientId,
        CF_ACCESS_CLIENT_SECRET: clientSecret,
        CUSTOM_ROUTE_PROOF: customRouteProof,
        EXPECTED_CLIENT_ID: "client-id",
        EXPECTED_CLIENT_SECRET: "client-secret",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456",
        PATH: `${directory}:${process.env.PATH}`,
        PRODUCTION_ROUTE_URL: "https://reports.openclaw.ai/crawl-remote",
        RELEASE_SHA: mergedCrawlRemoteMain,
      },
    });
  }

  try {
    const validCredentials = verify("access-service-token", "client-id", "client-secret");
    assert.equal(validCredentials.status, 0, validCredentials.stdout + validCredentials.stderr);
    assert.notEqual(verify("disabled", "client-id", "client-secret").status, 0);
    assert.notEqual(verify("access-service-token", "", "client-secret").status, 0);
    assert.notEqual(verify("access-service-token", "client-id", "").status, 0);
    assert.notEqual(verify("access-service-token", "client-id", "wrong-secret").status, 0);
    assert.notEqual(verify("public", "client-id", "client-secret").status, 0);
    assert.match(run, /requires CRAWL_REMOTE_ACCESS_CLIENT_ID/);
    assert.match(run, /requires CRAWL_REMOTE_ACCESS_CLIENT_SECRET/);
    assert.match(run, /\$PRODUCTION_ROUTE_URL\/health\?access_preflight=/);
    assert.match(run, /\$PRODUCTION_ROUTE_URL\/v1\/contract\?access_preflight=/);
    assert.match(run, /CF-Access-Client-Id/);
    assert.match(run, /CF-Access-Client-Secret/);
    assert.match(run, /contract\?\.release_sha !== releaseSha/);

    const checkout = step(deploy, "Checkout trusted deployment toolchain");
    const migration = step(deploy, "Apply and verify D1 migrations");
    const workerDeploy = step(deploy, "Deploy verified Worker bundle");
    assert.ok(steps(deploy).indexOf(proofCredentials) < steps(deploy).indexOf(checkout));
    assert.ok(steps(deploy).indexOf(proofCredentials) < steps(deploy).indexOf(migration));
    assert.ok(steps(deploy).indexOf(proofCredentials) < steps(deploy).indexOf(workerDeploy));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical crawl-remote production authority must be permanently removed", () => {
  const token = step(deploy, "Create exact-repository reauthorization token");
  assert.equal(
    token.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(token.with?.owner, "openclaw");
  assert.equal(token.with?.repositories, "crawl-remote");
  assert.equal(token.with?.["permission-actions"], "read");
  assert.equal(token.with?.["permission-contents"], "read");
  assert.equal(
    Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")).length,
    2,
  );

  const retirement = step(deploy, "Verify canonical crawl-remote mutator is retired");
  const run = retirement.run ?? "";
  assert.match(run, /repos\/\$TARGET_REPOSITORY\/contents\/\.github\/workflows\?ref=\$DEPLOY_SHA/);
  assert.match(run, /repos\/\$TARGET_REPOSITORY\/actions\/workflows\?per_page=100/);
  assert.match(run, /--paginate --slurp/);
  assert.match(run, /actions\/workflows\/\$workflow_id\/runs\?per_page=100&status=\$status/);
  assert.match(run, /action_required in_progress pending queued requested waiting/);
  assert.match(run, /workflow authority response is truncated/);
  assert.match(run, /workflow still has \$\{status\} runs/);
  assert.match(run, /'deleted'/);
  assert.match(run, /must be deleted before central deployment is enabled/);
  assert.match(run, /reactivatable registry state/);
  assert.doesNotMatch(
    run,
    /--method\s+(?:POST|PUT|PATCH|DELETE)|workflow dispatch|workflow disable/,
  );

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-authority-retirement-"));
  const contentsPath = join(directory, "contents.json");
  const workflowIdPath = join(directory, "workflow-id.txt");
  const registryPath = join(directory, "registry.json");
  const runsRoot = join(directory, "runs");
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
case "$*" in
  *"contents/.github/workflows?ref="*)
    printf '%s\\n' "$WORKFLOW_CONTENTS_JSON"
    ;;
  *"status=waiting"*)
    printf '%s\\n' "$WAITING_RUNS_JSON"
    ;;
  *"/runs?per_page=100"*)
    printf '%s\\n' "$EMPTY_RUNS_JSON"
    ;;
  *"actions/workflows?per_page=100"*)
    printf '%s\\n' "$WORKFLOW_REGISTRY_JSON"
    ;;
  *)
    exit 97
    ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);

  function verify({
    contentPresent,
    registryState,
    registryTruncated = false,
    waitingRun = false,
  }: {
    contentPresent: boolean;
    registryState?: string;
    registryTruncated?: boolean;
    waitingRun?: boolean;
  }) {
    const canonicalPath = ".github/workflows/deploy.yml";
    const contents = contentPresent
      ? [
          {
            name: "deploy.yml",
            path: canonicalPath,
            sha: "a".repeat(40),
            type: "file",
          },
        ]
      : [{ name: "ci.yml", path: ".github/workflows/ci.yml", sha: "b".repeat(40), type: "file" }];
    const workflows = registryState
      ? [{ id: 123, name: "deploy production", path: canonicalPath, state: registryState }]
      : [];
    const registryPages = [
      {
        total_count: workflows.length + (registryTruncated ? 1 : 0),
        workflows,
      },
    ];
    const emptyRuns = [{ total_count: 0, workflow_runs: [] }];
    const waitingRuns = waitingRun
      ? [{ total_count: 1, workflow_runs: [{ id: 456, status: "waiting" }] }]
      : emptyRuns;
    rmSync(workflowIdPath, { force: true });
    rmSync(runsRoot, { recursive: true, force: true });
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CANONICAL_WORKFLOW_PATH: canonicalPath,
        DEPLOY_SHA: mergedCrawlRemoteMain,
        EMPTY_RUNS_JSON: JSON.stringify(emptyRuns),
        GH_TOKEN: "test",
        PATH: `${directory}:${process.env.PATH}`,
        TARGET_REPOSITORY: "openclaw/crawl-remote",
        WORKFLOW_CONTENTS_JSON: JSON.stringify(contents),
        WORKFLOW_CONTENTS_RESPONSE: contentsPath,
        WAITING_RUNS_JSON: JSON.stringify(waitingRuns),
        WORKFLOW_ID_PATH: workflowIdPath,
        WORKFLOW_REGISTRY_JSON: JSON.stringify(registryPages),
        WORKFLOW_REGISTRY_RESPONSE: registryPath,
        WORKFLOW_RUNS_ROOT: runsRoot,
      },
    });
  }

  function assertSucceeds(result: ReturnType<typeof verify>) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }

  try {
    assertSucceeds(verify({ contentPresent: false, registryState: "deleted" }));
    assertSucceeds(verify({ contentPresent: false }));
    assert.notEqual(verify({ contentPresent: true, registryState: "disabled_manually" }).status, 0);
    assert.notEqual(
      verify({ contentPresent: true, registryState: "disabled_inactivity" }).status,
      0,
    );
    assert.notEqual(verify({ contentPresent: true, registryState: "active" }).status, 0);
    assert.notEqual(verify({ contentPresent: true }).status, 0);
    assert.notEqual(verify({ contentPresent: false, registryState: "active" }).status, 0);
    assert.notEqual(
      verify({
        contentPresent: true,
        registryState: "deleted",
        registryTruncated: true,
      }).status,
      0,
    );
    assert.notEqual(
      verify({
        contentPresent: false,
        registryState: "deleted",
        waitingRun: true,
      }).status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const checkout = step(deploy, "Checkout trusted deployment toolchain");
  const migration = step(deploy, "Apply and verify D1 migrations");
  assert.ok(steps(deploy).indexOf(token) < steps(deploy).indexOf(retirement));
  assert.ok(steps(deploy).indexOf(retirement) < steps(deploy).indexOf(checkout));
  assert.ok(steps(deploy).indexOf(retirement) < steps(deploy).indexOf(migration));
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
  const pendingMigrationsPath = join(directory, "pending-migrations.json");
  const previousWorkerProbePath = join(directory, "previous-worker-proof.txt");
  const receiptPath = join(directory, "receipt.json");
  const consumedReceiptPath = `${receiptPath}.consumed`;
  writeFileSync(
    ghPath,
    `#!/bin/sh
case "$*" in
  *"repos/$SOURCE_REPOSITORY/commits/main"*)
    printf '%s\\n' "$CURRENT_SOURCE_MAIN_SHA"
    ;;
  *)
    printf '%s\\n' "$CURRENT_MAIN_SHA"
    ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(receiptPath, "{}\n");
  writeFileSync(consumedReceiptPath, "{}\n");
  writeFileSync(pendingMigrationsPath, "{}\n");
  writeFileSync(previousWorkerProbePath, `${mergedCrawlRemoteMain}\n`);

  function runScript(script: string, deploySha: string, authorize: boolean) {
    writeFileSync(outputPath, "");
    return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONSUMED_RECEIPT_PATH: consumedReceiptPath,
        CURRENT_MAIN_SHA: mergedCrawlRemoteMain,
        CURRENT_SOURCE_MAIN_SHA: "c".repeat(40),
        DEPLOY_SHA: deploySha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456",
        OBSERVATION_ORDER_STATE: "dormant",
        PATH: `${directory}:${process.env.PATH}`,
        PENDING_MIGRATIONS_PATH: pendingMigrationsPath,
        PREVIOUS_WORKER_PROBE_PATH: previousWorkerProbePath,
        RECEIPT_PATH: receiptPath,
        REQUESTED_SHA: deploySha,
        SNAPSHOT_PROVENANCE_STATE: "dormant",
        SOURCE_GH_TOKEN: "test",
        SOURCE_REPOSITORY: "openclaw/clawsweeper",
        TARGET_REPOSITORY: "openclaw/crawl-remote",
        WORKFLOW_SHA: "c".repeat(40),
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
  const pendingMigrationsPath = join(directory, "pending-migrations.json");
  const previousWorkerProbePath = join(directory, "previous-worker-proof.txt");
  const receiptPath = join(directory, "receipt.json");
  writeFileSync(
    ghPath,
    `#!/bin/sh
case "$*" in
  *"repos/$SOURCE_REPOSITORY/commits/main"*)
    printf '%s\\n' "$WORKFLOW_SHA"
    exit 0
    ;;
esac
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
  writeFileSync(pendingMigrationsPath, "{}\n");
  writeFileSync(previousWorkerProbePath, `${mergedCrawlRemoteMain}\n`);

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
        PENDING_MIGRATIONS_PATH: pendingMigrationsPath,
        PREVIOUS_WORKER_PROBE_PATH: previousWorkerProbePath,
        RECEIPT_PATH: receiptPath,
        SOURCE_GH_TOKEN: "test",
        SOURCE_REPOSITORY: "openclaw/clawsweeper",
        TARGET_REPOSITORY: "openclaw/crawl-remote",
        WORKFLOW_SHA: "c".repeat(40),
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
    "5c1e92dbf4d51ef62d317e212a0ec8e39df104983656c6416d0c58ef3503744d",
    "9a021763b074dd6362615f0d0183933b5986eaf880c792c3a8c8cfcd18bc731f",
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

test("deploy uses the committed exact Node and Wrangler toolchain before credentials", () => {
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

  const credentialSteps = steps(deploy).filter(
    (candidate) => candidate.env?.CLOUDFLARE_API_TOKEN !== undefined,
  );
  assert.deepEqual(
    credentialSteps.map((candidate) => candidate.name),
    [
      "Apply and verify D1 migrations",
      "Deploy verified Worker bundle",
      "Resolve Worker deployment ownership",
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
  assert.equal(source.match(/CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN/g)?.length, 5);
});

test("networked CI installs the pinned Wrangler lock and exercises its dry-run outside pnpm check", () => {
  const integration = ciWorkflow.jobs["crawl-remote-toolchain"];
  const check = ciWorkflow.jobs.check;
  assert.ok(integration, "missing crawl-remote toolchain integration job");
  assert.equal(integration.name, "crawl-remote toolchain integration");
  assert.equal(integration["timeout-minutes"], 10);
  assert.equal(integration.env.WRANGLER_VERSION, "4.107.1");
  assert.equal(
    integration.env.TOOLCHAIN_ROOT,
    "${{ github.workspace }}/.github/deploy/crawl-remote-toolchain",
  );
  assert.equal(step(check, "Run check").run, "pnpm run check");
  assert.doesNotMatch(step(check, "Run check").run ?? "", /crawl-remote-toolchain|npm ci/);

  const checkout = steps(integration)[0];
  assert.equal(checkout.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(checkout.with?.["sparse-checkout"], ".github/deploy/crawl-remote-toolchain");
  assert.equal(checkout.with?.["sparse-checkout-cone-mode"], false);
  assert.equal(checkout.with?.["persist-credentials"], false);

  const setup = step(integration, "Setup pinned Node runtime");
  assert.equal(setup.uses, "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
  assert.equal(setup.with?.["node-version"], "24.18.0");

  const install = step(integration, "Install pinned Wrangler from the committed lock");
  assert.equal(install["working-directory"], ".github/deploy/crawl-remote-toolchain");
  assert.match(install.run ?? "", /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(install.run ?? "", /\.\/node_modules\/\.bin\/wrangler --version/);
  assert.doesNotMatch(install.run ?? "", /npm install|npx|wrangler@/);

  const dryRun = step(integration, "Exercise pinned Wrangler dry-run");
  assert.match(dryRun.run ?? "", /\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/);
  assert.match(dryRun.run ?? "", /deploy[\s\S]*--dry-run[\s\S]*--outdir/);
  assert.match(dryRun.run ?? "", /test -s "\$BUNDLE_ROOT\/index\.js"/);
  assert.doesNotMatch(dryRun.run ?? "", /\bnpm\b|\bnpx\b/);

  const integrationRuns = steps(integration)
    .map((candidate) => candidate.run ?? "")
    .join("\n");
  assert.equal(integrationRuns.match(/\bnpm ci\b/g)?.length, 1);
  assert.doesNotMatch(integrationRuns, /CLOUDFLARE_API_TOKEN|secrets\./);
  assert.doesNotMatch(ciSource, /CRAWL_REMOTE_PRODUCTION_CLOUDFLARE_API_TOKEN/);
});

test("deploy reauthorizes exact current main before and after privileged mutations", () => {
  const token = step(deploy, "Create exact-repository reauthorization token");
  assert.equal(
    token.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(token.with?.repositories, "crawl-remote");
  assert.equal(token.with?.["permission-actions"], "read");
  assert.equal(token.with?.["permission-contents"], "read");
  assert.equal(
    Object.keys(token.with ?? {}).filter((key) => key.startsWith("permission-")).length,
    2,
  );

  const baseline = step(deploy, "Capture previous Worker D1 contract baseline");
  const reauthorizeBeforeD1 = step(deploy, "Reauthorize current main before D1 mutation");
  const migration = step(deploy, "Apply and verify D1 migrations");
  const previousWorkerProbe = step(deploy, "Probe previous Worker against migrated D1");
  const reauthorizeBeforeWorker = step(
    deploy,
    "Reauthorize current main immediately before Worker deploy",
  );
  const workerDeploy = step(deploy, "Deploy verified Worker bundle");
  const deploymentState = step(deploy, "Resolve Worker deployment ownership");
  const deployReceipt = step(deploy, "Validate Worker deploy receipt");
  const reauthorizeAfterWorker = step(deploy, "Reauthorize current main after Worker deploy");
  for (const reauthorize of [
    reauthorizeBeforeD1,
    reauthorizeBeforeWorker,
    reauthorizeAfterWorker,
  ]) {
    assert.match(reauthorize.run ?? "", /\[\[ "\$DEPLOY_SHA" != "\$current_main_sha" \]\]/);
    assert.match(
      reauthorize.run ?? "",
      /\[\[ "\$WORKFLOW_SHA" != "\$current_source_main_sha" \]\]/,
    );
    assert.equal(reauthorize.env?.SOURCE_GH_TOKEN, "${{ github.token }}");
    assert.doesNotMatch(reauthorize.run ?? "", /compare\/|comparison_status|ancestor|"ahead"/);
    assert.equal(reauthorize.env?.CLOUDFLARE_API_TOKEN, undefined);
  }

  assert.equal(steps(deploy).indexOf(baseline) + 1, steps(deploy).indexOf(reauthorizeBeforeD1));
  assert.equal(steps(deploy).indexOf(reauthorizeBeforeD1) + 1, steps(deploy).indexOf(migration));
  assert.equal(steps(deploy).indexOf(migration) + 1, steps(deploy).indexOf(previousWorkerProbe));
  assert.equal(
    steps(deploy).indexOf(previousWorkerProbe) + 1,
    steps(deploy).indexOf(reauthorizeBeforeWorker),
  );
  assert.equal(
    steps(deploy).indexOf(reauthorizeBeforeWorker) + 1,
    steps(deploy).indexOf(workerDeploy),
  );
  assert.equal(steps(deploy).indexOf(workerDeploy) + 1, steps(deploy).indexOf(deploymentState));
  assert.equal(steps(deploy).indexOf(deploymentState) + 1, steps(deploy).indexOf(deployReceipt));
  assert.equal(
    steps(deploy).indexOf(deployReceipt) + 1,
    steps(deploy).indexOf(reauthorizeAfterWorker),
  );
  assert.match(migration.run ?? "", /test ! -e "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(migration.run ?? "", /mv -- "\$RECEIPT_PATH" "\$CONSUMED_RECEIPT_PATH"/);
  assert.equal(baseline.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(previousWorkerProbe.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.match(baseline.run ?? "", /\$WORKERS_DEV_URL\/v1\/contract\?migration_probe=/);
  assert.match(previousWorkerProbe.run ?? "", /\$WORKERS_DEV_URL\/v1\/contract\?migration_probe=/);
  assert.match(reauthorizeBeforeWorker.run ?? "", /test -f "\$PENDING_MIGRATIONS_PATH"/);
  assert.match(reauthorizeBeforeWorker.run ?? "", /test -f "\$PREVIOUS_WORKER_PROBE_PATH"/);
  assert.match(reauthorizeBeforeWorker.run ?? "", /test -f "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(workerDeploy.run ?? "", /test -f "\$CONSUMED_RECEIPT_PATH"/);
  assert.match(workerDeploy.run ?? "", /test -f "\$PENDING_MIGRATIONS_PATH"/);
  assert.match(workerDeploy.run ?? "", /test -f "\$PREVIOUS_WORKER_PROBE_PATH"/);
  assert.equal(workerDeploy["continue-on-error"], true);
  assert.equal(deploymentState["continue-on-error"], true);
  assert.equal(deployReceipt["continue-on-error"], true);
  assert.equal(reauthorizeAfterWorker["continue-on-error"], true);
  assert.match(
    reauthorizeAfterWorker.if ?? "",
    /steps\.deployment-state\.outputs\.mutation_owned == 'true'/,
  );
  assert.match(reauthorizeAfterWorker.if ?? "", /steps\.deploy-receipt\.outcome == 'success'/);
});

test("privileged mutations use only verified files and prove the selected D1 fence state", () => {
  const migration = step(deploy, "Apply and verify D1 migrations").run ?? "";
  const workerDeploy = step(deploy, "Deploy verified Worker bundle").run ?? "";
  assert.match(migration, /\$TOOLCHAIN_ROOT\/node_modules\/\.bin\/wrangler/);
  assert.match(migration, /deployments status/);
  assert.match(migration, /versions\.length !== 1/);
  assert.match(migration, /versions\[0\]\?\.percentage !== 100/);
  assert.match(migration, /PREVIOUS_VERSION_PATH/);
  assert.match(migration, /select name from d1_migrations order by id/);
  assert.match(migration, /PENDING_MIGRATIONS_NODE/);
  assert.match(migration, /release manifest is not bound to the reviewed migration set/);
  assert.match(migration, /remote D1 migration ledger is not the reviewed migration prefix/);
  assert.match(
    migration,
    /pending migration \$\{migration\.name\} is not classified as compatible with the previous Worker/,
  );
  assert.match(migration, /additive-snapshot-provenance-and-retirement-v2/);
  assert.match(migration, /additive-publish-candidate-compat-v1/);
  assert.match(migration, /gitcrawl_snapshot_provenance/);
  assert.match(migration, /gitcrawl_archive_snapshot_state/);
  assert.match(migration, /gitcrawl_publish_candidates/);
  assert.match(migration, /on conflict\\\(capability\\\) do nothing/);
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
  assert.match(workerDeploy, /--message "\$DEPLOY_MESSAGE"/);
  assert.match(workerDeploy, /test -f "\$PREVIOUS_VERSION_PATH"/);
  assert.match(workerDeploy, /deployments status/);
  assert.match(workerDeploy, /versions\.length !== 1/);
  assert.match(workerDeploy, /versions\[0\]\?\.percentage !== 100/);
  assert.match(workerDeploy, /versions\[0\]\?\.version_id !== previousVersion/);
  assert.match(workerDeploy, /current Worker version changed after migration proof/);
  assert.match(deploy.env.DEPLOY_MESSAGE ?? "", /github\.run_id.*github\.run_attempt.*deploy_sha/);
  assert.ok(
    workerDeploy.indexOf("deployments status") < workerDeploy.indexOf("WRANGLER_OUTPUT_FILE_PATH"),
  );

  const ledgerQueryIndex = migration.indexOf('> "$APPLIED_MIGRATIONS_RESPONSE"');
  const preQueryIndex = migration.indexOf('> "$PRE_FENCE_RESPONSE"');
  const migrationIndex = migration.indexOf('"$wrangler" d1 migrations apply');
  const postQueryIndex = migration.indexOf('> "$FENCE_RESPONSE"');
  assert.ok(ledgerQueryIndex >= 0);
  assert.ok(ledgerQueryIndex < preQueryIndex);
  assert.ok(preQueryIndex >= 0);
  assert.ok(preQueryIndex < migrationIndex);
  assert.ok(migrationIndex < postQueryIndex);
});

test("failed Worker release rolls back only the exact previously stable Worker version", () => {
  const workerDeploy = step(deploy, "Deploy verified Worker bundle");
  const deploymentState = step(deploy, "Resolve Worker deployment ownership");
  const deployReceipt = step(deploy, "Validate Worker deploy receipt");
  const postDeployMain = step(deploy, "Reauthorize current main after Worker deploy");
  const proof = step(deploy, "Poll exact production release");
  const rollback = step(deploy, "Roll back failed Worker release");
  const finalGate = step(deploy, "Require successful release and proof");
  const run = rollback.run ?? "";

  assert.equal(workerDeploy.id, "worker-deploy");
  assert.equal(deploymentState.id, "deployment-state");
  assert.equal(deployReceipt.id, "deploy-receipt");
  assert.equal(postDeployMain.id, "post-deploy-main");
  assert.equal(proof.id, "production-proof");
  assert.equal(proof["continue-on-error"], true);
  assert.match(rollback.if ?? "", /always\(\)/);
  assert.match(rollback.if ?? "", /steps\.deployment-state\.outcome == 'success'/);
  assert.match(rollback.if ?? "", /steps\.deployment-state\.outputs\.mutation_owned == 'true'/);
  assert.match(rollback.if ?? "", /steps\.worker-deploy\.outcome != 'success'/);
  assert.match(rollback.if ?? "", /steps\.deploy-receipt\.outcome != 'success'/);
  assert.match(rollback.if ?? "", /steps\.post-deploy-main\.outcome != 'success'/);
  assert.match(rollback.if ?? "", /steps\.production-proof\.outcome != 'success'/);
  assert.match(workerDeploy.run ?? "", /WRANGLER_OUTPUT_FILE_PATH="\$DEPLOY_OUTPUT_PATH"/);
  assert.match(workerDeploy.run ?? "", /WRANGLER_DEPLOY_TIMEOUT_SECONDS/);
  assert.doesNotMatch(workerDeploy.run ?? "", /DEPLOYED_VERSION_PATH|entry\?\.type === 'deploy'/);
  assert.match(deploymentState.run ?? "", /deployment\?\.annotations\?\.\['workers\/message'\]/);
  assert.match(deploymentState.run ?? "", /mutation_owned=true/);
  assert.match(deploymentState.run ?? "", /\['success', 'failure', 'cancelled'\]/);
  assert.match(deploymentState.run ?? "", /deployment mutation remains indeterminate/);
  assert.match(deploymentState.run ?? "", /DEPLOYMENT_STATUS_TIMEOUT_SECONDS/);
  assert.match(deploymentState.run ?? "", /WRANGLER_READ_TIMEOUT_SECONDS/);
  assert.match(deploymentState.run ?? "", /ownership deadline expired/);
  assert.doesNotMatch(deploymentState.run ?? "", /mutation_owned=false/);
  assert.match(deployReceipt.run ?? "", /entry\?\.type === 'deploy'/);
  assert.match(deployReceipt.run ?? "", /deployments\[0\]\?\.version !== 1/);
  assert.match(deployReceipt.run ?? "", /version_id !== deployedVersion/);
  assert.match(run, /refusing rollback because this run no longer owns the current Worker version/);
  assert.match(run, /versions\[0\]\?\.version_id !== process\.env\.DEPLOYED_VERSION/);
  assert.match(run, /wrangler" rollback "\$previous_version"/);
  assert.match(run, /WRANGLER_ROLLBACK_TIMEOUT_SECONDS/);
  assert.match(run, /WRANGLER_READ_TIMEOUT_SECONDS/);
  assert.match(run, /--yes/);
  assert.match(run, /deployments status/);
  assert.match(run, /versions\[0\]\?\.version_id !== process\.env\.PREVIOUS_VERSION/);
  assert.match(run, /versions\[0\]\?\.percentage !== 100/);
  assert.match(run, /D1 migrations remain applied/);
  assert.equal(finalGate.if, "${{ always() }}");
  assert.match(finalGate.run ?? "", /D1 migrations are not rolled back/);
  assert.match(finalGate.run ?? "", /WORKER_DEPLOY_OUTCOME.*DEPLOYMENT_STATE_OUTCOME/s);
  assert.match(finalGate.run ?? "", /MUTATION_OWNED.*DEPLOY_RECEIPT_OUTCOME/s);
  assert.match(finalGate.run ?? "", /DEPLOY_RECEIPT_OUTCOME.*POST_DEPLOY_MAIN_OUTCOME/s);
  assert.match(finalGate.run ?? "", /PRODUCTION_PROOF_OUTCOME.*success/s);
  assert.match(finalGate.run ?? "", /rollback outcome/);
});

test("deployment ownership recovers a mutation after the deploy command reports failure", () => {
  const ownership = step(deploy, "Resolve Worker deployment ownership");
  const receipt = step(deploy, "Validate Worker deploy receipt");
  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-deployment-ownership-"));
  const toolchainRoot = join(directory, "toolchain");
  const binRoot = join(toolchainRoot, "node_modules", ".bin");
  const wranglerPath = join(binRoot, "wrangler");
  const previousVersionPath = join(directory, "previous-version.txt");
  const deployedVersionPath = join(directory, "deployed-version.txt");
  const deploymentResponsePath = join(directory, "deployment.json");
  const deployOutputPath = join(directory, "deploy-output.ndjson");
  const githubOutputPath = join(directory, "github-output");
  const previousVersion = "11111111-1111-4111-8111-111111111111";
  const deployedVersion = "22222222-2222-4222-8222-222222222222";
  const foreignVersion = "33333333-3333-4333-8333-333333333333";
  const deployMessage = "clawsweeper run 123/1 main " + mergedCrawlRemoteMain;
  const token = "production-token";
  const tokenSHA = createHash("sha256").update(token).digest("hex");

  mkdirSync(binRoot, { recursive: true });
  writeFileSync(
    wranglerPath,
    `#!/bin/sh
if test "$1" = "--version"; then
  printf '%s\\n' "$WRANGLER_VERSION"
  exit 0
fi
if test "$1 $2" = "deployments status"; then
  printf '%s\\n' "$CURRENT_DEPLOYMENT_JSON"
  exit 0
fi
exit 97
`,
  );
  chmodSync(wranglerPath, 0o755);
  writeFileSync(previousVersionPath, `${previousVersion}\n`);

  function runOwnership({
    currentVersion,
    currentMessage,
    deployOutcome,
  }: {
    currentVersion: string;
    currentMessage: string;
    deployOutcome: "success" | "failure" | "cancelled";
  }) {
    rmSync(deployedVersionPath, { force: true });
    rmSync(deploymentResponsePath, { force: true });
    rmSync(githubOutputPath, { force: true });
    return spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", ownership.run ?? ""],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_TOKEN_SHA256: tokenSHA,
          CURRENT_DEPLOYMENT_JSON: JSON.stringify({
            annotations: { "workers/message": currentMessage },
            versions: [{ percentage: 100, version_id: currentVersion }],
          }),
          CURRENT_DEPLOYMENT_RESPONSE: deploymentResponsePath,
          DEPLOYED_VERSION_PATH: deployedVersionPath,
          DEPLOYMENT_STATUS_ATTEMPTS: "1",
          DEPLOYMENT_STATUS_DELAY_SECONDS: "0",
          DEPLOYMENT_STATUS_TIMEOUT_SECONDS: "30",
          DEPLOY_MESSAGE: deployMessage,
          GITHUB_OUTPUT: githubOutputPath,
          PREVIOUS_VERSION_PATH: previousVersionPath,
          RELEASE_ROOT: directory,
          TOOLCHAIN_ROOT: toolchainRoot,
          WORKER_DEPLOY_OUTCOME: deployOutcome,
          WRANGLER_READ_TIMEOUT_SECONDS: "5",
          WRANGLER_VERSION: "4.107.1",
        },
      },
    );
  }

  try {
    const partialSuccess = runOwnership({
      currentVersion: deployedVersion,
      currentMessage: deployMessage,
      deployOutcome: "failure",
    });
    assert.equal(partialSuccess.status, 0, partialSuccess.stdout + partialSuccess.stderr);
    assert.match(readFileSync(githubOutputPath, "utf8"), /mutation_owned=true/);
    assert.equal(readFileSync(deployedVersionPath, "utf8").trim(), deployedVersion);

    writeFileSync(
      deployOutputPath,
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "crawl-remote",
        version_id: deployedVersion,
      })}\n`,
    );
    const validReceipt = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", receipt.run ?? ""],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOYED_VERSION_PATH: deployedVersionPath,
          DEPLOY_OUTPUT_PATH: deployOutputPath,
        },
      },
    );
    assert.equal(validReceipt.status, 0, validReceipt.stdout + validReceipt.stderr);

    const noMutation = runOwnership({
      currentVersion: previousVersion,
      currentMessage: "previous deployment",
      deployOutcome: "failure",
    });
    assert.notEqual(noMutation.status, 0);
    assert.match(
      noMutation.stdout + noMutation.stderr,
      /deployment mutation remains indeterminate after 1 status checks/,
    );
    assert.equal(existsSync(deployedVersionPath), false);

    const falseSuccess = runOwnership({
      currentVersion: previousVersion,
      currentMessage: "previous deployment",
      deployOutcome: "success",
    });
    assert.notEqual(falseSuccess.status, 0);
    assert.match(
      falseSuccess.stdout + falseSuccess.stderr,
      /deployment mutation remains indeterminate after 1 status checks/,
    );

    const cancelledSuccess = runOwnership({
      currentVersion: deployedVersion,
      currentMessage: deployMessage,
      deployOutcome: "cancelled",
    });
    assert.equal(cancelledSuccess.status, 0, cancelledSuccess.stdout + cancelledSuccess.stderr);
    assert.match(readFileSync(githubOutputPath, "utf8"), /mutation_owned=true/);
    assert.equal(readFileSync(deployedVersionPath, "utf8").trim(), deployedVersion);

    const foreignMutation = runOwnership({
      currentVersion: foreignVersion,
      currentMessage: "another deployer",
      deployOutcome: "failure",
    });
    assert.notEqual(foreignMutation.status, 0);
    assert.match(
      foreignMutation.stdout + foreignMutation.stderr,
      /current Worker deployment is not owned by this workflow run/,
    );

    writeFileSync(
      deployOutputPath,
      `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "crawl-remote",
        version_id: foreignVersion,
      })}\n`,
    );
    writeFileSync(deployedVersionPath, `${deployedVersion}\n`);
    const mismatchedReceipt = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", receipt.run ?? ""],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOYED_VERSION_PATH: deployedVersionPath,
          DEPLOY_OUTPUT_PATH: deployOutputPath,
        },
      },
    );
    assert.notEqual(mismatchedReceipt.status, 0);
    assert.match(
      mismatchedReceipt.stdout + mismatchedReceipt.stderr,
      /deploy receipt does not match the owned Worker version/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending migration compatibility accepts only the reviewed additive 0007-0008 suffix", () => {
  const run = step(deploy, "Apply and verify D1 migrations").run ?? "";
  const validator = run.match(
    /node --input-type=module <<'PENDING_MIGRATIONS_NODE'\n([\s\S]*?)\nPENDING_MIGRATIONS_NODE/,
  )?.[1];
  assert.ok(validator, "missing inline pending migration compatibility validator");

  const approvedMigrations = [
    [
      "0001_remote_archives.sql",
      "bfb2ee56d01c7547a644f48b5c493cb9d971646ce331acc10c6bfd78d9b7d066",
    ],
    [
      "0002_gitcrawl_enrichment_snapshots.sql",
      "f984199bef0406ce91724e9ac83a97f41928b1560a51974deb841596f1e403e2",
    ],
    [
      "0003_gitcrawl_snapshot_hardening.sql",
      "5daa6e14364f7bd4eba3cc5f61ec266b0559962e7345a65080cc9ef26b084e46",
    ],
    [
      "0004_gitcrawl_snapshot_cutover.sql",
      "e6c4a8edb300ebbf93a2e2449d180408f23be7eac1ef05733045b6ed496eb396",
    ],
    [
      "0005_discrawl_cursor_state.sql",
      "5964adcb0807448d937fed38ac9588a1063bf4f490a82b54f15f0e700374ae0c",
    ],
    [
      "0006_gitcrawl_observation_order.sql",
      "a0ebfbb5c40c85df5eaba6772a01a68910fa5f1327d4701d25c5dfde16f77d1a",
    ],
    [
      "0007_gitcrawl_snapshot_provenance.sql",
      "5c1e92dbf4d51ef62d317e212a0ec8e39df104983656c6416d0c58ef3503744d",
    ],
    [
      "0008_gitcrawl_publish_candidates.sql",
      "9a021763b074dd6362615f0d0183933b5986eaf880c792c3a8c8cfcd18bc731f",
    ],
  ] as const;
  const migrationSQL = `pragma foreign_keys = on;

create table if not exists gitcrawl_snapshot_provenance (
  archive_id text not null,
  snapshot_id text not null,
  binding_mode text not null,
  source_sha256 text not null default '',
  created_at text not null,
  current_manifest_pending integer not null default 0,
  current_manifest_published_at text not null default '',
  current_manifest_updated_at text not null default '',
  primary key (archive_id, snapshot_id),
  foreign key (archive_id, snapshot_id)
    references gitcrawl_snapshots(archive_id, snapshot_id) on delete cascade,
  check (binding_mode in ('legacy', 'bound')),
  check (
    (binding_mode = 'legacy' and source_sha256 = '')
    or (
      binding_mode = 'bound'
      and snapshot_id = source_sha256
      and length(source_sha256) = 64
      and source_sha256 = lower(source_sha256)
      and source_sha256 not glob '*[^0-9a-f]*'
    )
  ),
  check (current_manifest_pending in (0, 1))
);

create trigger if not exists gitcrawl_snapshot_provenance_identity_immutable
before update of archive_id, snapshot_id, binding_mode, source_sha256, created_at
on gitcrawl_snapshot_provenance
for each row
when new.archive_id is not old.archive_id
  or new.snapshot_id is not old.snapshot_id
  or new.binding_mode is not old.binding_mode
  or new.source_sha256 is not old.source_sha256
  or new.created_at is not old.created_at
begin
  select raise(abort, 'gitcrawl snapshot provenance identity is immutable');
end;

create trigger if not exists gitcrawl_snapshot_provenance_delete_guard
before delete on gitcrawl_snapshot_provenance
for each row
when exists (
  select 1
  from gitcrawl_snapshots snapshot
  where snapshot.archive_id = old.archive_id
    and snapshot.snapshot_id = old.snapshot_id
)
begin
  select raise(abort, 'gitcrawl snapshot provenance identity cannot be deleted');
end;

create table if not exists gitcrawl_archive_snapshot_state (
  archive_id text primary key references remote_archives(id) on delete cascade,
  raw_sqlite_retired integer not null default 1 check (raw_sqlite_retired = 1),
  raw_sqlite_retired_at text not null check (trim(raw_sqlite_retired_at) != '')
);

create trigger if not exists gitcrawl_archive_snapshot_state_immutable
before update of archive_id, raw_sqlite_retired, raw_sqlite_retired_at
on gitcrawl_archive_snapshot_state
for each row
when new.archive_id is not old.archive_id
  or new.raw_sqlite_retired is not old.raw_sqlite_retired
  or new.raw_sqlite_retired_at is not old.raw_sqlite_retired_at
begin
  select raise(abort, 'gitcrawl archive snapshot state is immutable');
end;

create trigger if not exists gitcrawl_archive_snapshot_state_delete_guard
before delete on gitcrawl_archive_snapshot_state
for each row
when exists (
  select 1
  from remote_archives archive
  where archive.id = old.archive_id
)
begin
  select raise(abort, 'gitcrawl archive snapshot state cannot be deleted');
end;

insert or ignore into gitcrawl_snapshot_provenance(
  archive_id,
  snapshot_id,
  binding_mode,
  source_sha256,
  created_at
)
select archive_id, snapshot_id, 'legacy', '', created_at
from gitcrawl_snapshots;

insert into remote_capability_fences(
  capability,
  migration_ready,
  cutover_enabled,
  created_at,
  activated_at
) values (
  'gitcrawl.snapshot.provenance.v1',
  1,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  ''
)
on conflict(capability) do nothing;
`;
  const migration0008SQL = `pragma foreign_keys = on;

create table if not exists gitcrawl_publish_candidates (
  archive_id text primary key references remote_archives(id) on delete cascade,
  snapshot_id text not null,
  completed_at text not null,
  foreign key (archive_id, snapshot_id)
    references gitcrawl_snapshots(archive_id, snapshot_id) on delete cascade
);

insert into gitcrawl_publish_candidates(archive_id, snapshot_id, completed_at)
select active.archive_id, active.snapshot_id, active.activated_at
from gitcrawl_active_snapshots active
join gitcrawl_snapshots snapshot
  on snapshot.archive_id = active.archive_id
 and snapshot.snapshot_id = active.snapshot_id
where snapshot.activated_at is not null
  and snapshot.coverage_complete = 1
  and trim(snapshot.hardening_validated_at) != ''
on conflict(archive_id) do update set
  snapshot_id = excluded.snapshot_id,
  completed_at = excluded.completed_at;

update gitcrawl_snapshot_cutovers
set snapshot_id = (
      select active.snapshot_id
      from gitcrawl_active_snapshots active
      join gitcrawl_snapshots snapshot
        on snapshot.archive_id = active.archive_id
       and snapshot.snapshot_id = active.snapshot_id
      where active.archive_id = gitcrawl_snapshot_cutovers.archive_id
        and snapshot.activated_at is not null
        and snapshot.coverage_complete = 1
        and trim(snapshot.hardening_validated_at) != ''
    ),
    cutover_at = (
      select active.activated_at
      from gitcrawl_active_snapshots active
      join gitcrawl_snapshots snapshot
        on snapshot.archive_id = active.archive_id
       and snapshot.snapshot_id = active.snapshot_id
      where active.archive_id = gitcrawl_snapshot_cutovers.archive_id
        and snapshot.activated_at is not null
        and snapshot.coverage_complete = 1
        and trim(snapshot.hardening_validated_at) != ''
    )
where exists (
  select 1
  from gitcrawl_active_snapshots active
  join gitcrawl_snapshots snapshot
    on snapshot.archive_id = active.archive_id
   and snapshot.snapshot_id = active.snapshot_id
  where active.archive_id = gitcrawl_snapshot_cutovers.archive_id
    and active.snapshot_id != gitcrawl_snapshot_cutovers.snapshot_id
    and snapshot.activated_at is not null
    and snapshot.coverage_complete = 1
    and trim(snapshot.hardening_validated_at) != ''
);

create trigger if not exists gitcrawl_publish_candidates_old_worker_activation
after update of activated_at on gitcrawl_snapshots
for each row
when old.activated_at is null
  and new.activated_at is not null
  and exists (
    select 1
    from gitcrawl_active_snapshots active
    where active.archive_id = new.archive_id
      and active.snapshot_id = new.snapshot_id
      and active.activated_at = new.activated_at
  )
begin
  insert into gitcrawl_publish_candidates(archive_id, snapshot_id, completed_at)
  values (new.archive_id, new.snapshot_id, new.activated_at)
  on conflict(archive_id) do update set
    snapshot_id = excluded.snapshot_id,
    completed_at = excluded.completed_at;

  update gitcrawl_snapshot_cutovers
  set snapshot_id = new.snapshot_id,
      cutover_at = new.activated_at
  where archive_id = new.archive_id;
end;
`;

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-pending-migrations-"));
  const releaseRoot = join(directory, "release");
  const migrationsRoot = join(releaseRoot, "migrations");
  const responsePath = join(directory, "applied.json");
  const proofPath = join(directory, "proof.json");
  mkdirSync(migrationsRoot, { recursive: true });
  writeFileSync(
    join(releaseRoot, "manifest.json"),
    JSON.stringify({
      files: approvedMigrations.map(([name, sha256]) => ({
        path: `migrations/${name}`,
        sha256,
      })),
    }),
  );
  writeFileSync(join(migrationsRoot, approvedMigrations[6][0]), migrationSQL);
  writeFileSync(join(migrationsRoot, approvedMigrations[7][0]), migration0008SQL);

  function validate(appliedNames: readonly string[], response?: unknown) {
    rmSync(proofPath, { force: true });
    writeFileSync(
      responsePath,
      JSON.stringify(
        response ?? [
          {
            success: true,
            results: appliedNames.map((name) => ({ name })),
          },
        ],
      ),
    );
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: validator,
      encoding: "utf8",
      env: {
        ...process.env,
        APPLIED_MIGRATIONS_RESPONSE: responsePath,
        PENDING_MIGRATIONS_PATH: proofPath,
        RELEASE_ROOT: releaseRoot,
      },
    });
  }

  try {
    const names = approvedMigrations.map(([name]) => name);
    const pending0007 = validate(names.slice(0, 6));
    assert.equal(pending0007.status, 0, pending0007.stdout + pending0007.stderr);
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    assert.deepEqual(proof.pending_migrations, [
      "0007_gitcrawl_snapshot_provenance.sql",
      "0008_gitcrawl_publish_candidates.sql",
    ]);
    assert.deepEqual(proof.compatible_with_previous_worker, [
      {
        name: "0007_gitcrawl_snapshot_provenance.sql",
        sha256: approvedMigrations[6][1],
        classification: "additive-snapshot-provenance-and-retirement-v2",
      },
      {
        name: "0008_gitcrawl_publish_candidates.sql",
        sha256: approvedMigrations[7][1],
        classification: "additive-publish-candidate-compat-v1",
      },
    ]);

    const pending0008 = validate(names.slice(0, 7));
    assert.equal(pending0008.status, 0, pending0008.stdout + pending0008.stderr);
    const pending0008Proof = JSON.parse(readFileSync(proofPath, "utf8"));
    assert.deepEqual(pending0008Proof.pending_migrations, ["0008_gitcrawl_publish_candidates.sql"]);
    assert.deepEqual(pending0008Proof.compatible_with_previous_worker, [
      {
        name: "0008_gitcrawl_publish_candidates.sql",
        sha256: approvedMigrations[7][1],
        classification: "additive-publish-candidate-compat-v1",
      },
    ]);

    assert.equal(validate(names).status, 0);
    assert.notEqual(validate(names.slice(0, 5)).status, 0);
    assert.notEqual(validate([...names.slice(0, 7), "0009_unreviewed.sql"]).status, 0);
    assert.notEqual(validate([names[0], names[2]]).status, 0);
    assert.notEqual(validate([], [{ success: false, results: [] }]).status, 0);

    writeFileSync(join(migrationsRoot, approvedMigrations[6][0]), `${migrationSQL}\n-- tampered\n`);
    assert.notEqual(validate(names.slice(0, 6)).status, 0);
    writeFileSync(join(migrationsRoot, approvedMigrations[6][0]), migrationSQL);
    writeFileSync(
      join(migrationsRoot, approvedMigrations[7][0]),
      `${migration0008SQL}\n-- tampered\n`,
    );
    assert.notEqual(validate(names.slice(0, 7)).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("previous Worker public contract must survive the D1 migration without regressions", () => {
  const baselineRun = step(deploy, "Capture previous Worker D1 contract baseline").run ?? "";
  const probeRun = step(deploy, "Probe previous Worker against migrated D1").run ?? "";
  const baselineValidator = baselineRun.match(
    /node --input-type=module <<'PREVIOUS_WORKER_BASELINE_NODE'\n([\s\S]*?)\nPREVIOUS_WORKER_BASELINE_NODE/,
  )?.[1];
  const probeValidator = probeRun.match(
    /node --input-type=module <<'PREVIOUS_WORKER_PROBE_NODE'\n([\s\S]*?)\nPREVIOUS_WORKER_PROBE_NODE/,
  )?.[1];
  assert.ok(baselineValidator, "missing previous Worker baseline validator");
  assert.ok(probeValidator, "missing previous Worker post-migration validator");

  const directory = mkdtempSync(join(tmpdir(), "crawl-remote-previous-worker-probe-"));
  const baselineHealthPath = join(directory, "baseline-health.json");
  const baselineContractPath = join(directory, "baseline-contract.json");
  const probeHealthPath = join(directory, "probe-health.json");
  const probeContractPath = join(directory, "probe-contract.json");
  const releasePath = join(directory, "release.txt");
  const proofPath = join(directory, "proof.txt");
  const releaseSHA = "a".repeat(40);
  const health = { ok: true, release_sha: releaseSHA };
  const contract = {
    service: "crawl-remote",
    protocol_version: "v1",
    release_sha: releaseSHA,
    routes: [
      { method: "GET", path: "/health", auth: "public" },
      { method: "GET", path: "/v1/contract", auth: "public" },
    ],
    apps: [{ app: "gitcrawl", capabilities: ["gitcrawl.observation-order.v1"] }],
  };
  writeFileSync(baselineHealthPath, JSON.stringify(health));
  writeFileSync(baselineContractPath, JSON.stringify(contract));

  function baseline() {
    rmSync(releasePath, { force: true });
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: baselineValidator,
      encoding: "utf8",
      env: {
        ...process.env,
        PREVIOUS_RELEASE_SHA_PATH: releasePath,
        PREVIOUS_WORKER_CONTRACT_BASELINE: baselineContractPath,
        PREVIOUS_WORKER_HEALTH_BASELINE: baselineHealthPath,
      },
    });
  }

  function probe(probedHealth: unknown, probedContract: unknown) {
    rmSync(proofPath, { force: true });
    writeFileSync(probeHealthPath, JSON.stringify(probedHealth));
    writeFileSync(probeContractPath, JSON.stringify(probedContract));
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: probeValidator,
      encoding: "utf8",
      env: {
        ...process.env,
        PREVIOUS_RELEASE_SHA_PATH: releasePath,
        PREVIOUS_WORKER_CONTRACT_BASELINE: baselineContractPath,
        PREVIOUS_WORKER_CONTRACT_PROBE: probeContractPath,
        PREVIOUS_WORKER_HEALTH_BASELINE: baselineHealthPath,
        PREVIOUS_WORKER_HEALTH_PROBE: probeHealthPath,
        PREVIOUS_WORKER_PROBE_PATH: proofPath,
      },
    });
  }

  try {
    const baselineResult = baseline();
    assert.equal(baselineResult.status, 0, baselineResult.stdout + baselineResult.stderr);
    const probeResult = probe(health, contract);
    assert.equal(probeResult.status, 0, probeResult.stdout + probeResult.stderr);
    assert.equal(readFileSync(proofPath, "utf8"), `${releaseSHA}\n`);
    assert.notEqual(probe({ ...health, release_sha: "b".repeat(40) }, contract).status, 0);
    assert.equal(
      probe(health, { ...contract, notes: ["additive migration-ready note"] }).status,
      0,
    );
    assert.notEqual(probe(health, { ...contract, apps: [] }).status, 0);

    writeFileSync(baselineContractPath, JSON.stringify({ ...contract, routes: [], apps: [] }));
    assert.notEqual(baseline().status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("production semantic validator requires workers.dev and the Access route", () => {
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
    customRouteProof: "access-service-token" = "access-service-token",
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
    assert.notEqual(validate("dormant", "dormant", {}, { contractSha: "b".repeat(40) }).status, 0);
    assert.equal(validate("dormant", "dormant", {}, {}).status, 0);
    assert.notEqual(validate("active", "dormant", { capabilities: [] }).status, 0);
    assert.notEqual(validate("dormant", "active", { capabilities: [] }).status, 0);
    assert.notEqual(
      validate("dormant", "dormant", {}, { capabilities: [observationCapability] }).status,
      0,
    );
    assert.notEqual(validate("dormant", "dormant", {}, { capabilities: null }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
