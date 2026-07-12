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

test("strict base binding requires the configured App identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ appId: "" }),
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
    const appIdentity = owner.indexOf("appId: process.env.CLAWSWEEPER_APP_ID");
    const configuredSlug = owner.indexOf("configuredAppSlug: process.env.CLAWSWEEPER_APP_SLUG");
    const appSlug = owner.indexOf("appSlug: process.env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG");
    const installationId = owner.indexOf(
      "installationId: process.env.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID",
    );
    const policySlug = owner.indexOf("policyAppSlug: process.env.CLAWSWEEPER_RULESET_APP_SLUG");
    const policyInstallationId = owner.indexOf(
      "policyInstallationId: process.env.CLAWSWEEPER_RULESET_INSTALLATION_ID",
    );
    const policyReader = owner.indexOf("policyReadJson: rulesetPolicyReader()");
    const merge = owner.indexOf(mergeCall);
    assert.ok(guard >= 0, `${file} is missing the strict base guard`);
    assert.ok(appIdentity > guard, `${file} does not bind the configured App identity`);
    assert.ok(configuredSlug > appIdentity, `${file} does not bind the configured App slug`);
    assert.ok(appSlug > configuredSlug, `${file} does not bind the authenticated App slug`);
    assert.ok(installationId > appSlug, `${file} does not bind the mutation installation`);
    assert.ok(policySlug > installationId, `${file} does not bind the verifier App slug`);
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
      assert.equal(reportCommands?.length, 1);
      assert.match(reportCommands?.[0] ?? "", /--publish-report-only\b/);
    }
    assert.ok(mergeStepCount > 0, `${file} has no merge-capable repair steps`);
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
    appId: string | number;
    configuredAppSlug: string;
    appSlug: string;
    installationId: string | number;
    policyAppSlug: string;
    policyInstallationId: string | number;
  }> = {},
) {
  return {
    appId: APP_ID,
    configuredAppSlug: APP_SLUG,
    appSlug: APP_SLUG,
    installationId: INSTALLATION_ID,
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
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
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
