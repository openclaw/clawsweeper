import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { renderReviewCommentFromReport } from "../dist/clawsweeper.js";
import { createReviewedPrActivityCursor } from "../dist/review-activity-cursor.js";

export const tmpPrefix = join(tmpdir(), "clawsweeper-test-");
export const emptyReviewedPrActivityCursor =
  createReviewedPrActivityCursor({ reviews: [], inlineComments: [], reviewThreads: [] }) ??
  (() => {
    throw new Error("empty reviewed PR activity must produce a cursor");
  })();

export function readText(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

export function item(overrides = {}) {
  return {
    repo: "openclaw/openclaw",
    number: 123,
    kind: "issue",
    title: "Sample item",
    url: "https://github.com/openclaw/openclaw/issues/123",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    author: "contributor",
    authorAssociation: "NONE",
    labels: [],
    ...overrides,
  };
}

export function closeDecision(overrides = {}) {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    summary: "Current main already implements this.",
    changeSummary: "Requests confirmation that the feature works on current main.",
    evidence: [
      {
        label: "implementation",
        detail: "The feature is present in source.",
        file: "src/example.ts",
        line: 12,
        command: null,
        sha: "abcdef1234567890",
      },
      {
        label: "git history provenance",
        detail: "git blame traces the implemented line to abcdef1234567890.",
        file: "src/example.ts",
        line: 12,
        command: "git blame -L 12,12 -- src/example.ts",
        sha: "abcdef1234567890",
      },
      {
        label: "release provenance",
        detail: "The fix is on current main and no containing release tag was found.",
        file: null,
        line: null,
        command: "git tag --contains abcdef1234567890",
        sha: "abcdef1234567890",
      },
    ],
    likelyOwners: [
      {
        person: "@alice",
        role: "introduced behavior",
        reason: "git blame points the relevant implementation line at abcdef1234567890.",
        commits: ["abcdef1234567890"],
        files: ["src/example.ts"],
        confidence: "high",
      },
      {
        person: "@bob",
        role: "recent maintainer",
        reason: "Recent adjacent commits changed the same code path.",
        commits: ["1234567890abcdef"],
        files: ["src/example.ts"],
        confidence: "medium",
      },
    ],
    risks: [],
    bestSolution: "Keep the implementation as-is.",
    maintainerDecision: {
      required: false,
      kind: "none",
      question: "",
      rationale: "",
      options: [],
      likelyOwner: { person: "", reason: "", confidence: "low" },
    },
    triagePriority: "P2",
    impactLabels: [],
    maturityLabels: [],
    mergeRiskLabels: [],
    mergeRiskOptions: [],
    reviewMetrics: [],
    labelJustifications: [
      {
        label: "P2",
        reason: "Normal priority applies to this limited-scope implemented behavior check.",
      },
    ],
    itemCategory: "bug",
    reproductionStatus: "reproduced",
    reproductionConfidence: "high",
    requiresNewFeature: false,
    requiresNewConfigOption: false,
    requiresProductDecision: false,
    reproductionAssessment:
      "Yes. Current main can be checked by inspecting src/example.ts and git blame evidence.",
    solutionAssessment:
      "Yes. Keeping the implementation as-is is the narrowest maintainable outcome.",
    visionFit: "not_applicable",
    visionFitReason: "Vision-fit assessment is not needed for this implemented close decision.",
    visionFitEvidence: [],
    implementationComplexity: "not_applicable",
    autoImplementationCandidate: "none",
    rootCauseCluster: {
      confidence: "low",
      canonicalRef: null,
      currentItemRelationship: "independent",
      summary: "No evidence-backed root-cause cluster was established.",
      members: [],
    },
    agentsPolicyStatus: {
      found: true,
      readFully: true,
      applied: true,
      status: "found_applied",
      summary: "Found AGENTS.md and applied relevant repository review guidance.",
    },
    reviewFindings: [],
    securityReview: {
      status: "not_applicable",
      summary: "No patch security review is needed for this issue cleanup decision.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "not_applicable",
      summary: "Real behavior proof is not required for non-PR issue triage.",
      evidenceKind: "not_applicable",
      needsContributorAction: false,
    },
    prRating: {
      proofTier: "NA",
      patchTier: "NA",
      overallTier: "NA",
      summary: "PR readiness rating is not applicable to this issue cleanup decision.",
      nextSteps: [],
    },
    telegramVisibleProof: {
      status: "not_needed",
      summary: "This non-PR issue triage does not need Telegram visible proof.",
    },
    mantisRecommendation: {
      status: "not_recommended",
      scenario: "none",
      reason: "Mantis proof is not useful for this issue triage.",
      maintainerComment: "",
    },
    featureShowcase: {
      status: "none",
      reason: "This item is not an unusually compelling feature idea.",
    },
    overallCorrectness: "not a patch",
    overallConfidenceScore: 0.75,
    fixedRelease: null,
    fixedSha: "abcdef1234567890",
    fixedAt: "2026-04-28T12:00:00Z",
    closeComment: "Closing this as implemented after Codex review.\n\n- Evidence.",
    workCandidate: "none",
    workConfidence: "low",
    workPriority: "low",
    workReason: "Close decisions do not need a fix PR.",
    workPrompt: "",
    workClusterRefs: [],
    workValidation: [],
    workLikelyFiles: [],
    ...overrides,
  };
}

export function reviewFinding(overrides = {}) {
  return {
    title: "Missing changelog entry",
    body: "This user-facing fix needs a CHANGELOG.md entry.",
    priority: 3,
    confidenceScore: 0.9,
    file: "src/runtime.ts",
    lineStart: 12,
    lineEnd: 12,
    ...overrides,
  };
}

export function changelogReviewDecision(overrides = {}) {
  return closeDecision({
    decision: "keep_open",
    closeReason: "none",
    confidence: "high",
    bestSolution: "Add the required changelog entry before merge.",
    reviewFindings: [reviewFinding({ title: "Add the required changelog entry" })],
    overallCorrectness: "patch is incorrect",
    workCandidate: "queue_fix_pr",
    workConfidence: "high",
    workPriority: "medium",
    workReason: "Add the required changelog entry.",
    workPrompt: "Add a CHANGELOG.md entry.",
    workLikelyFiles: ["CHANGELOG.md"],
    ...overrides,
  });
}

export function reportFrontMatter(overrides = {}) {
  const values = {
    repository: "openclaw/openclaw",
    type: "issue",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    action_taken: "kept_open",
    ...overrides,
  };
  if (values.type === "pull_request" && !Object.hasOwn(values, "review_activity_cursor")) {
    Object.assign(values, { review_activity_cursor: emptyReviewedPrActivityCursor });
  }
  return `---
${Object.entries(values)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---
`;
}

export function realBehaviorProofReportSection(overrides = {}) {
  const values = {
    status: "sufficient",
    evidenceKind: "terminal",
    needsContributorAction: false,
    summary:
      "The PR includes a terminal transcript from a real OpenClaw setup showing the fixed behavior after the patch.",
    ...overrides,
  };
  return `## Real Behavior Proof

Status: ${values.status}

Evidence kind: ${values.evidenceKind}

Needs contributor action: ${values.needsContributorAction}

Summary: ${values.summary}
`;
}

export function prRatingReportSection(overrides = {}) {
  const values = {
    overallTier: "B",
    proofTier: "A",
    patchTier: "B",
    overallLabel: "🐚 platinum hermit",
    proofLabel: "🦞 diamond lobster",
    patchLabel: "🐚 platinum hermit",
    summary: "This PR has strong proof and normal merge-ready implementation quality.",
    nextSteps: "- none",
    ...overrides,
  };
  return `## PR Rating

Overall tier: ${values.overallTier}

Proof tier: ${values.proofTier}

Patch tier: ${values.patchTier}

Overall label: ${values.overallLabel}

Proof label: ${values.proofLabel}

Patch label: ${values.patchLabel}

Summary: ${values.summary}

Next rank-up steps:

${values.nextSteps}
`;
}

export function detailsBody(markdown, summary) {
  const marker = `<summary>${summary}</summary>`;
  const markerIndex = markdown.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing details summary ${summary}`);
  const bodyStart = markerIndex + marker.length;
  const bodyEnd = markdown.indexOf("</details>", bodyStart);
  assert.notEqual(bodyEnd, -1, `missing details close for ${summary}`);
  return markdown.slice(bodyStart, bodyEnd);
}

export function auditRecord(number, overrides = {}) {
  return {
    repo: "openclaw/openclaw",
    number,
    location: "items",
    path: `items/${number}.md`,
    kind: "issue",
    title: `Item ${number}`,
    labels: [],
    decision: "keep_open",
    closeReason: "none",
    action: "kept_open",
    reviewStatus: "complete",
    currentState: undefined,
    ...overrides,
  };
}

export function workPlanCandidateReport(overrides = {}) {
  const frontmatter = {
    number: 321,
    repository: "openclaw/clawsweeper",
    type: "issue",
    title: "Render work plans",
    reviewed_at: new Date().toISOString(),
    review_status: "complete",
    local_checkout_access: "verified",
    decision: "keep_open",
    action_taken: "kept_open",
    work_candidate: "queue_fix_pr",
    work_status: "candidate",
    work_priority: "medium",
    work_confidence: "high",
    work_likely_files: JSON.stringify(["src/clawsweeper.ts", "test/clawsweeper.test.ts"]),
    work_validation: JSON.stringify(["pnpm run check"]),
    work_cluster_refs: JSON.stringify(["openclaw/clawsweeper#26"]),
    ...overrides,
  };
  if (
    frontmatter.type === "pull_request" &&
    !Object.hasOwn(frontmatter, "review_activity_cursor")
  ) {
    Object.assign(frontmatter, { review_activity_cursor: emptyReviewedPrActivityCursor });
  }
  return `---
${Object.entries(frontmatter)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---

# #321: Render work plans

## Summary

The dashboard has queue_fix_pr candidates but no generated coding plan.

## Repair Work Prompt

Render generated plan markdown from existing report fields.
`;
}

export function implementedCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "implemented_on_main",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    reproduction_status: "reproduced",
    reproduction_confidence: "high",
    fixed_sha: "1234567890abcdef1234567890abcdef12345678",
    fixed_at: "2026-05-01T02:00:00Z",
    ...overrides,
  })}\n\n## Evidence\n\n- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet\n  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)\n  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)\n\n## Close Comment\n\nClosing this because the requested behavior is already on main.\n`;
}

export function stalePullRequestReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    number: 330,
    type: "pull_request",
    title: "Stale F PR",
    url: "https://github.com/openclaw/openclaw/pull/330",
    author: "reporter",
    author_association: "CONTRIBUTOR",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    action_taken: "kept_open",
    work_candidate: "manual_review",
    work_status: "manual_review",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-02-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    reviewed_at: "2026-05-01T00:00:00Z",
    labels: JSON.stringify(["status: 📣 needs proof"]),
    pr_rating_overall: "F",
    pr_rating_proof: "F",
    pr_rating_patch: "F",
    ...overrides,
  })}\n\n## Real Behavior Proof\n\nStatus: missing\nEvidence kind: none\nNeeds contributor action: true\nSummary: No live proof was supplied.\n\n## PR Rating\n\nOverall tier: F\nProof tier: F\nPatch tier: F\nSummary: The PR is not merge-ready.\nNext rank-up steps:\n- Rebase and provide proof.\n`;
}

export function stripProofAndRatingFrontMatter(report: string): string {
  return report.replace(
    /\n(?:real_behavior_proof_status|pr_rating_overall|pr_rating_proof|pr_rating_patch):[^\n]*/g,
    "",
  );
}

export function lowSignalCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "pull_request",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "low_signal_unmergeable_pr",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-05-01T00:00:00Z",
    item_updated_at: "2026-05-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    ...overrides,
  })}\n\n## Evidence\n\n- **branch shape:** PR diff is mostly unrelated provider churn around a tiny possible useful tweak\n\n## Close Comment\n\nClosing this PR because the branch is not a useful landing base.\n`;
}

export function promotionGhMock(options: {
  number: number;
  title?: string;
  labels?: string[];
  itemCreatedAt?: string;
  itemUpdatedAt?: string;
  itemUpdatedAtAfterLabelSync?: string;
  itemUpdatedAtAfterLabelSyncLogPath?: string;
  itemUpdatedAtAfterProof?: string;
  itemUpdatedAtAfterProofLogPath?: string;
  headSha?: string;
  changedFiles?: number;
  sourceFiles?: Array<string | { filename: string; status: string }>;
  issueCommentCount?: number;
  comment: string;
  commentWriteLogPath?: string;
  commentWriteError?: string;
  closeAppliedBodyLogPath?: string;
  closeCommandLogPath?: string;
  closeCommandDelayMs?: number;
  comments?: unknown[];
  commentsAfterFirstRead?: unknown[];
  commentsAfterCommentWrite?: unknown[];
  reviews?: unknown[];
  reviewsAfterFirstRead?: unknown[];
  reviewsAfterFirstMutation?: unknown[];
  pullReviewComments?: unknown[];
  reviewThreads?: unknown[];
  reviewThreadsAfterFirstRead?: unknown[];
  timeline?: unknown[];
  mergeable?: boolean | null;
  mergeableState?: string | null;
  headActivityAt?: string | null;
  headRunPullRequests?: unknown[];
  authorLogin?: string;
  authorAssociation?: string;
  openPrCount?: number;
  authorSearchIncomplete?: boolean;
  authorSearchError?: string;
  headCommittedAt?: string;
  statusActivityAt?: string;
  checkActivityAt?: string;
  assignees?: unknown[];
  requestedReviewers?: unknown[];
  requestedTeams?: unknown[];
  linkedPulls?: Record<number, unknown>;
  linkedPullsAfterProof?: Record<number, unknown>;
  linkedPullsAfterCommentRead?: Record<number, unknown>;
  linkedPullHangAfterProof?: boolean;
  linkedIssues?: Record<number, unknown>;
  defaultBranch?: string;
  postHeadPathChanges?: Record<string, string | null>;
  deletedMainPaths?: string[];
  pathLookupError?: string;
}) {
  const title = options.title ?? "Stale F PR";
  const itemCreatedAt = options.itemCreatedAt ?? "2026-02-01T00:00:00Z";
  const itemUpdatedAt = options.itemUpdatedAt ?? "2026-05-01T00:00:00Z";
  const comments = options.comments ?? [
    {
      id: 9000 + options.number,
      html_url: `https://github.com/openclaw/openclaw/pull/${options.number}#issuecomment-${
        9000 + options.number
      }`,
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: options.comment,
    },
  ];
  const issueCommentCount = options.issueCommentCount ?? comments.length;
  const timeline = options.timeline ?? [];
  const linkedPulls = options.linkedPulls ?? {};
  const linkedIssues = options.linkedIssues ?? {};
  return `
	const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("fs");
	const { join } = require("path");
	const rawArgs = process.argv.slice(2);
	const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
	const path = args[1] || "";
	const slurp = args.includes("--slurp");
	const jqIndex = args.indexOf("--jq");
	const jq = jqIndex >= 0 ? args[jqIndex + 1] : "";
	const comments = ${JSON.stringify(comments)};
	const commentsAfterFirstRead = ${JSON.stringify(options.commentsAfterFirstRead ?? null)};
	const commentsAfterCommentWrite = ${JSON.stringify(options.commentsAfterCommentWrite ?? null)};
	const reviews = ${JSON.stringify(options.reviews ?? [])};
	const reviewsAfterFirstRead = ${JSON.stringify(options.reviewsAfterFirstRead ?? null)};
	const reviewsAfterFirstMutation = ${JSON.stringify(options.reviewsAfterFirstMutation ?? null)};
	const pullReviewComments = ${JSON.stringify(options.pullReviewComments ?? [])};
	const reviewThreads = ${JSON.stringify(options.reviewThreads ?? [])};
	const reviewThreadsAfterFirstRead = ${JSON.stringify(options.reviewThreadsAfterFirstRead ?? null)};
	const timeline = ${JSON.stringify(timeline)};
	const linkedPulls = ${JSON.stringify(linkedPulls)};
	const linkedPullsAfterProof = ${JSON.stringify(options.linkedPullsAfterProof ?? {})};
	const linkedPullsAfterCommentRead = ${JSON.stringify(options.linkedPullsAfterCommentRead ?? {})};
	const linkedPullHangAfterProof = ${JSON.stringify(options.linkedPullHangAfterProof ?? false)};
	const linkedIssues = ${JSON.stringify(linkedIssues)};
	const defaultBranch = ${JSON.stringify(options.defaultBranch ?? "main")};
	const postHeadPathChanges = ${JSON.stringify(options.postHeadPathChanges ?? {})};
	const deletedMainPaths = new Set(${JSON.stringify(options.deletedMainPaths ?? [])});
	const pathLookupError = ${JSON.stringify(options.pathLookupError ?? "")};
	const obsolescenceFileLookup = ${JSON.stringify(
    options.postHeadPathChanges !== undefined || options.deletedMainPaths !== undefined,
  )};
	const commentWriteLogPath = ${JSON.stringify(options.commentWriteLogPath ?? "")};
	const commentWriteError = ${JSON.stringify(options.commentWriteError ?? "")};
	const closeAppliedBodyLogPath = ${JSON.stringify(options.closeAppliedBodyLogPath ?? "")};
	const closeCommandLogPath = ${JSON.stringify(options.closeCommandLogPath ?? "")};
	const closeCommandDelayMs = ${JSON.stringify(options.closeCommandDelayMs ?? 0)};
	const number = ${options.number};
	const commentStatePath = join(__dirname, "..", "comment-state-" + number + ".json");
	const commentReadStatePath = join(__dirname, "..", "comment-read-" + number);
	const reviewReadStatePath = join(__dirname, "..", "review-read-" + number);
	const reviewThreadReadStatePath = join(__dirname, "..", "review-thread-read-" + number);
	const mutationComment = (id, body) => ({
	  id,
	  html_url: "https://github.com/openclaw/openclaw/pull/" + number + "#issuecomment-" + id,
	  created_at: "2026-05-01T01:00:00Z",
	  updated_at: "2026-05-01T02:00:00Z",
	  user: { login: "clawsweeper[bot]" },
	  body
	});
	const writeMutationComment = () => {
	  const input = args[args.indexOf("--input") + 1];
	  const body = JSON.parse(readFileSync(input, "utf8")).body;
	  const idMatch = path.match(/\\/issues\\/comments\\/(\\d+)$/);
	  const id = idMatch ? Number(idMatch[1]) : 9000 + number;
	  const comment = mutationComment(id, body);
	  writeFileSync(commentStatePath, JSON.stringify(comment), "utf8");
	  return comment;
	};
	const liveComments = () => {
	  const sourceComments = commentsAfterCommentWrite && existsSync(commentStatePath)
	    ? commentsAfterCommentWrite
	    : commentsAfterFirstRead && existsSync(commentReadStatePath)
	      ? commentsAfterFirstRead
	      : comments;
	  if (!existsSync(commentStatePath)) return sourceComments;
	  const written = JSON.parse(readFileSync(commentStatePath, "utf8"));
	  const existingIndex = sourceComments.findIndex((comment) => comment && comment.id === written.id);
	  if (existingIndex < 0) return [...sourceComments, written];
	  return sourceComments.map((comment, index) => index === existingIndex ? { ...comment, ...written } : comment);
	};
		const title = ${JSON.stringify(title)};
		const labels = ${JSON.stringify(options.labels ?? ["status: 📣 needs proof"])};
		const itemCreatedAt = ${JSON.stringify(itemCreatedAt)};
		const itemUpdatedAt = ${JSON.stringify(itemUpdatedAt)};
		const changedFiles = ${options.changedFiles ?? 2};
		const mergeable = ${JSON.stringify(options.mergeable ?? false)};
		const mergeableState = ${JSON.stringify(options.mergeableState ?? "dirty")};
		const headActivityAt = ${JSON.stringify(
      options.headActivityAt === undefined ? "2026-02-01T01:00:00Z" : options.headActivityAt,
    )};
		const authorLogin = ${JSON.stringify(options.authorLogin ?? "reporter")};
		const authorAssociation = ${JSON.stringify(options.authorAssociation ?? "CONTRIBUTOR")};
		const openPrCount = ${JSON.stringify(options.openPrCount ?? 16)};
		const authorSearchIncomplete = ${JSON.stringify(options.authorSearchIncomplete ?? false)};
		const authorSearchError = ${JSON.stringify(options.authorSearchError ?? "")};
		const headCommittedAt = ${JSON.stringify(options.headCommittedAt ?? "2026-02-01T00:00:00Z")};
		const statusActivityAt = ${JSON.stringify(options.statusActivityAt ?? "")};
		const checkActivityAt = ${JSON.stringify(options.checkActivityAt ?? "")};
		const sourceFiles = ${JSON.stringify(
      (options.sourceFiles ?? ["src/runtime.ts", "test/runtime.test.ts"]).map((entry) =>
        typeof entry === "string" ? { filename: entry, status: "modified" } : entry,
      ),
    )};
		const itemUpdatedAtAfterLabelSync = ${JSON.stringify(
      options.itemUpdatedAtAfterLabelSync ?? "",
    )};
		const itemUpdatedAtAfterLabelSyncLogPath = ${JSON.stringify(
      options.itemUpdatedAtAfterLabelSyncLogPath ?? "",
    )};
		const itemUpdatedAtAfterProof = ${JSON.stringify(options.itemUpdatedAtAfterProof ?? "")};
		const itemUpdatedAtAfterProofLogPath = ${JSON.stringify(
      options.itemUpdatedAtAfterProofLogPath ?? "",
    )};
		const proofHasRun = () =>
		  itemUpdatedAtAfterProofLogPath &&
		  existsSync(itemUpdatedAtAfterProofLogPath);
		const liveLinkedPulls = {
		  ...linkedPulls,
		  ...(proofHasRun() ? linkedPullsAfterProof : {}),
		  ...(existsSync(commentReadStatePath) ? linkedPullsAfterCommentRead : {})
		};
		const liveUpdatedAt =
		  itemUpdatedAtAfterProof &&
		  itemUpdatedAtAfterProofLogPath &&
		  existsSync(itemUpdatedAtAfterProofLogPath)
		    ? itemUpdatedAtAfterProof
		    : itemUpdatedAtAfterLabelSync &&
		        itemUpdatedAtAfterLabelSyncLogPath &&
		        existsSync(itemUpdatedAtAfterLabelSyncLogPath)
		      ? itemUpdatedAtAfterLabelSync
		      : itemUpdatedAt;
	const issueCommentCount = ${issueCommentCount};
	if (args[0] === "api" && path === "search/issues") {
	  if (authorSearchError) {
	    console.error(authorSearchError);
	    process.exit(1);
	  }
	  console.log(JSON.stringify({ total_count: openPrCount, incomplete_results: authorSearchIncomplete, items: [] }));
	} else if (args[0] === "api" && args[1] === "graphql") {
	  const currentReviewThreads =
	    reviewThreadsAfterFirstRead && existsSync(reviewThreadReadStatePath)
	      ? reviewThreadsAfterFirstRead
	      : reviewThreads;
	  if (!existsSync(reviewThreadReadStatePath)) writeFileSync(reviewThreadReadStatePath, "read", "utf8");
	  console.log(JSON.stringify({
	    data: {
	      repository: {
	        pullRequest: {
	          reviewThreads: {
	            nodes: currentReviewThreads,
	            pageInfo: { hasNextPage: false, endCursor: null }
	          }
	        }
	      }
	    }
	  }));
	} else if (args[0] === "api" && args[1] === "-i" && new RegExp("/issues/" + number + "/timeline(?:\\\\?|$)").test(args[2] || "")) {
	  console.log("HTTP/2 200\\n\\n" + JSON.stringify(timeline));
	} else if (args[0] === "api" && new RegExp("/issues/" + number + "/comments$").test(path) && args.includes("--method")) {
	  if (commentWriteLogPath) appendFileSync(commentWriteLogPath, args.join(" ") + "\\n");
	  if (commentWriteError) {
	    console.error(commentWriteError);
	    process.exit(1);
	  }
	  if (closeAppliedBodyLogPath) {
	    const input = args[args.indexOf("--input") + 1];
	    appendFileSync(closeAppliedBodyLogPath, JSON.parse(readFileSync(input, "utf8")).body + "\\n---body---\\n");
	  }
	  console.log(JSON.stringify(writeMutationComment()));
	} else if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args[args.indexOf("--method") + 1] === "DELETE") {
	  if (commentWriteLogPath) appendFileSync(commentWriteLogPath, args.join(" ") + "\\n");
	  console.log("");
	} else if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args.includes("--method")) {
	  if (commentWriteLogPath) appendFileSync(commentWriteLogPath, args.join(" ") + "\\n");
	  if (commentWriteError) {
	    console.error(commentWriteError);
	    process.exit(1);
	  }
	  console.log(JSON.stringify(writeMutationComment()));
	} else if (args[0] === "api" && new RegExp("/issues/" + number + "/comments(?:\\\\?|$)").test(path)) {
	  const currentComments = liveComments();
	  if (!existsSync(commentReadStatePath)) writeFileSync(commentReadStatePath, "read", "utf8");
	  console.log(JSON.stringify(slurp ? [currentComments] : currentComments));
} else if (args[0] === "api" && new RegExp("/issues/" + number + "/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [timeline] : timeline));
} else if (args[0] === "api" && new RegExp("/pulls/" + number + "/reviews(?:\\\\?|$)").test(path)) {
  const currentReviews =
    reviewsAfterFirstMutation &&
    itemUpdatedAtAfterLabelSyncLogPath &&
    existsSync(itemUpdatedAtAfterLabelSyncLogPath)
      ? reviewsAfterFirstMutation
      : reviewsAfterFirstRead && existsSync(reviewReadStatePath)
        ? reviewsAfterFirstRead
        : reviews;
  if (!existsSync(reviewReadStatePath)) writeFileSync(reviewReadStatePath, "read", "utf8");
  console.log(JSON.stringify(slurp ? [currentReviews] : currentReviews));
} else if (args[0] === "api" && new RegExp("/issues/" + number + "$").test(path)) {
  console.log(JSON.stringify({
    number,
    title,
    html_url: "https://github.com/openclaw/openclaw/pull/" + number,
    body: "Stale PR body.",
    created_at: itemCreatedAt,
    updated_at: liveUpdatedAt,
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: authorAssociation,
    user: { login: authorLogin },
    labels,
    assignees: ${JSON.stringify(options.assignees ?? [])},
    comments: issueCommentCount,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/" + number }
  }));
} else if (args[0] === "api" && new RegExp("/pulls/" + number + "$").test(path)) {
  console.log(JSON.stringify({
    number,
    title,
    html_url: "https://github.com/openclaw/openclaw/pull/" + number,
    state: "open",
    created_at: itemCreatedAt,
    mergeable,
    mergeable_state: mergeableState,
    changed_files: changedFiles,
    commits: 1,
    review_comments: 0,
    body: "Stale PR body.",
    requested_reviewers: ${JSON.stringify(options.requestedReviewers ?? [])},
    requested_teams: ${JSON.stringify(options.requestedTeams ?? [])},
    head: { sha: ${JSON.stringify(options.headSha ?? "head-sha")}, ref: "branch", repo: { id: 123, full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: authorLogin }
  }));
	} else if (args[0] === "api" && /\\/actions\\/runs\\?/.test(path)) {
	  console.log(JSON.stringify({
	    workflow_runs: headActivityAt ? [{
	      event: "pull_request",
	      created_at: headActivityAt,
	      head_branch: "branch",
	      head_repository: { id: 123, full_name: "fork/openclaw" },
	      pull_requests: ${JSON.stringify(options.headRunPullRequests ?? [{ number: options.number }])}
	    }] : []
	  }));
	} else if (args[0] === "api" && /\\/commits\\/head-sha\\/status(?:\\?|$)/.test(path)) {
	  console.log(JSON.stringify({
	    state: "success",
	    statuses: statusActivityAt ? [{ state: "success", updated_at: statusActivityAt }] : []
	  }));
	} else if (args[0] === "api" && /\\/commits\\/head-sha\\/check-runs(?:\\?|$)/.test(path)) {
	  console.log(JSON.stringify({
	    total_count: checkActivityAt ? 1 : 0,
	    check_runs: checkActivityAt ? [{ conclusion: "success", completed_at: checkActivityAt }] : []
	  }));
	} else if (args[0] === "api" && /\\/commits\\/head-sha(?:\\?|$)/.test(path)) {
	  console.log(JSON.stringify({ commit: { committer: { date: headCommittedAt } } }));
	} else if (args[0] === "api" && path === "repos/openclaw/openclaw") {
	  console.log(JSON.stringify({ default_branch: defaultBranch }));
	} else if (args[0] === "api" && path.startsWith("repos/openclaw/openclaw/commits?")) {
	  if (pathLookupError) {
	    console.error(pathLookupError);
	    process.exit(1);
	  }
	  const params = new URLSearchParams(path.split("?", 2)[1] || "");
	  const filename = params.get("path") || "";
	  const changedAt = Object.prototype.hasOwnProperty.call(postHeadPathChanges, filename)
	    ? postHeadPathChanges[filename]
	    : "2026-06-01T00:00:00Z";
	  console.log(JSON.stringify(changedAt ? [{ commit: { committer: { date: changedAt } } }] : []));
	} else if (args[0] === "api" && /\\/contents\\//.test(path)) {
	  const prefix = "repos/openclaw/openclaw/contents/";
	  const filename = decodeURIComponent(path.slice(prefix.length).split("?", 1)[0] || "");
	  if (deletedMainPaths.has(filename)) {
	    console.error("gh: Not Found (HTTP 404)");
	    process.exit(1);
	  }
	  console.log(JSON.stringify({ path: filename, type: "file" }));
	} else if (args[0] === "api" && /\\/pulls\\/(\\d+)$/.test(path)) {
	  const linkedNumber = Number((path.match(/\\/pulls\\/(\\d+)$/) || [])[1]);
	  if (proofHasRun() && linkedPullHangAfterProof) {
	    setTimeout(() => {}, 60_000);
	  } else {
	    if (!liveLinkedPulls[linkedNumber]) {
	      console.error("unexpected linked pull", linkedNumber);
	      process.exit(1);
	    }
	    console.log(JSON.stringify(liveLinkedPulls[linkedNumber]));
	  }
	} else if (args[0] === "api" && /\\/issues\\/(\\d+)\\/comments(?:\\?|$)/.test(path)) {
	  const linkedNumber = Number((path.match(/\\/issues\\/(\\d+)\\/comments/) || [])[1]);
	  const linkedIssue = liveLinkedPulls[linkedNumber] || linkedIssues[linkedNumber];
  if (!linkedIssue) {
    console.error("unexpected linked comments", linkedNumber);
    process.exit(1);
  }
  if (linkedIssue.commentsError) {
    console.error(linkedIssue.commentsError);
    process.exit(1);
  }
  const linkedComments = Array.isArray(linkedIssue.comments)
    ? linkedIssue.comments
    : [];
  console.log(JSON.stringify(slurp ? [linkedComments] : linkedComments));
	} else if (args[0] === "api" && /\\/issues\\/(\\d+)$/.test(path)) {
	  const linkedNumber = Number((path.match(/\\/issues\\/(\\d+)$/) || [])[1]);
	  const linkedIssue = liveLinkedPulls[linkedNumber] || linkedIssues[linkedNumber];
  if (!linkedIssue) {
    console.error("unexpected linked issue", linkedNumber);
    process.exit(1);
  }
  const labels = Array.isArray(linkedIssue.labels)
    ? linkedIssue.labels.map((label) =>
        typeof label === "string" ? label : label && label.name ? label.name : null,
      ).filter(Boolean)
    : [];
  if (jq === "[.labels[].name]") {
    console.log(JSON.stringify(labels));
  } else {
    console.log(JSON.stringify({
      number: linkedNumber,
      title: linkedIssue.title || ("PR #" + linkedNumber),
      html_url: linkedIssue.html_url || ("https://github.com/openclaw/openclaw/pull/" + linkedNumber),
      body: linkedIssue.body || "",
      state: linkedIssue.state || "open",
      labels: labels.map((name) => ({ name })),
      comments: Array.isArray(linkedIssue.comments) ? linkedIssue.comments.length : 0,
      pull_request: linkedIssue.pull_request || null,
    }));
  }
	} else if (args[0] === "api" && /\\/pulls\\/(\\d+)\\/files(?:\\?|$)/.test(path)) {
	  const linkedNumber = Number((path.match(/\\/pulls\\/(\\d+)\\/files/) || [])[1]);
	  if (linkedNumber !== number && !liveLinkedPulls[linkedNumber]) {
	    console.error("unexpected linked pull files", linkedNumber);
	    process.exit(1);
	  }
	  const files = linkedNumber === number ? sourceFiles : liveLinkedPulls[linkedNumber].files || sourceFiles;
  if (jq === "[.[].filename]") {
    console.log(JSON.stringify(files.map((file) =>
      typeof file === "string" ? file : file && file.filename ? file.filename : null,
    ).filter(Boolean)));
	  } else {
	    console.log(JSON.stringify(slurp ? [files] : obsolescenceFileLookup ? files : [files]));
	  }
} else if (args[0] === "api" && new RegExp("/pulls/" + number + "/comments(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [pullReviewComments] : pullReviewComments));
} else if (args[0] === "api" && new RegExp("/pulls/" + number + "/(files|commits)(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "pr" && args[1] === "close" && args[2] === String(number)) {
  if (closeCommandLogPath) appendFileSync(closeCommandLogPath, args.join(" ") + "\\n");
  if (closeCommandDelayMs > 0) setTimeout(() => console.log(""), closeCommandDelayMs);
  else console.log("");
	} else if (args[0] === "issue" && args[1] === "edit") {
	  if (itemUpdatedAtAfterLabelSyncLogPath) appendFileSync(itemUpdatedAtAfterLabelSyncLogPath, args.join(" ") + "\\n");
	  console.log("");
	} else if (args[0] === "label" || args[0] === "issue") {
	  console.log("");
	} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
}

export function markedReviewCommentForTest(number: number, body: string): string {
  return `${body.trimEnd()}\n\n<!-- clawsweeper-review item=${number} -->`;
}

function sha256ForTest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function reportWithSyncedReviewComment(
  report: string,
  number: number,
  reason = "none",
): {
  report: string;
  comment: string;
} {
  const comment = markedReviewCommentForTest(number, renderReviewCommentFromReport(report, reason));
  return {
    report: report.replace(
      /^---\n/,
      [
        "---",
        `review_comment_sha256: ${sha256ForTest(comment)}`,
        `review_comment_id: ${9000 + number}`,
        `review_comment_url: https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-${9000 + number}`,
        "review_comment_synced_at: 2026-05-01T01:00:00Z",
        "",
      ].join("\n"),
    ),
    comment,
  };
}

export function withMockCodexProof(
  root: string,
  result:
    | {
        type: "decision";
        decision: "covered" | "keep_open";
        reason: string;
        invocationLogPath?: string;
        expectedPromptIncludes?: string;
        unexpectedPromptIncludes?: string;
        coveredPromptIncludes?: string;
        keepOpenPromptIncludes?: string;
      }
    | { type: "failure"; message: string; invocationLogPath?: string },
  run: () => void,
): void {
  const originalPath = process.env.PATH;
  const originalCodexBin = process.env.CODEX_BIN;
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  const script =
    result.type === "decision"
      ? `#!/usr/bin/env node
	const { appendFileSync, writeFileSync } = require("fs");
	const args = process.argv.slice(2);
	const outputPath = args[args.indexOf("--output-last-message") + 1];
	const invocationLogPath = ${JSON.stringify(result.invocationLogPath ?? "")};
	const prompt = require("fs").readFileSync(0, "utf8");
	const expectedPrompt = ${JSON.stringify(result.expectedPromptIncludes ?? "")};
	if (expectedPrompt && !prompt.includes(expectedPrompt)) {
	  process.stderr.write("missing expected proof prompt text: " + expectedPrompt);
	  process.exit(1);
	}
	const unexpectedPrompt = ${JSON.stringify(result.unexpectedPromptIncludes ?? "")};
		if (unexpectedPrompt && prompt.includes(unexpectedPrompt)) {
		  process.stderr.write("unexpected proof prompt text: " + unexpectedPrompt);
		  process.exit(1);
		}
		const coveredPrompt = ${JSON.stringify(result.coveredPromptIncludes ?? "")};
		const keepOpenPrompt = ${JSON.stringify(result.keepOpenPromptIncludes ?? "")};
		const decision = coveredPrompt && prompt.includes(coveredPrompt)
		  ? "covered"
		  : keepOpenPrompt && prompt.includes(keepOpenPrompt)
		    ? "keep_open"
		    : ${JSON.stringify(result.decision)};
		if (invocationLogPath) appendFileSync(invocationLogPath, "proof\\n");
		writeFileSync(outputPath, JSON.stringify({
	  sourceSummary: "PR A updates the provider route.",
	  coveringSummary: "PR B updates a different provider path.",
	  coveredWork: decision === "covered" ? ["PR B includes PR A's provider route update."] : [],
	  uniqueSourceWork: decision === "covered" ? [] : ["PR A's provider route update is still unique."],
	  decision,
	  reason: ${JSON.stringify(result.reason)}
	}));
`
      : `#!/usr/bin/env node
const { appendFileSync } = require("fs");
const invocationLogPath = ${JSON.stringify(result.invocationLogPath ?? "")};
if (invocationLogPath) appendFileSync(invocationLogPath, "proof\\n");
console.error(${JSON.stringify(result.message)});
process.exit(1);
`;
  writeFileSync(codexPath, script, { mode: 0o755 });
  try {
    process.env.CODEX_BIN = codexPath;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    run();
  } finally {
    if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = originalCodexBin;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

export function runApplyDecisionsForTest(options: {
  targetRepo?: string;
  itemsDir: string;
  closedDir: string;
  plansDir: string;
  reportPath: string;
  extraArgs?: string[];
}): void {
  execFileSync(process.execPath, [
    "dist/clawsweeper.js",
    "apply-decisions",
    "--target-repo",
    options.targetRepo ?? "openclaw/clawsweeper",
    "--items-dir",
    options.itemsDir,
    "--closed-dir",
    options.closedDir,
    "--plans-dir",
    options.plansDir,
    "--report-path",
    options.reportPath,
    "--limit",
    "10",
    "--processed-limit",
    "1",
    "--close-delay-ms",
    "0",
    ...(options.extraArgs ?? []),
  ]);
}

export const git = {
  mainSha: "abcdef1234567890",
  latestRelease: null,
};

export function withMockGh(root: string, script: string, run: () => void): void {
  const originalGhBin = process.env.GH_BIN;
  const originalGhBinArgs = process.env.GH_BIN_ARGS;
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, "gh.js");
  writeFileSync(ghPath, script, { mode: 0o755 });
  try {
    process.env.GH_BIN = process.execPath;
    process.env.GH_BIN_ARGS = JSON.stringify([ghPath]);
    run();
  } finally {
    if (originalGhBin === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = originalGhBin;
    if (originalGhBinArgs === undefined) delete process.env.GH_BIN_ARGS;
    else process.env.GH_BIN_ARGS = originalGhBinArgs;
  }
}

export function mockCommandBinEnv(command: string, commandPath: string): NodeJS.ProcessEnv {
  const key = command.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return {
    [`${key}_BIN`]: process.execPath,
    [`${key}_BIN_ARGS`]: JSON.stringify([commandPath]),
  };
}

export function mockGhBinEnv(ghPath: string, binDir?: string): NodeJS.ProcessEnv {
  return {
    ...mockCommandBinEnv("gh", ghPath),
    ...(binDir ? { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` } : {}),
  };
}
