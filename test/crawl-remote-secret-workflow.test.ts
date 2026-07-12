import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/sync-crawl-remote-deploy-secret.yml";
const source = readFileSync(workflowPath, "utf8");
const workflow = parse(source);

test("crawl-remote secret sync is manual, fixed-target, and privilege-minimal", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.ok(workflow.on.workflow_dispatch);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["confirmation"]);

  const sync = workflow.jobs.sync;
  assert.match(sync.if, /github\.actor == 'vincentkoc'/);
  assert.match(sync.if, /github\.actor_id == '25068'/);
  assert.match(sync.if, /inputs\.confirmation == 'sync crawl-remote production secret'/);
  assert.equal(sync.env.TARGET_REPOSITORY, "openclaw/crawl-remote");
  assert.equal(sync.env.TARGET_ENVIRONMENT, "production");
  assert.equal(sync["timeout-minutes"], 5);

  const tokenStep = sync.steps[0];
  assert.equal(
    tokenStep.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.equal(tokenStep.with.owner, "openclaw");
  assert.equal(tokenStep.with.repositories, "crawl-remote");
  assert.equal(tokenStep.with["permission-environments"], "write");
  assert.equal(tokenStep.with["permission-secrets"], undefined);
});

test("crawl-remote secret sync validates main and never prints the credential", () => {
  assert.match(source, /test "\$DISPATCH_REF" = "refs\/heads\/main"/);
  assert.match(source, /deployment-branch-policies/);
  assert.match(source, /grep -Fxq "main"/);
  assert.match(source, /printf '%s' "\$CLOUDFLARE_API_TOKEN" \|/);
  assert.match(source, /gh secret set CLOUDFLARE_API_TOKEN/);
  assert.match(source, /--repo "\$TARGET_REPOSITORY"/);
  assert.match(source, /--env "\$TARGET_ENVIRONMENT"/);
  assert.doesNotMatch(source, /echo "\$CLOUDFLARE_API_TOKEN"/);
});
