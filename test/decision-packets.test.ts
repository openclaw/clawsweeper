import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildDecisionPacketFromReport,
  emptyMaintainerDecision,
  maintainerDecisionBlocksClose,
  maintainerDecisionFromReport,
  parseMaintainerDecision,
  syncDecisionPacketRecord,
} from "../dist/decision-packets.js";
import { tmpPrefix } from "./helpers.ts";

const productDecision = {
  required: true,
  kind: "product_direction",
  question: "Should config.patch replace redacted array entries or preserve them?",
  rationale:
    "Both behaviors are coherent, but choosing one defines the public configuration contract.",
  options: [
    {
      title: "Preserve redacted entries",
      body: "Merge visible values into the stored array without deleting redacted entries.",
      recommended: true,
    },
    {
      title: "Replace the array",
      body: "Treat the supplied array as authoritative and document the destructive behavior.",
      recommended: false,
    },
  ],
  likelyOwner: {
    person: "@config-owner",
    reason: "Recent history shows ownership of config.patch semantics.",
    confidence: "high",
  },
};

test("decision packets preserve the exact Codex-authored maintainer decision", () => {
  const report = decisionReport({
    number: 81234,
    repository: "openclaw/openclaw",
    type: "pull_request",
    title: JSON.stringify("config.patch redacted array write"),
    url: "https://github.com/openclaw/openclaw/pull/81234",
    labels: JSON.stringify(["clawsweeper:needs-product-decision", "P1"]),
    triage_priority: "P1",
    item_updated_at: "2026-06-20T00:00:00Z",
    current_item_updated_at: "2026-06-23T01:00:00Z",
    pull_head_sha: "abc123",
    main_sha: "main456",
    review_comment_url: "https://github.com/openclaw/openclaw/pull/81234#issuecomment-99",
    maintainer_decision: JSON.stringify(productDecision),
  });

  const packet = buildDecisionPacketFromReport(report, {
    generatedAt: "2026-06-23T12:00:00.000Z",
    reportPath: "records/openclaw-openclaw/items/81234.md",
  });

  assert.ok(packet);
  assert.equal(packet.lane, "product_direction");
  assert.equal(packet.priority, "P1");
  assert.equal(packet.question, productDecision.question);
  assert.equal(packet.rationale, productDecision.rationale);
  assert.deepEqual(packet.options, productDecision.options);
  assert.deepEqual(packet.recommendation, productDecision.options[0]);
  assert.deepEqual(packet.likelyOwner, productDecision.likelyOwner);
  assert.equal(packet.subject.headSha, "abc123");
  assert.equal(packet.subject.updatedAt, "2026-06-23T01:00:00Z");
  assert.equal(packet.updatedAt, "2026-06-23T01:00:00Z");
});

test("labels and report prose cannot invent a maintainer decision", () => {
  const report = `${decisionReport({
    labels: JSON.stringify([
      "clawsweeper:needs-product-decision",
      "clawsweeper:needs-security-review",
      "release-blocker",
    ]),
    requires_product_decision: "true",
  })}\n\n## Best Possible Solution\n\nAsk a maintainer what should happen next.\n`;

  assert.equal(buildDecisionPacketFromReport(report), null);
});

test("maintainer decision validation requires one recommendation and an exact owner", () => {
  assert.throws(
    () =>
      parseMaintainerDecision({
        ...productDecision,
        options: productDecision.options.map((option) => ({ ...option, recommended: false })),
      }),
    /exactly 1 recommended option/,
  );
  assert.throws(
    () =>
      parseMaintainerDecision({
        ...emptyMaintainerDecision(),
        question: "A label-derived question",
      }),
    /must be empty when no decision is required/,
  );
});

test("present malformed maintainer decisions fail closed", () => {
  const malformed = decisionReport({ maintainer_decision: "{" });
  assert.throws(() => maintainerDecisionFromReport(malformed), /must contain valid JSON/);
  assert.throws(
    () =>
      maintainerDecisionFromReport(
        decisionReport({ maintainer_decision: JSON.stringify({ required: true }) }),
      ),
    /maintainer_decision/,
  );
  assert.equal(maintainerDecisionBlocksClose(malformed), true);
  assert.equal(
    maintainerDecisionBlocksClose(
      decisionReport({ maintainer_decision: JSON.stringify(productDecision) }),
    ),
    true,
  );
  assert.equal(maintainerDecisionBlocksClose(decisionReport()), false);
});

test("decision packets prefer reconciled subject state", () => {
  const packet = buildDecisionPacketFromReport(
    decisionReport({
      action_taken: "kept_open",
      current_state: "closed",
      maintainer_decision: JSON.stringify(productDecision),
    }),
    { generatedAt: "2026-06-23T12:00:00.000Z" },
  );

  assert.ok(packet);
  assert.equal(packet.subject.state, "closed");
});

test("decision packet sync writes pointers and removes stale generated state", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const packetsDir = join(root, "records", "openclaw-clawsweeper", "decision-packets");
    const reportPath = join(root, "records", "openclaw-clawsweeper", "items", "321.md");
    const first = syncDecisionPacketRecord({
      markdown: decisionReport({ maintainer_decision: JSON.stringify(productDecision) }),
      reportPath,
      packetsDir,
      repoRoot: root,
      generatedAt: "2026-06-23T12:00:00.000Z",
      subjectState: "open",
    });

    assert.ok(first.packetPath);
    assert.ok(existsSync(first.packetPath));
    assert.match(
      first.markdown,
      /^decision_packet_path: records\/openclaw-clawsweeper\/decision-packets\/321\.json$/m,
    );
    assert.match(first.markdown, /^decision_packet_sha256: [a-f0-9]{64}$/m);
    const stored = JSON.parse(readFileSync(first.packetPath, "utf8"));
    assert.equal(stored.question, productDecision.question);

    const second = syncDecisionPacketRecord({
      markdown: first.markdown.replace(
        /^maintainer_decision: .*$/m,
        `maintainer_decision: ${JSON.stringify(emptyMaintainerDecision())}`,
      ),
      reportPath,
      packetsDir,
      repoRoot: root,
    });

    assert.equal(second.packet, null);
    assert.equal(existsSync(first.packetPath), false);
    assert.match(second.markdown, /^decision_packet_path: none$/m);
    assert.match(second.markdown, /^decision_packet_sha256: none$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-artifacts anchors packet pointers to an explicit record root", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const artifactDir = join(root, "artifacts");
    const recordRoot = join(root, "worker");
    const recordDir = join(recordRoot, "records", "openclaw-clawsweeper");
    const itemsDir = join(recordDir, "items");
    const closedDir = join(recordDir, "closed");
    const plansDir = join(recordDir, "plans");
    const packetsDir = join(recordDir, "decision-packets");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "321.md"),
      decisionReport({ maintainer_decision: JSON.stringify(productDecision) }),
      "utf8",
    );

    execFileSync(process.execPath, [
      "dist/clawsweeper.js",
      "apply-artifacts",
      "--target-repo",
      "openclaw/clawsweeper",
      "--artifact-dir",
      artifactDir,
      "--record-root",
      recordRoot,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--decision-packets-dir",
      packetsDir,
      "--replay-closed-artifacts",
      "--skip-reconcile",
    ]);

    assert.match(
      readFileSync(join(itemsDir, "321.md"), "utf8"),
      /^decision_packet_path: records\/openclaw-clawsweeper\/decision-packets\/321\.json$/m,
    );
    assert.ok(existsSync(join(packetsDir, "321.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function decisionReport(overrides: Record<string, unknown> = {}): string {
  const frontmatter = {
    number: 321,
    repository: "openclaw/clawsweeper",
    type: "issue",
    title: JSON.stringify("Render maintainer decision"),
    url: "https://github.com/openclaw/clawsweeper/issues/321",
    reviewed_at: "2026-06-23T10:00:00.000Z",
    item_created_at: "2026-06-20T00:00:00Z",
    item_updated_at: "2026-06-21T00:00:00Z",
    labels: JSON.stringify([]),
    triage_priority: "P2",
    action_taken: "kept_open",
    ...overrides,
  };
  return `---
${Object.entries(frontmatter)
  .map(([key, value]) => `${key}: ${String(value)}`)
  .join("\n")}
---

# #321: Render maintainer decision
`;
}
