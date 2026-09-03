import { stableJson } from "./stable-json.js";
import { reviewPullChecksDigestParts } from "./review-checks-digest.js";
import { reviewStructuralItemStateDigest } from "./review-structural-cache.js";
import {
  isIgnorableReviewSourceRevisionLabel,
  reviewSourceRevisionLabels,
} from "./repair/exact-review-guard-labels.js";
import type { GitInfo, Item, ItemContext } from "./clawsweeper-types.js";

interface SourceRevisionDependencies {
  asRecord: (value: unknown) => Record<string, unknown>;
  clawsweeperBotAuthors: ReadonlySet<string>;
  githubCount: (value: unknown) => number | null;
  isClawSweeperComment: (value: unknown) => boolean;
  login: (value: unknown) => string | undefined;
  normalizeAuthorAssociation: (value: unknown) => string;
  normalizeLabelName: (label: string) => string;
  pullHeadShaFromContext: (context: ItemContext) => string | null;
  sha256: (text: string) => string;
  stringOrUndefined: (value: unknown) => string | undefined;
}

export function createSourceRevisionTools({
  asRecord,
  clawsweeperBotAuthors,
  githubCount,
  isClawSweeperComment,
  login,
  normalizeAuthorAssociation,
  normalizeLabelName,
  pullHeadShaFromContext,
  sha256,
  stringOrUndefined,
}: SourceRevisionDependencies) {
  function reviewCommentBodyDigest(body: string): string {
    return sha256(body.trim());
  }

  function itemSnapshotHash(item: Item, context: ItemContext): string {
    const snapshotItem = {
      repo: item.repo,
      number: item.number,
      kind: item.kind,
      title: item.title,
      url: item.url,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: item.author,
      labels: item.labels,
    };
    return sha256(stableJson({ item: snapshotItem, context }));
  }

  function itemSourceRevisionSha256(issue: unknown, comments: unknown[] = []): string {
    const source = asRecord(issue);
    const snapshot = {
      title: sourceRevisionScalar(source.title),
      body: sourceRevisionScalar(source.body),
      labels: revisionLabels(source.labels),
      comments: comments
        .map(asRecord)
        .filter((comment) => !isClawSweeperComment(comment))
        .map((comment) => ({
          id: sourceRevisionScalar(comment.id),
          author: sourceRevisionScalar(login(comment.user) ?? comment.author),
          body: sourceRevisionScalar(comment.body),
          updated_at: sourceRevisionScalar(
            comment.updated_at ?? comment.updatedAt ?? comment.created_at,
          ),
        }))
        .sort((left, right) =>
          `${left.id}:${left.updated_at}`.localeCompare(`${right.id}:${right.updated_at}`),
        ),
    };
    return sha256(JSON.stringify(snapshot));
  }

  function hydratedReviewStructuralItemStateDigest(
    issue: unknown,
    comments: readonly unknown[],
  ): string | undefined {
    const source = asRecord(issue);
    const title = sourceRevisionScalar(source.title);
    const body = sourceRevisionScalar(source.body);
    const author = login(source.user);
    const authorAssociation = normalizeAuthorAssociation(
      stringOrUndefined(source.author_association),
    );
    const state = stringOrUndefined(source.state);
    if (!author || !authorAssociation || !state || typeof source.locked !== "boolean") {
      return undefined;
    }
    return (
      reviewStructuralItemStateDigest({
        titleDigest: sha256(title),
        bodyDigest: sha256(body),
        state,
        locked: source.locked,
        author,
        authorAssociation,
        labels: revisionLabels(source.labels),
        comments: comments
          .map(asRecord)
          .filter((comment) => !isClawSweeperComment(comment))
          .map((comment) => ({
            updatedAt: sourceRevisionScalar(
              comment.updated_at ?? comment.updatedAt ?? comment.created_at,
            ),
            author: login(comment.user) ?? stringOrUndefined(comment.author) ?? null,
            authorAssociation:
              normalizeAuthorAssociation(
                stringOrUndefined(comment.author_association ?? comment.authorAssociation),
              ) ?? null,
            bodyDigest: sha256(sourceRevisionScalar(comment.body)),
          })),
      }) ?? undefined
    );
  }

  function sourceRevisionScalar(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  function revisionLabels(labels: unknown): string[] {
    return reviewSourceRevisionLabels(labels);
  }

  function isIgnorableSourceRevisionLabel(label: string) {
    return isIgnorableReviewSourceRevisionLabel(normalizeLabelName(label));
  }

  function itemSourceRevisionSha256ForTest(issue: unknown, comments: unknown[] = []): string {
    return itemSourceRevisionSha256(issue, comments);
  }

  function isExactEventSourceRevisionChange(itemKind: Item["kind"], reason: string): boolean {
    if (itemKind === "pull_request") {
      return (
        reason.startsWith("PR head changed since context capture") ||
        reason === "PR head changed while holding the apply mutation lease"
      );
    }
    return (
      reason.startsWith("issue source revision changed since context capture") ||
      reason.startsWith("live issue source revision ") ||
      reason === "issue source revision changed while holding the apply mutation lease"
    );
  }

  function reviewCommentDigestParts(entries: unknown): unknown {
    if (!Array.isArray(entries)) return null;
    return entries
      .map(asRecord)
      .filter(
        (entry) =>
          typeof entry.author !== "string" ||
          !clawsweeperBotAuthors.has(entry.author.toLowerCase()),
      )
      .map((entry) => {
        const omitted = githubCount(entry.omitted);
        if (omitted !== null) return { omitted };
        return {
          id: entry.id ?? null,
          author: entry.author ?? null,
          authorAssociation: entry.authorAssociation ?? null,
          body: entry.body ?? null,
        };
      });
  }

  function reviewCommentContentRevision(entries: readonly unknown[]): string {
    return sha256(stableJson(reviewCommentDigestParts(entries)));
  }

  function reviewCommentContentRevisionForTest(entries: readonly unknown[]): string {
    return reviewCommentContentRevision(entries);
  }

  function pullCommitContentRevision(entries: readonly unknown[]): string | null {
    const identities = [];
    for (const value of entries) {
      const commit = asRecord(value);
      const commitInfo = asRecord(commit.commit);
      const message =
        typeof commitInfo.message === "string"
          ? commitInfo.message
          : typeof commit.message === "string"
            ? commit.message
            : null;
      if (message === null) return null;
      const author =
        typeof commit.author === "string"
          ? commit.author
          : login(commit.author) || stringOrUndefined(asRecord(commitInfo.author).name) || null;
      identities.push({ author, message });
    }
    return sha256(stableJson(identities));
  }

  function reviewTimelineDigestParts(entries: unknown): unknown {
    if (!Array.isArray(entries)) return null;
    return entries
      .map(asRecord)
      .filter((entry) => {
        const actor = typeof entry.actor === "string" ? entry.actor.toLowerCase() : "";
        if (actor && clawsweeperBotAuthors.has(actor)) return false;
        const label = typeof entry.label === "string" ? normalizeLabelName(entry.label) : "";
        return !label || !isIgnorableSourceRevisionLabel(label);
      })
      .map((entry) => ({
        id: entry.id ?? null,
        event: entry.event ?? null,
        actor: entry.actor ?? null,
        commitId: entry.commitId ?? null,
        label: entry.label ?? null,
        rename: entry.rename ?? null,
        sourceIssue: entry.sourceIssue ?? null,
      }));
  }

  function itemContentDigest(item: Item, context: ItemContext, git?: GitInfo): string {
    const isPull = item.kind === "pull_request";
    const pull = asRecord(context.pullRequest);
    const base = asRecord(pull.base);
    const baseSha = typeof base.sha === "string" ? base.sha : null;
    return sha256(
      stableJson({
        kind: item.kind,
        source: context.sourceRevision ?? null,
        timeline: context.timelineRevision ?? reviewTimelineDigestParts(context.timeline),
        relations: {
          closingPullRequests: context.closingPullRequests ?? null,
          referencingMergedPullRequests: context.referencingMergedPullRequests ?? null,
          relatedItems: context.relatedItems ?? null,
        },
        latestRelease: git?.latestRelease
          ? { tagName: git.latestRelease.tagName ?? null, sha: git.latestRelease.sha ?? null }
          : null,
        releaseStateComplete: git?.releaseStateComplete ?? false,
        targetMainSha: isPull ? null : (git?.mainSha ?? null),
        headSha: isPull ? pullHeadShaFromContext(context) : null,
        baseSha: isPull ? baseSha : null,
        pullState: isPull
          ? {
              draft: pull.draft ?? null,
              mergeable: pull.mergeable ?? null,
              mergeableState: pull.mergeableState ?? null,
              additions: pull.additions ?? null,
              deletions: pull.deletions ?? null,
              changedFiles: pull.changedFiles ?? null,
            }
          : null,
        diff: isPull ? (context.pullFiles ?? null) : null,
        commits: isPull ? (context.pullCommitsRevision ?? context.pullCommits ?? null) : null,
        reviewComments: isPull
          ? (context.pullReviewCommentsRevision ??
            reviewCommentDigestParts(context.pullReviewComments))
          : null,
        checks: isPull ? reviewPullChecksDigestParts(context.pullChecks ?? null) : null,
      }),
    );
  }

  function itemContentDigestForTest(item: Item, context: ItemContext, git?: GitInfo): string {
    return itemContentDigest(item, context, git);
  }

  return {
    hydratedReviewStructuralItemStateDigest,
    isExactEventSourceRevisionChange,
    isIgnorableSourceRevisionLabel,
    itemContentDigest,
    itemContentDigestForTest,
    itemSnapshotHash,
    itemSourceRevisionSha256,
    itemSourceRevisionSha256ForTest,
    pullCommitContentRevision,
    reviewCommentBodyDigest,
    reviewCommentContentRevision,
    reviewCommentContentRevisionForTest,
    reviewTimelineDigestParts,
  };
}
