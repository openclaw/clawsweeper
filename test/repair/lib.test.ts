import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  hasSecuritySignalText,
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

test("allowed owner guard accepts comma-separated owner lists", () => {
  assert.doesNotThrow(() =>
    assertAllowedOwner("valkyriweb/clawsweeper", "bermont-digital, valkyriweb"),
  );
  assert.throws(
    () => assertAllowedOwner("CLIP-SA/core-ai", "bermont-digital,valkyriweb"),
    /repo owner CLIP-SA does not match CLAWSWEEPER_ALLOWED_OWNER=/,
  );
});

test("allowed owner guard matches owners case-insensitively", () => {
  // GitHub repo identifiers are case-insensitive. Reviewer-side normalization
  // can lowercase the slug in the frontmatter while the var keeps canonical
  // casing; the guard must still accept the match.
  assert.doesNotThrow(() =>
    assertAllowedOwner("clip-sa/core-ai", "bermont-digital,valkyriweb,CLIP-SA"),
  );
  assert.doesNotThrow(() =>
    assertAllowedOwner("CLIP-SA/core-ai", "bermont-digital,valkyriweb,clip-sa"),
  );
  assert.doesNotThrow(() =>
    assertAllowedOwner("Valkyriweb/clawsweeper", "bermont-digital,VALKYRIWEB"),
  );
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
