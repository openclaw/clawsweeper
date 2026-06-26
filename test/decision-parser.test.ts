import assert from "node:assert/strict";
import test from "node:test";

import { parseDecision, rootCauseClusterFromReportForTest } from "../dist/clawsweeper.js";
import { closeDecision, item, reportFrontMatter } from "./helpers.ts";

test("decision parser enforces required schema-shaped evidence", () => {
  assert.equal(parseDecision(closeDecision()).decision, "close");
  assert.equal(parseDecision(closeDecision({ itemCategory: "skill" })).itemCategory, "skill");
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        evidence: [{ label: "partial", detail: "missing nullable fields" }],
      }),
    /decision\.evidence\[0\]\.file/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        likelyOwners: [],
      }),
    /decision\.likelyOwners must not be empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        likelyOwners: [{ person: "@alice", reason: "missing fields" }],
      }),
    /decision\.likelyOwners\[0\]\.role/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        workCandidate: "auto_everything",
      }),
    /decision\.workCandidate/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        itemCategory: "mixed_mode",
      }),
    /decision\.itemCategory/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        triagePriority: "urgent",
      }),
    /decision\.triagePriority/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: ["impact:unknown"],
      }),
    /decision\.impactLabels\[0\]/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: [
          "impact:data-loss",
          "impact:security",
          "impact:crash-loop",
          "impact:message-loss",
        ],
      }),
    /decision\.impactLabels must contain at most 3 labels/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        impactLabels: ["impact:data-loss", "impact:data-loss"],
      }),
    /decision\.impactLabels must not contain duplicates/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        maturityLabels: ["maturity:unknown"],
      }),
    /decision\.maturityLabels\[0\]/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        maturityLabels: ["maturity:stable", "maturity:stable"],
      }),
    /decision\.maturityLabels must contain at most 1 label/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk:unknown"],
      }),
    /decision\.mergeRiskLabels\[0\]/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: [
          "merge-risk: 🚨 compatibility",
          "merge-risk: 🚨 message-delivery",
          "merge-risk: 🚨 session-state",
          "merge-risk: 🚨 auth-provider",
        ],
      }),
    /decision\.mergeRiskLabels must contain at most 3 labels/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility", "merge-risk: 🚨 compatibility"],
      }),
    /decision\.mergeRiskLabels must not contain duplicates/,
  );
  assert.equal(
    parseDecision({
      ...closeDecision(),
      mergeRiskOptions: undefined,
    }).mergeRiskOptions.length,
    0,
  );
  assert.deepEqual(
    parseDecision({
      ...closeDecision(),
      reviewMetrics: [
        {
          label: "Files affected",
          value: "3 files affected",
          reason: "The PR touches enough files that maintainers should scan the changed surface.",
        },
      ],
    }).reviewMetrics,
    [
      {
        label: "Files affected",
        value: "3 files affected",
        reason: "The PR touches enough files that maintainers should scan the changed surface.",
      },
    ],
  );
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.reviewMetrics;
    return parseDecision(decision);
  }, /decision\.reviewMetrics must be an array/);
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        reviewMetrics: [{ label: "Files affected", value: "3 files affected" }],
      }),
    /decision\.reviewMetrics\[0\]\.reason/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskOptions: [
          {
            title: "Accept the risk",
            body: "Merge only if maintainers accept this risk.",
            category: "accept_risk",
            recommended: false,
            automergeInstruction: "",
          },
        ],
      }),
    /decision\.mergeRiskOptions must be empty when mergeRiskLabels is empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility"],
      }),
    /decision\.mergeRiskOptions must include 1-3 options when mergeRiskLabels is not empty/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 compatibility"],
        mergeRiskOptions: [
          {
            title: "Preserve behavior",
            body: "Keep the existing default behavior before merge.",
            category: "fix_before_merge",
            recommended: true,
            automergeInstruction: "Keep the existing default behavior before merge.",
          },
          {
            title: "Accept risk",
            body: "Merge only if maintainers accept the compatibility break.",
            category: "accept_risk",
            recommended: true,
            automergeInstruction: "",
          },
        ],
      }),
    /decision\.mergeRiskOptions must not contain more than one recommended option/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 security-boundary"],
        mergeRiskOptions: [
          {
            title: "Accept risk",
            body: "Merge only if maintainers accept the hardening tradeoff.",
            category: "accept_risk",
            recommended: true,
            automergeInstruction: "Merge the intentional hardening change.",
          },
        ],
      }),
    /decision\.mergeRiskOptions\[0\]\.automergeInstruction requires fix_before_merge category/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        mergeRiskLabels: ["merge-risk: 🚨 message-delivery"],
        mergeRiskOptions: [
          {
            title: "Guard delivery",
            body: "Add delivery-state tests before merge.",
            category: "fix_before_merge",
            recommended: false,
            automergeInstruction: "Add delivery-state tests before merge.",
          },
        ],
      }),
    /decision\.mergeRiskOptions\[0\]\.automergeInstruction requires a recommended option/,
  );
  assert.deepEqual(
    parseDecision(
      closeDecision({
        impactLabels: ["impact:other"],
        labelJustifications: [
          {
            label: "P2",
            reason: "Normal priority applies to this limited-scope implemented behavior check.",
          },
          {
            label: "impact:other",
            reason: "The issue has maintainer-visible impact outside the specific taxonomy.",
          },
        ],
      }),
    ).impactLabels,
    ["impact:other"],
  );
  assert.deepEqual(
    parseDecision(
      closeDecision({
        mergeRiskLabels: ["merge-risk: 🚨 other"],
        mergeRiskOptions: [
          {
            title: "Validate the uncategorized risk",
            body: "Run targeted validation for the maintainer-visible risk before merge.",
            category: "fix_before_merge",
            recommended: true,
            automergeInstruction:
              "Run targeted validation for the maintainer-visible risk before merge.",
          },
        ],
        labelJustifications: [
          {
            label: "P2",
            reason: "Normal priority applies to this limited-scope implemented behavior check.",
          },
          {
            label: "merge-risk: 🚨 other",
            reason: "The PR has a maintainer-visible merge risk outside the specific taxonomy.",
          },
        ],
      }),
    ).mergeRiskLabels,
    ["merge-risk: 🚨 other"],
  );
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.labelJustifications;
    return parseDecision(decision);
  }, /decision\.labelJustifications must be an array/);
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision({
          impactLabels: ["impact:message-loss"],
          maturityLabels: ["maturity:stable"],
          labelJustifications: [
            {
              label: "P2",
              reason: "Normal priority applies to this limited-scope implemented behavior check.",
            },
          ],
        }),
      }),
    /decision\.labelJustifications missing selected labels: impact:message-loss, maturity:stable/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision({
          labelJustifications: [
            {
              label: "P2",
              reason: "Normal priority applies to this limited-scope implemented behavior check.",
            },
            {
              label: "impact:data-loss",
              reason: "The selected labels did not include this impact area.",
            },
          ],
        }),
      }),
    /decision\.labelJustifications contains unselected labels: impact:data-loss/,
  );
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        requiresNewConfigOption: "false",
      }),
    /decision\.requiresNewConfigOption/,
  );
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.securityReview;
    return parseDecision(decision);
  }, /decision\.securityReview/);
  assert.throws(() => {
    const decision = closeDecision();
    delete decision.realBehaviorProof;
    return parseDecision(decision);
  }, /decision\.realBehaviorProof/);
  const workCandidate = parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      workCandidate: "queue_fix_pr",
      workConfidence: "high",
      workPriority: "medium",
      workReason: "The bug is narrow and reproducible.",
      workPrompt: "Fix the narrow bug and add a regression test.",
      workClusterRefs: ["#123", "#456"],
      workValidation: ["pnpm test:unit"],
      workLikelyFiles: ["src/example.ts", "test/example.test.ts"],
    }),
  );
  assert.equal(workCandidate.workCandidate, "queue_fix_pr");
  assert.equal(workCandidate.triagePriority, "P2");
  assert.equal(workCandidate.itemCategory, "bug");
  assert.equal(workCandidate.reproductionStatus, "reproduced");
  assert.equal(workCandidate.realBehaviorProof.status, "not_applicable");
  assert.deepEqual(workCandidate.workClusterRefs, ["#123", "#456"]);
});

test("decision parser validates typed root-cause clusters", () => {
  const canonicalRef = "https://github.com/openclaw/openclaw/pull/456";
  const canonicalIssueRef = "https://github.com/openclaw/openclaw/issues/456";
  const candidatePullRef = "https://github.com/openclaw/openclaw/pull/789";
  const independentRootCauseCluster = {
    confidence: "low",
    canonicalRef: null,
    currentItemRelationship: "independent",
    summary: "No evidence-backed root-cause cluster was established.",
    members: [],
  };
  const rootCauseCluster = {
    confidence: "high",
    canonicalRef,
    currentItemRelationship: "fixed_by_candidate",
    summary: "The candidate PR fixes the reproduced issue.",
    members: [
      {
        ref: canonicalRef,
        relationship: "canonical",
        reason: "The PR contains the focused fix and regression test.",
      },
    ],
  };
  const parsed = parseDecision(
    closeDecision({ rootCauseCluster }),
    item({ repo: "openclaw/openclaw", number: 123, kind: "issue" }),
  );
  assert.deepEqual(parsed.rootCauseCluster, rootCauseCluster);

  const prCandidateForCanonicalIssue = {
    confidence: "high",
    canonicalRef: canonicalIssueRef,
    currentItemRelationship: "fixed_by_candidate",
    summary: "This PR is the candidate fix for the canonical issue.",
    members: [
      {
        ref: canonicalIssueRef,
        relationship: "canonical",
        reason: "The issue tracks the underlying user-visible bug.",
      },
    ],
  };
  assert.deepEqual(
    parseDecision(
      closeDecision({ rootCauseCluster: prCandidateForCanonicalIssue }),
      item({ kind: "pull_request" }),
    ).rootCauseCluster,
    prCandidateForCanonicalIssue,
  );

  const canonicalIssueWithCandidateMember = {
    confidence: "high",
    canonicalRef: "https://github.com/openclaw/openclaw/issues/123",
    currentItemRelationship: "canonical",
    summary: "The issue is canonical and has an open candidate fix PR.",
    members: [
      {
        ref: candidatePullRef,
        relationship: "fixed_by_candidate",
        reason: "The PR carries the candidate fix for this canonical issue.",
      },
    ],
  };
  assert.deepEqual(
    parseDecision(closeDecision({ rootCauseCluster: canonicalIssueWithCandidateMember }), item())
      .rootCauseCluster,
    canonicalIssueWithCandidateMember,
  );

  const invalidRootCauseClusters = [
    {
      ...rootCauseCluster,
      members: [...rootCauseCluster.members, ...rootCauseCluster.members],
    },
    {
      ...rootCauseCluster,
      canonicalRef: "https://github.com/other/repo/pull/456",
      members: [
        {
          ...rootCauseCluster.members[0],
          ref: "https://github.com/other/repo/pull/456",
        },
      ],
    },
    {
      ...rootCauseCluster,
      members: [
        ...rootCauseCluster.members,
        {
          ref: "https://github.com/openclaw/openclaw/issues/789",
          relationship: "canonical",
          reason: "A conflicting second canonical item.",
        },
      ],
    },
    {
      ...rootCauseCluster,
      members: [
        {
          ...rootCauseCluster.members[0],
          ref: "https://github.com/openclaw/openclaw/pull/789",
        },
      ],
    },
    {
      ...rootCauseCluster,
      canonicalRef: canonicalIssueRef,
      members: [
        {
          ...rootCauseCluster.members[0],
          ref: canonicalIssueRef,
        },
      ],
    },
    {
      ...canonicalIssueWithCandidateMember,
      members: [
        {
          ref: "https://github.com/openclaw/openclaw/issues/789",
          relationship: "fixed_by_candidate",
          reason: "Issue-to-issue candidate-fix labels are not meaningful.",
        },
      ],
    },
    {
      ...rootCauseCluster,
      members: [
        {
          ref: "https://github.com/openclaw/openclaw/issues/123",
          relationship: "canonical",
          reason: "Incorrectly repeats the current item.",
        },
      ],
      canonicalRef: "https://github.com/openclaw/openclaw/issues/123",
      currentItemRelationship: "duplicate",
    },
    {
      ...rootCauseCluster,
      members: [
        {
          ref: "https://github.com/OpenClaw/OpenClaw/issues/123",
          relationship: "canonical",
          reason: "Incorrectly repeats the current item with different casing.",
        },
      ],
      canonicalRef: "https://github.com/OpenClaw/OpenClaw/issues/123",
      currentItemRelationship: "duplicate",
    },
    {
      ...rootCauseCluster,
      members: [
        rootCauseCluster.members[0],
        {
          ...rootCauseCluster.members[0],
          ref: "https://github.com/OpenClaw/OpenClaw/pull/456",
        },
      ],
    },
  ];

  for (const invalidRootCauseCluster of invalidRootCauseClusters) {
    assert.deepEqual(
      parseDecision(
        closeDecision({
          rootCauseCluster: invalidRootCauseCluster,
        }),
        item(),
      ).rootCauseCluster,
      independentRootCauseCluster,
    );
  }
});

test("root-cause report parsing defaults legacy and malformed reports safely", () => {
  assert.deepEqual(rootCauseClusterFromReportForTest(reportFrontMatter({ number: "123" })), {
    confidence: "low",
    canonicalRef: null,
    currentItemRelationship: "independent",
    summary: "No evidence-backed root-cause cluster was established.",
    members: [],
  });
  assert.deepEqual(
    rootCauseClusterFromReportForTest(
      reportFrontMatter({
        number: "123",
        root_cause_cluster: "{not-json",
      }),
    ),
    {
      confidence: "low",
      canonicalRef: null,
      currentItemRelationship: "independent",
      summary: "No evidence-backed root-cause cluster was established.",
      members: [],
    },
  );
  const valid = {
    confidence: "high",
    canonicalRef: "https://github.com/openclaw/openclaw/issues/456",
    currentItemRelationship: "duplicate",
    summary: "The other issue is the canonical report.",
    members: [
      {
        ref: "https://github.com/openclaw/openclaw/issues/456",
        relationship: "canonical",
        reason: "It has the complete reproduction and accepted scope.",
      },
    ],
  };
  assert.deepEqual(
    rootCauseClusterFromReportForTest(
      reportFrontMatter({
        number: "123",
        root_cause_cluster: JSON.stringify(valid),
      }),
    ),
    valid,
  );
});
