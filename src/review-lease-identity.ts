import { frontMatterField } from "./report-front-matter.js";

export type QueueReviewLeaseIdentity = {
  kind: "queue";
  itemKey: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
};

export type ReviewLeaseIdentity =
  | QueueReviewLeaseIdentity
  | { kind: "comment"; owner: string; commentId: number };

const QUEUE_FIELDS = [
  "item_key",
  "lease_revision",
  "claim_generation",
  "run_id",
  "run_attempt",
] as const;

function positiveSafeInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function queueIdentity(values: readonly string[]): QueueReviewLeaseIdentity | null {
  const [itemKey = "", revision = "", generation = "", runId = "", attempt = ""] = values;
  const itemNumber = itemKey.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#([1-9]\d*)$/)?.[1];
  const leaseRevision = positiveSafeInteger(revision);
  const claimGeneration = positiveSafeInteger(generation);
  const runAttempt = positiveSafeInteger(attempt);
  if (
    !itemNumber ||
    positiveSafeInteger(itemNumber) === null ||
    leaseRevision === null ||
    claimGeneration === null ||
    runAttempt === null ||
    !/^[1-9]\d{0,29}$/.test(runId)
  ) {
    return null;
  }
  return { kind: "queue", itemKey, leaseRevision, claimGeneration, runId, runAttempt };
}

export function hasQueueReviewLeaseIdentity(markdown: string): boolean {
  return (
    QUEUE_FIELDS.some(
      (field) => frontMatterField(markdown, `review_queue_${field}`).status !== "absent",
    ) ||
    /(?:^|\r?\n)review_queue_(?:item_key|lease_revision|claim_generation|run_id|run_attempt)\s*:/.test(
      markdown,
    )
  );
}

export function queueReviewLeaseIdentityFromReport(
  markdown: string,
): QueueReviewLeaseIdentity | null {
  if (frontMatterField(markdown, "review_lease_comment_id").status !== "absent") return null;
  const owner = frontMatterField(markdown, "review_lease_owner");
  if (
    owner.status !== "value" ||
    owner.value === "unknown" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(owner.value)
  ) {
    return null;
  }
  const values: string[] = [];
  for (const field of QUEUE_FIELDS) {
    const value = frontMatterField(markdown, `review_queue_${field}`);
    if (value.status !== "value") return null;
    values.push(value.value);
  }
  return queueIdentity(values);
}

/** Reads only v2 queue attributes; the caller validates the enclosing review marker. */
export function queueReviewLeaseIdentityFromMarker(
  attributes: string,
): QueueReviewLeaseIdentity | null {
  const fields = new Map<string, string>();
  for (const match of attributes.matchAll(/(?:^|\s)([a-z_]+)=([^\s>]*)/g)) {
    const key = match[1]!;
    if (fields.has(key)) return null;
    fields.set(key, match[2]!);
  }
  if (fields.get("lease_kind") !== "queue" || fields.has("lease_comment_id")) return null;
  const owner = fields.get("lease_owner");
  if (!owner || owner === "unknown" || !/^[A-Za-z0-9._:-]{1,200}$/.test(owner)) return null;
  return queueIdentity(QUEUE_FIELDS.map((field) => fields.get(`queue_${field}`) ?? ""));
}

export function queueReviewLeaseMarkerAttributes(identity: QueueReviewLeaseIdentity): string {
  return [
    "lease_kind=queue",
    `queue_item_key=${identity.itemKey}`,
    `queue_lease_revision=${identity.leaseRevision}`,
    `queue_claim_generation=${identity.claimGeneration}`,
    `queue_run_id=${identity.runId}`,
    `queue_run_attempt=${identity.runAttempt}`,
  ].join(" ");
}
