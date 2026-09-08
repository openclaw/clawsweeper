import { createHash } from "node:crypto";
import { labelNames } from "./clawsweeper-item-policy.js";
import { compareCodeUnits, stableJson } from "./stable-json.js";
import { recordOrEmpty, stringOrEmpty } from "./value-coerce.js";

export interface OversizedPrSourceSnapshot {
  fingerprint: string;
  updatedAt: string;
  observedAt: string;
  comments: number;
  reviewComments: number;
}

export interface OversizedPrActivityReceipt {
  sourceFingerprint: string;
  activityFingerprint: string;
  ownedCommentId: number | null;
  ownedCommentFingerprint: string | null;
}

const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function oversizedPrSourceSnapshot(
  pull: Record<string, unknown>,
  observedAt?: string,
): OversizedPrSourceSnapshot | null {
  if (
    !timestamp(pull.updated_at) ||
    !count(pull.comments) ||
    !count(pull.review_comments) ||
    typeof pull.title !== "string" ||
    !(typeof pull.body === "string" || pull.body === null) ||
    !Array.isArray(pull.labels)
  )
    return null;
  return {
    fingerprint: hash({
      head: recordOrEmpty(pull.head).sha,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      state: pull.state,
      locked: pull.locked === true,
      title: pull.title,
      body: pull.body ?? "",
      labels: labelNames(pull.labels).sort(),
      draft: pull.draft === true,
      baseRef: stringOrEmpty(recordOrEmpty(pull.base).ref),
      assignees: pull.assignees ?? [],
      milestone: pull.milestone ?? null,
      requestedReviewers: pull.requested_reviewers ?? [],
      requestedTeams: pull.requested_teams ?? [],
    }),
    updatedAt: pull.updated_at,
    observedAt: timestamp(observedAt) ? observedAt : pull.updated_at,
    comments: pull.comments,
    reviewComments: pull.review_comments,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return recordOrEmpty(value);
}

export function parseOversizedPrSourceSnapshot(value: unknown): OversizedPrSourceSnapshot | null {
  const source = jsonRecord(value);
  return digest(source.fingerprint) &&
    timestamp(source.updatedAt) &&
    timestamp(source.observedAt) &&
    count(source.comments) &&
    count(source.reviewComments)
    ? {
        fingerprint: source.fingerprint,
        updatedAt: source.updatedAt,
        observedAt: source.observedAt,
        comments: source.comments,
        reviewComments: source.reviewComments,
      }
    : null;
}

function commentIdentity(value: Record<string, unknown>): unknown {
  return {
    id: value.id,
    body: value.body ?? "",
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    author: recordOrEmpty(value.user).login,
    association: value.author_association ?? "",
  };
}

function activityIdentity(entry: Record<string, unknown>, timeline: boolean): string | null {
  if (count(entry.id)) return stableJson({ event: entry.event ?? "", id: entry.id });
  if (!timeline || typeof entry.event !== "string") return null;
  if (typeof entry.sha === "string" || typeof entry.node_id === "string")
    return stableJson({ event: entry.event, sha: entry.sha ?? null, node: entry.node_id ?? null });
  if (entry.event !== "cross-referenced" || !timestamp(entry.created_at)) return null;
  const source = recordOrEmpty(entry.source),
    issue = recordOrEmpty(source.issue),
    actor = recordOrEmpty(entry.actor);
  const issueIdentity = count(issue.id)
    ? issue.id
    : typeof issue.node_id === "string"
      ? issue.node_id
      : typeof issue.html_url === "string"
        ? issue.html_url
        : null;
  return source.type === "issue" && issueIdentity !== null
    ? stableJson({
        event: entry.event,
        createdAt: entry.created_at,
        actor: actor.id ?? actor.login ?? null,
        source: issueIdentity,
      })
    : null;
}

/** A bounded activity receipt, independent of source-file hydration and model review. */
export function createOversizedPrFreshnessGuard(options: {
  repo: string;
  number: number;
  source: OversizedPrSourceSnapshot | null;
  priorReceipt?: unknown;
  ownedComment?: Record<string, unknown>;
  ghJson: <T>(args: string[]) => T;
}) {
  type Capture = { pull: OversizedPrSourceSnapshot; streams: Record<string, unknown>[][] };
  let baseline: Capture | null = null;
  let ownedComment = options.ownedComment;
  let closed = false;
  let cached: { generation: number; reason: string | null } | undefined;
  const prior = jsonRecord(options.priorReceipt);
  const boundedList = (endpoint: string): Record<string, unknown>[] => {
    const items: Record<string, unknown>[] = [];
    const identities = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const batch = options.ghJson<unknown>(["api", `${endpoint}?per_page=100&page=${page}`]);
      if (!Array.isArray(batch)) throw new Error("activity response is incomplete or invalid");
      for (const entry of batch) {
        const identity = activityIdentity(recordOrEmpty(entry), endpoint.endsWith("/timeline"));
        if (!identity) throw new Error("activity response is incomplete or invalid");
        if (identities.has(identity)) throw new Error("activity pagination repeated an identity");
        identities.add(identity);
      }
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error("activity exceeds the bounded 300-entry window");
  };
  const capture = (): Capture => {
    const root = `repos/${options.repo}`;
    const pull = oversizedPrSourceSnapshot(
      recordOrEmpty(options.ghJson(["api", `${root}/pulls/${options.number}`])),
    );
    if (!pull) throw new Error("live PR metadata snapshot is incomplete");
    const comments = boundedList(`${root}/issues/${options.number}/comments`);
    const timeline = boundedList(`${root}/issues/${options.number}/timeline`);
    const inline = boundedList(`${root}/pulls/${options.number}/comments`);
    const reviews = boundedList(`${root}/pulls/${options.number}/reviews`);
    if (
      [...comments, ...inline].some(
        (entry) =>
          typeof entry.body !== "string" ||
          !timestamp(entry.created_at) ||
          !timestamp(entry.updated_at),
      ) ||
      reviews.some((entry) => !timestamp(entry.submitted_at)) ||
      timeline.some(
        (entry) =>
          entry.event !== "committed" &&
          ![entry.created_at, entry.updated_at, entry.submitted_at].some(timestamp),
      )
    ) {
      throw new Error("activity timestamps are incomplete");
    }
    if (comments.length !== pull.comments || inline.length !== pull.reviewComments)
      throw new Error("live PR activity counts changed during capture");
    const confirmed = oversizedPrSourceSnapshot(
      recordOrEmpty(options.ghJson(["api", `${root}/pulls/${options.number}`])),
    );
    if (!confirmed || stableJson(confirmed) !== stableJson(pull))
      throw new Error("PR metadata changed during activity capture");
    return { pull, streams: [comments, timeline, inline, reviews] };
  };
  const activityFingerprint = (current: Capture): string =>
    hash(
      current.streams.map((stream, index) =>
        stream
          .filter(
            (entry) =>
              !(
                ownedComment &&
                entry.id === ownedComment.id &&
                (index === 0 || (index === 1 && entry.event === "commented"))
              ),
          )
          .map((entry) => (index === 0 ? commentIdentity(entry) : entry))
          .sort((left, right) => compareCodeUnits(stableJson(left), stableJson(right))),
      ),
    );
  const ownCommentMatches = (current: Capture): boolean =>
    !ownedComment ||
    current.streams[0]!.some(
      (entry) =>
        entry.id === ownedComment!.id &&
        hash(commentIdentity(entry)) === hash(commentIdentity(ownedComment!)),
    );
  const checkCapture = (current: Capture): string | null => {
    const source = options.source;
    if (
      !source ||
      current.pull.fingerprint !== source.fingerprint ||
      current.pull.reviewComments !== source.reviewComments
    )
      return "oversized PR metadata changed since admission";
    if (!ownCommentMatches(current)) return "the owned size-policy comment changed or disappeared";
    if (!baseline) {
      const countDelta = current.pull.comments - source.comments;
      if (
        countDelta !== 0 &&
        !(
          countDelta === 1 &&
          ownedComment &&
          timestamp(ownedComment.created_at) &&
          Date.parse(ownedComment.created_at) >= Date.parse(source.updatedAt)
        )
      )
        return "PR comment activity changed since admission";
      if (
        current.pull.updatedAt !== source.updatedAt &&
        (!ownedComment || current.pull.updatedAt !== ownedComment.updated_at)
      ) {
        return "PR updated_at changed since admission";
      }
      // Include the observation second and clock slack because GitHub timestamps are coarse.
      const cutoff = Math.floor(Date.parse(source.observedAt) / 1000) * 1000 - 1000;
      if (
        options.priorReceipt === undefined &&
        ownedComment &&
        (countDelta !== 0 ||
          current.pull.updatedAt !== source.updatedAt ||
          (timestamp(ownedComment.updated_at) && Date.parse(ownedComment.updated_at) >= cutoff))
      ) {
        return "owned comment changed since admission without a persisted activity receipt";
      }
      if (current.streams[3]!.length > 0 && Date.parse(source.updatedAt) >= cutoff) {
        return "ambiguous PR timestamp cannot exclude review-summary edits";
      }
      if (
        current.streams.some((stream, index) =>
          stream.some((entry) => {
            if (
              ownedComment &&
              entry.id === ownedComment.id &&
              (index === 0 || (index === 1 && entry.event === "commented"))
            )
              return false;
            return [entry.created_at, entry.updated_at, entry.submitted_at].some(
              (value) => timestamp(value) && Date.parse(value) >= cutoff,
            );
          }),
        )
      )
        return "ambiguous or new PR activity at the admission observation boundary";
      if (
        options.priorReceipt !== undefined &&
        (prior.sourceFingerprint !== source.fingerprint ||
          prior.activityFingerprint !== activityFingerprint(current) ||
          prior.ownedCommentId !== (ownedComment?.id ?? null) ||
          prior.ownedCommentFingerprint !==
            (ownedComment ? hash(commentIdentity(ownedComment)) : null))
      )
        return "persisted PR activity receipt no longer matches";
      return null;
    }
    if (activityFingerprint(current) !== activityFingerprint(baseline))
      return "non-owned PR activity changed during apply";
    if (
      current.pull.updatedAt !== baseline.pull.updatedAt &&
      current.pull.updatedAt !== ownedComment?.updated_at
    )
      return "PR updated_at changed beyond the owned comment write";
    return null;
  };
  const check = (generation: number, force = false): string | null => {
    if (closed) return null;
    if (!force && cached?.generation === generation) return cached.reason;
    let reason: string | null;
    try {
      const current = capture();
      reason = checkCapture(current);
      if (!reason && !baseline) baseline = current;
    } catch (error) {
      reason = `oversized PR activity revalidation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    cached = { generation, reason };
    return reason;
  };
  return {
    check,
    recordOwnComment(comment: Record<string, unknown>): void {
      ownedComment = comment;
      cached = undefined;
    },
    receipt(): OversizedPrActivityReceipt | null {
      return baseline && options.source
        ? {
            sourceFingerprint: options.source.fingerprint,
            activityFingerprint: activityFingerprint(baseline),
            ownedCommentId: typeof ownedComment?.id === "number" ? ownedComment.id : null,
            ownedCommentFingerprint: ownedComment ? hash(commentIdentity(ownedComment)) : null,
          }
        : null;
    },
    markClosed(): void {
      closed = true;
    },
  };
}
