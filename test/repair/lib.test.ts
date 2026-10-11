import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../dist/repair/lib.js";
import { hasDeterministicSecuritySignal } from "../../dist/repair/security-signals.js";

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

test("security signals recognize only the seven exact owner labels", () => {
  const labels = [
    "security",
    "security-sensitive",
    "security sensitive",
    "type: security",
    "type:security",
    "kind: security",
    "kind:security",
  ];
  for (const label of labels) {
    assert.equal(hasDeterministicSecuritySignal({ labels: [label] }), true, label);
    assert.equal(
      hasDeterministicSecuritySignal({ labels: [{ name: ` ${label.toUpperCase()} ` }] }),
      true,
      label,
    );
  }
  for (const label of [
    "security:sensitive",
    "security/internal",
    "type: security review",
    "insecurity",
    "security advisory triage for GHSA-1234-5678-abcd",
    "CVE-2026-12345 is routed to the security lane",
  ]) {
    assert.equal(hasDeterministicSecuritySignal({ labels: [label] }), false, label);
    assert.equal(hasDeterministicSecuritySignal({ comments: [label] }), false, label);
  }
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
  assert.equal(hasDeterministicSecuritySignal({ labels: ["security-sensitive"] }), true);
  assert.equal(
    hasDeterministicSecuritySignal({
      comments: ["<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->"],
    }),
    true,
  );
  for (const comment of [
    "clawsweeper-security:security-sensitive item=123 sha=abc",
    "<!-- clawsweeper-security:security-not-a-label -->",
    "<!-- clawsweeper-security:security-sensitive",
  ]) {
    assert.equal(hasDeterministicSecuritySignal({ comments: [comment] }), false, comment);
  }
});
