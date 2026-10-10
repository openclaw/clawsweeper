import assert from "node:assert/strict";
import test from "node:test";
import {
  applicableCloseReasons,
  renderReviewSections,
  reviewPromptSections,
  type ReviewPromptSection,
} from "../dist/review-prompt-sections.js";
import {
  ABANDONED_PR_MIN_AGE_DAYS,
  ALLOWED_REASONS,
  DAY_MS,
  OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  PROTECTED_LABELS,
  STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS,
  STALE_VERSION_BUG_MIN_AGE_DAYS,
  STALLED_UNPROVEN_PR_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  UNSPONSORED_FEATURE_MIN_AGE_DAYS,
} from "../dist/clawsweeper-policy.js";
import {
  ACCEPTED_LARGE_LABEL,
  evaluateOversizedPullRequest,
  maxPrChangedLines,
} from "../dist/clawsweeper-oversized-pr-policy.js";
import type { Item, ItemContext, ReviewPromptRuntimeHints } from "../dist/clawsweeper-types.js";
import type { RepositoryCloseReason } from "../dist/repository-profiles.js";
import { applyBlockingProtectedLabels } from "../dist/clawsweeper-item-policy.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const reasons = [...ALLOWED_REASONS];

function target(overrides: Partial<Item> = {}): Item {
  return {
    repo: "openclaw/openclaw",
    number: 123,
    kind: "pull_request",
    title: "Review fixture",
    url: "https://github.com/openclaw/openclaw/pull/123",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    author: "contributor",
    authorAssociation: "NONE",
    labels: [],
    ...overrides,
  };
}

function context(overrides: Partial<ItemContext> = {}): ItemContext {
  return { issue: {}, comments: [], timeline: [], ...overrides };
}

function renderedSection(
  section: ReviewPromptSection,
  item = target(),
  input = context(),
  hints: ReviewPromptRuntimeHints = {},
): string {
  return renderReviewSections(
    `before\n<!-- review-section: ${section} -->\nsection body\n<!-- /review-section -->\nafter`,
    reviewPromptSections(item, input, hints),
  );
}

function assertSection(
  section: ReviewPromptSection,
  enabled: boolean,
  item = target(),
  input = context(),
  hints: ReviewPromptRuntimeHints = {},
): void {
  assert.equal(reviewPromptSections(item, input, hints)[section], enabled);
  assert.equal(
    renderedSection(section, item, input, hints),
    enabled ? "before\nsection body\nafter" : "before\nafter",
  );
}

test("follow-up instructions render only for PRs with a previous review", () => {
  for (const previousClawSweeperReview of [undefined, null, {}, { summary: "Prior review" }]) {
    for (const kind of ["issue", "pull_request"] as const) {
      assertSection(
        "follow_up",
        kind === "pull_request" && previousClawSweeperReview != null,
        target({ kind }),
        context({ previousClawSweeperReview }),
      );
    }
  }
});

test("media instructions require both a nonempty summary and a manifest path", () => {
  for (const mediaProofSummary of [undefined, "", " \n ", "Prepared local images"]) {
    for (const mediaProofManifestPath of [undefined, "", " \t ", "/tmp/media.json"]) {
      assertSection(
        "media",
        Boolean(mediaProofSummary?.trim() && mediaProofManifestPath?.trim()),
        target(),
        context(),
        { mediaProofSummary, mediaProofManifestPath },
      );
    }
  }
});

test("maintainer and external author instructions are mutually exclusive", () => {
  for (const [authorAssociation, maintainer] of [
    ["OWNER", true],
    ["MEMBER", true],
    ["COLLABORATOR", true],
    [" member ", true],
    ["CONTRIBUTOR", false],
    ["FIRST_TIME_CONTRIBUTOR", false],
    ["NONE", false],
    ["", false],
  ] as const) {
    for (const kind of ["issue", "pull_request"] as const) {
      const item = target({ authorAssociation, kind });
      assertSection("maintainer_author", maintainer, item);
      assertSection("external_author", !maintainer, item);
    }
  }
});

test("authority review stays available for every PR, including runtime-consumed Markdown", () => {
  for (const pullFiles of [
    undefined,
    [],
    [{ filename: "src/authority.ts" }],
    [{ filename: "docs/guide.md" }],
    [{ filename: "docs/reference/templates/AGENTS.md" }],
    [{ filename: "docs/proof/run-proof.mjs" }],
  ]) {
    const input = context({ pullFiles });
    assertSection("authority_chain", true, target(), input);
    assertSection("authority_chain", false, target({ kind: "issue" }), input);
  }
});

test("automation authors retain security review without external-human proof gating", () => {
  for (const author of ["dependabot[bot]", "app/clawsweeper"]) {
    const item = target({ author });
    assertSection("external_author", false, item);
    assertSection("maintainer_author", false, item);
    assertSection("authority_chain", true, item);
  }
});

test("renderer composes adjacent sections without exposing markers or changing literal content", () => {
  const sections = reviewPromptSections(target(), context());
  const template =
    "prefix\n<!-- review-section: external_author -->\nexternal\n<!-- /review-section -->\n<!-- review-section: maintainer_author -->\nmaintainer\n<!-- /review-section -->\n<!-- review-section: external_author -->\nexternal again\n<!-- /review-section -->\nsuffix\n";
  for (const lineEnding of ["\n", "\r\n"]) {
    assert.equal(
      renderReviewSections(template.replaceAll("\n", lineEnding), sections),
      "prefix\nexternal\nexternal again\nsuffix\n",
    );
  }
  const literal =
    "prefix\n\n  <!-- review-section: external_author --> inline\n{{unchanged}}\nsuffix\n";
  assert.equal(renderReviewSections(literal, sections), literal);
});

test("renderer rejects unknown, nested and unbalanced sections, including excluded ones", () => {
  const sections = reviewPromptSections(target(), context());
  for (const template of [
    "<!-- review-section: unknown -->\nbody\n<!-- /review-section -->",
    "<!-- /review-section -->",
    "<!-- review-section: external_author -->\nbody",
    "<!-- review-section: maintainer_author -->\nbody",
    "<!-- review-section: maintainer_author -->\n<!-- review-section: external_author -->\n<!-- /review-section -->\n<!-- /review-section -->",
  ]) {
    for (const lineEnding of ["\n", "\r\n"]) {
      assert.throws(() => renderReviewSections(template.replaceAll("\n", lineEnding), sections));
    }
  }
});

const ageGates: readonly [RepositoryCloseReason, Item["kind"], number][] = [
  ["mostly_implemented_on_main", "pull_request", STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS],
  ["stalled_unproven_pr", "pull_request", STALLED_UNPROVEN_PR_MIN_AGE_DAYS],
  ["abandoned_pr", "pull_request", ABANDONED_PR_MIN_AGE_DAYS],
  ["unconfirmed_product_direction", "pull_request", UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS],
  ["unsponsored_feature_request", "issue", UNSPONSORED_FEATURE_MIN_AGE_DAYS],
  ["stale_version_bug", "issue", STALE_VERSION_BUG_MIN_AGE_DAYS],
  ["obsolete_fix_pr", "pull_request", OBSOLETE_FIX_PR_MIN_AGE_DAYS],
  ["stale_insufficient_info", "issue", STALE_INSUFFICIENT_INFO_MIN_AGE_DAYS],
];

for (const [reason, kind, days] of ageGates) {
  test(`${reason} age gate excludes below/equal and includes above the owner threshold`, () => {
    for (const [offset, included] of [
      [-1, false],
      [0, false],
      [1, true],
    ] as const) {
      const createdAt = new Date(now - days * DAY_MS - offset).toISOString();
      assert.deepEqual(
        applicableCloseReasons(target({ kind, createdAt }), context(), [reason], now),
        included ? [reason] : [],
      );
    }
    for (const createdAt of ["", "not-a-date"]) {
      assert.deepEqual(
        applicableCloseReasons(target({ kind, createdAt }), context(), [reason], now),
        [reason],
      );
    }
  });
}

test("close reasons omit other item kinds and unproduced author budget evidence", () => {
  const issueOnly: RepositoryCloseReason[] = [
    "unsponsored_feature_request",
    "stale_version_bug",
    "stale_insufficient_info",
  ];
  const prOnly: RepositoryCloseReason[] = [
    "mostly_implemented_on_main",
    "low_signal_unmergeable_pr",
    "oversized_pull_request",
    "stalled_unproven_pr",
    "abandoned_pr",
    "unconfirmed_product_direction",
    "obsolete_fix_pr",
  ];
  assert.deepEqual(applicableCloseReasons(target(), context(), issueOnly, now), []);
  assert.deepEqual(applicableCloseReasons(target({ kind: "issue" }), context(), prOnly, now), []);
  for (const kind of ["issue", "pull_request"] as const) {
    assert.deepEqual(
      applicableCloseReasons(
        target({ kind }),
        context(),
        ["none", "author_pr_budget_exceeded"],
        now,
      ),
      [],
    );
    const shared: RepositoryCloseReason[] = [
      "incoherent",
      "implemented_on_main",
      "cannot_reproduce",
      "clawhub",
      "duplicate_or_superseded",
      "not_actionable_in_repo",
    ];
    assert.deepEqual(applicableCloseReasons(target({ kind }), context(), shared, now), shared);
  }
});

function oversizedPull(additions = maxPrChangedLines() + 1) {
  return { additions, deletions: 0, changedFiles: 1, head: { sha: "a".repeat(40) } };
}

test("maintainer and protected close guards preserve only evaluator-authorized oversized exceptions", () => {
  const guarded = [
    ...["OWNER", "MEMBER", "COLLABORATOR"].map((authorAssociation) =>
      target({ authorAssociation }),
    ),
    ...PROTECTED_LABELS,
  ].map((candidate) =>
    typeof candidate === "string" ? target({ labels: [candidate] }) : candidate,
  );
  for (const item of guarded) {
    assert.deepEqual(applicableCloseReasons(item, context(), reasons, now), []);
    const pull = oversizedPull();
    assert.deepEqual(
      applicableCloseReasons(
        { ...item, kind: "issue" },
        context({ pullRequest: pull }),
        reasons,
        now,
      ),
      [],
    );
    const admitted = evaluateOversizedPullRequest({
      ...pull,
      head: pull.head.sha,
      labels: item.labels,
      threshold: maxPrChangedLines(),
    }).admitted;
    assert.deepEqual(
      applicableCloseReasons(item, context({ pullRequest: pull }), reasons, now),
      admitted || applyBlockingProtectedLabels(item.labels, "oversized_pull_request").length > 0
        ? []
        : ["oversized_pull_request"],
    );
  }
  assert.deepEqual(
    applicableCloseReasons(
      target({ authorAssociation: "OWNER" }),
      context({ pullRequest: oversizedPull() }),
      reasons,
      now,
    ),
    ["oversized_pull_request"],
  );
});

test("oversized close reason requires complete metadata above the configured owner threshold", () => {
  const reason: RepositoryCloseReason[] = ["oversized_pull_request"];
  for (const pullRequest of [
    undefined,
    {},
    oversizedPull(maxPrChangedLines() - 1),
    oversizedPull(maxPrChangedLines()),
    { ...oversizedPull(), head: {} },
    { ...oversizedPull(), additions: undefined },
    { ...oversizedPull(), changedFiles: undefined },
  ]) {
    assert.deepEqual(applicableCloseReasons(target(), context({ pullRequest }), reason, now), []);
  }
  for (const pullRequest of [
    oversizedPull(),
    { ...oversizedPull(), changedFiles: undefined, changed_files: 1 },
  ]) {
    assert.deepEqual(
      applicableCloseReasons(target(), context({ pullRequest }), reason, now),
      reason,
    );
    assert.deepEqual(
      applicableCloseReasons(target({ kind: "issue" }), context({ pullRequest }), reason, now),
      [],
    );
    assert.deepEqual(
      applicableCloseReasons(
        target({ labels: [ACCEPTED_LARGE_LABEL] }),
        context({ pullRequest }),
        reason,
        now,
      ),
      [],
    );
  }
});
