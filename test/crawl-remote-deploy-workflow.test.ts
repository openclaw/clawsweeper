import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/deploy-crawl-remote.yml";
const source = readFileSync(workflowPath, "utf8");
const workflow = parse(source);
const deploy = workflow.jobs.deploy;
const steps = deploy.steps as Array<{
  name: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
}>;

function step(name: string) {
  const match = steps.find((candidate) => candidate.name === name);
  assert.ok(match, `missing workflow step: ${name}`);
  return match;
}

test("crawl-remote deployment is manual, protected, and maintainer-bound", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["confirmation", "main_sha"]);
  assert.match(deploy.if, /github\.actor == 'vincentkoc'/);
  assert.match(deploy.if, /github\.actor_id == '25068'/);
  assert.match(deploy.if, /github\.triggering_actor == 'vincentkoc'/);
  assert.match(deploy.if, /github\.run_attempt == 1/);
  assert.match(deploy.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy.if, /inputs\.confirmation == 'deploy crawl-remote production'/);
  assert.deepEqual(deploy.environment, {
    name: "crawl-remote-production",
    url: "https://crawl-remote.services-91b.workers.dev",
  });
  assert.equal(deploy.env.TARGET_REPOSITORY, "openclaw/crawl-remote");
  assert.equal(deploy.env.CLOUDFLARE_ACCOUNT_ID, "91b59577e757131d68d55a471fe32aca");
  assert.equal(deploy["timeout-minutes"], 25);
});

test("crawl-remote deployment checks out one exact current main release", () => {
  const token = step("Create exact-repository read token");
  assert.equal(
    token.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(token.with?.owner, "openclaw");
  assert.equal(token.with?.repositories, "crawl-remote");
  assert.equal(token.with?.["permission-contents"], "read");
  assert.equal(token.with?.["permission-environments"], undefined);

  const authorize = step("Authorize immutable main release");
  assert.match(authorize.run ?? "", /\^\[0-9a-f\]\{40\}\$/);
  assert.match(authorize.run ?? "", /repos\/\$TARGET_REPOSITORY\/commits\/main/);
  assert.match(authorize.run ?? "", /deploy_sha=\$REQUESTED_SHA/);

  const checkout = step("Checkout approved crawl-remote main");
  assert.equal(checkout.uses, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
  assert.equal(checkout.with?.repository, "openclaw/crawl-remote");
  assert.equal(checkout.with?.ref, "${{ steps.authorize.outputs.deploy_sha }}");
  assert.equal(checkout.with?.token, "${{ steps.target-token.outputs.token }}");
  assert.equal(checkout.with?.["persist-credentials"], false);

  assert.equal(
    step("Setup Node").uses,
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  );
  assert.match(step("Verify checked-out release SHA").run ?? "", /git rev-parse HEAD/);

  const freezeIndex = steps.findIndex(
    (candidate) => candidate.name === "Freeze current main as the release unit",
  );
  const migrationIndex = steps.findIndex(
    (candidate) => candidate.name === "Apply remote D1 migrations",
  );
  assert.equal(freezeIndex + 1, migrationIndex);
  assert.match(steps[freezeIndex]?.run ?? "", /repos\/\$TARGET_REPOSITORY\/commits\/main/);
  assert.match(steps[freezeIndex]?.run ?? "", /CURRENT_MAIN_SHA.*DEPLOY_SHA/s);
});

test("crawl-remote deployment preflights before the immutable mutation pair", () => {
  assert.equal(step("Install dependencies").run, "npm ci");
  assert.equal(step("Typecheck").run, "npm run typecheck");
  assert.equal(step("Test").run, "npm test");
  assert.equal(
    step("Validate Worker bundle").run,
    "npm run deploy -- --dry-run --outdir .wrangler/deploy-dry-run",
  );
  const migration = step("Apply remote D1 migrations");
  assert.match(migration.run ?? "", /npm run db:migrate:remote/);
  assert.match(migration.run ?? "", /wrangler d1 execute crawl-remote/);
  assert.match(migration.run ?? "", /--remote/);
  assert.match(migration.run ?? "", /--json/);
  assert.match(
    migration.run ?? "",
    /select capability, migration_ready, cutover_enabled from remote_capability_fences/,
  );
  assert.match(migration.run ?? "", /capability = 'gitcrawl\.observation-order\.v1'/);
  assert.match(migration.run ?? "", /executions\.length !== 1/);
  assert.match(migration.run ?? "", /rows\.length !== 1/);
  assert.match(migration.run ?? "", /Number\(fence\?\.migration_ready\) !== 1/);
  assert.match(migration.run ?? "", /Number\(fence\?\.cutover_enabled\) !== 0/);
  assert.equal(
    migration.env?.FENCE_RESPONSE,
    "${{ runner.temp }}/crawl-remote-observation-fence.json",
  );
  assert.match(step("Deploy Worker").run ?? "", /npm run deploy -- --message/);
});

test("Cloudflare credential is step-scoped and never copied", () => {
  assert.equal(deploy.env.CLOUDFLARE_API_TOKEN, undefined);

  const credentialSteps = steps.filter(
    (candidate) => candidate.env?.CLOUDFLARE_API_TOKEN !== undefined,
  );
  assert.deepEqual(
    credentialSteps.map((candidate) => candidate.name),
    ["Apply remote D1 migrations", "Deploy Worker"],
  );
  for (const candidate of credentialSteps) {
    assert.equal(
      candidate.env?.CLOUDFLARE_API_TOKEN,
      "${{ secrets.OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN }}",
    );
  }

  assert.doesNotMatch(source, /gh secret set|CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.[^O]/);
  assert.equal(source.match(/OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN/g)?.length, 2);
});

test("crawl-remote deployment proves health and contract after release", () => {
  const verify = step("Verify production endpoints");
  assert.match(verify.run ?? "", /\$PRODUCTION_URL\/health/);
  assert.match(verify.run ?? "", /\$PRODUCTION_URL\/v1\/contract/);
  assert.match(verify.run ?? "", /health\.ok !== true/);
  assert.match(verify.run ?? "", /contract\.service !== 'crawl-remote'/);
  assert.match(verify.run ?? "", /contract\.protocol_version !== 'v1'/);
  assert.match(
    verify.run ?? "",
    /Gitcrawl observation ordering requires the D1 migration, explicit publisher capability, and operator cutover fence before it is advertised or activated\./,
  );
  assert.match(verify.run ?? "", /notes\.includes\(observationFenceNote\)/);
  assert.equal(verify.env?.CLOUDFLARE_API_TOKEN, undefined);
});
