import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import { serverStrictBaseBindingBlock } from "../../dist/repair/strict-base-binding.js";

const APP_ID = 3306130;
const APP_SLUG = "openclaw-clawsweeper";
const INSTALLATION_ID = 987654;

test("strict base binding accepts an enforced non-bypass ruleset", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: { bypass_actors: [] },
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
});

test("strict base binding uses documented action outputs without an installation endpoint", () => {
  const requestedEndpoints: string[] = [];
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: { bypass_actors: [] },
    requestedEndpoints,
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
  assert.doesNotMatch(requestedEndpoints.join("\n"), /(?:^|\/)installation(?:\/|$)/m);
});

test("strict base binding rejects a ruleset that exempts the merge app", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: {
      bypass_actors: [{ actor_type: "Integration", actor_id: APP_ID, bypass_mode: "always" }],
    },
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: merge credential bypasses the strict base-binding ruleset",
  );
});

test("strict base binding accepts classic strict branch protection", () => {
  const github = fakeGithub({
    rules: [],
    protection: {
      required_status_checks: {
        strict: true,
        contexts: ["ci"],
      },
    },
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/example",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "",
  );
});

test("strict base binding fails closed without an installation identity output", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ installationId: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects rulesets whose bypass actors are hidden", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: {},
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: github,
    }),
    "automerge disabled: unable to verify server-enforced strict base binding",
  );
});

test("strict base binding rejects a missing ruleset verifier credential", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: undefined,
    }),
    "automerge disabled: ruleset verifier credential is unavailable",
  );
});

test("strict base binding rejects a verifier credential from another installation", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyInstallationId: INSTALLATION_ID + 1 }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding rejects a verifier credential from another App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyAppSlug: "other-repair-app" }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding requires the authenticated App identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ authenticatedAppId: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding requires the authenticated App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ appSlug: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects a verifier credential from another App id", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyAppId: APP_ID + 1 }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding rejects a mutation credential from another App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ appSlug: "other-repair-app" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects a missing configured App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ configuredAppSlug: "" }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects missing verifier identity outputs", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ policyInstallationId: "" }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding fails closed for non-repository rulesets without fetching them", () => {
  for (const sourceType of ["Organization", "Enterprise"] as const) {
    const requestedEndpoints: string[] = [];
    assert.equal(
      serverStrictBaseBindingBlock({
        repo: "openclaw/openclaw",
        baseBranch: "main",
        ...appIdentity(),
        policyReadJson: fakeGithub({
          rules: [strictRulesetRule(sourceType)],
          requestedEndpoints,
        }),
      }),
      "automerge disabled: unable to verify server-enforced strict base binding",
    );
    assert.doesNotMatch(requestedEndpoints.join("\n"), /^(?:orgs|enterprises)\//m);
    assert.doesNotMatch(requestedEndpoints.join("\n"), /rulesets\/18588237/);
  }
});

test("all repair merge owners invoke the shared strict base guard before merge", () => {
  for (const [file, functionName, mergeCall] of [
    ["src/repair/apply-result.ts", "function applyMergeAction(", "ghWithRetry(mergeArgs)"],
    ["src/repair/comment-router.ts", "function executeAutomerge(", "const result = ghSpawn("],
    ["src/repair/post-flight.ts", "function finalizeFixPr(", "ghWithRetry(mergeArgs)"],
  ] as const) {
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf(functionName);
    const end = source.indexOf("\nfunction ", start + functionName.length);
    const owner = source.slice(start, end < 0 ? undefined : end);
    const guard = owner.indexOf("serverStrictBaseBindingBlock({");
    const configuredSlug = owner.indexOf("configuredAppSlug: process.env.CLAWSWEEPER_APP_SLUG");
    const appIdentity = owner.indexOf(
      "authenticatedAppId: process.env.CLAWSWEEPER_AUTHENTICATED_APP_ID",
    );
    const appSlug = owner.indexOf("appSlug: process.env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG");
    const installationId = owner.indexOf(
      "installationId: process.env.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID",
    );
    const policyAppId = owner.indexOf("policyAppId: process.env.CLAWSWEEPER_RULESET_APP_ID");
    const policySlug = owner.indexOf("policyAppSlug: process.env.CLAWSWEEPER_RULESET_APP_SLUG");
    const policyInstallationId = owner.indexOf(
      "policyInstallationId: process.env.CLAWSWEEPER_RULESET_INSTALLATION_ID",
    );
    const policyReader = owner.indexOf("policyReadJson: rulesetPolicyReader()");
    const merge = owner.indexOf(mergeCall);
    assert.ok(guard >= 0, `${file} is missing the strict base guard`);
    assert.ok(configuredSlug > guard, `${file} does not bind the configured App slug`);
    assert.ok(appIdentity > configuredSlug, `${file} does not bind the authenticated App id`);
    assert.ok(appSlug > appIdentity, `${file} does not bind the authenticated App slug`);
    assert.ok(installationId > appSlug, `${file} does not bind the mutation installation`);
    assert.ok(policyAppId > installationId, `${file} does not bind the verifier App id`);
    assert.ok(policySlug > policyAppId, `${file} does not bind the verifier App slug`);
    assert.ok(policyInstallationId > policySlug, `${file} does not bind the verifier installation`);
    assert.ok(
      policyReader > policyInstallationId,
      `${file} does not use the isolated ruleset verifier`,
    );
    assert.ok(merge > guard, `${file} does not guard the merge call`);
  }
});

test("merge-capable workflows isolate verifier credentials in trusted jobs", () => {
  for (const file of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
  ]) {
    const workflow = readWorkflow(file);
    let mergeStepCount = 0;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const mergeSteps = steps.filter((step) =>
        /pnpm run repair:(?:apply-result|post-flight|comment-router)\b/.test(step.run ?? ""),
      );
      if (mergeSteps.length === 0) continue;
      mergeStepCount += mergeSteps.length;

      for (const step of mergeSteps) {
        const tokenProducer = workflowOutputStep(step.env?.GH_TOKEN, "token");
        const slugProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_AUTHENTICATED_APP_SLUG,
          "app-slug",
        );
        const installationProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID,
          "installation-id",
        );
        const verifierProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_GH_TOKEN,
          "token",
        );
        const verifierSlugProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_APP_SLUG,
          "app-slug",
        );
        const verifierInstallationProducer = workflowOutputStep(
          step.env?.CLAWSWEEPER_RULESET_INSTALLATION_ID,
          "installation-id",
        );
        assert.ok(tokenProducer, `${file}:${jobName} merge step is missing an App token output`);
        assert.equal(
          slugProducer,
          tokenProducer,
          `${file}:${jobName} merge step does not bind the authenticated slug to its token`,
        );
        assert.equal(
          installationProducer,
          tokenProducer,
          `${file}:${jobName} merge step does not bind the installation to its token`,
        );
        assert.ok(
          verifierProducer,
          `${file}:${jobName} merge step is missing a ruleset verifier token`,
        );
        assert.equal(
          verifierSlugProducer,
          verifierProducer,
          `${file}:${jobName} verifier slug is not bound to its token`,
        );
        assert.equal(
          verifierInstallationProducer,
          verifierProducer,
          `${file}:${jobName} verifier installation is not bound to its token`,
        );
        assert.notEqual(
          verifierProducer,
          tokenProducer,
          `${file}:${jobName} merge step reuses its mutation credential for ruleset verification`,
        );
        assert.match(
          String(step.env?.CLAWSWEEPER_AUTHENTICATED_APP_ID ?? ""),
          /steps\.[^.]+\.outputs\.app_id/,
          `${file}:${jobName} merge step does not bind the authenticated App id`,
        );
        assert.match(
          String(step.env?.CLAWSWEEPER_RULESET_APP_ID ?? ""),
          /steps\.[^.]+\.outputs\.app_id/,
          `${file}:${jobName} merge step does not bind the verifier App id`,
        );

        const mutationStep = steps.find((candidate) => candidate.id === tokenProducer);
        const verifierStep = steps.find((candidate) => candidate.id === verifierProducer);
        assert.ok(
          mutationStep,
          `${file}:${jobName} mutation token is produced outside the merge job`,
        );
        assert.ok(
          verifierStep,
          `${file}:${jobName} verifier token is produced outside the merge job`,
        );
        assert.equal(
          mutationStep.with?.["permission-administration"],
          undefined,
          `${file}:${jobName} mutation credential still carries administration access`,
        );
        assert.equal(
          verifierStep.with?.["permission-administration"],
          "write",
          `${file}:${jobName} ruleset verifier cannot observe bypass actors`,
        );
        assertRepoScoped(file, jobName, "mutation", mutationStep);
        assertRepoScoped(file, jobName, "verifier", verifierStep);
        assert.equal(
          verifierStep.with?.owner,
          mutationStep.with?.owner,
          `${file}:${jobName} verifier owner scope differs from mutation scope`,
        );
        assert.equal(
          verifierStep.with?.repositories,
          mutationStep.with?.repositories,
          `${file}:${jobName} verifier repository scope differs from mutation scope`,
        );
      }

      const trustedJobCommands = steps
        .map((step) => `${step.uses ?? ""}\n${step.run ?? ""}`)
        .join("\n");
      assert.doesNotMatch(
        trustedJobCommands,
        /(?:^|\/)setup-codex\b/,
        `${file}:${jobName} exposes the verifier to Codex setup`,
      );
      assert.doesNotMatch(
        trustedJobCommands,
        /pnpm run (?:review\b|repair:review-results\b)/,
        `${file}:${jobName} exposes the verifier to review commands`,
      );
      const executeFixCommands = steps
        .map((step) => step.run ?? "")
        .filter((run) => /pnpm run repair:execute-fix\b/.test(run));
      for (const command of executeFixCommands) {
        assert.match(
          command,
          /--publish-report-only\b/,
          `${file}:${jobName} exposes the verifier to non-report repair execution`,
        );
        assert.doesNotMatch(
          command,
          /--defer-publication\b/,
          `${file}:${jobName} exposes the verifier to deferred repair execution`,
        );
      }
    }
    if (file.endsWith("repair-cluster-worker.yml")) {
      const reportCommands = workflow.jobs?.report?.steps
        ?.map((step) => step.run ?? "")
        .filter((run) => /pnpm run repair:execute-fix\b/.test(run));
      assert.equal(reportCommands?.length, 0);
      assert.match(fs.readFileSync(file, "utf8"), /repair:execution-handoff -- publish/);
    }
    assert.ok(mergeStepCount > 0, `${file} has no merge-capable repair steps`);
  }
});

test("repair execution and validation cannot mutate GitHub before trusted publication", () => {
  const file = ".github/workflows/repair-cluster-worker.yml";
  const source = fs.readFileSync(file, "utf8");
  const workflow = readWorkflow(file);
  const execute = workflow.jobs?.execute;
  const validate = workflow.jobs?.validate;
  const report = workflow.jobs?.report;
  const mutate = workflow.jobs?.mutate;
  assert.ok(execute && validate && report && mutate);

  const executeText = JSON.stringify(execute);
  const validateText = JSON.stringify(validate);
  const reportText = JSON.stringify(report);
  assert.doesNotMatch(executeText, /create-github-app-token|create-state-token|setup-state/);
  assert.doesNotMatch(validateText, /create-github-app-token|create-state-token|setup-state/);
  assert.doesNotMatch(
    `${executeText}\n${validateText}`,
    /\b(?:git push|gh pr create|gh pr merge|gh issue close|gh api .*comments)\b/,
  );
  assert.match(executeText, /"GH_TOKEN":""/);
  assert.match(executeText, /"GITHUB_TOKEN":""/);
  assert.match(validateText, /"GH_TOKEN":""/);
  assert.match(validateText, /"GITHUB_TOKEN":""/);
  assert.match(executeText, /--prepare-publication/);
  assert.match(String(mutate.if ?? ""), /needs\.execute\.result == 'success'/);
  assert.match(
    String(mutate.if ?? ""),
    /needs\.execute\.outputs\.execute_fix_outcome == 'success'/,
  );
  assert.match(String(mutate.if ?? ""), /needs\.validate\.result == 'success'/);
  assert.match(String(report.if ?? ""), /always\(\)/);
  assert.match(reportText, /count-requeue-required/);
  assert.match(reportText, /repair:requeue/);
  assert.doesNotMatch(reportText, /target_post_flight_token|permission-pull-requests/);
  assert.doesNotMatch(JSON.stringify(mutate), /repair:apply-result|repair:tag-clawsweeper/);
  assert.match(JSON.stringify(mutate), /npm_config_ignore_scripts/);
  assert.match(source, /Publish execution-disabled terminal status/);
  assert.match(source, /--dashboard-only/);
});

test("exact router dispatch concurrency is item-specific and cannot replace another item", () => {
  const source = fs.readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  const workflow = readWorkflow(".github/workflows/repair-comment-router.yml");
  const group = String(workflow.concurrency?.group ?? "");

  assert.match(group, /github\.event\.client_payload\.comment_id/);
  assert.match(group, /github\.event\.client_payload\.item_number/);
  assert.match(group, /inputs\.item_numbers/);
  assert.equal(workflow.concurrency?.["cancel-in-progress"], false);
  assert.match(
    source,
    /format\('repair-comment-router-\{0\}-item-\{1\}'.*github\.event\.client_payload\.item_number/,
  );
});

test("workflow App identity is derived from authenticated tokens, never a configured numeric id", () => {
  for (const file of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /CLAWSWEEPER_APP_ID/);
    assert.match(source, /gh api "apps\/\$APP_SLUG" --jq '\.id'/);
    assert.doesNotMatch(source, new RegExp(`gh api (?:["'])?installation(?:["'/\\s]|$)`));
  }
});

test("event review delegates routing without verifier or local router access", () => {
  const workflow = fs.readFileSync(".github/workflows/sweep.yml", "utf8");
  const eventStart = workflow.indexOf("\n  event-review-apply:");
  const eventEnd = workflow.indexOf("\n  target-fanout:", eventStart);
  const eventJob = workflow.slice(eventStart, eventEnd);

  assert.ok(eventStart > 0 && eventEnd > eventStart);
  assert.doesNotMatch(eventJob, /ruleset-verifier-token/);
  assert.doesNotMatch(eventJob, /CLAWSWEEPER_RULESET_GH_TOKEN/);
  assert.doesNotMatch(eventJob, /permission-administration/);
  assert.doesNotMatch(eventJob, /pnpm run repair:comment-router\b/);
  assert.match(eventJob, /gh workflow run repair-comment-router\.yml/);
  assert.match(eventJob, /-f item_numbers="\$ITEM_NUMBER"/);
});

test("commit finding intake is merge-disabled and carries no verifier credential", () => {
  const file = ".github/workflows/repair-commit-finding-intake.yml";
  const source = fs.readFileSync(file, "utf8");
  const workflow = readWorkflow(file);

  assert.equal(workflow.env?.CLAWSWEEPER_ALLOW_MERGE, "0");
  assert.doesNotMatch(source, /ruleset-verifier-token/);
  assert.doesNotMatch(source, /CLAWSWEEPER_RULESET_GH_TOKEN/);
  assert.doesNotMatch(source, /permission-administration/);
});

function strictRulesetRule(
  sourceType: "Repository" | "Organization" | "Enterprise" = "Repository",
) {
  return {
    type: "required_status_checks",
    ruleset_id: 18588237,
    ruleset_source: sourceType === "Repository" ? "openclaw/openclaw" : "openclaw",
    ruleset_source_type: sourceType,
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "required-ci/exact-merge" }],
    },
  };
}

function appIdentity(
  overrides: Partial<{
    configuredAppSlug: string;
    authenticatedAppId: string | number;
    appSlug: string;
    installationId: string | number;
    policyAppId: string | number;
    policyAppSlug: string;
    policyInstallationId: string | number;
  }> = {},
) {
  return {
    configuredAppSlug: APP_SLUG,
    authenticatedAppId: APP_ID,
    appSlug: APP_SLUG,
    installationId: INSTALLATION_ID,
    policyAppId: APP_ID,
    policyAppSlug: APP_SLUG,
    policyInstallationId: INSTALLATION_ID,
    ...overrides,
  };
}

type WorkflowStep = {
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
};

type Workflow = {
  env?: Record<string, string>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<string, { if?: string; steps?: WorkflowStep[] }>;
};

function readWorkflow(file: string): Workflow {
  return parse(fs.readFileSync(file, "utf8")) as Workflow;
}

function assertRepoScoped(
  file: string,
  jobName: string,
  credential: string,
  step: WorkflowStep,
): void {
  assert.ok(step.with?.owner, `${file}:${jobName} ${credential} token has no owner scope`);
  assert.ok(
    step.with?.repositories,
    `${file}:${jobName} ${credential} token has no repository scope`,
  );
}

function workflowOutputStep(value: string | undefined, output: string): string | null {
  return (
    value?.match(new RegExp(`steps\\.([^.]+)\\.outputs\\.${output.replace("-", "\\-")}`))?.[1] ??
    null
  );
}

function fakeGithub({
  rules,
  ruleset = null,
  protection = { required_status_checks: null },
  requestedEndpoints,
}: {
  rules: unknown[];
  ruleset?: unknown;
  protection?: unknown;
  requestedEndpoints?: string[];
}) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (endpoint) requestedEndpoints?.push(endpoint);
    if (endpoint === "repos/openclaw/openclaw/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/example/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/openclaw/rulesets/18588237" && ruleset) return ruleset;
    if (endpoint?.endsWith("/branches/main/protection")) return protection;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}
