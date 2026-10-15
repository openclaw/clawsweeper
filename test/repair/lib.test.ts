import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../dist/repair/lib.js";
import { isSecurityLabel } from "../../dist/repair/security-signals.js";

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
    assert.equal(isSecurityLabel(label), true, label);
    assert.equal(isSecurityLabel(` ${label.toUpperCase()} `), true, label);
  }
  for (const label of [
    "security:sensitive",
    "security/internal",
    "type: security review",
    "insecurity",
    "security advisory triage for GHSA-1234-5678-abcd",
    "CVE-2026-12345 is routed to the security lane",
  ]) {
    assert.equal(isSecurityLabel(label), false, label);
  }
});
