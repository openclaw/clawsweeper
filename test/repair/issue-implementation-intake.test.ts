import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverImplementationCandidates,
  issueImplementationJobNeedsRefresh,
  markIssueImplementationDispatched,
  parseReviewReport,
  referencedIssueNumbers,
  referencedPullRequestCoordinates,
  reportRevisionSha256,
  reportOnlyDecision,
} from "../../dist/repair/issue-implementation-intake.js";
import {
  issueImplementationJobPath,
  renderIssueImplementationJob,
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
  REVIEW_VIABLE_ISSUE_TRIGGER_SOURCE,
  REVIEW_VISION_FIT_TRIGGER_SOURCE,
} from "../../dist/repair/comment-router-core.js";
import { readText } from "../helpers.ts";

function report(overrides = {}) {
  const fields = {
    number: "123",
    repository: "openclaw/openclaw",
    type: "issue",
    state_at_review: "open",
    review_status: "complete",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    work_candidate: "queue_fix_pr",
    work_confidence: "high",
    work_validation: JSON.stringify(["pnpm test src/example.test.ts"]),
    work_likely_files: JSON.stringify(["src/example.ts", "src/example.test.ts"]),
    work_cluster_refs: JSON.stringify(["#123"]),
    labels: JSON.stringify(["bug"]),
    item_category: "bug",
    reproduction_status: "reproduced",
    reproduction_confidence: "high",
    requires_new_feature: "false",
    requires_new_config_option: "false",
    requires_product_decision: "false",
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n## Repair Work Prompt\n\nFix the reproduced existing-behavior bug and add a regression test.\n`;
}

test("strict reproducible bug reports are eligible for implementation intake", () => {
  const markdown = report();
  const parsed = parseReviewReport(markdown);
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parsed,
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("small source-proven bug reports are eligible for implementation intake", () => {
  const markdown = report({
    reproduction_status: "source_reproducible",
    implementation_complexity: "small",
    auto_implementation_candidate: "strict_bug",
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("legacy source-proven reviews remain eligible without an implementation marker", () => {
  const markdown = report({
    reproduction_status: "source_reproducible",
    implementation_complexity: "small",
    auto_implementation_candidate: "none",
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("legacy implementation-marker compatibility is limited to source-proven bugs", () => {
  for (const overrides of [
    { reproduction_status: "reproduced", auto_implementation_candidate: "none" },
    {
      reproduction_status: "source_reproducible",
      implementation_complexity: "small",
      auto_implementation_candidate: "vision_fit",
    },
  ]) {
    const markdown = report(overrides);
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
    });

    assert.equal(decision.shouldRepair, false);
    assert.match(decision.reason, /auto implementation candidate/);
  }
});

test("source-proven bugs need high confidence and a small repair", () => {
  for (const overrides of [
    { implementation_complexity: "" },
    { implementation_complexity: "medium" },
    { implementation_complexity: "large" },
    { implementation_complexity: "unclear" },
    { reproduction_confidence: "medium" },
  ]) {
    const markdown = report({
      reproduction_status: "source_reproducible",
      implementation_complexity: "small",
      ...overrides,
    });
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
    });

    assert.equal(decision.shouldRepair, false);
  }
});

test("source-proven bugs retain duplicate-PR and protected-label safeguards", () => {
  const markdown = report({
    reproduction_status: "source_reproducible",
    implementation_complexity: "small",
    auto_implementation_candidate: "strict_bug",
  });
  const reportData = parseReviewReport(markdown);

  for (const live of [
    {
      issue: { state: "open", locked: false, labels: [], title: "Bug", body: "" },
      existingPrs: [{ number: 456, state: "OPEN" }],
      existingBranchPrs: [],
      referencedPrs: [],
      clusterExistingPrs: [],
    },
    {
      issue: {
        state: "open",
        locked: false,
        labels: [{ name: "clawsweeper:human-review" }],
        title: "Bug",
        body: "",
      },
      existingPrs: [],
      existingBranchPrs: [],
      referencedPrs: [],
      clusterExistingPrs: [],
    },
  ]) {
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: reportData,
      reportMarkdown: markdown,
      live,
    });

    assert.equal(decision.shouldRepair, false);
  }
});

test("source-proven bugs admit closed historical PRs but reject open or unverifiable PRs", () => {
  const markdown = report({
    reproduction_status: "source_reproducible",
    implementation_complexity: "small",
    auto_implementation_candidate: "strict_bug",
    work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/98326"]),
  });
  const parsed = parseReviewReport(markdown);
  const baseLive = {
    issue: { state: "open", locked: false, labels: [], title: "Bug", body: "" },
    existingPrs: [],
    existingBranchPrs: [],
    clusterExistingPrs: [],
  };

  assert.equal(
    reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parsed,
      reportMarkdown: markdown,
    }).shouldRepair,
    true,
  );
  assert.equal(
    reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parsed,
      reportMarkdown: markdown,
      live: {
        ...baseLive,
        referencedPrs: [
          {
            number: 98326,
            state: "closed",
            is_pull: true,
            url: "https://github.com/openclaw/openclaw/pull/98326",
          },
        ],
      },
    }).shouldRepair,
    true,
  );

  for (const referencedPrs of [
    [{ state: "open" }],
    [{ state: "unknown" }],
    [],
    [{ number: 98326, state: "closed", is_pull: false }],
    [
      {
        number: 98327,
        state: "closed",
        is_pull: true,
        url: "https://github.com/openclaw/openclaw/pull/98327",
      },
    ],
    undefined,
  ]) {
    const blocked = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parsed,
      reportMarkdown: markdown,
      live: { ...baseLive, ...(referencedPrs ? { referencedPrs } : {}) },
    });
    assert.equal(blocked.shouldRepair, false);
    assert.match(blocked.reason, /open or unverifiable pull request/);
  }
});

test("source-proven bug intake verifies relative and every explicit historical PR reference", () => {
  const baseLive = {
    issue: { state: "open", locked: false, labels: [], title: "Bug", body: "" },
    existingPrs: [],
    existingBranchPrs: [],
    clusterExistingPrs: [],
  };
  for (const reference of [
    "/pull/98326",
    "../pull/98326",
    "./pull/98326",
    "openclaw/openclaw/pull/98326",
  ]) {
    const markdown = report({
      reproduction_status: "source_reproducible",
      implementation_complexity: "small",
      auto_implementation_candidate: "strict_bug",
      work_cluster_refs: JSON.stringify([reference]),
    });
    const rejected = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      live: { ...baseLive, referencedPrs: [] },
    });
    assert.equal(rejected.shouldRepair, false);
    assert.match(rejected.reason, /open or unverifiable pull request/);
  }

  const markdown = report({
    reproduction_status: "source_reproducible",
    implementation_complexity: "small",
    auto_implementation_candidate: "strict_bug",
    work_cluster_refs: JSON.stringify([
      "https://github.com/openclaw/openclaw/pull/98326",
      "https://github.com/openclaw/openclaw/pull/98327",
    ]),
  });
  const missingSecond = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    live: {
      ...baseLive,
      referencedPrs: [
        {
          number: 98326,
          state: "closed",
          is_pull: true,
          url: "https://github.com/openclaw/openclaw/pull/98326",
        },
      ],
    },
  });
  assert.equal(missingSecond.shouldRepair, false);
});

test("automatic implementation refuses report and live bulk-filer signals", () => {
  for (const overrides of [
    { bulk_filer_detected: "true" },
    { labels: JSON.stringify(["bug", "clawsweeper:bulk-filed"]) },
  ]) {
    const markdown = report(overrides);
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
    });

    assert.equal(decision.shouldRepair, false);
    assert.match(decision.reason, /bulk-filed/);
  }

  const markdown = report();
  const liveDecision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    live: {
      issue: {
        state: "open",
        locked: false,
        labels: [{ name: "clawsweeper:bulk-filed" }],
        title: "Bug",
        body: "",
      },
      existingPrs: [],
      existingBranchPrs: [],
      referencedPrs: [],
      clusterExistingPrs: [],
    },
  });

  assert.equal(liveDecision.shouldRepair, false);
  assert.match(liveDecision.reason, /bulk-filed/);
});

test("owner policy admits allowed owners and rejects the rest before durable intake", () => {
  const markdown = report({ repository: "steipete/oracle" });
  const parsed = parseReviewReport(markdown);
  const base = {
    targetRepo: "steipete/oracle",
    report: parsed,
    reportMarkdown: markdown,
  };

  // Review-only external owner: policy does not include it, so nothing is queued.
  const reviewOnly = reportOnlyDecision({ ...base, allowedOwner: "openclaw" });
  assert.equal(reviewOnly.shouldRepair, false);
  assert.equal(reviewOnly.status, "owner_policy_blocked");
  assert.match(reviewOnly.reason, /unsupported target repo owner steipete/);
  assert.match(reviewOnly.reason, /repair owner policy allows openclaw/);

  // Explicitly approved external repair owner: the same report queues.
  const approved = reportOnlyDecision({ ...base, allowedOwner: "openclaw, steipete" });
  assert.equal(approved.shouldRepair, true);
  assert.equal(approved.status, "queued_for_repair");

  // Allowed primary owner keeps working under the widened policy.
  const internalMarkdown = report();
  const internal = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(internalMarkdown),
    reportMarkdown: internalMarkdown,
    allowedOwner: "openclaw,steipete",
  });
  assert.equal(internal.shouldRepair, true);
  assert.equal(internal.status, "queued_for_repair");

  // An operator override cannot bypass the owner policy.
  const overridden = reportOnlyDecision({
    ...base,
    allowedOwner: "openclaw",
    operatorOverride: true,
  });
  assert.equal(overridden.shouldRepair, false);
  assert.equal(overridden.status, "owner_policy_blocked");
});

test("implementation intake rejects feature and config-option work", () => {
  for (const overrides of [
    { item_category: "feature" },
    { requires_new_feature: "true" },
    { requires_new_config_option: "true" },
    { requires_product_decision: "true" },
    { reproduction_status: "unclear" },
  ]) {
    const markdown = report(overrides);
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
    });

    assert.equal(decision.shouldRepair, false);
  }
});

test("implementation intake override permits soft blockers", () => {
  const markdown = report({
    item_category: "feature",
    requires_new_feature: "true",
    work_validation: JSON.stringify([]),
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    operatorOverride: true,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "override_queued_for_repair");
  assert.equal(decision.blockerClass, "soft");
  assert.equal(decision.operatorOverride, true);
  assert.match(decision.reason, /item category is feature/);
});

test("implementation intake override routes hard blockers to handoff", () => {
  const markdown = report({
    labels: JSON.stringify(["security"]),
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    operatorOverride: true,
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "override_handoff");
  assert.equal(decision.blockerClass, "hard");
  assert.equal(decision.operatorOverride, true);
  assert.match(decision.reason, /protected label present/);
});

test("vision-fit reports are eligible for sibling implementation intake", () => {
  const markdown = report({
    item_category: "feature",
    reproduction_status: "not_applicable",
    reproduction_confidence: "low",
    requires_new_feature: "true",
    auto_implementation_candidate: "vision_fit",
    vision_fit: "aligned",
    vision_fit_evidence: JSON.stringify([
      "VISION.md lists setup reliability and first-run UX as current priorities.",
    ]),
    implementation_complexity: "small",
  });
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "vision_fit",
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("vision-fit intake rejects broad or unaligned issue work", () => {
  for (const overrides of [
    { auto_implementation_candidate: "none" },
    { vision_fit: "rejected" },
    { implementation_complexity: "medium" },
    { requires_product_decision: "true" },
    { vision_fit_evidence: JSON.stringify([]) },
  ]) {
    const markdown = report({
      item_category: "feature",
      reproduction_status: "not_applicable",
      reproduction_confidence: "low",
      requires_new_feature: "true",
      auto_implementation_candidate: "vision_fit",
      vision_fit: "aligned",
      vision_fit_evidence: JSON.stringify(["VISION.md supports this narrow direction."]),
      implementation_complexity: "small",
      ...overrides,
    });
    const decision = reportOnlyDecision({
      targetRepo: "openclaw/openclaw",
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      candidateKind: "vision_fit",
    });

    assert.equal(decision.shouldRepair, false);
  }
});

test("viable reviews queue autonomous implementation outside protected repositories", () => {
  const markdown = report({
    number: "244",
    repository: "steipete/summarize",
    item_category: "feature",
    reproduction_status: "not_applicable",
    reproduction_confidence: "low",
  });
  const decision = reportOnlyDecision({
    targetRepo: "steipete/summarize",
    itemNumber: 244,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("viable reviews let Codex discover the implementation and validation strategy", () => {
  const markdown = report({
    number: "244",
    repository: "steipete/summarize",
    confidence: "low",
    work_candidate: "none",
    work_confidence: "low",
    work_validation: JSON.stringify([]),
  }).replace(/## Repair Work Prompt[\s\S]*$/, "");
  const decision = reportOnlyDecision({
    targetRepo: "steipete/summarize",
    itemNumber: 244,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
});

test("viable reviews reject product-decision and automatic PR pause signals", () => {
  for (const overrides of [
    { requires_product_decision: "true" },
    { labels: JSON.stringify(["clawsweeper:no-new-fix-pr"]) },
    { labels: JSON.stringify(["clawsweeper:needs-maintainer-review"]) },
    { labels: JSON.stringify(["clawsweeper:needs-product-decision"]) },
  ]) {
    const markdown = report({
      number: "244",
      repository: "steipete/summarize",
      item_category: "feature",
      reproduction_status: "not_applicable",
      reproduction_confidence: "low",
      ...overrides,
    });
    const decision = reportOnlyDecision({
      targetRepo: "steipete/summarize",
      itemNumber: 244,
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      candidateKind: "viable",
    });

    assert.equal(decision.shouldRepair, false);

    const overrideDecision = reportOnlyDecision({
      targetRepo: "steipete/summarize",
      itemNumber: 244,
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      candidateKind: "viable",
      operatorOverride: true,
    });
    assert.equal(overrideDecision.shouldRepair, true);
    assert.equal(overrideDecision.status, "override_queued_for_repair");
    assert.equal(overrideDecision.blockerClass, "soft");
  }
});

test("viable review routing resolves pull request context during live intake", () => {
  const markdown = report({
    number: "244",
    repository: "steipete/summarize",
    item_category: "feature",
    reproduction_status: "not_applicable",
    reproduction_confidence: "low",
    work_cluster_refs: JSON.stringify(["https://github.com/other/project/pull/12"]),
  });
  const decision = reportOnlyDecision({
    targetRepo: "steipete/summarize",
    itemNumber: 244,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
  });
  const openDecision = reportOnlyDecision({
    targetRepo: "steipete/summarize",
    itemNumber: 244,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live: {
      issue: { state: "open", locked: false, labels: [], title: "Feature", body: "" },
      existingPrs: [],
      existingBranchPrs: [],
      referencedPrs: [{ state: "open" }],
    },
  });
  const closedDecision = reportOnlyDecision({
    targetRepo: "steipete/summarize",
    itemNumber: 244,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live: {
      issue: { state: "open", locked: false, labels: [], title: "Feature", body: "" },
      existingPrs: [],
      existingBranchPrs: [],
      referencedPrs: [
        {
          number: 12,
          state: "closed",
          is_pull: true,
          url: "https://github.com/other/project/pull/12",
        },
      ],
    },
  });

  assert.equal(decision.shouldRepair, true);
  assert.equal(decision.status, "queued_for_repair");
  assert.equal(openDecision.shouldRepair, false);
  assert.match(openDecision.reason, /references an open or unverifiable pull request/);
  assert.equal(closedDecision.shouldRepair, true);
  assert.equal(closedDecision.status, "queued_for_repair");
});

test("viable review routing resolves full and shorthand pull request references", () => {
  assert.deepEqual(
    referencedPullRequestCoordinates({
      targetRepo: "steipete/oracle",
      itemNumber: 241,
      references: [
        "#241",
        "Superseded by #216",
        "See steipete/oracle#217",
        "https://github.com/other/project/pull/12",
        "https://github.com/steipete/oracle/issues/218",
        "Superseded by [PR #13](https://github.com/other/project/pull/13)",
        "/pull/14",
        "another/project/pull/15",
        "[PR #16](/another/project/pull/16)",
        "[PR #17](../pull/17)",
      ],
    }),
    [
      { owner: "steipete", name: "oracle", number: 216, knownPullRequest: false },
      { owner: "steipete", name: "oracle", number: 217, knownPullRequest: false },
      { owner: "other", name: "project", number: 12, knownPullRequest: true },
      { owner: "other", name: "project", number: 13, knownPullRequest: true },
      { owner: "steipete", name: "oracle", number: 14, knownPullRequest: true },
      { owner: "another", name: "project", number: 15, knownPullRequest: true },
      { owner: "another", name: "project", number: 16, knownPullRequest: true },
      { owner: "steipete", name: "oracle", number: 17, knownPullRequest: true },
    ],
  );
});

test("issue implementation deduplicates work across related issue references", () => {
  assert.deepEqual(
    referencedIssueNumbers({
      targetRepo: "steipete/oracle",
      itemNumber: 241,
      references: [
        "#241",
        "Duplicate of #216",
        "See steipete/oracle#217",
        "https://github.com/steipete/oracle/issues/218",
        "https://github.com/other/project/issues/219",
        "[PR #220](/another/project/pull/220)",
        "[Issue #221](https://github.com/steipete/oracle/issues/221)",
        "[Issue #222](/issues/222)",
        "[Issue #223](/steipete/oracle/issues/223)",
        "[Issue #224](../issues/224)",
        "[Issue #225](/another/project/issues/225)",
      ],
    }),
    [216, 217, 218, 221, 222, 223, 224],
  );

  const markdown = report();
  const decision = reportOnlyDecision({
    targetRepo: "openclaw/openclaw",
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    live: {
      issue: { state: "open", locked: false, labels: [], title: "Bug", body: "" },
      existingPrs: [],
      existingBranchPrs: [],
      referencedPrs: [],
      clusterExistingPrs: [{ number: 456, state: "open" }],
    },
  });
  assert.equal(decision.shouldRepair, false);
  assert.match(decision.reason, /related issue in this work cluster/);
});

test("viable live intake allows auth-provider prose but blocks explicit security signals", () => {
  const markdown = report({
    number: "241",
    repository: "steipete/oracle",
    labels: JSON.stringify(["impact:auth-provider"]),
  });
  const live = {
    issue: {
      state: "open",
      locked: false,
      labels: [{ name: "impact:auth-provider" }],
      title: "Bearer-token login probe rejects authenticated users",
      body: "The access token is attached by the browser SPA.",
    },
    comments: [],
    existingPrs: [],
    existingBranchPrs: [],
    referencedPrs: [],
  };
  const viable = reportOnlyDecision({
    targetRepo: "steipete/oracle",
    itemNumber: 241,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live,
  });
  const security = reportOnlyDecision({
    targetRepo: "steipete/oracle",
    itemNumber: 241,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live: {
      ...live,
      issue: { ...live.issue, labels: [{ name: "security:sensitive" }] },
    },
  });
  const vulnerability = reportOnlyDecision({
    targetRepo: "steipete/oracle",
    itemNumber: 241,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live: {
      ...live,
      issue: { ...live.issue, title: "Stored XSS in browser output", body: "" },
    },
  });
  const credentialExposure = reportOnlyDecision({
    targetRepo: "steipete/oracle",
    itemNumber: 241,
    report: parseReviewReport(markdown),
    reportMarkdown: markdown,
    candidateKind: "viable",
    live: {
      ...live,
      issue: { ...live.issue, title: "Leaked access token in browser output", body: "" },
    },
  });

  assert.equal(viable.shouldRepair, true);
  assert.equal(viable.status, "queued_for_repair");
  assert.equal(security.shouldRepair, false);
  assert.match(security.reason, /security-sensitive signal/);
  assert.equal(vulnerability.shouldRepair, false);
  assert.match(vulnerability.reason, /security-sensitive signal/);
  assert.equal(credentialExposure.shouldRepair, false);
  assert.match(credentialExposure.reason, /security-sensitive signal/);
});

test("viable review routing excludes protected repositories and invalid review identity", () => {
  const base = {
    number: "244",
    repository: "steipete/summarize",
    item_category: "feature",
    reproduction_status: "not_applicable",
    reproduction_confidence: "low",
  };
  const cases = [
    { targetRepo: "openclaw/openclaw", overrides: { repository: "openclaw/openclaw" } },
    { targetRepo: "openclaw/clawhub", overrides: { repository: "openclaw/clawhub" } },
    { targetRepo: "steipete/summarize", overrides: { review_status: "incomplete" } },
    { targetRepo: "steipete/summarize", overrides: { decision: "close" } },
    { targetRepo: "steipete/summarize", overrides: { number: "245" } },
  ];

  for (const { targetRepo, overrides } of cases) {
    const markdown = report({ ...base, ...overrides });
    const decision = reportOnlyDecision({
      targetRepo,
      itemNumber: 244,
      report: parseReviewReport(markdown),
      reportMarkdown: markdown,
      candidateKind: "viable",
    });
    assert.equal(decision.shouldRepair, false);
  }
});

test("bug candidate discovery includes legacy small source-proven OpenClaw reviews", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-source-proven-bug-"));
  try {
    const reportDir = path.join(root, "records", "openclaw-openclaw", "items");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      path.join(reportDir, "123.md"),
      report({
        reproduction_status: "source_reproducible",
        implementation_complexity: "small",
        auto_implementation_candidate: "none",
      }),
    );

    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }),
      [
        {
          item_number: 123,
          report_path: "records/openclaw-openclaw/items/123.md",
          report_url:
            "https://github.com/openclaw/clawsweeper-state/blob/state/records/openclaw-openclaw/items/123.md",
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bug candidate discovery admits a source-proven issue whose previous fix PR was closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-closed-pr-bug-"));
  try {
    const reportDir = path.join(root, "records", "openclaw-openclaw", "items");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      path.join(reportDir, "123.md"),
      report({
        reproduction_status: "source_reproducible",
        implementation_complexity: "small",
        auto_implementation_candidate: "strict_bug",
        work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/98326"]),
      }),
    );

    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [123],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted newer review artifacts supersede stale hydrated canonical snapshots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-published-review-"));
  try {
    const recordDir = path.join(root, "records", "openclaw-openclaw", "items");
    const artifactDir = path.join(root, "artifacts");
    mkdirSync(recordDir, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(recordDir, "123.md"),
      report({ decision: "close", reviewed_at: "2026-07-31T10:00:00.000Z" }),
    );
    const acceptedReview = report({ reviewed_at: "2026-07-31T10:05:00.000Z" });
    writeFileSync(path.join(artifactDir, "123.md"), acceptedReview);

    const options = {
      enabled: true,
      candidateKind: "strict_bug" as const,
      targetRepo: "openclaw/openclaw",
      reportRepo: "openclaw/clawsweeper-state",
      sourceDirs: [artifactDir],
      jobRoot: root,
    };
    assert.deepEqual(
      discoverImplementationCandidates(options).map(({ item_number }) => item_number),
      [123],
    );

    const jobPath = path.join(root, issueImplementationJobPath("openclaw/openclaw", 123));
    const auditPath = path.join(
      root,
      "results",
      "issue-implementation-intake",
      "openclaw-openclaw",
      "123.md",
    );
    mkdirSync(path.dirname(jobPath), { recursive: true });
    mkdirSync(path.dirname(auditPath), { recursive: true });
    writeFileSync(jobPath, "queued\n");
    writeFileSync(
      auditPath,
      `---\nreport_revision_sha256: ${reportRevisionSha256(acceptedReview)}\ndecision: not_eligible\nworker_dispatched: false\nworker_retry_after: ${new Date(Date.now() + 30 * 60_000).toISOString()}\n---\n`,
    );
    assert.deepEqual(discoverImplementationCandidates(options), []);

    writeFileSync(
      path.join(artifactDir, "123.md"),
      report({ reviewed_at: "2026-07-31T10:06:00.000Z" }),
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      path.join(recordDir, "123.md"),
      report({ decision: "close", reviewed_at: "2026-07-31T10:07:00.000Z" }),
    );
    assert.deepEqual(discoverImplementationCandidates(options), []);

    writeFileSync(
      path.join(recordDir, "123.md"),
      report({ reviewed_at: "2026-07-31T10:07:00.000Z" }),
    );
    writeFileSync(
      path.join(artifactDir, "123.md"),
      report({ decision: "close", reviewed_at: "2026-07-31T10:08:00.000Z" }),
    );
    assert.deepEqual(
      discoverImplementationCandidates({ ...options, sourceDirs: [artifactDir, recordDir] }),
      [],
    );
    assert.deepEqual(
      discoverImplementationCandidates({ ...options, sourceDirs: [recordDir, artifactDir] }),
      [],
    );

    writeFileSync(
      path.join(recordDir, "123.md"),
      report({
        decision: "close",
        item_updated_at: "2026-07-31T10:09:00.000Z",
        reviewed_at: "2026-07-31T10:07:00.000Z",
      }),
    );
    writeFileSync(
      path.join(artifactDir, "123.md"),
      report({
        item_updated_at: "2026-07-31T10:08:00.000Z",
        reviewed_at: "2026-07-31T10:10:00.000Z",
      }),
    );
    assert.deepEqual(
      discoverImplementationCandidates({ ...options, sourceDirs: [artifactDir, recordDir] }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("undispatched issue jobs are regenerated when their authoritative review changes", () => {
  const current = report({ implementation_complexity: "small" });
  const legacy = parseReviewReport(`---
decision: queued_for_repair
report_revision_sha256: old-review-revision
---
`);
  const alreadyDispatched = parseReviewReport(`---
decision: queued_for_repair
report_revision_sha256: old-review-revision
worker_dispatched: true
---
`);
  const temporarilyIneligible = parseReviewReport(`---
decision: not_eligible
report_revision_sha256: temporarily-ineligible-review
worker_dispatched: false
---
`);
  const temporarilyIneligibleAfterChangedReview = parseReviewReport(`---
decision: not_eligible
report_revision_sha256: ${reportRevisionSha256(current)}
job_report_revision_sha256: original-job-review
worker_dispatched: false
---
`);
  const legacyTemporarilyIneligible = parseReviewReport(`---
decision: not_eligible
report_revision_sha256: ${reportRevisionSha256(current)}
---
`);
  const unchanged = parseReviewReport(`---
decision: queued_for_repair
report_revision_sha256: ${reportRevisionSha256(current)}
worker_dispatched: false
---
`);

  assert.equal(issueImplementationJobNeedsRefresh(legacy, current), true);
  assert.equal(issueImplementationJobNeedsRefresh(alreadyDispatched, current), false);
  assert.equal(
    issueImplementationJobNeedsRefresh(alreadyDispatched, current, { completedWorker: true }),
    true,
  );
  assert.equal(issueImplementationJobNeedsRefresh(temporarilyIneligible, current), true);
  assert.equal(
    issueImplementationJobNeedsRefresh(temporarilyIneligibleAfterChangedReview, current),
    true,
  );
  assert.equal(issueImplementationJobNeedsRefresh(legacyTemporarilyIneligible, current), true);
  assert.equal(issueImplementationJobNeedsRefresh(unchanged, current), false);
});

test("viable candidate discovery backfills reports and recovers undispatched queued jobs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-issue-backfill-"));
  try {
    const reportDir = path.join(root, "records", "steipete-summarize", "items");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      path.join(reportDir, "244.md"),
      report({
        number: "244",
        repository: "steipete/summarize",
      }),
    );
    writeFileSync(
      path.join(reportDir, "245.md"),
      report({
        number: "245",
        repository: "steipete/summarize",
        decision: "close",
      }),
    );

    const options = {
      enabled: true,
      candidateKind: "viable" as const,
      targetRepo: "steipete/summarize",
      reportRepo: "openclaw/clawsweeper-state",
      sourceDirs: [reportDir, reportDir],
      jobRoot: root,
    };
    assert.deepEqual(discoverImplementationCandidates(options), [
      {
        item_number: 244,
        report_path: "records/steipete-summarize/items/244.md",
        report_url:
          "https://github.com/openclaw/clawsweeper-state/blob/state/records/steipete-summarize/items/244.md",
      },
    ]);

    const report244Path = path.join(reportDir, "244.md");
    const auditPath = path.join(
      root,
      "results",
      "issue-implementation-intake",
      "steipete-summarize",
      "244.md",
    );
    mkdirSync(path.dirname(auditPath), { recursive: true });
    writeFileSync(
      auditPath,
      `---
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: not_eligible
---
`,
    );
    assert.deepEqual(discoverImplementationCandidates(options), []);
    const artifactDir = path.join(root, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, "244.md"),
      readFileSync(report244Path, "utf8").replace(/^---\n/, "---\ndecision_packet_path: none\n"),
    );
    assert.deepEqual(
      discoverImplementationCandidates({ ...options, sourceDirs: [artifactDir, reportDir] }),
      [],
    );
    writeFileSync(report244Path, `${readFileSync(report244Path, "utf8")}\n`);
    assert.equal(discoverImplementationCandidates(options).length, 1);

    const jobPath = path.join(root, issueImplementationJobPath("steipete/summarize", 244));
    mkdirSync(path.dirname(jobPath), { recursive: true });
    writeFileSync(jobPath, "queued\n");
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: not_eligible
worker_dispatched: false
worker_retry_after: ${new Date(Date.now() - 60_000).toISOString()}
---
`,
    );
    writeFileSync(
      path.join(reportDir, "245.md"),
      report({ number: "245", repository: "steipete/summarize" }),
    );
    writeFileSync(
      path.join(reportDir, "246.md"),
      report({ number: "246", repository: "steipete/summarize" }),
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map(({ item_number }) => item_number),
      [244, 245, 246],
    );
    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: queued_for_repair
worker_dispatched: false
---
`,
    );
    writeFileSync(
      path.join(reportDir, "247.md"),
      report({ number: "247", repository: "steipete/summarize" }),
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map((candidate) => candidate.item_number),
      [244, 245, 246, 247],
    );
    assert.deepEqual(
      discoverImplementationCandidates(options)
        .slice(0, 1)
        .map((candidate) => candidate.item_number),
      [244],
    );
    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: queued_for_repair
worker_dispatched: false
worker_retry_after: invalid
---
`,
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map((candidate) => candidate.item_number),
      [244, 245, 246, 247],
    );
    rmSync(path.join(reportDir, "246.md"));
    rmSync(path.join(reportDir, "247.md"));
    writeFileSync(
      path.join(reportDir, "245.md"),
      report({ number: "245", repository: "steipete/summarize", decision: "close" }),
    );

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: not_eligible
---
`,
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: not_eligible
worker_dispatched: false
worker_retry_after: ${new Date(Date.now() + 30 * 60_000).toISOString()}
---
`,
    );
    assert.deepEqual(discoverImplementationCandidates(options), []);
    assert.deepEqual(
      discoverImplementationCandidates({ ...options, sourceDirs: [artifactDir, reportDir] }),
      [],
    );
    writeFileSync(report244Path, `${readFileSync(report244Path, "utf8")}\n`);
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}
decision: queued_for_repair
---
`,
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(report244Path, `${readFileSync(report244Path, "utf8")}\n`);
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: temporarily-ineligible-review
decision: not_eligible
worker_dispatched: false
---
`,
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      `---
repo: steipete/summarize
number: 244
report_revision_sha256: old-review-revision
decision: queued_for_repair
worker_dispatched: false
---
`,
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);

    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^report_revision_sha256:.*$/m,
        `report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}`,
      ),
    );
    markIssueImplementationDispatched({
      root,
      auditPath: path.relative(root, auditPath),
      jobPath: path.relative(root, jobPath),
    });
    assert.match(readFileSync(auditPath, "utf8"), /worker_dispatched: true/);
    assert.match(readFileSync(auditPath, "utf8"), /worker_dispatched_at: \d{4}-/);
    assert.match(readFileSync(auditPath, "utf8"), /worker_attempt_count: 1/);
    assert.deepEqual(discoverImplementationCandidates(options), []);

    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^worker_retry_after:.*$/m,
        `worker_retry_after: ${new Date(Date.now() - 60_000).toISOString()}`,
      ),
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map((candidate) => candidate.item_number),
      [244],
    );

    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^report_revision_sha256:.*$/m,
        "report_revision_sha256: old-dispatched-review",
      ),
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map((candidate) => candidate.item_number),
      [244],
    );
    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^report_revision_sha256:.*$/m,
        `report_revision_sha256: ${reportRevisionSha256(readFileSync(report244Path, "utf8"))}`,
      ),
    );

    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^worker_attempt_count:.*$/m,
        "worker_attempt_count: 3",
      ),
    );
    assert.deepEqual(discoverImplementationCandidates(options), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful issue workers with open implementation PRs are not requeued", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-open-implementation-pr-"));
  try {
    const markdown = report({ reviewed_at: "2026-07-31T10:00:00.000Z" });
    const reportDir = path.join(root, "records", "openclaw-openclaw", "items");
    const reportPath = path.join(reportDir, "123.md");
    const jobPath = path.join(root, issueImplementationJobPath("openclaw/openclaw", 123));
    const auditPath = path.join(
      root,
      "results",
      "issue-implementation-intake",
      "openclaw-openclaw",
      "123.md",
    );
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(path.dirname(jobPath), { recursive: true });
    mkdirSync(path.dirname(auditPath), { recursive: true });
    writeFileSync(reportPath, markdown);
    writeFileSync(jobPath, "existing issue implementation job\n");
    writeFileSync(
      auditPath,
      `---
repo: openclaw/openclaw
number: 123
report_revision_sha256: ${reportRevisionSha256(markdown)}
report_reviewed_at: 2026-07-31T10:00:00.000Z
job_report_revision_sha256: ${reportRevisionSha256(markdown)}
decision: not_eligible
prepared_at: ${new Date().toISOString()}
worker_dispatched: true
worker_dispatched_at: ${new Date(Date.now() - 300_000).toISOString()}
worker_attempt_count: 1
worker_retry_after: ${new Date(Date.now() + 30 * 60_000).toISOString()}
---

## Blockers

- existing ClawSweeper issue implementation PR is open
`,
    );

    const options = {
      enabled: true,
      candidateKind: "strict_bug" as const,
      targetRepo: "openclaw/openclaw",
      reportRepo: "openclaw/clawsweeper-state",
      sourceDirs: [reportDir],
      jobRoot: root,
    };
    assert.deepEqual(discoverImplementationCandidates(options), []);
    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^worker_retry_after:.*$/m,
        `worker_retry_after: ${new Date(Date.now() - 60_000).toISOString()}`,
      ),
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);
    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^worker_retry_after:.*$/m,
        `worker_retry_after: ${new Date(Date.now() + 30 * 60_000).toISOString()}`,
      ),
    );
    writeFileSync(reportPath, report({ reviewed_at: "2026-07-31T10:05:00.000Z" }));
    assert.equal(discoverImplementationCandidates(options).length, 1);
    writeFileSync(
      path.join(reportDir, "124.md"),
      report({ number: "124", work_cluster_refs: JSON.stringify(["#124"]) }),
    );
    assert.deepEqual(
      discoverImplementationCandidates(options).map(({ item_number }) => item_number),
      [123, 124],
    );
    rmSync(path.join(reportDir, "124.md"));
    writeFileSync(reportPath, markdown);
    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8")
        .replace("worker_dispatched: true", "worker_dispatched: false")
        .replace(
          /^worker_retry_after:.*$/m,
          `worker_retry_after: ${new Date(Date.now() - 60_000).toISOString()}`,
        ),
    );
    assert.equal(discoverImplementationCandidates(options).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer reviews immediately regenerate completed jobs ahead of fresh issue work", () => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "clawsweeper-newer-review-recovery-")),
  );
  try {
    for (const entry of ["dist", "config", "package.json"]) {
      cpSync(entry, path.join(root, entry), { recursive: true });
    }
    const oldReport = report({ reviewed_at: "2026-07-31T10:00:00.000Z" });
    const currentReport = report({
      reviewed_at: "2026-07-31T10:05:00.000Z",
      work_cluster_refs: JSON.stringify(["https://github.com/openclaw/openclaw/pull/456"]),
    });
    const reportDir = path.join(root, "records", "openclaw-openclaw", "items");
    const jobRelativePath = issueImplementationJobPath("openclaw/openclaw", 123);
    const jobPath = path.join(root, jobRelativePath);
    const auditPath = path.join(
      root,
      "results",
      "issue-implementation-intake",
      "openclaw-openclaw",
      "123.md",
    );
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(path.dirname(jobPath), { recursive: true });
    mkdirSync(path.dirname(auditPath), { recursive: true });
    writeFileSync(path.join(reportDir, "123.md"), currentReport);
    writeFileSync(
      path.join(reportDir, "124.md"),
      report({ number: "124", work_cluster_refs: JSON.stringify(["#124"]) }),
    );
    writeFileSync(jobPath, "old queued issue implementation job\n");
    const dispatchedAt = new Date(Date.now() - 180_000).toISOString();
    const completedAt = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(
      auditPath,
      `---
repo: openclaw/openclaw
number: 123
report_revision_sha256: ${reportRevisionSha256(oldReport)}
report_reviewed_at: 2026-07-31T10:00:00.000Z
job_report_revision_sha256: ${reportRevisionSha256(oldReport)}
decision: queued_for_repair
prepared_at: ${dispatchedAt}
worker_dispatched: true
worker_dispatched_at: ${dispatchedAt}
worker_attempt_count: 3
worker_retry_after: ${new Date(Date.now() + 30 * 60_000).toISOString()}
---
`,
    );
    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [123, 124],
    );
    writeFileSync(
      path.join(reportDir, "123.md"),
      report({
        reviewed_at: "2026-07-31T09:55:00.000Z",
        item_updated_at: "2026-07-31T09:00:00.000Z",
      }),
    );
    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [124],
    );
    const fakeGh = path.join(root, "fake-gh");
    const openPrFlag = path.join(root, "open-implementation-pr");
    const workflowHistory = JSON.stringify({
      total_count: 1,
      workflow_runs: [
        {
          display_title: `issue implementation ${jobRelativePath}`,
          status: "completed",
          conclusion: "failure",
          created_at: dispatchedAt,
          updated_at: completedAt,
        },
      ],
    });
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$2" in
  repos/openclaw/openclaw/issues/123) printf '%s\\n' '{"state":"open","labels":[],"title":"Existing bug","body":"Existing behavior"}' ;;
  repos/openclaw/openclaw/issues/456)
    if [ -f '${openPrFlag}' ]; then
      printf '%s\\n' '{"number":456,"state":"open","url":"https://github.com/openclaw/openclaw/pull/456","is_pull":true}'
    else
      printf '%s\\n' '{"number":456,"state":"closed","url":"https://github.com/openclaw/openclaw/pull/456","is_pull":true}'
    fi ;;
  repos/openclaw/openclaw/issues/123/comments*) printf '%s\\n' '[]' ;;
  repos/openclaw/openclaw/pulls) printf '%s\\n' '[]' ;;
  search/issues) printf '%s\\n' '[]' ;;
  repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs*) printf '%s\\n' '${workflowHistory}' ;;
  *) printf 'unexpected fake GitHub call: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);
    const intakeArgs = [
      path.join(root, "dist", "repair", "issue-implementation-intake.js"),
      "prepare",
      "--enabled",
      "true",
      "--candidate-kind",
      "strict_bug",
      "--target-repo",
      "openclaw/openclaw",
      "--item-number",
      "123",
    ];
    const processOptions = {
      cwd: root,
      encoding: "utf8" as const,
      env: {
        ...process.env,
        GH_BIN: fakeGh,
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
      },
    };
    const dispatchedAudit = readFileSync(auditPath, "utf8");
    writeFileSync(
      auditPath,
      dispatchedAudit.replace("worker_dispatched: true", "worker_dispatched: false"),
    );
    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [124],
    );
    for (const previousAudit of [readFileSync(auditPath, "utf8"), dispatchedAudit]) {
      writeFileSync(auditPath, previousAudit);
      const stalePreparation = spawnSync(process.execPath, intakeArgs, processOptions);
      assert.equal(stalePreparation.status, 1);
      assert.match(stalePreparation.stderr, /older than the authoritative intake/);
    }
    assert.equal(
      parseReviewReport(readFileSync(auditPath, "utf8")).frontmatter.report_revision_sha256,
      reportRevisionSha256(oldReport),
    );
    assert.equal(readFileSync(jobPath, "utf8"), "old queued issue implementation job\n");
    writeFileSync(path.join(reportDir, "123.md"), currentReport);
    writeFileSync(openPrFlag, "open\n");
    const blockedPreparation = spawnSync(process.execPath, intakeArgs, processOptions);
    assert.equal(blockedPreparation.status, 0, blockedPreparation.stderr);
    assert.equal(JSON.parse(blockedPreparation.stdout).status, "not_eligible");
    const blockedAudit = parseReviewReport(readFileSync(auditPath, "utf8"));
    assert.match(
      blockedAudit.body,
      /review report references an open or unverifiable pull request/,
    );
    assert.ok(
      Date.parse(blockedAudit.frontmatter.worker_retry_after ?? "") > Date.now() + 25 * 60_000,
    );
    rmSync(openPrFlag);
    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [124],
    );
    writeFileSync(
      auditPath,
      readFileSync(auditPath, "utf8").replace(
        /^worker_retry_after:.*$/m,
        `worker_retry_after: ${new Date(Date.now() - 60_000).toISOString()}`,
      ),
    );
    assert.deepEqual(
      discoverImplementationCandidates({
        enabled: true,
        candidateKind: "strict_bug",
        targetRepo: "openclaw/openclaw",
        reportRepo: "openclaw/clawsweeper-state",
        sourceDirs: [reportDir],
        jobRoot: root,
      }).map(({ item_number }) => item_number),
      [123, 124],
    );
    const prepared = spawnSync(process.execPath, intakeArgs, processOptions);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.ok(prepared.stdout, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).status, "queued_for_repair");
    const refreshedAudit = parseReviewReport(readFileSync(auditPath, "utf8"));
    assert.equal(
      refreshedAudit.frontmatter.report_revision_sha256,
      reportRevisionSha256(currentReport),
    );
    assert.equal(
      refreshedAudit.frontmatter.job_report_revision_sha256,
      reportRevisionSha256(currentReport),
    );
    assert.equal(refreshedAudit.frontmatter.report_reviewed_at, "2026-07-31T10:05:00.000Z");
    assert.equal(refreshedAudit.frontmatter.worker_dispatched, "false");
    assert.equal(refreshedAudit.frontmatter.worker_attempt_count, "0");
    assert.notEqual(readFileSync(jobPath, "utf8"), "old queued issue implementation job\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-triggered issue implementation jobs require autogenerated autofix labels", () => {
  const job = renderIssueImplementationJob({
    repo: "openclaw/openclaw",
    issueNumber: 123,
    title: "Crash on existing command",
    triggerSource: REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
    reviewReportPath: "records/openclaw-openclaw/items/123.md",
    strictBugOnly: true,
  });

  assert.match(job, /trigger_source: review_reproducible_bug/);
  assert.match(job, /required_pr_labels:\n  - clawsweeper:autogenerated\n  - clawsweeper:autofix/);
  assert.match(job, /Treat it as bug-only/);
  assert.match(job, /new config\s+option/);
});

test("dispatch audit preserves an existing deduplicated worker generation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-deduplicated-issue-worker-"));
  try {
    const repository = "openclaw/openclaw";
    const number = 123;
    const jobPath = issueImplementationJobPath(repository, number);
    const auditPath = `results/issue-implementation-intake/openclaw-openclaw/${number}.md`;
    const originalDispatch = "2026-07-31T18:57:00.000Z";
    mkdirSync(path.dirname(path.join(root, jobPath)), { recursive: true });
    mkdirSync(path.dirname(path.join(root, auditPath)), { recursive: true });
    writeFileSync(path.join(root, jobPath), "durable issue job\n");
    writeFileSync(
      path.join(root, auditPath),
      `---
repo: ${repository}
number: ${number}
report_revision_sha256: ${"a".repeat(64)}
job_report_revision_sha256: ${"a".repeat(64)}
decision: already_queued
prepared_at: 2026-07-31T18:59:00.000Z
worker_dispatched: false
worker_dispatched_at: 2026-07-31T18:59:00.000Z
worker_attempt_count: 0
worker_retry_after:
---
`,
    );

    markIssueImplementationDispatched({
      root,
      auditPath,
      jobPath,
      workerCreatedAt: originalDispatch,
    });

    const markedAudit = readFileSync(path.join(root, auditPath), "utf8");
    assert.match(markedAudit, new RegExp(`worker_dispatched_at: ${originalDispatch}`));
    assert.match(markedAudit, /worker_attempt_count: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vision-fit issue implementation jobs carry vision guardrails", () => {
  const job = renderIssueImplementationJob({
    repo: "openclaw/openclaw",
    issueNumber: 124,
    title: "Improve first-run setup",
    triggerSource: REVIEW_VISION_FIT_TRIGGER_SOURCE,
    reviewReportPath: "records/openclaw-openclaw/items/124.md",
    visionFit: true,
  });

  assert.match(job, /trigger_source: review_vision_fit/);
  assert.match(job, /vision-fit issue lane/);
  assert.match(job, /target repository VISION\.md/);
  assert.match(job, /clawsweeper:autogenerated/);
  assert.match(job, /clawsweeper:autofix/);
});

test("viable issue implementation jobs enter the existing autofix loop", () => {
  const job = renderIssueImplementationJob({
    repo: "steipete/summarize",
    issueNumber: 244,
    title: "Implement reviewed issue",
    triggerSource: REVIEW_VIABLE_ISSUE_TRIGGER_SOURCE,
    reviewReportPath: "records/steipete-summarize/items/244.md",
    sourceIssueRevision: "a".repeat(64),
  });

  assert.match(job, /trigger_source: review_viable_issue/);
  assert.match(job, /source_issue_repo: "steipete\/summarize"/);
  assert.match(job, /source_issue_number: 244/);
  assert.match(job, new RegExp(`source_issue_revision_sha256: "${"a".repeat(64)}"`));
  assert.match(job, /required_pr_labels:\n  - clawsweeper:autogenerated\n  - clawsweeper:autofix/);
  assert.match(job, /Use a closing reference/);
});

test("issue implementation PR executor applies autofix and removes automerge", () => {
  const source = readText("src/repair/execute-fix-artifact.ts");

  assert.match(source, /AUTOGENERATED_LABEL/);
  assert.match(source, /addLabel\(result\.repo, number, AUTOFIX_LABEL, targetDir\)/);
  assert.match(source, /removeLabelIfPresent\(result\.repo, number, AUTOMERGE_LABEL, targetDir\)/);
  assert.match(source, /job\.frontmatter\.source === "issue_implementation"/);
});

test("generated issue PRs terminate review-only and cannot automerge", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(
    source,
    /reviewOnlyRepairLoopCompletionLabels\(command\.target\?\.labels \?\? \[\]\)/,
  );
  assert.match(source, /waiting for required checks to appear before autofix completion/);
  assert.match(source, /waiting for required checks before autofix completion/);
  assert.match(source, /required checks block autofix completion/);
  assert.match(source, /reviewOnlyRepairLoopMergeStateBlockReason/);
  assert.match(source, /autofix_complete: true/);
  assert.match(source, /if \(command\.autofix_complete && command\.issue_number\)/);
  assert.match(
    source,
    /if \(hasLabel\(target, AUTOGENERATED_LABEL\)\)\s+return "generated issue implementation PRs require manual merge"/,
  );
});

test("repair executor uses retryable blobless target checkout", () => {
  const source = readText("src/repair/execute-fix-artifact.ts");

  assert.match(source, /cloneTargetCheckout/);
  assert.match(source, /--filter=blob:none/);
  assert.match(source, /CLAWSWEEPER_CHECKOUT_CLONE_ATTEMPTS/);
  assert.match(source, /CLAWSWEEPER_CHECKOUT_CLONE_TIMEOUT_MS/);
});

test("comment router default allows one same-head infrastructure retry", () => {
  const source = readText("src/repair/config.ts");

  assert.match(source, /CLAWSWEEPER_MAX_REPAIRS_PER_HEAD \?\? 2/);
});

test("comment router rewrites existing issue implementation jobs on override", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /command\.operator_override === true/);
  assert.match(source, /fs\.writeFileSync\(\s*absolute,\s*renderIssueImplementationJob/s);
  assert.match(source, /issueImplementationJobOptions\(command\)/);
  assert.match(source, /statusDetail = "written"/);
});

test("comment router classifies protected issue build overrides as hard", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /issueImplementationOverrideBlockerClass\(command\)/);
  assert.match(source, /target\.kind === "issue" && target\.job_path/);
  assert.match(source, /issueImplementationLinkedPrSignal\(target\)/);
  assert.match(source, /issueLinkedOpenPrReferences\(issue, issueNumber\)/);
  assert.match(source, /open_prs: linkedOpenPrs/);
  assert.match(source, /addPullRequestReferenceNumbersFromText/);
  assert.match(source, /searchOpenPullRequestsMentioningIssue\(Number\(issueNumber\)\)/);
  assert.match(source, /"search\/issues",\s+"--method",\s+"GET"/);
  assert.match(source, /target\.body/);
  assert.match(source, /target\.locked === true/);
  assert.match(source, /labels\.some\(isIssueImplementationProtectedLabel\)/);
  assert.match(source, /overrideBlockerClass,\n\s+overrideAction: command\.operator_override/);
  assert.match(source, /prepare a non-mutating handoff for this issue/);
});
