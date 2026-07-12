import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import { serverStrictBaseBindingBlock } from "../../dist/repair/strict-base-binding.js";

const APP_ID = 3306130;
const APP_SLUG = "openclaw-clawsweeper";

test("strict base binding accepts an enforced non-bypass ruleset", () => {
  const github = fakeGithub({
    rules: [strictRulesetRule()],
    ruleset: { bypass_actors: [] },
  });
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: github,
      policyReadJson: github,
    }),
    "",
  );
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
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: github,
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
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: github,
      policyReadJson: github,
    }),
    "",
  );
});

test("strict base binding fails closed without an installation identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: () => {
        throw new Error("not an installation token");
      },
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
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: github,
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
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: ruleset verifier credential is unavailable",
  );
});

test("strict base binding binds the verifier to the configured App", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: fakeGithub({ rules: [], protection: {} }),
      policyReadJson: fakeGithub({
        rules: [],
        protection: {},
        resolvedAppId: APP_ID + 1,
      }),
    }),
    "automerge disabled: ruleset verifier credential is not the configured GitHub App installation",
  );
});

test("strict base binding requires the configured App identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: "",
      appSlug: APP_SLUG,
      readJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding requires the authenticated App slug", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      appSlug: "",
      readJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects an authenticated slug that resolves to another App", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      appSlug: APP_SLUG,
      readJson: fakeGithub({ rules: [], protection: {}, resolvedAppId: APP_ID + 1 }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
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
    const appSlug = owner.indexOf("appSlug: process.env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG");
    const policyReader = owner.indexOf("policyReadJson: rulesetPolicyReader()");
    const merge = owner.indexOf(mergeCall);
    assert.ok(guard >= 0, `${file} is missing the strict base guard`);
    assert.ok(appIdentity > guard, `${file} does not bind the configured App identity`);
    assert.ok(appSlug > appIdentity, `${file} does not bind the authenticated App slug`);
    assert.ok(policyReader > appSlug, `${file} does not use the isolated ruleset verifier`);
    assert.ok(merge > guard, `${file} does not guard the merge call`);
  }
});

test("merge-capable workflow steps bind the app slug to the token-producing step", () => {
  for (const file of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/sweep.yml",
  ]) {
    const workflow = parse(fs.readFileSync(file, "utf8")) as {
      jobs?: Record<
        string,
        {
          steps?: Array<{
            id?: string;
            env?: Record<string, string>;
            run?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const mergeSteps = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter((step) =>
        /pnpm run repair:(?:apply-result|post-flight|comment-router)\b/.test(step.run ?? ""),
      ),
    );
    assert.ok(mergeSteps.length > 0, `${file} has no merge-capable repair steps`);
    for (const step of mergeSteps) {
      const tokenProducer = workflowOutputStep(step.env?.GH_TOKEN, "token");
      const slugProducer = workflowOutputStep(
        step.env?.CLAWSWEEPER_AUTHENTICATED_APP_SLUG,
        "app-slug",
      );
      const verifierProducer = workflowOutputStep(step.env?.CLAWSWEEPER_RULESET_GH_TOKEN, "token");
      assert.ok(tokenProducer, `${file} merge step is missing an App token output`);
      assert.equal(
        slugProducer,
        tokenProducer,
        `${file} merge step does not bind the authenticated slug to its token`,
      );
      assert.ok(verifierProducer, `${file} merge step is missing a ruleset verifier token`);
      assert.notEqual(
        verifierProducer,
        tokenProducer,
        `${file} merge step reuses its mutation credential for ruleset verification`,
      );
      const workflowSteps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
      const mutationStep = workflowSteps.find((candidate) => candidate.id === tokenProducer);
      assert.equal(
        mutationStep?.with?.["permission-administration"],
        undefined,
        `${file} mutation credential still carries administration access`,
      );
      const verifierStep = workflowSteps.find((candidate) => candidate.id === verifierProducer);
      assert.equal(
        verifierStep?.with?.["permission-administration"],
        "write",
        `${file} ruleset verifier cannot observe bypass actors`,
      );
    }
  }
});

function strictRulesetRule() {
  return {
    type: "required_status_checks",
    ruleset_id: 18588237,
    ruleset_source: "openclaw/openclaw",
    ruleset_source_type: "Repository",
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "required-ci/exact-merge" }],
    },
  };
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
  resolvedAppId = APP_ID,
}: {
  rules: unknown[];
  ruleset?: unknown;
  protection?: unknown;
  resolvedAppId?: number;
}) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (endpoint === "installation/repositories?per_page=1") {
      return { total_count: 1, repositories: [{ full_name: "openclaw/openclaw" }] };
    }
    if (endpoint === `apps/${APP_SLUG}`) {
      return { id: resolvedAppId, slug: APP_SLUG };
    }
    if (endpoint === "repos/openclaw/openclaw/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/example/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/openclaw/rulesets/18588237" && ruleset) return ruleset;
    if (endpoint?.endsWith("/branches/main/protection")) return protection;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}
