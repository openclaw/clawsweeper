import assert from "node:assert/strict";
import test from "node:test";

import { createLabelPolicy } from "../dist/clawsweeper-label-policy.js";
import { createLabelSynchronization } from "../dist/clawsweeper-label-sync.js";
import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";
import { createReportParser } from "../dist/clawsweeper-report-parser.js";
import { createReportHelpers } from "../dist/clawsweeper-report-helpers.js";
import { createRealBehaviorProofPolicy } from "../dist/clawsweeper-proof-policy.js";
import { syncApplyPullRequestLabels } from "../dist/clawsweeper-apply-pull-request-labels.js";
import type { RealBehaviorProof } from "../dist/clawsweeper-types.js";
import {
  featureShowcaseLabelsForTest,
  goodFirstIssueLabelOptedOutForTest,
  impactLabelsForTest,
  impactLabelSchemeForTest,
  issueAdvisoryLabelsForTest,
  labelJustificationsMarkdownForTest,
  mergeRiskLabelsForTest,
  mergeRiskLabelSchemeForTest,
  maturityLabelSchemeForTest,
  maturityLabelsForTest,
  parseDecision,
  prRatingLabelsForTest,
  prRatingLabelSchemeForTest,
  prStatusLabelsForTest,
  prStatusLabelSchemeForTest,
  priorityLabelsForTest,
  priorityLabelSchemeForTest,
  reviewDecisionSchemaText,
  reviewPromptTemplate,
  telegramVisibleProofLabelsForTest,
} from "../dist/clawsweeper.js";
import {
  closeDecision,
  item,
  realBehaviorProofReportSection,
  reportFrontMatter,
} from "./helpers.ts";

for (const proofStatus of ["missing", "not_applicable"] as const) {
  test(`failed ${proofStatus} reports remove positive statuses through apply label sync`, () => {
    const metadata = createRecordMetadata({} as never);
    const parser = createReportParser({
      ...metadata,
      ...createReportHelpers({
        OWNED_REVIEW_SECTION_HEADINGS: new Set(),
        parseBacktickLocation: () => null,
      }),
      isDocsOnlyPullRequestReport: () => false,
      isExternalPullRequestReport: () => true,
    } as Parameters<typeof createReportParser>[0]);
    const reportRealBehaviorProofPolicy = createRealBehaviorProofPolicy({
      ...metadata,
      ...parser,
      isDocsOnlyPullRequestReport: () => false,
      isExternalPullRequestReport: () => true,
    });
    const policy = createLabelPolicy({
      ...metadata,
      ...parser,
      reportRealBehaviorProofPolicy,
      asRecord: (value) => value as Record<string, unknown>,
      isAutomationReportAuthor: () => false,
      stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
      timestampMs: (value) => (value ? Date.parse(value) : null),
    });
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
      const synchronization = createLabelSynchronization({
        ...metadata,
        ...parser,
        labelPolicy: policy,
        ghObservedMutationCommand: ({ args }) => {
          commands.push(args);
          return "";
        },
        hasNormalizedLabel: (current, label) => current.includes(label),
        normalizeLabelName: (label) => label.toLowerCase(),
        protectedLabels: () => [],
        isBulkFilerExemptAuthorAssociation: () => false,
        isBulkFilerExemptRepositoryPermission: () => false,
      } as Parameters<typeof createLabelSynchronization>[0]);
      const result = syncApplyPullRequestLabels(
        {
          ...metadata,
          ...parser,
          ...synchronization,
          prStatusLabelKindFromReport: policy.prStatusLabelKindFromReport,
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
      assert.equal(policy.prStatusLabelKindFromReport(report, context, labels), expected);
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

test("report-based status selection requires external N/A proof without an action flag", () => {
  const metadata = createRecordMetadata({} as never);
  const reportRealBehaviorProofPolicy = createRealBehaviorProofPolicy({
    ...metadata,
    isDocsOnlyPullRequestReport: () => false,
    isExternalPullRequestReport: (markdown) =>
      metadata.frontMatterValue(markdown, "author_association") === "CONTRIBUTOR",
    reportAttachedLiveVerification: () => ({ status: "absent" }),
    reportRealBehaviorProof: () => ({
      status: "not_applicable",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
      summary: "Recorded reviewer assessment.",
    }),
  });
  const policy = createLabelPolicy({
    ...metadata,
    asRecord: (value) => value as Record<string, unknown>,
    isAutomationReportAuthor: () => false,
    mergeRiskOptionsFromReport: () => [],
    reportOverallCorrectness: () => "patch is correct",
    reportRealBehaviorProofPolicy,
    reportReviewFindings: () => [],
    reportSecurityReview: () => ({ status: "cleared", summary: "", concerns: [] }),
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
    timestampMs: (value) => (value ? Date.parse(value) : null),
  });
  for (const path of ["README.md", "src/arbitrary.ts"]) {
    const report = reportFrontMatter({
      type: "pull_request",
      review_status: "complete",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      pull_files: JSON.stringify([path]),
      pull_files_truncated: false,
      reviewed_at: "2026-08-30T12:00:00Z",
    });
    assert.equal(
      policy.prStatusLabelKindFromReport(report, { comments: [], timeline: [] }, [
        "clawsweeper:automerge",
      ]),
      "needs_proof",
      path,
    );
    for (const [labels, comments, expected] of [
      [["clawsweeper:human-review"], [], null],
      [["clawsweeper:manual-only"], [], null],
      [["clawsweeper:merge-ready"], [], null],
      [
        [],
        [
          {
            author: "contributor",
            body: "@clawsweeper re-review",
            createdAt: "2026-08-30T13:00:00Z",
          },
        ],
        "re_review_loop",
      ],
      [
        [],
        [{ author: "contributor", body: "Added evidence", createdAt: "2026-08-30T13:00:00Z" }],
        "actively_grinding",
      ],
    ] as const) {
      assert.equal(
        policy.prStatusLabelKindFromReport(
          report,
          { comments: [...comments], timeline: [] },
          labels,
        ),
        expected,
      );
    }
    const commands: string[][] = [];
    const synchronization = createLabelSynchronization({
      ...metadata,
      ghObservedMutationCommand: ({ args }) => {
        commands.push(args);
        return "";
      },
      hasNormalizedLabel: (labels, label) => labels.includes(label),
      normalizeLabelName: (label) => label.toLowerCase(),
      protectedLabels: () => [],
      isBulkFilerExemptAuthorAssociation: () => false,
      isBulkFilerExemptRepositoryPermission: () => false,
      reportSecurityReview: () => ({ status: "cleared", summary: "", concerns: [] }),
      labelPolicy: policy,
    } as Parameters<typeof createLabelSynchronization>[0]);
    const decision = closeDecision();
    const result = syncApplyPullRequestLabels(
      {
        ...metadata,
        ...synchronization,
        prStatusLabelKindFromReport: policy.prStatusLabelKindFromReport,
        reportRealBehaviorProof: (markdown) => reportRealBehaviorProofPolicy(markdown).assessment,
        reportPrRating: () => decision.prRating,
        reportFeatureShowcase: () => decision.featureShowcase,
        reportOverallCorrectness: () => "patch is correct",
        reportSecurityReview: () => decision.securityReview,
        reportTelegramVisibleProof: () => decision.telegramVisibleProof,
      },
      {
        markdown: report,
        item: item({ kind: "pull_request", labels: ["clawsweeper:automerge"] }),
        number: 74465,
        currentItemContext: () => ({ comments: [], timeline: [] }) as never,
        dryRun: false,
        labelSyncFreshEnough: () => true,
        staleReviewHead: null,
        onMutation: () => {},
      },
    );
    assert.equal(result.currentPrStatusKind, "needs_proof", path);
    assert.ok(result.labels.includes("status: 📣 needs proof"), path);
    assert.ok(!result.labels.includes("proof: sufficient"), path);
    assert.equal(result.markdown, report, path);
    assert.ok(
      commands.some(
        (args) => args.includes("--add-label") && args.includes("status: 📣 needs proof"),
      ),
      path,
    );
    assert.ok(!commands.some((args) => args.includes("status: 🚀 automerge armed")), path);
  }
});

test("ClawSweeper PR rating labels use one themed overall label", () => {
  assert.deepEqual(prRatingLabelsForTest(["bug"], "A"), ["bug", "rating: 🦞 diamond lobster"]);
  assert.deepEqual(
    prRatingLabelsForTest(["rating: 🦀 challenger crab", "bug", "rating: 🦐 gold shrimp"], "D"),
    ["bug", "rating: 🦪 silver shellfish"],
  );
  assert.deepEqual(prRatingLabelsForTest(["bug"], "bogus"), [
    "bug",
    "rating: 🌊 off-meta tidepool",
  ]);
  assert.deepEqual(prRatingLabelsForTest(["bug", "rating: 🌊 off-meta tidepool"], "NA", true), [
    "bug",
  ]);
});

test("ClawSweeper PR rating label scheme exposes boring internal tiers", () => {
  assert.deepEqual(
    prRatingLabelSchemeForTest().map(({ tier, name, color }) => ({ tier, name, color })),
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
    featureShowcaseLabelsForTest(["enhancement"], {
      itemCategory: "feature",
      status: "showcase",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement", "feature: ✨ showcase"],
  );
  assert.deepEqual(
    featureShowcaseLabelsForTest(["enhancement"], {
      itemCategory: "feature",
      status: "none",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement"],
  );
  assert.deepEqual(
    featureShowcaseLabelsForTest(["feature: ✨ showcase"], {
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
    featureShowcaseLabelsForTest(["bug"], {
      itemCategory: "bug",
      status: "showcase",
      securityReviewStatus: "cleared",
      overallCorrectness: "patch is correct",
    }),
    ["bug"],
  );
  assert.deepEqual(
    featureShowcaseLabelsForTest(["enhancement"], {
      itemCategory: "feature",
      status: "showcase",
      securityReviewStatus: "needs_attention",
      overallCorrectness: "patch is correct",
    }),
    ["enhancement"],
  );
  assert.deepEqual(
    featureShowcaseLabelsForTest(["enhancement"], {
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
    prStatusLabelsForTest(["bug", "status: ⏳ waiting on author"], {
      findingPriorities: [2],
      hasRecentAuthorActivity: true,
    }),
    ["bug", "status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabelsForTest(["bug", "status: 🛠️ actively grinding"], {
      proofStatus: "sufficient",
      overallCorrectness: "patch is correct",
    }),
    ["bug", "status: 👀 ready for maintainer look"],
  );
});

test("ClawSweeper PR status routes security owner acceptance to maintainer look", () => {
  const ownerAcceptanceLabels = prStatusLabelsForTest([], {
    proofStatus: "sufficient",
    securityStatus: "needs_attention",
    mergeRiskOptions: [{ category: "accept_risk", recommended: true }],
    overallCorrectness: "patch is correct",
  });

  assert.equal(
    ownerAcceptanceLabels.some((label) => label.endsWith("ready for maintainer look")),
    true,
  );
  assert.equal(
    ownerAcceptanceLabels.some((label) => label.endsWith("waiting on author")),
    false,
  );

  const authorFixLabels = prStatusLabelsForTest([], {
    proofStatus: "sufficient",
    securityStatus: "needs_attention",
    mergeRiskOptions: [{ category: "fix_before_merge", recommended: true }],
    overallCorrectness: "patch is correct",
  });

  assert.equal(
    authorFixLabels.some((label) => label.endsWith("waiting on author")),
    true,
  );

  const ambiguousSecurityLabels = prStatusLabelsForTest([], {
    proofStatus: "sufficient",
    securityStatus: "needs_attention",
    overallCorrectness: "patch is correct",
  });

  assert.equal(
    ambiguousSecurityLabels.some((label) => label.endsWith("waiting on author")),
    true,
  );
});

test("unresolved proof routes contributors and maintainers to distinct owners", () => {
  assert.deepEqual(
    prStatusLabelsForTest(["clawsweeper:automerge"], {
      proofStatus: "insufficient",
      needsContributorAction: true,
    }),
    ["clawsweeper:automerge", "status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabelsForTest(["clawsweeper:automerge"], {
      proofStatus: "insufficient",
      needsContributorAction: false,
    }),
    ["clawsweeper:automerge", "status: needs maintainer proof decision"],
  );
});

test("historical receipt failures route to the proof owner without erasing independent proof", () => {
  let receiptStatus = "failed";
  let needsContributorAction = false;
  let reviewFailed = false;
  const reportRealBehaviorProofPolicy = createRealBehaviorProofPolicy({
    frontMatterValue: (_markdown, key) =>
      key === "review_status" && reviewFailed ? "failed" : undefined,
    frontMatterStringArray: () => [],
    isDocsOnlyPullRequestReport: () => false,
    isExternalPullRequestReport: () => true,
    reviewSectionValue: () => "",
    reportAttachedLiveVerification: () => ({ status: receiptStatus }) as never,
    reportRealBehaviorProof: (): RealBehaviorProof => ({
      status: needsContributorAction ? "missing" : "sufficient",
      evidenceKind: "terminal",
      needsContributorAction,
      summary: "Contributor-supplied terminal output already proves the changed behavior.",
    }),
  });
  const policy = createLabelPolicy({
    asRecord: (value) => value as Record<string, unknown>,
    frontMatterValue: (_markdown, key) =>
      key === "type"
        ? "pull_request"
        : key === "reviewed_at"
          ? "2026-08-27T12:00:00.000Z"
          : key === "review_status" && reviewFailed
            ? "failed"
            : undefined,
    isAutomationReportAuthor: () => false,
    mergeRiskOptionsFromReport: () => [],
    reportOverallCorrectness: () => "patch is correct",
    reportRealBehaviorProofPolicy,
    reportReviewFindings: () => [],
    reportSecurityReview: () => ({ status: "cleared", summary: "", concerns: [] }),
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
    timestampMs: (value) => (value ? Date.parse(value) : null),
  });

  for (reviewFailed of [false, true]) {
    for (receiptStatus of ["absent", "passed", "failed", "malformed"]) {
      for (needsContributorAction of [false, true]) {
        assert.equal(
          policy.prStatusLabelKindFromReport("report", { comments: [], timeline: [] }, [
            "clawsweeper:automerge",
          ]),
          needsContributorAction && !reviewFailed
            ? "needs_proof"
            : receiptStatus === "failed" || receiptStatus === "malformed"
              ? "needs_maintainer_proof_decision"
              : reviewFailed
                ? null
                : "automerge_armed",
          `${receiptStatus}: contributor action=${needsContributorAction}, failed review=${reviewFailed}`,
        );
      }
    }
  }
});

test("ClawSweeper PR status labels preserve other label families", () => {
  assert.deepEqual(
    prStatusLabelsForTest(
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
  const automergeArmedLabel = prStatusLabelSchemeForTest().find(
    (label) => label.kind === "automerge_armed",
  )?.name;
  const reReviewLabel = prStatusLabelSchemeForTest().find(
    (label) => label.kind === "re_review_loop",
  )?.name;
  assert.ok(automergeArmedLabel);
  assert.ok(reReviewLabel);
  assert.deepEqual(
    prStatusLabelsForTest(["clawsweeper:automerge"], {
      proofStatus: "missing",
      hasRecentReReviewRequest: true,
    }),
    ["clawsweeper:automerge", reReviewLabel],
  );
  assert.deepEqual(
    prStatusLabelsForTest(
      ["clawsweeper:automerge", "clawsweeper:human-review", automergeArmedLabel],
      {
        proofStatus: "missing",
        hasRecentReReviewRequest: true,
      },
    ),
    ["clawsweeper:automerge", "clawsweeper:human-review"],
  );
  assert.deepEqual(
    prStatusLabelsForTest(
      ["clawsweeper:automerge", "clawsweeper:merge-ready", automergeArmedLabel],
      {
        proofStatus: "missing",
        hasRecentReReviewRequest: true,
      },
    ),
    ["clawsweeper:automerge", "clawsweeper:merge-ready"],
  );
  assert.deepEqual(
    prStatusLabelsForTest(
      ["clawsweeper:automerge", "clawsweeper:manual-only", automergeArmedLabel],
      {
        proofStatus: "missing",
        hasRecentReReviewRequest: true,
      },
    ),
    ["clawsweeper:automerge", "clawsweeper:manual-only"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
      hasRecentReReviewRequest: true,
    }),
    ["status: 🔁 re-review loop"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
      hasRecentAuthorActivity: true,
    }),
    ["status: 🛠️ actively grinding"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      proofStatus: "missing",
    }),
    ["status: 📣 needs proof"],
  );
  assert.deepEqual(
    prStatusLabelsForTest([], {
      findingPriorities: [2],
    }),
    ["status: ⏳ waiting on author"],
  );
});

test("ClawSweeper PR status ignores bot-authored re-review guidance", () => {
  assert.deepEqual(
    prStatusLabelsForTest([], {
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
    prStatusLabelsForTest([], {
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

test("ClawSweeper PR status treats maintainer-only rank-up moves as ready", () => {
  assert.deepEqual(
    prStatusLabelsForTest([], {
      nextSteps: [
        "Maintainer accepts the relative details.reportPath contract change before merge.",
      ],
      proofStatus: "sufficient",
      overallCorrectness: "patch is correct",
    }),
    ["status: 👀 ready for maintainer look"],
  );
});

test("ClawSweeper PR status labels are PR-only", () => {
  assert.deepEqual(
    prStatusLabelsForTest(["bug", "status: ⏳ waiting on author"], {
      isPullRequest: false,
      nextSteps: ["Add proof."],
    }),
    ["bug"],
  );
});

test("ClawSweeper PR status label scheme exposes workflow states", () => {
  assert.deepEqual(
    prStatusLabelSchemeForTest().map(({ kind, name, color }) => ({ kind, name, color })),
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
  assert.deepEqual(telegramVisibleProofLabelsForTest(["channel: telegram"], "needed"), [
    "channel: telegram",
    "proof: telegram-e2e",
  ]);
  assert.deepEqual(
    telegramVisibleProofLabelsForTest(["channel: telegram", "proof: telegram-e2e"], "not_needed"),
    ["channel: telegram"],
  );
  assert.deepEqual(
    telegramVisibleProofLabelsForTest(
      ["channel: telegram", "mantis: telegram-visible-proof"],
      "needed",
    ),
    ["channel: telegram", "proof: telegram-e2e"],
  );
  assert.deepEqual(
    telegramVisibleProofLabelsForTest(
      ["channel: telegram", "mantis: telegram-visible-proof"],
      "not_needed",
    ),
    ["channel: telegram"],
  );
});

test("ClawSweeper replaces the legacy Telegram proof label during synchronization", () => {
  const commands: string[][] = [];
  const labels = createLabelSynchronization({
    ghObservedMutationCommand: ({ args }: { args: string[] }) => {
      commands.push(args);
      return "";
    },
    hasNormalizedLabel: (current: readonly string[], label: string) =>
      current.some((candidate) => candidate.toLowerCase() === label.toLowerCase()),
    normalizeLabelName: (label: string) => label.toLowerCase(),
    protectedLabels: () => [],
    isBulkFilerExemptAuthorAssociation: () => false,
    isBulkFilerExemptRepositoryPermission: () => false,
    frontMatterValue: () => undefined,
    frontMatterStringArray: () => [],
    reportSecurityReview: () => ({ status: "not_applicable", evidence: [] }),
    reviewSectionValue: () => "",
    labelPolicy: {},
  } as never);

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
  assert.deepEqual(priorityLabelSchemeForTest(), [
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
  for (const label of priorityLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper priority label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      triagePriority?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.triagePriority?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of priorityLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("review prompt keeps unrelated CI noise out of triage priority", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      triagePriority?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.triagePriority?.description ?? "";
  const prompt = reviewPromptTemplate();

  assert.match(prompt, /Do not raise `triagePriority` solely because CI or status checks/);
  assert.match(
    prompt,
    /failing,\s+pending,\s+missing,\s+flaky,\s+or require routine maintainer follow-up/,
  );
  assert.match(prompt, /PR diff plausibly caused an urgent regression/);
  assert.match(schemaDescription, /Do not raise priority solely because CI or status checks/);
  assert.match(schemaDescription, /diff-caused urgent regressions/);
});

test("ClawSweeper priority labels follow triage priority", () => {
  assert.deepEqual(priorityLabelsForTest(["bug"], "P2"), ["bug", "P2"]);
  assert.deepEqual(priorityLabelsForTest(["bug", "P3"], "P1"), ["bug", "P1"]);
  assert.deepEqual(priorityLabelsForTest(["P0", "bug"], "none"), ["bug"]);
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
  assert.deepEqual(impactLabelSchemeForTest(), [
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
  for (const label of impactLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper impact label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      impactLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.impactLabels?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of impactLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
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
        description?: string;
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
  const schemaDescription = schema.properties?.impactLabels?.description ?? "";
  const impactLabelEnum = schema.properties?.impactLabels?.items?.enum ?? [];
  const justificationLabelEnum =
    schema.properties?.labelJustifications?.items?.properties?.label?.enum ?? [];
  const prompt = reviewPromptTemplate();

  assert.match(prompt, /Apply this UX override before falling back to ordinary technical severity/);
  assert.match(prompt, /non-technical first-time or community user/);
  assert.match(prompt, /terminal commands, config edits, log inspection, manual file edits/);
  assert.match(prompt, /override requires a\s+blocked user-facing path/);
  assert.match(prompt, /Set `triagePriority: "P0"` and include `impact:ux-release-blocker`/);
  assert.match(prompt, /Doctor button,\s+Fix button,\s+setup wizard,\s+inline\s+recovery/);
  assert.match(schemaDescription, /UX override:/);
  assert.match(schemaDescription, /non-technical first-time or community user/);
  assert.match(schemaDescription, /Doctor button, Fix button, setup wizard, inline recovery/);
  assert.ok(impactLabelEnum.includes("impact:ux-release-blocker"));
  assert.ok(impactLabelEnum.includes("impact:ux-friction"));
  assert.ok(justificationLabelEnum.includes("impact:ux-release-blocker"));
  assert.ok(justificationLabelEnum.includes("impact:ux-friction"));
});

test("ClawSweeper merge-risk label scheme exposes PR-only merge warning labels", () => {
  assert.deepEqual(mergeRiskLabelSchemeForTest(), [
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
  for (const label of mergeRiskLabelSchemeForTest()) {
    assert.ok(
      label.description.length <= 100,
      `${label.name} description is ${label.description.length} characters`,
    );
  }
});

test("ClawSweeper merge-risk label descriptions stay aligned with prompt and schema", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      mergeRiskLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.mergeRiskLabels?.description ?? "";
  const prompt = reviewPromptTemplate();
  for (const label of mergeRiskLabelSchemeForTest()) {
    assert.ok(
      prompt.includes(`\`${label.name}\`: ${label.description}`),
      `${label.name} description is missing from the review prompt`,
    );
    assert.ok(
      schemaDescription.includes(`${label.name}: ${label.description}`),
      `${label.name} description is missing from the schema`,
    );
  }
});

test("review prompt uses automation merge risk only for diff-caused automation risk", () => {
  const schema = JSON.parse(reviewDecisionSchemaText()) as {
    properties?: {
      mergeRiskLabels?: {
        description?: string;
      };
    };
  };
  const schemaDescription = schema.properties?.mergeRiskLabels?.description ?? "";
  const prompt = reviewPromptTemplate();

  assert.match(prompt, /Do not use `merge-risk: 🚨 automation` only because CI is red/);
  assert.match(prompt, /pending,\s+flaky,\s+or absent/);
  assert.match(prompt, /PR diff changes automation behavior/);
  assert.match(prompt, /plausibly causes CI,\s+automerge,\s+proof capture,\s+label sync/);
  assert.match(schemaDescription, /Do not use merge-risk: 🚨 automation only because CI is red/);
  assert.match(schemaDescription, /PR diff changes automation behavior/);
});

test("ClawSweeper merge-risk labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    mergeRiskLabelsForTest(
      ["bug", "merge-risk: 🚨 compatibility", "merge-risk: 🚨 availability", "impact:message-loss"],
      ["merge-risk: 🚨 message-delivery", "merge-risk: 🚨 other", "not-a-merge-risk-label"],
    ),
    ["bug", "impact:message-loss", "merge-risk: 🚨 message-delivery", "merge-risk: 🚨 other"],
  );
  assert.deepEqual(mergeRiskLabelsForTest(["bug", "merge-risk: 🚨 auth-provider"], []), ["bug"]);
});

test("ClawSweeper impact labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(
    impactLabelsForTest(
      ["bug", "impact:data-loss", "impact:security", "proof: sufficient", "P1"],
      ["impact:message-loss", "impact:other", "not-an-impact-label"],
    ),
    ["bug", "proof: sufficient", "P1", "impact:message-loss", "impact:other"],
  );
  assert.deepEqual(impactLabelsForTest(["bug", "impact:auth-provider"], []), ["bug"]);
});

test("ClawSweeper maturity labels remove stale owned labels and preserve unrelated labels", () => {
  assert.deepEqual(maturityLabelSchemeForTest(), [
    {
      name: "maturity:stable",
      color: "1F883D",
      description: "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
    },
  ]);
  assert.deepEqual(maturityLabelsForTest(["bug"], ["maturity:stable"]), ["bug", "maturity:stable"]);
  assert.deepEqual(maturityLabelsForTest(["bug", "maturity:stable", "impact:security"], []), [
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
    const labels = createLabelSynchronization({
      ghObservedMutationCommand: ({ args }: { args: string[] }) => {
        commands.push(args);
        return "";
      },
      hasNormalizedLabel: (current: readonly string[], expected: string) =>
        current.some((candidate) => candidate.toLowerCase() === expected.toLowerCase()),
      normalizeLabelName: (name: string) => name.toLowerCase(),
      protectedLabels: () => [],
      isBulkFilerExemptAuthorAssociation: () => false,
      isBulkFilerExemptRepositoryPermission: () => false,
      frontMatterValue: () => undefined,
      frontMatterStringArray: () => [],
      reportSecurityReview: () => ({ status: "not_applicable", evidence: [] }),
      reviewSectionValue: () => "",
      labelPolicy: {},
    } as never);

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
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦀 challenger crab", "clawsweeper:current-main-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦞 diamond lobster", "clawsweeper:source-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "reproduced",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "not_reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:not-repro-on-main"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "medium",
    }),
    ["bug", "issue-rating: 🐚 platinum hermit", "clawsweeper:needs-live-repro"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["bug"], {
      type: "issue",
      reproductionStatus: "unclear",
      reproductionConfidence: "low",
    }),
    ["bug", "issue-rating: 🦪 silver shellfish", "clawsweeper:needs-info"],
  );
});

test("ClawSweeper issue advisory labels expose work-lane routing state", () => {
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
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
    issueAdvisoryLabelsForTest(["clawsweeper"], {
      type: "issue",
      workCandidate: "queue_fix_pr",
      workStatus: "candidate",
      workConfidence: "medium",
    }),
    ["clawsweeper", "issue-rating: 🧂 unranked krab"],
  );
  assert.deepEqual(
    issueAdvisoryLabelsForTest(["clawsweeper"], {
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
    issueAdvisoryLabelsForTest(["clawsweeper"], {
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
  const labels = issueAdvisoryLabelsForTest(["bug", "clawsweeper:bulk-filed"], {
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

  assert.equal(
    issueAdvisoryLabelsForTest(["bug"], eligibleState).includes("good first issue"),
    true,
  );

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
      issueAdvisoryLabelsForTest(["bug"], { ...eligibleState, ...ineligibleState }).includes(
        "good first issue",
      ),
      false,
      JSON.stringify(ineligibleState),
    );
  }

  for (const securityLabel of [
    "security",
    "security-sensitive",
    "security:sensitive",
    "security/internal",
    "impact:security",
  ]) {
    assert.equal(
      issueAdvisoryLabelsForTest(["bug", securityLabel], eligibleState).includes(
        "good first issue",
      ),
      false,
      securityLabel,
    );
  }
  assert.equal(
    issueAdvisoryLabelsForTest(["bug", "maintainer"], eligibleState).includes("good first issue"),
    false,
  );
  assert.equal(
    issueAdvisoryLabelsForTest(["bug", "good first issue"], {
      ...eligibleState,
      implementationComplexity: "medium",
    }).includes("good first issue"),
    true,
  );
});

test("ClawSweeper respects human good first issue removal", () => {
  assert.equal(
    goodFirstIssueLabelOptedOutForTest([
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
    ]),
    true,
  );
  assert.equal(
    goodFirstIssueLabelOptedOutForTest([
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
    ]),
    false,
  );
  assert.equal(
    goodFirstIssueLabelOptedOutForTest([
      {
        id: 1,
        event: "unlabeled",
        label: "good first issue",
        actor: "openclaw-clawsweeper[bot]",
        createdAt: "2026-07-02T00:00:00Z",
      },
    ]),
    false,
  );
});

test("ClawSweeper issue advisory labels protect queueable issues from stale automation", () => {
  const queueableLabels = issueAdvisoryLabelsForTest(["bug", "stale"], {
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

  const alreadyProtectedLabels = issueAdvisoryLabelsForTest(["bug", "no-stale"], {
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
  const lowerConfidenceLabels = issueAdvisoryLabelsForTest(["bug", "stale"], {
    type: "issue",
    workCandidate: "queue_fix_pr",
    workStatus: "candidate",
    workConfidence: "medium",
    hasWorkShape: true,
  });

  assert.equal(lowerConfidenceLabels.includes("stale"), true);
  assert.equal(lowerConfidenceLabels.includes("no-stale"), false);
  assert.equal(lowerConfidenceLabels.includes("clawsweeper:queueable-fix"), false);

  const manualReviewLabels = issueAdvisoryLabelsForTest(["bug", "stale"], {
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

  const demotedQueueableLabels = issueAdvisoryLabelsForTest(
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

  const manuallyProtectedLabels = issueAdvisoryLabelsForTest(["bug", "no-stale"], {
    type: "issue",
    workCandidate: "manual_review",
  });

  assert.equal(manuallyProtectedLabels.includes("no-stale"), true);
  assert.equal(manuallyProtectedLabels.includes("clawsweeper:needs-maintainer-review"), true);

  const pullRequestLabels = issueAdvisoryLabelsForTest(["bug", "stale"], {
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
    issueAdvisoryLabelsForTest(["bug"], {
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
    issueAdvisoryLabelsForTest(["bug"], {
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
    issueAdvisoryLabelsForTest(["bug"], {
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
    issueAdvisoryLabelsForTest(["bug"], {
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
    issueAdvisoryLabelsForTest(
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
    issueAdvisoryLabelsForTest(["bug"], {
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
