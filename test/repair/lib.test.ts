import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedRepairOwners,
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  hasSecuritySignalText,
  isAllowedRepairOwner,
  parseArgs,
  parseSimpleYaml,
  renderPrompt,
  validateJob,
} from "../../dist/repair/lib.js";

test("parseArgs ignores package-manager double dash separators", () => {
  assert.deepEqual(parseArgs(["--", "jobs/openclaw/inbox/example.md"]), {
    _: ["jobs/openclaw/inbox/example.md"],
  });
  assert.deepEqual(parseArgs(["--mode", "autonomous", "--", "job.md", "--latest"]), {
    _: ["job.md"],
    latest: true,
    mode: "autonomous",
  });
});

test("renderPrompt loads tracked repair prompt templates", () => {
  const prompt = renderPrompt(
    {
      raw: "---\nrepo: openclaw/clawsweeper\ncluster_id: smoke\nmode: autonomous\nrefs:\n  - 1\n---\nRepair smoke.",
      frontmatter: {
        repo: "openclaw/clawsweeper",
        cluster_id: "smoke",
        mode: "autonomous",
        refs: [1],
      },
    },
    "autonomous",
  );
  assert.match(prompt, /## Job file/);
  assert.match(prompt, /Repair smoke\./);
});

test("validateJob rejects unknown canonical job intents", () => {
  const frontmatter = parseSimpleYaml(`repo: openclaw/openclaw
cluster_id: smoke
mode: autonomous
job_intent: surprise
allowed_actions:
  - comment
candidates:
  - "#1"
`);
  assert.deepEqual(validateJob({ frontmatter }), ["unsupported job_intent: surprise"]);
});

test("security signal detection ignores non-security advisory wording", () => {
  assert.equal(
    hasSecuritySignalText(
      "pnpm lint:tmp:dynamic-import-warts (advisory-only; no new run-loop.ts advisory)",
    ),
    false,
  );
});

test("security signal detection keeps explicit security advisory wording", () => {
  assert.equal(hasSecuritySignalText("security advisory triage for GHSA-1234-5678-abcd"), true);
  assert.equal(hasSecuritySignalText("CVE-2026-12345 is routed to the security lane"), true);
  assert.equal(hasSecuritySignalText({ name: "security:sensitive" }), true);
});

test("deterministic security signals ignore prose credential wording", () => {
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: [
        "Current main's Codex credential reader types expose codexHome, platform, and execSync, but no allowKeychainPrompt.",
      ],
    }),
    false,
  );
});

test("deterministic security signals accept labels and structured ClawSweeper markers", () => {
  assert.equal(hasDeterministicSecuritySignal({ labels: ["security:sensitive"] }), true);
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: ["<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->"],
    }),
    true,
  );
});

test("repair owner policy accepts a comma or whitespace separated owner list", () => {
  assert.deepEqual(allowedRepairOwners("openclaw, steipete"), ["openclaw", "steipete"]);
  assert.deepEqual(allowedRepairOwners("  OpenClaw   steipete\n"), ["openclaw", "steipete"]);
  assert.deepEqual(allowedRepairOwners(undefined), []);

  assert.equal(isAllowedRepairOwner("openclaw/openclaw", "openclaw,steipete"), true);
  assert.equal(isAllowedRepairOwner("steipete/oracle", "openclaw,steipete"), true);
  assert.equal(isAllowedRepairOwner("Steipete/oracle", "openclaw,steipete"), true);
  assert.equal(isAllowedRepairOwner("evil/oracle", "openclaw,steipete"), false);
  // An empty policy keeps the historical fail-open behavior of assertAllowedOwner.
  assert.equal(isAllowedRepairOwner("anyone/repo", undefined), true);

  assertAllowedOwner("steipete/oracle", "openclaw,steipete");
  assert.throws(
    () => assertAllowedOwner("evil/oracle", "openclaw,steipete"),
    /repo owner evil does not match CLAWSWEEPER_ALLOWED_OWNER=openclaw,steipete/,
  );
});
