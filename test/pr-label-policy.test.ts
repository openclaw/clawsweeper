import assert from "node:assert/strict";
import test from "node:test";

import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "../dist/clawsweeper-label-operations.js";
import {
  hasRecentReReviewRequest,
  hasRepairLoopPauseLabel,
  nextFeatureShowcaseLabels,
  nextPrStatusLabels,
  prStatusLabelKind,
  prStatusLabelKindFromReport,
} from "../dist/clawsweeper-label-policy.js";
import {
  nextImpactLabels,
  nextIssueAdvisoryLabels,
  nextMaturityLabels,
  nextMergeRiskLabels,
  nextPriorityLabels,
  nextTelegramVisibleProofLabels,
} from "../dist/clawsweeper-label-selection.js";
import {
  IMPACT_LABELS,
  LIVE_VERIFICATION_MARKER,
  MATURITY_LABELS,
  MERGE_RISK_LABELS,
  PR_RATING_LABELS,
  PR_STATUS_LABELS,
  PRIORITY_LABELS,
} from "../dist/clawsweeper-policy.js";
import { reportRealBehaviorProofPolicy } from "../dist/clawsweeper-proof-policy.js";
import { nextPrRatingLabels } from "../dist/clawsweeper-rating.js";
import { reportAttachedLiveVerification } from "../dist/live-proof/report.js";
import { syncApplyPullRequestLabels } from "../dist/clawsweeper-apply-pull-request-labels.js";
import type {
  LiveProofPlan,
  MergeRiskOption,
  PublicBeforeMergeItem,
} from "../dist/clawsweeper-types.js";
import {
  buildLiveVerificationResult,
  encodeLiveVerificationReportPayload,
} from "../dist/live-proof/verification.js";
import {
  labelJustificationsMarkdownForTest,
  parseDecision,
  reviewDecisionSchemaText,
} from "../dist/clawsweeper.js";
import { goodFirstIssueHumanLabelState } from "../dist/clawsweeper-context-hydration.js";
import {
  closeDecision,
  item,
  legacyLiveProofSection,
  pullRequestProofReport,
  realBehaviorProofReportSection,
  reportFrontMatter,
  reviewPrompt,
} from "./helpers.ts";

const noActivity = { comments: [], timeline: [] };

// Label sync that records each gh command and reads an empty label catalog.
function recordingLabelSync(commands: string[][]) {
  return createLabelSyncOperations(
    createLabelMutationOperations({
      ghJson: <T>(): T => [] as T,
      ghObservedMutationCommand: ({ args }) => {
        commands.push(args);
        return "";
      },
    }),
  );
}

function labelScheme(labels: readonly { name: string; color: string; description: string }[]) {
  return labels.map(({ name, color, description }) => ({ name, color, description }));
}

function featureShowcaseLabels(
  labels: readonly string[],
  options: {
    itemCategory: string;
    status: "showcase" | "none";
    securityReviewStatus: "cleared" | "needs_attention";
    overallCorrectness: "patch is correct" | "patch is incorrect";
  },
): string[] {
  return nextFeatureShowcaseLabels(labels, {
    isPullRequest: true,
    itemCategory: options.itemCategory,
    requiresNewFeature: false,
    showcase: {
      status: options.status,
      reason: options.status === "showcase" ? "This is a high-signal feature idea." : "",
    },
    securityReview: { status: options.securityReviewStatus },
    overallCorrectness: options.overallCorrectness,
  });
}

// Applies the status that the label policy picks for these typed review facts.
function prStatusLabels(
  labels: readonly string[],
  options: {
    isPullRequest?: boolean;
    proofStatus?: string;
    needsContributorAction?: boolean;
    beforeMergeItems?: readonly PublicBeforeMergeItem["state"][];
    securityStatus?: "cleared" | "needs_attention";
    mergeRiskOptions?: readonly Pick<MergeRiskOption, "category" | "recommended">[];
    hasAutomergeLabel?: boolean;
    hasRecentReReviewRequest?: boolean;
    hasRecentAuthorActivity?: boolean;
    reviewedAt?: string;
    comments?: readonly {
      author?: string;
      body?: string;
      createdAt?: string;
      updatedAt?: string;
    }[];
  },
): string[] {
  if (options.isPullRequest === false) return nextPrStatusLabels(labels, null);
  const unresolvedProof = ["missing", "mock_only", "insufficient"].includes(
    options.proofStatus ?? "",
  );
  return nextPrStatusLabels(
    labels,
    prStatusLabelKind({
      reviewFailed: false,
      proofPolicy: {
        blocksMerge: unresolvedProof,
        needsContributorAction: unresolvedProof && (options.needsContributorAction ?? true),
      },
      beforeMergeItems: (options.beforeMergeItems ?? []).map((state) => ({ state })),
      securityReview: { status: options.securityStatus ?? "cleared" },
      mergeRiskOptions: options.mergeRiskOptions ?? [],
      hasAutomergeLabel: options.hasAutomergeLabel ?? labels.includes("clawsweeper:automerge"),
      hasRepairLoopPauseLabel: hasRepairLoopPauseLabel(labels),
      hasRecentReReviewRequest:
        options.hasRecentReReviewRequest ??
        hasRecentReReviewRequest(
          { comments: [...(options.comments ?? [])] },
          options.reviewedAt ?? "2026-01-01T00:00:00Z",
        ),
      hasRecentAuthorActivity: options.hasRecentAuthorActivity === true,
    }),
  );
}

for (const proofStatus of ["missing", "not_applicable"] as const) {
  test(`failed ${proofStatus} reports remove positive statuses through apply label sync`, () => {
    const oldStatuses = ["status: 🚀 automerge armed", "status: 👀 ready for maintainer look"];
    for (const [extraLabels, comment, incorrect, expected] of [
      [["clawsweeper:automerge"], "", false, null],
      [[], "", false, null],
      [["clawsweeper:human-review"], "@clawsweeper re-review", false, null],
      [["clawsweeper:manual-only"], "", false, null],
      [["clawsweeper:merge-ready"], "", false, null],
      [[], "@clawsweeper re-review", false, "re_review_loop"],
      [[], "Working on the remaining finding", true, "actively_grinding"],
    ] as const) {
      const labels = [...oldStatuses, ...extraLabels];
      const report = `${reportFrontMatter({
        type: "pull_request",
        number: "74466",
        review_status: "failed",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        reviewed_at: "2026-08-30T12:00:00Z",
        labels: JSON.stringify(labels),
      })}
${realBehaviorProofReportSection({
  status: proofStatus,
  evidenceKind: proofStatus === "missing" ? "none" : "not_applicable",
  needsContributorAction: proofStatus === "missing",
  summary: "Retained proof assessment from an incomplete review.",
})}
## Review Findings

Overall correctness: ${incorrect ? "patch is incorrect" : "patch is correct"}

Full review comments:

- none
`;
      const context = {
        comments: comment
          ? [{ author: "contributor", body: comment, createdAt: "2026-08-30T13:00:00Z" }]
          : [],
        timeline: [],
      };
      const commands: string[][] = [];
      const result = syncApplyPullRequestLabels(
        {
          ...recordingLabelSync(commands),
          syncStalePullRequestReviewLabels: () => assert.fail("the review head is current"),
        },
        {
          markdown: report,
          item: item({ kind: "pull_request", labels }),
          number: 74466,
          currentItemContext: () => context as never,
          dryRun: false,
          labelSyncFreshEnough: () => true,
          staleReviewHead: null,
          onMutation: () => {},
        },
      );
      assert.equal(result.currentPrStatusKind, expected);
      assert.equal(prStatusLabelKindFromReport(report, context, labels), expected);
      assert.equal(reportRealBehaviorProofPolicy(report).blocksMerge, false);
      for (const oldStatus of oldStatuses) {
        assert.ok(!result.labels.includes(oldStatus), oldStatus);
        assert.ok(
          commands.some((args) => args.includes("--remove-label") && args.includes(oldStatus)),
          oldStatus,
        );
      }
      assert.ok(!result.labels.includes("status: 📣 needs proof"));
      assert.ok(
        !commands.some(
          (args) => args.includes("--add-label") && args.some((arg) => oldStatuses.includes(arg)),
        ),
      );
      assert.equal(result.markdown, report);
    }
  });
}

test("report-based status selection follows the model proof assessment for external PRs", () => {
  for (const path of ["README.md", "src/arbitrary.ts"]) {
    for (const [proof, needsProof] of [
      [
        { status: "not_applicable", evidenceKind: "not_applicable", needsContributorAction: false },
        false,
      ],
      [{ status: "missing", evidenceKind: "none", needsContributorAction: true }, true],
    ] as const) {
      const report = `${reportFrontMatter({
        type: "pull_request",
        review_status: "complete",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        pull_files: JSON.stringify([path]),
        pull_files_truncated: false,
        reviewed_at: "2026-08-30T12:00:00Z",
      })}
${realBehaviorProofReportSection({ ...proof, summary: "Recorded reviewer assessment." })}`;
      const statusKind = prStatusLabelKindFromReport(report, noActivity, ["clawsweeper:automerge"]);
      if (needsProof) assert.equal(statusKind, "needs_proof", path);
      else assert.notEqual(statusKind, "needs_proof", path);
    }
  }
});

test("ClawSweeper PR rating labels use one themed overall label", () => {
  assert.deepEqual(nextPrRatingLabels(["bug"], { overallTier: "A" }), [
    "bug",
    "rating: 🦞 diamond lobster",
  ]);
  assert.deepEqual(
    nextPrRatingLabels(["rating: 🦀 challenger crab", "bug", "rating: 🦐 gold shrimp"], {
      overallTier: "D",
    }),
    ["bug", "rating: 🦪 silver shellfish"],
  );
  assert.deepEqual(nextPrRatingLabels(["bug"], { overallTier: "NA" }), [
    "bug",
    "rating: 🌊 off-meta tidepool",
  ]);
  assert.deepEqual(
    nextPrRatingLabels(["bug", "rating: 🌊 off-meta tidepool"], { overallTier: "NA" }, true),
    ["bug"],
  );
});

test("ClawSweeper PR rating label scheme exposes boring internal tiers", () => {
  assert.deepEqual(
    PR_RATING_LABELS.map(({ tier, name, color }) => ({ tier, name, color })),
    [
      { tier: "S", name: "rating: 🦀 challenger crab", color: "1F883D" },
      { tier: "A", name: "rating: 🦞 diamond lobster", color: "0969DA" },
      { tier: "B", name: "rating: 🐚 platinum hermit", color: "0F766E" },
      { tier: "C", name: "rating: 🦐 gold shrimp", color: "B7791F" },
      { tier: "D", name: "rating: 🦪 silver shellfish", color: "7A828E" },
      { tier: "F", name: "rating: 🧂 unranked krab", color: "8C2F39" },
      { tier: "NA", name: "rating: 🌊 off-meta tidepool", color: "6E7781" },
    ],
  );
});

test("ClawSweeper feature showcase label is positive-only and high signal", () => {
  assert.deepEqual(
    featureShowcaseLabels(["enhancement"], {
      itemCategory: "feature",
      status: "showcase",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement", "feature: ✨ showcase"],
  );
  assert.deepEqual(
    featureShowcaseLabels(["enhancement"], {
      itemCategory: "feature",
      status: "none",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement"],
  );
  assert.deepEqual(
    featureShowcaseLabels(["feature: ✨ showcase"], {
      itemCategory: "feature",
      status: "none",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["feature: ✨ showcase"],
  );
});

test("ClawSweeper feature showcase label does not apply to unsafe or non-feature PRs", () => {
  assert.deepEqual(
    featureShowcaseLabels(["bug"], {
      itemCategory: "bug",
      status: "showcase",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["bug"],
  );
  assert.deepEqual(
    featureShowcaseLabels(["enhancement"], {
      itemCategory: "feature",
      status: "showcase",
      securityReviewStatus: "needs_attention",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement"],
  );
  assert.deepEqual(
    featureShowcaseLabels(["enhancement"], {
      itemCategory: "feature",
      status: "showcase",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is incorrect",
    }),
    ["enhancement"],
  );
});

test("ClawSweeper PR status labels use one current workflow status", () => {
  assert.deepEqual(
    prStatusLabels(["bug", "status: ⏳ waiting on author"], {
      beforeMergeItems: ["needs-changes"],
      hasRecentAuthorActivity: true,
    }),
    ["bug", "status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabels(["bug", "status: 🛠️ actively grinding"], {
      proofStatus: "sufficient",
    }),
    ["bug", "status: 👀 ready for maintainer look"],
  );
});

test("ClawSweeper PR status is ready only when Before merge lists no item", () => {
  const readyLabel = "status: 👀 ready for maintainer look";
  assert.deepEqual(prStatusLabels([readyLabel], { beforeMergeItems: [] }), [readyLabel]);
  assert.deepEqual(prStatusLabels([readyLabel], { beforeMergeItems: ["blocked"] }), []);
  assert.deepEqual(prStatusLabels([readyLabel], { beforeMergeItems: ["needs-changes"] }), [
    "status: ⏳ waiting on author",
  ]);
  // A maintainer-owned security acceptance is still a Before-merge item.
  assert.deepEqual(
    prStatusLabels([readyLabel], {
      proofStatus: "sufficient",
      securityStatus: "needs_attention",
      mergeRiskOptions: [{ category: "accept_risk", recommended: true }],
      beforeMergeItems: ["blocked"],
    }),
    [],
  );
  for (const mergeRiskOptions of [[{ category: "fix_before_merge", recommended: true }], []]) {
    assert.deepEqual(
      prStatusLabels([], {
        proofStatus: "sufficient",
        securityStatus: "needs_attention",
        mergeRiskOptions,
        beforeMergeItems: ["blocked"],
      }),
      ["status: ⏳ waiting on author"],
    );
  }
});

test("unresolved proof routes contributors and maintainers to distinct owners", () => {
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge"], {
      proofStatus: "insufficient",
      needsContributorAction: true,
    }),
    ["clawsweeper:automerge", "status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge"], {
      proofStatus: "insufficient",
      needsContributorAction: false,
    }),
    ["clawsweeper:automerge", "status: needs maintainer proof decision"],
  );
});

test("historical receipt failures route to the proof owner without erasing independent proof", () => {
  const headSha = "abc123def456abc123def456abc123def456abcd";
  const plan: LiveProofPlan = {
    status: "recommended",
    surface: "terminal",
    terminalCompletion: "exit_zero",
    reason: "Run the changed command once.",
    payoff: { kind: "static_text", justification: "The command output shows the behavior." },
    entry: "synthetic-command",
    steps: [
      { action: "run", command: "synthetic-command" },
      { action: "expect_output", text: "Synthetic output." },
    ],
  };
  const receipt = (status: "completed" | "failed") =>
    `${LIVE_VERIFICATION_MARKER}\nResult: ${encodeLiveVerificationReportPayload(
      buildLiveVerificationResult({
        repo: "openclaw/openclaw",
        item: 119610,
        headSha,
        plan,
        driveStatus: status,
        stepLog: plan.steps.map((step) => ({
          action: step.action,
          status,
          detail: "Synthetic outcome.",
          presentAtStart: false,
          satisfied: status === "completed",
        })),
        output: "Synthetic output.",
        verifiedAt: "2026-08-27T00:00:00.000Z",
      }),
    )}`;
  const receipts = {
    absent: "",
    passed: receipt("completed"),
    failed: receipt("failed"),
    malformed: `${LIVE_VERIFICATION_MARKER}\nResult: invalid!`,
  };

  for (const reviewFailed of [false, true]) {
    for (const receiptStatus of ["absent", "passed", "failed", "malformed"] as const) {
      for (const needsContributorAction of [false, true]) {
        const report = pullRequestProofReport({
          author: "contributor",
          association: "CONTRIBUTOR",
          status: needsContributorAction ? "missing" : "sufficient",
          frontMatter: {
            repository: "openclaw/openclaw",
            pull_head_sha: headSha,
            reviewed_at: "2026-08-27T12:00:00.000Z",
            review_status: reviewFailed ? "failed" : "complete",
          },
          sections: `## Live Proof\n\n${legacyLiveProofSection(plan)}${
            receipts[receiptStatus] ? `\n\n${receipts[receiptStatus]}` : ""
          }\n\n`,
        });
        const context = `${receiptStatus}: contributor action=${needsContributorAction}, failed review=${reviewFailed}`;
        assert.equal(reportAttachedLiveVerification(report).status, receiptStatus, context);
        assert.equal(
          prStatusLabelKindFromReport(report, noActivity, ["clawsweeper:automerge"]),
          needsContributorAction && !reviewFailed
            ? "needs_proof"
            : receiptStatus === "failed" || receiptStatus === "malformed"
              ? "needs_maintainer_proof_decision"
              : reviewFailed
                ? null
                : "automerge_armed",
          context,
        );
      }
    }
  }
});

test("ClawSweeper PR status labels preserve other label families", () => {
  assert.deepEqual(
    prStatusLabels(
      [
        "rating: 🦞 diamond lobster",
        "merge-risk: 🚨 compatibility",
        "proof: sufficient",
        "status: custom-user-label",
      ],
      {
        proofStatus: "missing",
      },
    ),
    [
      "rating: 🦞 diamond lobster",
      "merge-risk: 🚨 compatibility",
      "proof: sufficient",
      "status: custom-user-label",
      "status: 📣 needs proof",
    ],
  );
});

test("ClawSweeper PR status labels respect priority ordering", () => {
  const automergeArmedLabel = PR_STATUS_LABELS.find(
    (label) => label.kind === "automerge_armed",
  )?.name;
  const reReviewLabel = PR_STATUS_LABELS.find((label) => label.kind === "re_review_loop")?.name;
  assert.ok(automergeArmedLabel);
  assert.ok(reReviewLabel);
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge"], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", reReviewLabel],
  );
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge", "clawsweeper:human-review", automergeArmedLabel], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", "clawsweeper:human-review"],
  );
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge", "clawsweeper:merge-ready", automergeArmedLabel], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", "clawsweeper:merge-ready"],
  );
  assert.deepEqual(
    prStatusLabels(["clawsweeper:automerge", "clawsweeper:manual-only", automergeArmedLabel], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", "clawsweeper:manual-only"],
  );
  assert.deepEqual(
    prStatusLabels([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
      hasRecentReReviewRequest: true,
    }),
    ["status: 🔁 re-review loop"],
  );
  assert.deepEqual(
    prStatusLabels([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
    }),
    ["status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabels([], {
      proofStatus: "missing",
    }),
    ["status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabels([], {
      beforeMergeItems: ["needs-changes"],
    }),
    ["status: ⏳ waiting on author"],
  );
});

test("ClawSweeper PR status ignores bot-authored re-review guidance", () => {
  assert.deepEqual(
    prStatusLabels([], {
      proofStatus: "missing",
      reviewedAt: "2026-01-01T00:00:00Z",
      comments: [
        {
          author: "openclaw-clawsweeper[bot]",
          body: "After adding proof, comment `@clawsweeper re-review`.",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      ],
    }),
    ["status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabels([], {
      proofStatus: "missing",
      reviewedAt: "2026-01-01T00:00:00Z",
      comments: [
        {
          author: "contributor",
          body: "@clawsweeper re-review",
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    }),
    ["status: 🔁 re-review loop"],
  );
});

test("ClawSweeper PR status labels are PR-only", () => {
  assert.deepEqual(
    prStatusLabels(["bug", "status: ⏳ waiting on author"], {
      isPullRequest: false,
    }),
    ["bug"],
  );
});

test("ClawSweeper PR status label scheme exposes workflow states", () => {
  assert.deepEqual(
    PR_STATUS_LABELS.map(({ kind, name, color }) => ({ kind, name, color })),
    [
      { kind: "automerge_armed", name: "status: 🚀 automerge armed", color: "0E8A16" },
      { kind: "re_review_loop", name: "status: 🔁 re-review loop", color: "8250DF" },
      { kind: "actively_grinding", name: "status: 🛠️ actively grinding", color: "0969DA" },
      { kind: "needs_proof", name: "status: 📣 needs proof", color: "D93F0B" },
      {
        kind: "needs_maintainer_proof_decision",
        name: "status: needs maintainer proof decision",
        color: "D93F0B",
      },
      { kind: "waiting_on_author", name: "status: ⏳ waiting on author", color: "FBCA04" },
      {
        kind: "ready_for_maintainer_look",
        name: "status: 👀 ready for maintainer look",
        color: "2DA44E",
      },
    ],
  );
});

test("ClawSweeper Telegram proof judgement controls the E2E proof label", () => {
  assert.deepEqual(nextTelegramVisibleProofLabels(["channel: telegram"], { status: "needed" }), [
    "channel: telegram",
    "proof: telegram-e2e",
  ]);
  assert.deepEqual(
    nextTelegramVisibleProofLabels(["channel: telegram", "proof: telegram-e2e"], {
      status: "not_needed",
    }),
    ["channel: telegram"],
  );
  assert.deepEqual(
    nextTelegramVisibleProofLabels(["channel: telegram", "mantis: telegram-visible-proof"], {
      status: "needed",
    }),
    ["channel: telegram", "proof: telegram-e2e"],
  );
  assert.deepEqual(
    nextTelegramVisibleProofLabels(["channel: telegram", "mantis: telegram-visible-proof"], {
      status: "not_needed",
    }),
    ["channel: telegram"],
  );
});

test("ClawSweeper replaces the legacy Telegram proof label during synchronization", () => {
  const commands: string[][] = [];
  const labels = recordingLabelSync(commands);

  labels.syncTelegramVisibleProofLabel({
    number: 42,
    labels: ["channel: telegram", "mantis: telegram-visible-proof"],
    proof: { status: "needed" },
    dryRun: false,
  });

  assert.deepEqual(commands, [
    [
      "label",
      "create",
      "proof: telegram-e2e",
      "--color",
      "57606A",
      "--description",
      "This PR needs Telegram Test Server proof with the repository E2E skill.",
    ],
    ["issue", "edit", "42", "--add-label", "proof: telegram-e2e"],
    ["issue", "edit", "42", "--remove-label", "mantis: telegram-visible-proof"],
  ]);
});

test("ClawSweeper priority label scheme exposes P0 through P3 labels", () => {
  assert.deepEqual(labelScheme(PRIORITY_LABELS), [
    {
      name: "P0",
      color: "B60205",
      description: "Emergency: data loss, security bypass, crash loop, or unusable core runtime.",
    },
    {
      name: "P1",
      color: "D93F0B",
      description: "Urgent regression or broken agent/channel workflow affecting real users now.",
    },
    {
      name: "P2",
      color: "FBCA04",
      description: "Normal priority bug or improvement with limited blast radius.",
    },
    {
      name: "P3",
      color: "8C959F",
      description: "Low-risk cleanup, docs, polish, ergonomics, or speculative feature.",
    },
  ]);
});

test("ClawSweeper priority label descriptions fit GitHub label limits", () => {
  for (const label of labelScheme(PRIORITY_LABELS)) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper priority label descriptions live in the schema only", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      triagePriority?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.triagePriority?.description ?? "";
  const prompt = `${reviewPrompt("issue")}\n${reviewPrompt("pull_request")}`;
  for (const label of labelScheme(PRIORITY_LABELS)) {
    assert.ok(
      !prompt.includes(`\`${label.name}\`: `),
      `${label.name} description is restated in the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper priority labels follow triage priority", () => {
  assert.deepEqual(nextPriorityLabels(["bug"], "P2"), ["bug", "P2"]);
  assert.deepEqual(nextPriorityLabels(["bug", "P3"], "P1"), ["bug", "P1"]);
  assert.deepEqual(nextPriorityLabels(["P0", "bug"], "none"), ["bug"]);
});

test("ClawSweeper label justifications render selected label reasons", () => {
  assert.equal(
    labelJustificationsMarkdownForTest([
      {
        label: "P1",
        reason: "The PR changes an active channel workflow affecting real users.",
      },
      {
        label: "impact:message-loss",
        reason: "The diff touches message retry and delivery ordering.",
      },
      {
        label: "merge-risk: 🚨 compatibility",
        reason: "Merging changes the default upgrade behavior for existing configs.",
      },
    ]),
    [
      "- `P1`: The PR changes an active channel workflow affecting real users.",
      "- `impact:message-loss`: The diff touches message retry and delivery ordering.",
      "- `merge-risk: 🚨 compatibility`: Merging changes the default upgrade behavior for existing configs.",
    ].join("\n"),
  );
});

test("ClawSweeper impact label scheme exposes owned impact labels", () => {
  assert.deepEqual(labelScheme(IMPACT_LABELS), [
    {
      name: "impact:data-loss",
      color: "B60205",
      description:
        "This issue is about lost, corrupted, or silently dropped user/session/config data.",
    },
    {
      name: "impact:security",
      color: "B60205",
      description:
        "This issue is about security boundaries, credentials, authz, sandboxing, or sensitive data.",
    },
    {
      name: "impact:crash-loop",
      color: "D93F0B",
      description:
        "This issue is about crashes, hangs, restart loops, or process-level availability.",
    },
    {
      name: "impact:message-loss",
      color: "D93F0B",
      description:
        "This issue is about lost, duplicated, misrouted, or suppressed channel messages.",
    },
    {
      name: "impact:session-state",
      color: "F9D65C",
      description:
        "This issue is about session, memory, transcript, context, or agent state drift.",
    },
    {
      name: "impact:auth-provider",
      color: "F9D65C",
      description:
        "This issue is about auth, provider routing, model choice, or SecretRef resolution.",
    },
    {
      name: "impact:ux-release-blocker",
      color: "B60205",
      description: "A non-technical user is blocked without terminal, logs, config, or support.",
    },
    {
      name: "impact:ux-friction",
      color: "FBCA04",
      description:
        "User-facing flow adds avoidable confusion or support burden without fully blocking progress.",
    },
    {
      name: "impact:other",
      color: "C5DEF5",
      description:
        "This issue has meaningful maintainer-visible impact outside the owned taxonomy.",
    },
  ]);
});

test("ClawSweeper impact label descriptions fit GitHub label limits", () => {
  for (const label of labelScheme(IMPACT_LABELS)) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper impact label descriptions live in the schema only", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.impactLabels?.description ?? "";
  const prompt = `${reviewPrompt("issue")}\n${reviewPrompt("pull_request")}`;
  for (const label of labelScheme(IMPACT_LABELS)) {
    assert.ok(
      !prompt.includes(`\`${label.name}\`: `),
      `${label.name} description is restated in the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper impact label schema avoids unsupported response-format keywords", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: Record<string, unknown>;
    };
  };
  assert.equal(schema.properties?.impactLabels?.uniqueItems, undefined);
});

test("review prompt and schema define UX release-blocker override", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: {
        items?: {
          enum?: string[];
        };
      };
      labelJustifications?: {
        items?: {
          properties?: {
            label?: {
              enum?: string[];
            };
          };
        };
      };
    };
  };
  const impactLabelEnum = schema.properties?.impactLabels?.items?.enum ?? [];
  const justificationLabelEnum =
    schema.properties?.labelJustifications?.items?.properties?.label?.enum ?? [];

  assert.ok(impactLabelEnum.includes("impact:ux-release-blocker"));
  assert.ok(impactLabelEnum.includes("impact:ux-friction"));
  assert.ok(justificationLabelEnum.includes("impact:ux-release-blocker"));
  assert.ok(justificationLabelEnum.includes("impact:ux-friction"));
});

test("ClawSweeper merge-risk label scheme exposes PR-only merge warning labels", () => {
  assert.deepEqual(labelScheme(MERGE_RISK_LABELS), [
    {
      name: "merge-risk: 🚨 compatibility",
      color: "D1242F",
      description:
        "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
    },
    {
      name: "merge-risk: 🚨 message-delivery",
      color: "D1242F",
      description:
        "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
    },
    {
      name: "merge-risk: 🚨 session-state",
      color: "F97316",
      description:
        "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
    },
    {
      name: "merge-risk: 🚨 auth-provider",
      color: "F97316",
      description:
        "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
    },
    {
      name: "merge-risk: 🚨 security-boundary",
      color: "B60205",
      description:
        "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
    },
    {
      name: "merge-risk: 🚨 availability",
      color: "D93F0B",
      description:
        "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
    },
    {
      name: "merge-risk: 🚨 automation",
      color: "FBCA04",
      description:
        "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
    },
    {
      name: "merge-risk: 🚨 other",
      color: "C5DEF5",
      description: "🚨 Merging this PR has meaningful risk outside the owned taxonomy.",
    },
  ]);
});

test("ClawSweeper merge-risk label descriptions fit GitHub label limits", () => {
  for (const label of labelScheme(MERGE_RISK_LABELS)) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper merge-risk label descriptions live in the schema only", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      mergeRiskLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.mergeRiskLabels?.description ?? "";
  const prompt = `${reviewPrompt("issue")}\n${reviewPrompt("pull_request")}`;
  for (const label of labelScheme(MERGE_RISK_LABELS)) {
    assert.ok(
      !prompt.includes(`\`${label.name}\`: `),
      `${label.name} description is restated in the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("ClawSweeper merge-risk labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    nextMergeRiskLabels(
      ["bug", "merge-risk: 🚨 compatibility", "merge-risk: 🚨 availability", "impact:message-loss"],
      ["merge-risk: 🚨 message-delivery", "merge-risk: 🚨 other", "not-a-merge-risk-label"],
    ),
    ["bug", "impact:message-loss", "merge-risk: 🚨 message-delivery", "merge-risk: 🚨 other"],
  );
  assert.deepEqual(nextMergeRiskLabels(["bug", "merge-risk: 🚨 auth-provider"], []), ["bug"]);
});

test("ClawSweeper impact labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    nextImpactLabels(
      ["bug", "impact:data-loss", "impact:security", "proof: sufficient", "P1"],
      ["impact:message-loss", "impact:other", "not-an-impact-label"],
    ),
    ["bug", "proof: sufficient", "P1", "impact:message-loss", "impact:other"],
  );
  assert.deepEqual(nextImpactLabels(["bug", "impact:auth-provider"], []), ["bug"]);
});

test("ClawSweeper maturity labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(labelScheme(MATURITY_LABELS), [
    {
      name: "maturity:stable",
      color: "1F883D",
      description: "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
    },
  ]);
  assert.deepEqual(nextMaturityLabels(["bug"], ["maturity:stable"]), ["bug", "maturity:stable"]);
  assert.deepEqual(nextMaturityLabels(["bug", "maturity:stable", "impact:security"], []), [
    "bug",
    "impact:security",
  ]);
});

test("ClawSweeper updates each managed label category before applying it", () => {
  for (const [method, field, label] of [
    ["syncImpactLabels", "impactLabels", "impact:data-loss"],
    ["syncMaturityLabels", "maturityLabels", "maturity:stable"],
    ["syncMergeRiskLabels", "mergeRiskLabels", "merge-risk: 🚨 session-state"],
  ] as const) {
    const commands: string[][] = [];
    const labels = recordingLabelSync(commands);

    const result = labels[method]({
      number: 42,
      labels: ["bug"],
      [field]: [label],
      dryRun: false,
    } as never);

    assert.deepEqual(result, { labels: ["bug", label], changed: true });
    assert.deepEqual(
      commands.map((args) => args.slice(0, 3)),
      [
        ["label", "create", label],
        ["issue", "edit", "42"],
      ],
    );
    if (method !== "syncMaturityLabels") continue;
    assert.deepEqual(commands[0], [
      "label",
      "create",
      "maturity:stable",
      "--force",
      "--color",
      "1F883D",
      "--description",
      "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
    ]);
  }
});

test("ClawSweeper impact labels do not alter PR review finding priorities", () => {
  const decision = parseDecision(
    closeDecision({
      impactLabels: ["impact:data-loss", "impact:security"],
      maturityLabels: ["maturity:stable"],
      labelJustifications: [
        {
          label: "P2",
          reason: "Normal priority applies to this limited-scope implemented behavior check.",
        },
        {
          label: "impact:data-loss",
          reason: "The selected labels include a data-loss impact classification.",
        },
        {
          label: "impact:security",
          reason: "The selected labels include a security impact classification.",
        },
        {
          label: "maturity:stable",
          reason: "taxonomy feature agent-session is currently scored M4.",
        },
      ],
      reviewFindings: [
        {
          title: "A concrete review finding",
          body: "This remains a PR review finding priority, not an impact label.",
          priority: 1,
          confidenceScore: 0.9,
          file: "src/example.ts",
          lineStart: 10,
          lineEnd: 10,
        },
      ],
    }),
  );
  assert.deepEqual(decision.impactLabels, ["impact:data-loss", "impact:security"]);
  assert.deepEqual(decision.maturityLabels, ["maturity:stable"]);
  assert.equal(decision.reviewFindings[0]?.priority, 1);
});

test("ClawSweeper issue advisory labels expose high-confidence reproduction state", () => {
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦀 challenger crab", "clawsweeper:current-main-repro"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦞 diamond lobster", "clawsweeper:source-repro"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "not_reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:not-repro-on-main"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit", "clawsweeper:needs-live-repro"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      reproductionStatus: "unclear",
      reproductionConfidence: "low",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:needs-info"],
  );
});

test("ClawSweeper issue advisory labels expose work-lane routing state", () => {
  assert.deepEqual(
    nextIssueAdvisoryLabels(["clawsweeper"], {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "high",
      hasWorkShape: true,
    }),
    [
      "clawsweeper",
      "no-stale",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:queueable-fix",
      "clawsweeper:fix-shape-clear",
    ],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["clawsweeper"], {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "medium",
    }),
    ["clawsweeper", "issue-rating: 🧂 unranked krab"],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["clawsweeper"], {
      type: "issue",
      workCandidate: "manual_review",
    }),
    [
      "clawsweeper",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-maintainer-review",
    ],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["clawsweeper"], {
      type: "issue",
      workStatus: "manual_review",
    }),
    [
      "clawsweeper",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-maintainer-review",
    ],
  );
});

test("bulk-filed issues never enter automated fix dispatch", () => {
  const labels = nextIssueAdvisoryLabels(["bug", "clawsweeper:bulk-filed"], {
    type: "issue",
    itemCategory: "bug",
    reproductionStatus: "reproduced",
    reproductionConfidence: "high",
    implementationComplexity: "small",
    autoImplementationCandidate: "strict_bug",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "high",
    hasWorkShape: true,
    hasWorkPrompt: true,
    hasWorkValidation: true,
  });

  assert.equal(labels.includes("clawsweeper:bulk-filed"), true);
  assert.equal(labels.includes("clawsweeper:no-new-fix-pr"), true);
  assert.equal(labels.includes("clawsweeper:queueable-fix"), false);
  assert.equal(labels.includes("good first issue"), false);
  assert.equal(labels.includes("no-stale"), false);
});

test("ClawSweeper labels only small verified strict bugs as good first issues", () => {
  const eligibleState = {
    type: "issue",
    itemCategory: "bug",
    reproductionStatus: "reproduced",
    reproductionConfidence: "high",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    implementationComplexity: "small",
    autoImplementationCandidate: "strict_bug",
    securityReviewStatus: "not_applicable",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "high",
    hasWorkShape: true,
    hasWorkPrompt: true,
    hasWorkValidation: true,
    goodFirstIssueOptedOut: false,
    locked: false,
    hasOpenLinkedPullRequest: false,
  };

  assert.equal(nextIssueAdvisoryLabels(["bug"], eligibleState).includes("good first issue"), true);

  for (const ineligibleState of [
    { reproductionStatus: "source_reproducible" },
    { reproductionConfidence: "medium" },
    { itemCategory: "feature" },
    { requiresNewFeature: true },
    { requiresNewConfigOption: true },
    { requiresProductDecision: true },
    { implementationComplexity: "medium" },
    { autoImplementationCandidate: "none" },
    { securityReviewStatus: "needs_attention" },
    { workCandidate: "manual_review" },
    { workStatus: "manual_review" },
    { workConfidence: "medium" },
    { hasWorkPrompt: false },
    { hasWorkValidation: false },
    { goodFirstIssueOptedOut: true },
    { locked: true },
    { hasOpenLinkedPullRequest: true },
  ]) {
    assert.equal(
      nextIssueAdvisoryLabels(["bug"], { ...eligibleState, ...ineligibleState }).includes(
        "good first issue",
      ),
      false,
      JSON.stringify(ineligibleState),
    );
  }

  for (const securityLabel of [
    "security",
    "security-sensitive",
    "security sensitive",
    "type: security",
    "type:security",
    "kind: security",
    "kind:security",
    " SECURITY ",
    "impact:security",
  ]) {
    assert.equal(
      nextIssueAdvisoryLabels(["bug", securityLabel], eligibleState).includes("good first issue"),
      false,
      securityLabel,
    );
  }
  for (const label of [
    "security:sensitive",
    "security/internal",
    "security review",
    "insecurity",
  ]) {
    assert.equal(
      nextIssueAdvisoryLabels(["bug", label], eligibleState).includes("good first issue"),
      true,
      label,
    );
  }
  assert.equal(
    nextIssueAdvisoryLabels(["bug", "maintainer"], eligibleState).includes("good first issue"),
    false,
  );
  assert.equal(
    nextIssueAdvisoryLabels(["bug", "good first issue"], {
      ...eligibleState,
      implementationComplexity: "medium",
    }).includes("good first issue"),
    true,
  );
});

test("ClawSweeper respects human good first issue removal", () => {
  assert.equal(
    goodFirstIssueHumanLabelState([
      {
        id: 1,
        event: "labeled",
        label: { name: "good first issue" },
        actor: { login: "openclaw-clawsweeper[bot]" },
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        id: 2,
        event: "unlabeled",
        label: { name: "good first issue" },
        actor: { login: "maintainer" },
        created_at: "2026-07-02T00:00:00Z",
      },
      {
        id: 3,
        event: "labeled",
        label: { name: "good first issue" },
        actor: { login: "openclaw-clawsweeper[bot]" },
        created_at: "2026-07-03T00:00:00Z",
      },
    ]) === "removed",
    true,
  );
  assert.equal(
    goodFirstIssueHumanLabelState([
      {
        id: 2,
        event: "unlabeled",
        label: "good first issue",
        actor: "maintainer",
        createdAt: "2026-07-02T00:00:00Z",
      },
      {
        id: 3,
        event: "labeled",
        label: "good first issue",
        actor: "maintainer",
        createdAt: "2026-07-03T00:00:00Z",
      },
      {
        id: 4,
        event: "unlabeled",
        label: "good first issue",
        actor: "github-actions[bot]",
        createdAt: "2026-07-04T00:00:00Z",
      },
    ]) === "removed",
    false,
  );
  assert.equal(
    goodFirstIssueHumanLabelState([
      {
        id: 1,
        event: "unlabeled",
        label: "good first issue",
        actor: "openclaw-clawsweeper[bot]",
        createdAt: "2026-07-02T00:00:00Z",
      },
    ]) === "removed",
    false,
  );
});

test("ClawSweeper issue advisory labels protect queueable issues from stale automation", () => {
  const queueableLabels = nextIssueAdvisoryLabels(["bug", "stale"], {
    type: "issue",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "high",
    hasWorkShape: true,
  });

  assert.equal(queueableLabels.includes("stale"), false);
  assert.equal(queueableLabels.includes("no-stale"), true);
  assert.equal(queueableLabels.includes("clawsweeper:queueable-fix"), true);
  assert.equal(queueableLabels.includes("clawsweeper:fix-shape-clear"), true);

  const alreadyProtectedLabels = nextIssueAdvisoryLabels(["bug", "no-stale"], {
    type: "issue",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "high",
  });

  assert.equal(alreadyProtectedLabels.includes("stale"), false);
  assert.equal(alreadyProtectedLabels.filter((label) => label === "no-stale").length, 1);
  assert.equal(alreadyProtectedLabels.includes("clawsweeper:queueable-fix"), true);
});

test("ClawSweeper issue advisory labels do not stale-proof non-queueable issues", () => {
  const lowerConfidenceLabels = nextIssueAdvisoryLabels(["bug", "stale"], {
    type: "issue",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "medium",
    hasWorkShape: true,
  });

  assert.equal(lowerConfidenceLabels.includes("stale"), true);
  assert.equal(lowerConfidenceLabels.includes("no-stale"), false);
  assert.equal(lowerConfidenceLabels.includes("clawsweeper:queueable-fix"), false);

  const manualReviewLabels = nextIssueAdvisoryLabels(["bug", "stale"], {
    type: "issue",
    workCandidate: "manual_review",
    workConfidence: "high",
    hasWorkShape: true,
  });

  assert.equal(manualReviewLabels.includes("stale"), true);
  assert.equal(manualReviewLabels.includes("no-stale"), false);
  assert.equal(manualReviewLabels.includes("clawsweeper:queueable-fix"), false);
  assert.equal(manualReviewLabels.includes("clawsweeper:fix-shape-clear"), true);
  assert.equal(manualReviewLabels.includes("clawsweeper:needs-maintainer-review"), true);

  const demotedQueueableLabels = nextIssueAdvisoryLabels(
    ["bug", "no-stale", "clawsweeper:queueable-fix"],
    {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "medium",
    },
  );

  assert.equal(demotedQueueableLabels.includes("no-stale"), false);
  assert.equal(demotedQueueableLabels.includes("clawsweeper:queueable-fix"), false);

  const manuallyProtectedLabels = nextIssueAdvisoryLabels(["bug", "no-stale"], {
    type: "issue",
    workCandidate: "manual_review",
  });

  assert.equal(manuallyProtectedLabels.includes("no-stale"), true);
  assert.equal(manuallyProtectedLabels.includes("clawsweeper:needs-maintainer-review"), true);

  const pullRequestLabels = nextIssueAdvisoryLabels(["bug", "stale"], {
    type: "pull_request",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "high",
    hasWorkShape: true,
  });

  assert.deepEqual(pullRequestLabels, ["bug", "stale"]);
});

test("ClawSweeper issue advisory labels expose linked PR and human decision blockers", () => {
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      hasOpenLinkedPullRequest: true,
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:linked-pr-open",
      "clawsweeper:no-new-fix-pr",
    ],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      requiresProductDecision: true,
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-product-decision",
    ],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      securityReviewStatus: "needs_attention",
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-security-review",
    ],
  );
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "issue",
      itemCategory: "security",
    }),
    [
      "bug",
      "issue-rating: 🧂 unranked krab",
      "clawsweeper:no-new-fix-pr",
      "clawsweeper:needs-security-review",
    ],
  );
});

test("ClawSweeper issue advisory labels remove stale owned labels and preserve other labels", () => {
  assert.deepEqual(
    nextIssueAdvisoryLabels(
      [
        "bug",
        "clawsweeper:source-repro",
        "clawsweeper:not-repro-on-main",
        "clawsweeper:needs-live-repro",
        "clawsweeper:needs-info",
        "clawsweeper:linked-pr-open",
        "clawsweeper:no-new-fix-pr",
        "clawsweeper:queueable-fix",
        "good first issue",
        "clawsweeper:fix-shape-clear",
        "clawsweeper:needs-product-decision",
        "clawsweeper:needs-security-review",
        "issue-rating: 🦞 diamond lobster",
        "issue-rating: 🌊 off-meta tidepool",
        "clawsweeper:autofix",
        "clawsweeper:automerge",
        "clawsweeper:human-review",
        "clawsweeper:merge-ready",
        "proof: sufficient",
        "proof: telegram-e2e",
      ],
      {
        type: "issue",
        reproductionStatus: "reproduced",
        reproductionConfidence: "high",
      },
    ),
    [
      "bug",
      "good first issue",
      "clawsweeper:autofix",
      "clawsweeper:automerge",
      "clawsweeper:human-review",
      "clawsweeper:merge-ready",
      "proof: sufficient",
      "proof: telegram-e2e",
      "issue-rating: 🦀 challenger crab",
      "clawsweeper:current-main-repro",
    ],
  );
});

test("ClawSweeper issue advisory labels do not apply to pull requests", () => {
  assert.deepEqual(
    nextIssueAdvisoryLabels(["bug"], {
      type: "pull_request",
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "high",
      hasOpenLinkedPullRequest: true,
      requiresProductDecision: true,
      securityReviewStatus: "needs_attention",
      hasWorkShape: true,
    }),
    ["bug"],
  );
});
