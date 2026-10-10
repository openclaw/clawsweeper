import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { shouldSyncReviewComment } from "../dist/clawsweeper-record-metadata.js";
import * as publication from "../dist/clawsweeper-review-comment-publication.js";
import * as state from "../dist/clawsweeper-review-comment-state.js";
import { postReviewStartStatusComment } from "../dist/clawsweeper-review-comment-leases.js";
import {
  reviewAutomationMarkersFromReport,
  reviewVersionMarkerFromReport,
} from "../dist/clawsweeper-review-comment-automation.js";
import { freshExactHeadReviewStartLease } from "../dist/repair/comment-router/admission.js";
import { manualPublicationOwnerFromEnv } from "../dist/manual-publication-authority.js";
import { reviewReportFrontMatter, withMockGh, withReviewRecord, item } from "./helpers.ts";
import { ReviewRecordFormatError } from "../dist/review-record.js";
import { repositoryProfileFor, withTargetProfile } from "../dist/repository-profiles.js";
import { withGitHubRun } from "../dist/clawsweeper-github-runtime.js";

const itemNumber = 120232;
const headSha = "522ac4a03828a827c5c266194459d995b9982ff9";
const reviewMarker = `<!-- clawsweeper-review item=${itemNumber} -->`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const markedReviewBody = (body: string) => `${body.trimEnd()}\n\n${reviewMarker}`;

function durableReviewComment(options: {
  id: number;
  reviewedAt: string;
  updatedAt: string;
  leaseCommentId?: number;
  state?: "ready" | "blocked" | "needs-changes";
  author?: string;
}): Record<string, unknown> {
  return {
    id: options.id,
    created_at: options.updatedAt,
    updated_at: options.updatedAt,
    user: { login: options.author ?? "clawsweeper[bot]" },
    body: [
      "Codex review: durable state fixture.",
      `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high updated_at=${options.updatedAt} reviewed_at=${options.reviewedAt} -->`,
      `<!-- clawsweeper-review-state:${options.state ?? "ready"} item=${itemNumber} sha=${headSha} v=1 -->`,
      `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=${options.reviewedAt} sha=${headSha} source_revision=${"a".repeat(64)} lease_owner=fixture lease_comment_id=${options.leaseCommentId ?? options.id} v=1 -->`,
      reviewMarker,
    ].join("\n\n"),
  };
}

interface GitHubFixtureState {
  comments: Record<string, unknown>[];
  calls: string[][];
  reads: number;
  payloads: string[];
  response?: Record<string, unknown> | "empty";
  preserveComments?: boolean;
  updatedAt?: string;
  nextId?: number;
}

function withPublicationFixture(
  comments: Record<string, unknown>[],
  run: (fixture: {
    read: () => GitHubFixtureState;
    update: (changes: Partial<GitHubFixtureState>) => void;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-publication-"));
  const path = join(root, "github.json");
  writeFileSync(path, JSON.stringify({ comments, calls: [], reads: 0, payloads: [] }));
  const read = (): GitHubFixtureState => JSON.parse(readFileSync(path, "utf8"));
  const update = (changes: Partial<GitHubFixtureState>) =>
    writeFileSync(path, JSON.stringify({ ...read(), ...changes }));
  const script = `
const { readFileSync, writeFileSync } = require("node:fs");
const file = ${JSON.stringify(path)};
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args.includes("--input")) {
  state.calls.push(args);
  state.payloads.push(args[args.indexOf("--input") + 1]);
  const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")).body;
  const patch = args[args.indexOf("--method") + 1] === "PATCH";
  const id = patch ? Number(args[1].split("/").at(-1)) : (state.nextId ?? 100);
  const previous = state.comments.find(comment => comment.id === id);
  const comment = { ...previous, id, user: { login: "clawsweeper[bot]" }, body, updated_at: state.updatedAt ?? "2026-08-08T00:01:00Z" };
  if (!state.preserveComments) state.comments = [...state.comments.filter(entry => entry.id !== id), comment];
  if (state.response !== "empty") console.log(JSON.stringify(state.response ?? comment));
} else {
  if (args[0] !== "api" || !args[1].includes("/comments")) throw new Error("unexpected gh args: " + JSON.stringify(args));
  state.reads++;
  console.log(JSON.stringify([state.comments]));
}
writeFileSync(file, JSON.stringify(state));
`;
  try {
    withTargetProfile(repositoryProfileFor("openclaw/openclaw"), () =>
      withGitHubRun(() => withMockGh(root, script, () => run({ read, update }))),
    );
  } finally {
    for (const payload of read().payloads) {
      rmSync(payload, { force: true });
      rmSync(payload.replace(/\.json$/, ".md"), { force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const previousReview = () =>
  durableReviewComment({
    id: 20,
    reviewedAt: "2026-08-07T16:00:00Z",
    updatedAt: "2026-08-07T16:01:00Z",
  });

test("manual publication owner metadata requires actual producer or batch claim identifiers", () => {
  const run = { GITHUB_RUN_ID: "1074", GITHUB_RUN_ATTEMPT: "2" };
  assert.deepEqual(
    manualPublicationOwnerFromEnv({ ...run, EXACT_REVIEW_LEASE_ID: "claimed-lease" }),
    { leaseId: "claimed-lease", runId: "1074", runAttempt: 2 },
  );
  assert.deepEqual(
    manualPublicationOwnerFromEnv({
      ...run,
      EXACT_REVIEW_BATCH_ID: "claimed-batch",
      EXACT_REVIEW_BATCH_LEASE_OWNER: "claimed-worker",
    }),
    { batchId: "claimed-batch", leaseOwner: "claimed-worker", runId: "1074", runAttempt: 2 },
  );
  for (const invalid of [
    {
      ...run,
      EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#74",
      EXACT_REVIEW_LEASE_REVISION: "1",
      EXACT_REVIEW_CLAIM_GENERATION: "1",
    },
    { ...run, EXACT_REVIEW_LEASE_ID: "old-producer", EXACT_REVIEW_BATCH_ID: "incomplete-batch" },
    { EXACT_REVIEW_LEASE_ID: "claimed-lease", GITHUB_RUN_ID: "1074" },
    { ...run, EXACT_REVIEW_LEASE_ID: "claimed-lease", GITHUB_RUN_ATTEMPT: "0" },
  ])
    assert.throws(() => manualPublicationOwnerFromEnv(invalid), /manual publication requires/);
});

test("canonical lease expiry releases admission without rewriting surrounding bytes", () => {
  const expiresAt = "2026-09-02T21:41:00.000Z";
  const queuedAt = "2026-09-02T21:23:00.000Z";
  const body = `Review started.  \r\n\r\n<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=2026-09-02T21:00:00.000Z lease_expires_at=${expiresAt} owner=worker-1 v=1 -->\r\n<!-- clawsweeper-review-lease item=${itemNumber} -->\r\n`;
  const rewritten = state.expireReviewStartStatusLease(body, queuedAt);
  assert.equal(rewritten, body.replace(expiresAt, queuedAt));
  const options = {
    itemNumber,
    headSha,
    trustedAuthors: new Set(["clawsweeper[bot]"]),
    nowMs: Date.parse(queuedAt) + 1,
    comments: [{ body, user: { login: "clawsweeper[bot]" } }],
  };
  assert.ok(freshExactHeadReviewStartLease(options));
  options.comments[0]!.body = rewritten;
  assert.equal(freshExactHeadReviewStartLease(options), null);
  for (const noncanonical of [
    "No marker.  \r\n",
    "<!-- clawsweeper-review-status:started item=1 lease_expires_at=later -->\nVisible text",
    "```\n<!-- clawsweeper-review-status:started item=1 lease_expires_at=later -->\n```",
    "<!-- clawsweeper-review-status:started item=1 lease_expires_at=later -->\n<!-- clawsweeper-review-lease item=2 -->",
  ])
    assert.equal(state.expireReviewStartStatusLease(noncanonical, queuedAt), noncanonical);
});

test("close-applied evidence uses typed fixing PR metadata and preserves legacy links", () => {
  const legacy = reviewReportFrontMatter({
    type: "pull_request",
    number: String(itemNumber),
    fixed_pr_url: "https://github.com/openclaw/openclaw/pull/11",
    fixed_pr_number: "11",
  });
  const options = {
    number: itemNumber,
    closeReason: "implemented_on_main" as const,
    itemUrl: "https://github.com/openclaw/openclaw/pull/120232",
  };
  const publishedBody = (markdown: string): string => {
    let body = "";
    withPublicationFixture([], (fixture) => {
      publication.ensureCloseAppliedComment({ ...options, markdown, dryRun: false });
      body = String(fixture.read().comments[0]!.body);
    });
    return body;
  };
  assert.ok(
    publishedBody(legacy).includes("[fix PR #11](https://github.com/openclaw/openclaw/pull/11)"),
  );
  const typed = withReviewRecord(legacy).replace(/^review_record: (.+)$/m, (_line, value) => {
    const record = JSON.parse(value);
    record.decision.fixedPullRequest = {
      repo: "openclaw/openclaw",
      number: 22,
      url: "https://github.com/openclaw/openclaw/pull/22",
      title: "Fix the reported behavior",
      sha: null,
      confidence: "high",
      source: "GitHub closing PR reference",
      mergedAt: "2026-09-01T00:00:00Z",
    };
    return `review_record: ${JSON.stringify(record)}`;
  });
  assert.ok(
    publishedBody(typed).includes("[fix PR #22](https://github.com/openclaw/openclaw/pull/22)"),
  );
  assert.throws(
    () => publishedBody(typed.replace(/^review_record: \{/m, "review_record: {broken")),
    ReviewRecordFormatError,
  );
});

test("an unchanged exact-head re-review refreshes its durable comment once", () => {
  const existing = durableReviewComment({
    id: 20,
    reviewedAt: "2026-09-08T17:51:38Z",
    updatedAt: "2026-09-08T17:52:00Z",
  });
  const reviewedAt = "2026-09-09T20:00:00Z";
  const body = String(
    durableReviewComment({
      id: 20,
      reviewedAt,
      updatedAt: "2026-09-08T17:52:00Z",
      leaseCommentId: 21,
    }).body,
  );
  withPublicationFixture([existing], (fixture) => {
    const shouldSync = (candidate: string) => {
      const current = fixture.read().comments[0]!;
      return shouldSyncReviewComment({
        syncCommentsOnly: false,
        isCloseProposal: false,
        commentSyncMinAgeDays: 7,
        reviewCommentSyncedAt: String(current.updated_at),
        reviewedAt,
        hasExistingReviewComment: true,
        needsReviewCommentBodySync: !state.commentBodyMatches(current, candidate),
        needsReviewCommentHashSync: !state.reviewCommentHashMatches(
          current,
          candidate,
          sha256(String(current.body)),
          sha256(candidate),
        ),
        needsReviewCommentReferenceSync: false,
      });
    };
    assert.equal(shouldSync(body), true);
    fixture.update({ updatedAt: "2026-09-09T20:01:00Z" });
    const published = publication.upsertReviewComment(itemNumber, body);
    const calls = fixture.read().calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1], "repos/openclaw/openclaw/issues/comments/20");
    assert.equal(calls[0]![calls[0]!.indexOf("--method") + 1], "PATCH");
    const identity = state.durableReviewCausalIdentityFromBody(String(published.body), itemNumber);
    assert.equal(identity?.reviewedAt, reviewedAt);
    assert.equal(identity?.headSha, headSha);
    assert.equal(shouldSync(body), false);
    assert.equal(shouldSync(body.replace("lease_comment_id=21", "lease_comment_id=22")), false);
  });
});

test("review version timestamps round-trip through the durable parser", () => {
  const report = [
    "---",
    "type: pull_request",
    `number: ${itemNumber}`,
    `pull_head_sha: ${headSha}`,
    "reviewed_at: 2026-08-08T20:00:00+02:00",
    `item_source_revision: ${"a".repeat(64)}`,
    "review_lease_owner: fixture",
    "review_lease_comment_id: 20",
    "---",
    "Review",
    "",
  ].join("\n");
  const versionMarker = reviewVersionMarkerFromReport(report);
  const parsed = state.durableReviewCausalIdentityFromBody(
    [
      versionMarker,
      `<!-- clawsweeper-review-state:ready item=${itemNumber} sha=${headSha} v=1 -->`,
      reviewMarker,
    ].join("\n\n"),
    itemNumber,
  );
  assert.match(versionMarker, /\breviewed_at=2026-08-08T18:00:00\.000Z\b/);
  assert.equal(parsed?.reviewedAt, "2026-08-08T18:00:00.000Z");
  const restricted = report.replace("---\n", "---\npublication_policy: record_comment_only\n");
  assert.equal(reviewAutomationMarkersFromReport(restricted), "");
  assert.equal(reviewVersionMarkerFromReport(restricted), versionMarker);
});

test("oversized publication refuses suppressed markers and otherwise verifies a bounded blocked receipt", () => {
  const existing = previousReview();
  const oversized = [
    "Codex review: ready for maintainer look.",
    "x".repeat(70_000),
    `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high updated_at=2026-08-07T16:01:00Z reviewed_at=2026-08-07T18:00:00+02:00 diagnostic=${"y".repeat(70_000)} -->`,
    `<!-- clawsweeper-review-state:ready item=${itemNumber} sha=${headSha} v=1 -->`,
    `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=2026-08-07T18:00:00+02:00 sha=${headSha} source_revision=${"a".repeat(64)} lease_owner=fixture lease_comment_id=20 v=1 -->`,
    reviewMarker,
  ].join("\n\n");
  withPublicationFixture([existing], (fixture) => {
    assert.throws(
      () =>
        publication.upsertReviewComment(itemNumber, oversized, existing, undefined, {
          suppressAutomationMarkers: true,
        }),
      /marker-suppressed publication cannot emit a fallback/,
    );
    assert.equal(fixture.read().calls.length, 0);
    assert.deepEqual(fixture.read().comments, [existing]);
    assert.throws(
      () => publication.upsertReviewComment(itemNumber, oversized, existing),
      (error) => {
        assert.ok(error instanceof publication.DurableReviewPublicationBlockedError);
        assert.match(error.message, /published a blocked fallback and kept the item open/);
        assert.equal(error.syncedComment.id, 20);
        const body = String(fixture.read().comments[0]!.body);
        assert.equal(error.publishedBody, body);
        assert.ok(Buffer.byteLength(body, "utf8") <= 60 * 1024);
        assert.match(body, /Codex review: publication failed closed\./);
        assert.match(body, /## Before merge[\s\S]*- \[ \]/);
        assert.match(body, /clawsweeper-verdict:needs-human/);
        assert.match(body, /clawsweeper-review-state:blocked/);
        assert.doesNotMatch(body, /clawsweeper-review-state:ready|y{100}|z{100}/);
        assert.match(body, /\breviewed_at=2026-08-07T16:00:00\.000Z\b/);
        assert.doesNotMatch(body, /reviewed_at=2026-08-07T18:00:00[+_]02:00/);
        assert.equal((body.match(/<!-- clawsweeper-review-state:/g) ?? []).length, 1);
        assert.equal((body.match(/<!-- clawsweeper-review-version\b/g) ?? []).length, 1);
        assert.ok(body.trimEnd().endsWith(reviewMarker));
        return true;
      },
    );
    assert.equal(fixture.read().calls.length, 1);
  });
});

test("malformed oversized fallback creates a new comment without borrowing an older identity", () => {
  for (const version of [
    "",
    `<!-- clawsweeper-review-version item=${itemNumber} reviewed_at=2026-08-07T14:00:00Z sha=${"b".repeat(40)} v=1 -->`,
  ]) {
    const older = durableReviewComment({
      id: 10,
      reviewedAt: "2026-08-07T15:00:00Z",
      updatedAt: "2026-08-07T15:01:00Z",
    });
    const current = previousReview();
    withPublicationFixture([older, current], (fixture) => {
      const oversized = [
        "Codex review: ready for maintainer look.",
        "x".repeat(70_000),
        `<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} confidence=high reviewed_at=unknown -->`,
        version,
        reviewMarker,
      ]
        .filter(Boolean)
        .join("\n\n");
      assert.throws(
        () => publication.upsertReviewComment(itemNumber, oversized, current),
        publication.DurableReviewPublicationBlockedError,
      );
      const published = fixture.read().comments.find((comment) => comment.id === 100)!;
      assert.ok(fixture.read().calls[0]!.includes("POST"));
      assert.equal(
        state.durableReviewCausalIdentityFromBody(String(published.body), itemNumber),
        null,
      );
      assert.match(String(published.body), /Codex review: publication failed closed\./);
      assert.doesNotMatch(
        String(published.body),
        /clawsweeper-review-state:|clawsweeper-review-version/,
      );
      assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
    });
  }
});

test("identity-less fallback requires a complete causally newer review", () => {
  const selected = {
    id: 20,
    created_at: "2026-08-07T16:00:00Z",
    updated_at: "2026-08-07T16:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: markedReviewBody("Codex review: incomplete durable state."),
  };
  const older = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-07T15:00:00Z",
    updatedAt: "2026-08-07T15:01:00Z",
  });
  withPublicationFixture([older, selected], (fixture) => {
    assert.throws(
      () =>
        publication.upsertReviewComment(
          itemNumber,
          markedReviewBody(
            `${"x".repeat(70_000)}\n<!-- clawsweeper-verdict:needs-human item=${itemNumber} sha=${headSha} reviewed_at=unknown -->`,
          ),
          selected,
        ),
      publication.DurableReviewPublicationBlockedError,
    );
    const blocked = fixture.read().comments.find((comment) => comment.id === 100)!;
    assert.equal(state.durableReviewCausalIdentityFromBody(String(blocked.body), itemNumber), null);
    assert.doesNotMatch(String(blocked.body), /clawsweeper-review-state:/);
    assert.match(fixture.read().calls[0]![1]!, /issues\/120232\/comments$/);
    const fresh = durableReviewComment({
      id: 120,
      reviewedAt: "2026-08-07T16:04:00Z",
      updatedAt: "2026-08-07T16:05:00Z",
      leaseCommentId: 120,
    });
    const body = String(fresh.body);
    for (const malformed of [
      body.replace(/<!-- clawsweeper-review-state:[^>]+-->\n\n/, ""),
      body.replace(`sha=${headSha} v=1 -->`, `sha=${"b".repeat(40)} v=1 -->`),
      body.replace(
        `reviewed_at=2026-08-07T16:04:00Z sha=${headSha}`,
        "reviewed_at=2026-08-07T16:04:00Z sha=na",
      ),
      body.replace("clawsweeper-review-state:ready", "clawsweeper-review-state:unknown"),
      body.replace("lease_owner=fixture", "lease_owner=unknown"),
    ]) {
      fixture.update({ comments: [older, blocked, { ...fresh, body: malformed }] });
      assert.equal(state.durableReviewCausalIdentityFromBody(malformed, itemNumber), null);
      assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
      assert.throws(
        () => publication.upsertReviewComment(itemNumber, malformed, blocked),
        /fresh review lease is required/,
      );
      assert.equal(fixture.read().calls.length, 1);
    }
    fixture.update({
      comments: [
        older,
        blocked,
        durableReviewComment({
          id: 110,
          reviewedAt: "2026-08-08T23:00:00Z",
          updatedAt: "2026-08-08T23:01:00Z",
          leaseCommentId: 90,
        }),
      ],
    });
    assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
    const synced = publication.upsertReviewComment(itemNumber, body, blocked);
    assert.equal(synced.id, 100);
    assert.match(fixture.read().calls[1]![1]!, /issues\/comments\/100$/);
    assert.equal(
      state.durableReviewCausalIdentityFromBody(String(synced.body), itemNumber)?.leaseCommentId,
      120,
    );
    assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
  });
});

test("newest durable comment wins over older trusted duplicates and spoofed newer comments", () => {
  const older = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-07T15:00:00Z",
    updatedAt: "2026-08-07T16:10:00Z",
  });
  const newer = durableReviewComment({
    id: 20,
    reviewedAt: "2026-08-07T16:00:00Z",
    updatedAt: "2026-08-07T16:05:00Z",
    state: "blocked",
  });
  const spoof = durableReviewComment({
    id: 30,
    reviewedAt: "2026-08-07T17:00:00Z",
    updatedAt: "2026-08-07T17:00:00Z",
    author: "reviewer",
  });
  withPublicationFixture([older, spoof, newer], () =>
    assert.equal(state.issueReviewComment(itemNumber)?.id, 20),
  );
});

test("active legacy leases on non-canonical duplicates block workflow acquisition", () => {
  const canonical = previousReview();
  const legacy = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-07T15:00:00Z",
    updatedAt: "2026-08-07T15:01:00Z",
  });
  legacy.body = String(legacy.body).replace(
    reviewMarker,
    `<!-- clawsweeper-review-status:started item=${itemNumber} sha=${headSha} started_at=${new Date(Date.now() - 60_000).toISOString()} lease_expires_at=${new Date(Date.now() + 600_000).toISOString()} owner=legacy-worker v=1 -->\n\n${reviewMarker}`,
  );
  withPublicationFixture(
    [{ ...legacy, id: 5, user: { login: "reviewer" } }, legacy, canonical],
    (fixture) => {
      const snapshot = state.issueReviewCommentState(itemNumber);
      assert.equal(snapshot.reviewComment?.id, 20);
      assert.deepEqual(
        snapshot.leaseComments.map((comment) => comment.id),
        [10],
      );
      const result = postReviewStartStatusComment({
        item: { ...item({ number: itemNumber }), kind: "pull_request" },
        headSha,
        reviewTimeoutMs: 60_000,
        position: 1,
        total: 1,
        shardIndex: 0,
        shardCount: 1,
      });
      assert.equal(result.status, "held");
      assert.equal(result.didMutate, false);
      assert.equal(fixture.read().calls.length, 0);
    },
  );
});

test("mutation fallback verifies the exact trusted comment identity", () => {
  const older = durableReviewComment({
    id: 10,
    reviewedAt: "2026-08-07T15:00:00Z",
    updatedAt: "2026-08-07T16:10:00Z",
  });
  const selected = durableReviewComment({
    id: 20,
    reviewedAt: "2026-08-07T16:00:00Z",
    updatedAt: "2026-08-07T16:20:00Z",
    state: "blocked",
  });
  const contributor = durableReviewComment({
    id: 30,
    reviewedAt: "2026-08-07T17:00:00Z",
    updatedAt: "2026-08-07T16:30:00Z",
    author: "reviewer",
  });
  const body = String(
    durableReviewComment({
      id: 99,
      reviewedAt: "2026-08-07T17:00:00Z",
      updatedAt: "2026-08-07T17:01:00Z",
      state: "needs-changes",
    }).body,
  );
  withPublicationFixture([older, contributor, selected], (fixture) => {
    assert.equal(state.issueReviewComment(itemNumber)?.id, 20);
    fixture.update({
      comments: [{ ...older, body }, selected, { ...contributor, body }],
      response: "empty",
      preserveComments: true,
    });
    assert.throws(
      () => publication.upsertReviewComment(itemNumber, body, selected),
      /did not verify target comment 20/,
    );
    assert.match(fixture.read().calls[0]![1]!, /issues\/comments\/20$/);
    fixture.update({ comments: [older, selected, contributor], response: selected });
    assert.throws(
      () => publication.upsertReviewComment(itemNumber, body, selected),
      /did not verify target comment 20/,
    );
    assert.match(fixture.read().calls[1]![1]!, /issues\/comments\/20$/);
    fixture.update({
      comments: [
        { ...older, body },
        { ...selected, body },
        { ...contributor, body },
      ],
      response: "empty",
    });
    assert.equal(publication.upsertReviewComment(itemNumber, body, contributor).id, 20);
    assert.match(fixture.read().calls[2]![1]!, /issues\/120232\/comments$/);
  });
});

test("an issue review with a newer owned lease clears an identity-less fallback", () => {
  const blocked = {
    id: 100,
    user: { login: "clawsweeper[bot]" },
    body: markedReviewBody("Codex review: publication failed closed."),
  };
  const issueReview = (leaseCommentId: number, reviewedAt: string) => {
    const review = durableReviewComment({
      id: 120,
      leaseCommentId,
      reviewedAt,
      updatedAt: reviewedAt,
    });
    return {
      ...review,
      body: String(review.body)
        .replace(/<!-- clawsweeper-review-state:[^>]+-->\n\n/, "")
        .replaceAll(`sha=${headSha}`, "sha=na"),
    };
  };
  const fresh = issueReview(120, "2026-08-08T12:00:00Z");
  const old = issueReview(90, "2026-08-09T12:00:00Z");
  withPublicationFixture([blocked, old], (fixture) => {
    assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
    for (const invalid of [
      old.body,
      fresh.body.replace("lease_owner=fixture", "lease_owner=unknown"),
      fresh.body.replace(`source_revision=${"a".repeat(64)}`, "source_revision=unknown"),
      fresh.body.replaceAll("sha=na", "sha=unknown"),
      fresh.body.replace(
        reviewMarker,
        `<!-- clawsweeper-review-state:ready item=${itemNumber} sha=${headSha} v=1 -->\n\n${reviewMarker}`,
      ),
    ])
      assert.throws(
        () => publication.upsertReviewComment(itemNumber, invalid, blocked),
        /fresh review lease is required/,
      );
    assert.equal(fixture.read().calls.length, 0);
    const published = publication.upsertReviewComment(itemNumber, fresh.body, blocked);
    assert.equal(published.id, 100);
    assert.equal(fixture.read().calls.length, 1);
    assert.ok(fixture.read().calls[0]!.includes("PATCH"));
    assert.match(fixture.read().calls[0]![1]!, /issues\/comments\/100$/);
    const identity = state.durableReviewCausalIdentityFromBody(String(published.body), itemNumber);
    assert.equal(identity?.headSha, null);
    assert.equal(identity?.state, null);
    assert.equal(identity?.leaseCommentId, 120);
    assert.equal(state.issueReviewComment(itemNumber)?.id, 100);
  });
});

test("publication requires exact trusted receipts with one scoped readback recovery", () => {
  const selected = previousReview();
  const body = String(
    durableReviewComment({
      id: 120,
      reviewedAt: "2026-08-08T12:00:00Z",
      updatedAt: "2026-08-08T12:01:00Z",
    }).body,
  );
  const receipt = { ...selected, body };
  withPublicationFixture([], (fixture) => {
    for (const response of [
      { ...receipt, id: -1 },
      { ...receipt, id: 0 },
      { ...receipt, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...receipt, id: 21 },
      { ...receipt, user: { login: "contributor" } },
      { ...receipt, body: body + "\n" },
      {
        ...receipt,
        body: body.replace("reviewed_at=2026-08-08T12:00:00Z", "reviewed_at=2026-08-08T13:00:00Z"),
      },
    ]) {
      fixture.update({ comments: [], preserveComments: true, response });
      assert.throws(
        () => publication.upsertReviewComment(itemNumber, body, selected),
        /did not verify target comment 20/,
      );
    }
    fixture.update({ comments: [receipt], calls: [], reads: 0, response: "empty" });
    assert.equal(publication.upsertReviewComment(itemNumber, body, selected).id, 20);
    assert.equal(fixture.read().calls.length, 1);
    assert.equal(fixture.read().reads, 1);
  });
});
