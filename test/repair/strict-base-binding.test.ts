import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { serverStrictBaseBindingBlock } from "../../dist/repair/strict-base-binding.js";

const APP_ID = 3306130;

test("strict base binding accepts an enforced non-bypass ruleset", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      readJson: fakeGithub({
        rules: [strictRulesetRule()],
        ruleset: { bypass_actors: [] },
      }),
    }),
    "",
  );
});

test("strict base binding rejects a ruleset that exempts the merge app", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      readJson: fakeGithub({
        rules: [strictRulesetRule()],
        ruleset: {
          bypass_actors: [{ actor_type: "Integration", actor_id: APP_ID, bypass_mode: "always" }],
        },
      }),
    }),
    "automerge disabled: merge credential bypasses the strict base-binding ruleset",
  );
});

test("strict base binding accepts classic strict branch protection", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/example",
      baseBranch: "main",
      appId: APP_ID,
      readJson: fakeGithub({
        rules: [],
        protection: {
          required_status_checks: {
            strict: true,
            contexts: ["ci"],
          },
        },
      }),
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
      readJson: () => {
        throw new Error("not an installation token");
      },
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("strict base binding rejects rulesets whose bypass actors are hidden", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: APP_ID,
      readJson: fakeGithub({
        rules: [strictRulesetRule()],
        ruleset: {},
      }),
    }),
    "automerge disabled: unable to verify server-enforced strict base binding",
  );
});

test("strict base binding requires the configured App identity", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      appId: "",
      readJson: fakeGithub({ rules: [], protection: {} }),
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
    const merge = owner.indexOf(mergeCall);
    assert.ok(guard >= 0, `${file} is missing the strict base guard`);
    assert.ok(appIdentity > guard, `${file} does not bind the configured App identity`);
    assert.ok(merge > guard, `${file} does not guard the merge call`);
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
      required_status_checks: [{ context: "clownfish/exact-merge" }],
    },
  };
}

function fakeGithub({
  rules,
  ruleset = null,
  protection = { required_status_checks: null },
}: {
  rules: unknown[];
  ruleset?: unknown;
  protection?: unknown;
}) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (endpoint === "installation/repositories?per_page=1") {
      return { total_count: 1, repositories: [{ full_name: "openclaw/openclaw" }] };
    }
    if (endpoint === "repos/openclaw/openclaw/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/example/rules/branches/main") return rules;
    if (endpoint === "repos/openclaw/openclaw/rulesets/18588237" && ruleset) return ruleset;
    if (endpoint?.endsWith("/branches/main/protection")) return protection;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}
