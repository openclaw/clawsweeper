import {
  ACCEPTED_LARGE_LABEL,
  PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES,
} from "./repair/exact-review-guard-labels.ts";
import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.ts";
import { recordOrEmpty } from "./value-coerce.ts";
import {
  oversizedPrSourceSnapshot,
  parseOversizedPrSourceSnapshot,
  type OversizedPrSourceSnapshot,
} from "./oversized-pr-snapshot.ts";

export const OVERSIZED_ACTIVITY_VERSION = 1;
export const OVERSIZED_ACTIVITY_FENCE_MS = 30 * 60_000;
export const activityHash = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface OversizedActivityReference {
  version: 1;
  repo: string;
  number: number;
  epoch: string;
}
export interface OversizedCommentImage {
  id: number;
  bodyFingerprint: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  author: string;
}
export interface OversizedActivityEntry {
  identity: string;
  fingerprint: string;
  commentId: number | null;
}
export interface OversizedActivityBaseline {
  source: OversizedPrSourceSnapshot;
  comments: OversizedCommentImage[];
  streams: OversizedActivityEntry[][];
}
export interface OversizedAcknowledgementReceipt {
  id: string;
  kind: "POST" | "PATCH" | "DELETE";
  before: OversizedCommentImage | null;
  after: OversizedCommentImage | null;
  requestedBodyFingerprint: string | null;
  startedAt: string;
  completedAt: string | null;
  pullAfter: OversizedPrSourceSnapshot | null;
}
export interface OversizedActivityEvidence {
  reference: OversizedActivityReference;
  baseline: OversizedActivityBaseline | null;
  receipts: OversizedAcknowledgementReceipt[];
  invalid: string | null;
}
export interface OversizedActivityOwner {
  itemKey: string;
  leaseId: string;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
}
export interface OversizedActivityContext {
  reference: OversizedActivityReference;
  owner: OversizedActivityOwner;
  queueUrl: string;
  failurePath?: string;
}

export function parseOversizedActivityReference(
  value: unknown,
  repo?: string,
  number?: number,
): OversizedActivityReference | null {
  const v = recordOrEmpty(value);
  return v.version === 1 &&
    typeof v.repo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo) &&
    positive(v.number) &&
    typeof v.epoch === "string" &&
    /^[a-f0-9-]{36}$/.test(v.epoch) &&
    (!repo || v.repo.toLowerCase() === repo.toLowerCase()) &&
    (!number || v.number === number)
    ? { version: 1, repo: v.repo, number: v.number, epoch: v.epoch }
    : null;
}

export function oversizedCommentImage(value: unknown): OversizedCommentImage {
  const v = recordOrEmpty(value);
  const author = recordOrEmpty(v.user).login;
  if (
    !positive(v.id) ||
    typeof v.body !== "string" ||
    !timestamp(v.created_at) ||
    !timestamp(v.updated_at) ||
    typeof author !== "string" ||
    !author
  )
    throw new Error("incomplete comment write image");
  const identity = {
    id: v.id,
    body: v.body,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    author,
    association: v.author_association ?? "",
  };
  return {
    id: v.id,
    bodyFingerprint: activityHash(v.body),
    fingerprint: activityHash(identity),
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    author,
  };
}

function validImage(v: unknown): v is OversizedCommentImage {
  const r = recordOrEmpty(v);
  return (
    positive(r.id) &&
    digest(r.bodyFingerprint) &&
    digest(r.fingerprint) &&
    timestamp(r.createdAt) &&
    timestamp(r.updatedAt) &&
    typeof r.author === "string" &&
    r.author.length > 0
  );
}

/** Shared by the Worker and synchronous CLI: exactly the same bounded reads and checks. */
export function* captureOversizedActivity(
  repo: string,
  number: number,
  observedAt: string,
  initial = false,
): Generator<string, OversizedActivityBaseline, unknown> {
  const root = `repos/${repo}`;
  const source = oversizedPrSourceSnapshot(
    recordOrEmpty(yield `${root}/pulls/${number}`),
    observedAt,
  );
  if (!source) throw new Error("live PR metadata snapshot is incomplete");
  const streams: Record<string, unknown>[][] = [];
  for (const endpoint of [
    `issues/${number}/comments`,
    `issues/${number}/timeline`,
    `pulls/${number}/comments`,
    `pulls/${number}/reviews`,
  ]) {
    const entries: Record<string, unknown>[] = [];
    const identities = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const batch = yield `${root}/${endpoint}?per_page=100&page=${page}`;
      if (!Array.isArray(batch)) throw new Error("activity response is incomplete or invalid");
      for (const raw of batch) {
        const entry = recordOrEmpty(raw);
        const identity = activityIdentity(entry, endpoint.endsWith("/timeline"));
        if (!identity || identities.has(identity))
          throw new Error("activity identity is missing or repeated");
        identities.add(identity);
        entries.push(entry);
      }
      if (batch.length < 100) break;
      if (page === 3) throw new Error("activity exceeds the bounded 300-entry window");
    }
    streams.push(entries);
  }
  const [comments = [], timeline = [], inline = [], reviews = []] = streams;
  if (
    [...comments, ...inline].some(
      (e) => typeof e.body !== "string" || !timestamp(e.created_at) || !timestamp(e.updated_at),
    ) ||
    reviews.some((e) => !timestamp(e.submitted_at)) ||
    timeline.some(
      (e) =>
        e.event !== "committed" && ![e.created_at, e.updated_at, e.submitted_at].some(timestamp),
    )
  )
    throw new Error("activity timestamps are incomplete");
  if (source.comments !== comments.length || source.reviewComments !== inline.length)
    throw new Error("live PR activity counts changed during capture");
  const confirmed = oversizedPrSourceSnapshot(
    recordOrEmpty(yield `${root}/pulls/${number}`),
    observedAt,
  );
  if (!confirmed || stableJson(confirmed) !== stableJson(source))
    throw new Error("PR metadata changed during activity capture");
  if (initial) {
    const cutoff = Math.floor(Date.parse(observedAt) / 1000) * 1000 - 1000;
    if (reviews.length && Date.parse(source.updatedAt) >= cutoff)
      throw new Error("ambiguous PR timestamp cannot exclude review-summary edits");
    if (
      streams.some((stream) =>
        stream.some((e) =>
          [e.created_at, e.updated_at, e.submitted_at].some(
            (t) => timestamp(t) && Date.parse(t) >= cutoff,
          ),
        ),
      )
    )
      throw new Error("ambiguous or new PR activity at the admission observation boundary");
  }
  return {
    source,
    comments: comments.map(oversizedCommentImage),
    streams: streams.map((stream, index) =>
      stream
        .map((e) => ({
          identity: activityIdentity(e, index === 1)!,
          fingerprint: index === 0 ? oversizedCommentImage(e).fingerprint : activityHash(e),
          commentId: index === 0 || (index === 1 && e.event === "commented") ? Number(e.id) : null,
        }))
        .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)),
    ),
  };
}

function activityIdentity(entry: Record<string, unknown>, timeline: boolean): string | null {
  if (Number.isSafeInteger(entry.id) && Number(entry.id) >= 0)
    return stableJson({ event: entry.event ?? "", id: entry.id });
  if (!timeline || typeof entry.event !== "string") return null;
  if (typeof entry.sha === "string" || typeof entry.node_id === "string")
    return stableJson({ event: entry.event, sha: entry.sha ?? null, node: entry.node_id ?? null });
  if (entry.event !== "cross-referenced" || !timestamp(entry.created_at)) return null;
  const source = recordOrEmpty(entry.source),
    issue = recordOrEmpty(source.issue),
    actor = recordOrEmpty(entry.actor);
  const id = typeof issue.id === "number" ? issue.id : (issue.node_id ?? issue.html_url);
  return source.type === "issue" && id != null
    ? stableJson({
        event: entry.event,
        createdAt: entry.created_at,
        actor: actor.id ?? actor.login ?? null,
        source: id,
      })
    : null;
}

export function parseOversizedActivityEvidence(value: unknown): OversizedActivityEvidence | null {
  const v = recordOrEmpty(value),
    b = recordOrEmpty(v.baseline);
  const ref = parseOversizedActivityReference(v.reference);
  if (!ref || !(v.invalid === null || typeof v.invalid === "string") || !Array.isArray(v.receipts))
    return null;
  if (
    v.baseline !== null &&
    (!parseOversizedPrSourceSnapshot(b.source) ||
      !Array.isArray(b.comments) ||
      b.comments.length >= 300 ||
      !b.comments.every(validImage) ||
      new Set(b.comments.map((c) => c.id)).size !== b.comments.length ||
      recordOrEmpty(b.source).comments !== b.comments.length ||
      !Array.isArray(b.streams) ||
      b.streams.length !== 4 ||
      !b.streams.every(
        (s) =>
          Array.isArray(s) &&
          s.length < 300 &&
          new Set(s.map((e) => recordOrEmpty(e).identity)).size === s.length &&
          s.every((entry) => {
            const e = recordOrEmpty(entry);
            return (
              typeof e.identity === "string" &&
              e.identity.length <= 4096 &&
              digest(e.fingerprint) &&
              (e.commentId === null || positive(e.commentId))
            );
          }),
      ))
  )
    return null;
  if (
    !v.receipts.every((raw) => {
      const r = recordOrEmpty(raw);
      return (
        typeof r.id === "string" &&
        /^[a-f0-9-]{36}$/.test(r.id) &&
        ["POST", "PATCH", "DELETE"].includes(String(r.kind)) &&
        (r.before === null || validImage(r.before)) &&
        (r.after === null || validImage(r.after)) &&
        (r.requestedBodyFingerprint === null || digest(r.requestedBodyFingerprint)) &&
        timestamp(r.startedAt) &&
        (r.completedAt === null || (timestamp(r.completedAt) && r.pullAfter !== null)) &&
        (r.pullAfter === null || parseOversizedPrSourceSnapshot(r.pullAfter))
      );
    })
  )
    return null;
  return v as unknown as OversizedActivityEvidence;
}

export function oversizedActivityBlock(
  evidence: OversizedActivityEvidence | null,
  current: OversizedActivityBaseline,
): string | null {
  if (!evidence?.baseline || evidence.invalid)
    return evidence?.invalid || "missing queue-owned activity evidence";
  const base = evidence.baseline;
  if (
    base.source.fingerprint !== current.source.fingerprint ||
    base.source.reviewComments !== current.source.reviewComments
  )
    return "oversized PR metadata changed since queue admission";
  const expected = new Map(base.comments.map((c) => [c.id, c]));
  const owned = new Set<number>();
  let updatedAt = base.source.updatedAt;
  const seen = new Set<string>();
  for (const r of evidence.receipts) {
    if (!r.completedAt || !r.pullAfter || seen.has(r.id))
      return "incomplete or ambiguous owned-write receipt";
    seen.add(r.id);
    if (
      r.kind === "POST"
        ? r.before !== null || !r.after || expected.has(r.after.id)
        : !r.before || expected.get(r.before.id)?.fingerprint !== r.before.fingerprint
    )
      return "owned-write preimage does not match queue baseline";
    if (r.kind === "DELETE") {
      if (r.after !== null || !r.before || !r.pullAfter) return "incomplete deletion receipt";
      expected.delete(r.before.id);
      owned.add(r.before.id);
    } else {
      if (
        !r.after ||
        r.after.bodyFingerprint !== r.requestedBodyFingerprint ||
        (r.before && r.before.id !== r.after.id)
      )
        return "invalid owned-write response";
      expected.set(r.after.id, r.after);
      owned.add(r.after.id);
      if (Date.parse(r.after.updatedAt) > Date.parse(updatedAt)) updatedAt = r.after.updatedAt;
    }
    if (r.pullAfter) {
      if (
        r.pullAfter.fingerprint !== base.source.fingerprint ||
        r.pullAfter.reviewComments !== base.source.reviewComments ||
        r.pullAfter.comments !== expected.size
      )
        return "non-owned metadata or comment count changed during owned write";
      if (Date.parse(r.pullAfter.updatedAt) > Date.parse(updatedAt))
        updatedAt = r.pullAfter.updatedAt;
    }
  }
  if (
    current.comments.length !== expected.size ||
    current.comments.some((c) => expected.get(c.id)?.fingerprint !== c.fingerprint)
  )
    return "non-owned PR comment changed or an owned write is unreceipted";
  const nonOwned = (b: OversizedActivityBaseline) =>
    b.streams.map((stream) =>
      stream.filter((e) => e.commentId === null || !owned.has(e.commentId)),
    );
  if (stableJson(nonOwned(base)) !== stableJson(nonOwned(current)))
    return "non-owned PR activity changed since queue admission";
  if (current.source.updatedAt !== updatedAt)
    return "PR updated_at changed beyond receipted writes";
  return null;
}

/** Routing hint only; the existing policy still owns threshold, head and exemption checks. */
export function oversizedActivityNeeded(value: unknown, thresholdValue: unknown): boolean {
  const p = recordOrEmpty(value);
  const exemptions = new Set<string>([ACCEPTED_LARGE_LABEL, ...PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES]);
  if (
    Array.isArray(p.labels) &&
    p.labels.some((label) => {
      const name = typeof label === "string" ? label : recordOrEmpty(label).name;
      return typeof name === "string" && exemptions.has(name.trim().toLowerCase());
    })
  )
    return false;
  if (
    p.state !== "open" ||
    p.locked === true ||
    !Number.isSafeInteger(p.changed_files) ||
    Number(p.changed_files) < 0 ||
    typeof recordOrEmpty(p.head).sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(String(recordOrEmpty(p.head).sha))
  )
    return false;
  const raw = typeof thresholdValue === "string" ? thresholdValue.trim() : "";
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const threshold = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 50_000;
  return (
    typeof p.additions === "number" &&
    typeof p.deletions === "number" &&
    Number.isSafeInteger(p.additions) &&
    p.additions >= 0 &&
    Number.isSafeInteger(p.deletions) &&
    p.deletions >= 0 &&
    Number.isSafeInteger(p.additions + p.deletions) &&
    p.additions + p.deletions > threshold
  );
}
