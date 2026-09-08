type GitHubJsonRequest = (options: {
  path: string;
  method?: string;
  body?: unknown;
  errorLabel: string;
}) => Promise<unknown>;

type PullRequestAcknowledgementOptions = {
  githubJson: GitHubJsonRequest;
  targetRepo: string;
  itemNumber: number;
  sourceAction: string;
};

const MAX_PULL_REQUEST_ACKNOWLEDGEMENT_PAGES = 10;
const TRUSTED_PULL_REQUEST_ACKNOWLEDGEMENT_LOGINS = new Set([
  "clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper[bot]",
]);
const inFlightPullRequestAcknowledgements = new Map<string, Promise<number | null>>();

export type PullRequestAcknowledgementResolution =
  | { outcome: "resolved"; commentId: number | null }
  | { outcome: "lookup_limit"; commentId: null };

class PullRequestAcknowledgementLookupLimitError extends Error {
  constructor() {
    super("pull_request_acknowledgement_lookup_limit_reached");
  }
}

export async function resolvePullRequestAcknowledgement(
  options: PullRequestAcknowledgementOptions,
): Promise<PullRequestAcknowledgementResolution> {
  const createsReceipt = ["opened", "ready_for_review"].includes(options.sourceAction);
  try {
    return {
      outcome: "resolved",
      commentId: createsReceipt
        ? await createPullRequestAcknowledgementOnce(options)
        : await prunePullRequestAcknowledgements(options),
    };
  } catch (error) {
    if (!(error instanceof PullRequestAcknowledgementLookupLimitError)) throw error;
    // A capped search cannot prove receipt absence or safely choose among
    // receipts. Treat it as unavailable without mutating comments; review
    // admission is intentionally allowed to continue.
    return { outcome: "lookup_limit", commentId: null };
  }
}

export async function settlePullRequestAcknowledgement(options: PullRequestAcknowledgementOptions) {
  await prunePullRequestAcknowledgements(options, 24 * 60 * 60 * 1000);
}

async function createPullRequestAcknowledgementOnce(options: PullRequestAcknowledgementOptions) {
  const key = `${options.targetRepo.toLowerCase()}:${options.itemNumber}:clawsweeper-pr-ack`;
  const pending = inFlightPullRequestAcknowledgements.get(key);
  if (pending) return pending;
  const next = createPullRequestAcknowledgement(options).finally(() => {
    inFlightPullRequestAcknowledgements.delete(key);
  });
  inFlightPullRequestAcknowledgements.set(key, next);
  return next;
}

async function createPullRequestAcknowledgement(options: PullRequestAcknowledgementOptions) {
  const existingId = await prunePullRequestAcknowledgements(options);
  if (existingId) return existingId;
  const marker = pullRequestAcknowledgementMarker(options.itemNumber, options.sourceAction);
  const payload = objectValue(
    await options.githubJson({
      path: `/repos/${options.targetRepo}/issues/${options.itemNumber}/comments`,
      method: "POST",
      body: { body: renderPullRequestAcknowledgement(marker) },
      errorLabel: "ClawSweeper ack comment",
    }),
  );
  return (await prunePullRequestAcknowledgements(options)) || Number(payload.id) || null;
}

async function prunePullRequestAcknowledgements(
  options: PullRequestAcknowledgementOptions,
  sinceMs: number | null = null,
) {
  const comments = await listPullRequestAcknowledgements(options, sinceMs);
  if (!comments.length) return null;
  const hasStatusComment = comments.some(isStatusBearingAcknowledgement);
  comments.sort(compareAcknowledgementKeepPriority);
  const keepId = Number(comments[0]?.id) || null;
  for (const comment of comments) {
    const id = Number(comment.id) || 0;
    if (id <= 0 || id === keepId) continue;
    if (hasStatusComment && isStatusBearingAcknowledgement(comment)) continue;
    await options
      .githubJson({
        path: `/repos/${options.targetRepo}/issues/comments/${id}`,
        method: "DELETE",
        errorLabel: "ClawSweeper duplicate ack cleanup",
      })
      .catch((error) => {
        if (!String((error as Error)?.message || "").includes("404")) throw error;
        return null;
      });
  }
  return keepId;
}

async function listPullRequestAcknowledgements(
  options: PullRequestAcknowledgementOptions,
  sinceMs: number | null,
) {
  const comments: Record<string, unknown>[] = [];
  const suffix = ` item=${options.itemNumber} -->`;
  const since =
    sinceMs === null
      ? ""
      : `&since=${encodeURIComponent(new Date(Date.now() - sinceMs).toISOString())}`;
  for (let page = 1; page <= MAX_PULL_REQUEST_ACKNOWLEDGEMENT_PAGES; page += 1) {
    const payload = await options.githubJson({
      path: `/repos/${options.targetRepo}/issues/${options.itemNumber}/comments?per_page=100&page=${page}${since}`,
      method: "GET",
      errorLabel: "ClawSweeper ack comment lookup",
    });
    if (!Array.isArray(payload)) return comments;
    const records = payload.map(objectValue);
    comments.push(
      ...records.filter((comment) => {
        const body = String(comment.body || "");
        const login = String(objectValue(comment.user).login || "")
          .trim()
          .toLowerCase();
        return (
          body.includes("clawsweeper-pr-ack:") &&
          body.includes(suffix) &&
          TRUSTED_PULL_REQUEST_ACKNOWLEDGEMENT_LOGINS.has(login)
        );
      }),
    );
    if (records.length < 100) return comments;
  }
  throw new PullRequestAcknowledgementLookupLimitError();
}

function compareAcknowledgementKeepPriority(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  const leftStatus = isStatusBearingAcknowledgement(left) ? 1 : 0;
  const rightStatus = isStatusBearingAcknowledgement(right) ? 1 : 0;
  if (leftStatus !== rightStatus) return rightStatus - leftStatus;
  if (leftStatus > 0) {
    const leftUpdated = String(left.updated_at || left.created_at || "");
    const rightUpdated = String(right.updated_at || right.created_at || "");
    return (
      rightUpdated.localeCompare(leftUpdated) || (Number(right.id) || 0) - (Number(left.id) || 0)
    );
  }
  const leftCreated = String(left.created_at || "");
  const rightCreated = String(right.created_at || "");
  return (
    leftCreated.localeCompare(rightCreated) || (Number(left.id) || 0) - (Number(right.id) || 0)
  );
}

function isStatusBearingAcknowledgement(comment: Record<string, unknown>) {
  const body = String(comment.body || "");
  return (
    body.includes("clawsweeper-command-status:") ||
    body.includes("<!-- clawsweeper-command-progress:start -->") ||
    body.includes("<!-- clawsweeper-review-progress:start -->")
  );
}

function pullRequestAcknowledgementMarker(itemNumber: number, sourceAction: string) {
  return `<!-- clawsweeper-pr-ack:${sourceAction} item=${itemNumber} -->`;
}

function renderPullRequestAcknowledgement(marker: string) {
  return [
    marker,
    "🦞👀",
    "ClawSweeper picked this up.",
    "",
    "Pull request received. I will update this pull request when review starts.",
  ].join("\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
