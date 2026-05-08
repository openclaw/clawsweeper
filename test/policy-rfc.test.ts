import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectPolicyPatterns,
  runPolicyRfc,
  scorePolicyPatterns,
  synthesizePolicyProposal,
} from "../dist/policy-rfc/index.js";

function writeRecord(
  root: string,
  item: number,
  body: string,
  section: "items" | "closed" = "items",
): void {
  const dir = join(root, "openclaw-openclaw", section);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${item}.md`), body);
}

function withPolicyFixture(run: (recordsRoot: string) => void): void {
  const recordsRoot = mkdtempSync(join(tmpdir(), "clawsweeper-policy-rfc-"));
  try {
    writeRecord(
      recordsRoot,
      1,
      `---
labels: ["clawsweeper:autofix", "bug"]
reviewed_at: 2026-05-01T00:00:00.000Z
close_reason: implemented_on_main
---
<!-- clawsweeper-verdict:needs-changes repo="openclaw/openclaw" -->
Automerge repair cause: flaky validation
Conflict type: generated lockfile
<!-- clawsweeper-repair:validation-fix -->
Result: applied
`,
    );
    writeRecord(
      recordsRoot,
      2,
      `---
labels: ["bug"]
reviewed_at: 2026-05-02T00:00:00.000Z
---
<!-- clawsweeper-verdict:needs-changes repo="openclaw/openclaw" -->
<!-- clawsweeper-repair:validation-fix -->
Result: applied
`,
    );
    writeRecord(
      recordsRoot,
      3,
      `---
labels: ["bug"]
reviewed_at: 2026-05-03T00:00:00.000Z
---
<!-- clawsweeper-verdict:needs-changes repo="openclaw/openclaw" -->
<!-- clawsweeper-repair:validation-fix -->
Result: applied
`,
    );
    writeRecord(recordsRoot, 4, "{ this is malformed but should not crash");
    run(recordsRoot);
  } finally {
    rmSync(recordsRoot, { recursive: true, force: true });
  }
}

function collectFixture(recordsRoot: string) {
  return collectPolicyPatterns({
    recordsRoot,
    targetRepo: "openclaw/openclaw",
  });
}

test("collector extracts repeated patterns from durable records", () => {
  withPolicyFixture((recordsRoot) => {
    const observations = collectFixture(recordsRoot);

    assert.ok(
      observations.some(
        (item) => item.patternType === "repair_marker" && item.value === "validation-fix",
      ),
    );
    assert.ok(
      observations.some(
        (item) => item.patternType === "review_verdict" && item.value === "needs-changes",
      ),
    );
    assert.ok(
      observations.some(
        (item) => item.patternType === "safe_close_reason" && item.value === "implemented_on_main",
      ),
    );
  });
});

test("collector tolerates missing and malformed records", () => {
  withPolicyFixture((recordsRoot) => {
    assert.doesNotThrow(() => collectFixture(recordsRoot));
    assert.deepEqual(
      collectPolicyPatterns({
        recordsRoot: join(recordsRoot, "does-not-exist"),
        targetRepo: "openclaw/openclaw",
      }),
      [],
    );
  });
});

test("collector preserves item numbers for archived closed records", () => {
  const recordsRoot = mkdtempSync(join(tmpdir(), "clawsweeper-policy-rfc-"));
  try {
    writeRecord(
      recordsRoot,
      42,
      `---
labels: ["bug"]
reviewed_at: 2026-05-05T00:00:00.000Z
---
<!-- clawsweeper-repair:validation-fix -->
`,
      "closed",
    );

    assert.ok(
      collectFixture(recordsRoot).some(
        (item) =>
          item.patternType === "repair_marker" &&
          item.value === "validation-fix" &&
          item.item === "#42" &&
          item.sourceRecord === "records/openclaw-openclaw/closed/42.md",
      ),
    );
  } finally {
    rmSync(recordsRoot, { recursive: true, force: true });
  }
});

test("scorer rejects low-frequency patterns", () => {
  withPolicyFixture((recordsRoot) => {
    const rejected = scorePolicyPatterns(collectFixture(recordsRoot), {
      minOccurrences: 4,
      now: new Date("2026-05-04T00:00:00.000Z"),
    });

    assert.equal(
      rejected.some((item) => item.patternType === "repair_marker"),
      false,
    );
  });
});

test("scorer accepts patterns above the configured threshold", () => {
  withPolicyFixture((recordsRoot) => {
    const accepted = scorePolicyPatterns(collectFixture(recordsRoot), {
      minOccurrences: 3,
      now: new Date("2026-05-04T00:00:00.000Z"),
    });
    const repairPattern = accepted.find((item) => item.patternType === "repair_marker");

    assert.ok(repairPattern);
    assert.equal(repairPattern.occurrenceCount, 3);
    assert.equal(repairPattern.distinctItems.length, 3);
    assert.equal(repairPattern.successfulOutcomes, 3);
  });
});

test("scorer default reference date is derived from evidence, not wall clock", () => {
  const observations = [1, 2, 3].map((item) => ({
    patternType: "repair_marker" as const,
    value: "old-pattern",
    repo: "openclaw/openclaw",
    item: `#${item}`,
    sourceRecord: `records/openclaw-openclaw/items/${item}.md`,
    observedAt: "2026-01-01T00:00:00.000Z",
    successfulOutcome: true,
  }));

  assert.deepEqual(
    scorePolicyPatterns(observations, { minOccurrences: 3 }),
    scorePolicyPatterns(observations, {
      minOccurrences: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    }),
  );
});

test("scorer default reference date preserves recency differences across patterns", () => {
  const observations = [
    ...[1, 2, 3].map((item) => ({
      patternType: "repair_marker" as const,
      value: "old-pattern",
      repo: "openclaw/openclaw",
      item: `#${item}`,
      sourceRecord: `records/openclaw-openclaw/items/${item}.md`,
      observedAt: "2026-01-01T00:00:00.000Z",
      successfulOutcome: true,
    })),
    ...[4, 5, 6].map((item) => ({
      patternType: "repair_marker" as const,
      value: "recent-pattern",
      repo: "openclaw/openclaw",
      item: `#${item}`,
      sourceRecord: `records/openclaw-openclaw/items/${item}.md`,
      observedAt: "2026-05-01T00:00:00.000Z",
      successfulOutcome: true,
    })),
  ];

  const scored = scorePolicyPatterns(observations, { minOccurrences: 3 });
  const oldPattern = scored.find((item) => item.value === "old-pattern");
  const recentPattern = scored.find((item) => item.value === "recent-pattern");

  assert.ok(oldPattern);
  assert.ok(recentPattern);
  assert.ok(recentPattern.confidenceScore > oldPattern.confidenceScore);
  assert.deepEqual(
    scored,
    scorePolicyPatterns(observations, {
      minOccurrences: 3,
      now: new Date("2026-05-01T00:00:00.000Z"),
    }),
  );
});

test("synthesizer produces stable markdown and proposal JSON", () => {
  withPolicyFixture((recordsRoot) => {
    const accepted = scorePolicyPatterns(collectFixture(recordsRoot), {
      minOccurrences: 3,
      now: new Date("2026-05-04T00:00:00.000Z"),
    });
    const repairPattern = accepted.find((item) => item.patternType === "repair_marker");
    assert.ok(repairPattern);

    const proposal = synthesizePolicyProposal(repairPattern, {
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    assert.match(proposal.markdown, /^# Policy RFC: Repair Marker - validation-fix/);
    assert.match(proposal.markdown, /Status: Draft/);
    assert.match(proposal.markdown, /## Safety Constraints/);
    assert.equal(proposal.json.status, "Draft");
    assert.equal(proposal.json.pattern_type, "repair_marker");
    assert.equal(proposal.json.evidence_items.length, 3);
    assert.equal(proposal.json.created_at, "2026-05-04T00:00:00.000Z");
  });
});

test("synthesizer defaults created_at to latest evidence timestamp", () => {
  withPolicyFixture((recordsRoot) => {
    const accepted = scorePolicyPatterns(collectFixture(recordsRoot), {
      minOccurrences: 3,
    });
    const repairPattern = accepted.find((item) => item.patternType === "repair_marker");
    assert.ok(repairPattern);

    const first = synthesizePolicyProposal(repairPattern);
    const second = synthesizePolicyProposal(repairPattern);

    assert.equal(first.json.created_at, "2026-05-03T00:00:00.000Z");
    assert.equal(first.markdown, second.markdown);
    assert.deepEqual(first.json, second.json);
  });
});

test("runPolicyRfc removes stale generated proposal files before writing current output", () => {
  withPolicyFixture((recordsRoot) => {
    const outputRoot = mkdtempSync(join(tmpdir(), "clawsweeper-policy-rfc-output-"));
    try {
      const first = runPolicyRfc({
        recordsRoot,
        outputRoot,
        targetRepo: "openclaw/openclaw",
        minOccurrences: 3,
      });
      const generatedFiles = readdirSync(first.outputDir).filter(
        (name) => name.endsWith(".md") || name.endsWith(".json"),
      );
      assert.ok(generatedFiles.length > 0);

      writeFileSync(join(first.outputDir, "policy-rfc-stale-deadbeef.md"), "stale\n");
      writeFileSync(join(first.outputDir, "policy-rfc-stale-deadbeef.json"), "{}\n");
      writeFileSync(join(first.outputDir, "operator-note.txt"), "preserve me\n");

      const second = runPolicyRfc({
        recordsRoot,
        outputRoot,
        targetRepo: "openclaw/openclaw",
        minOccurrences: 4,
      });

      assert.equal(second.proposals, 0);
      assert.deepEqual(readdirSync(second.outputDir).sort(), ["operator-note.txt"]);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
