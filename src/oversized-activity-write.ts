import { randomUUID } from "node:crypto";
import { recordOrEmpty } from "./value-coerce.ts";
import {
  activityHash,
  oversizedCommentImage,
  type OversizedActivityReference,
  type OversizedAcknowledgementReceipt,
} from "./oversized-activity-contract.ts";
import { oversizedPrSourceSnapshot } from "./oversized-pr-snapshot.ts";

export interface OversizedCommentRequest {
  path: string;
  method: string;
  body?: unknown;
}
export function isOversizedCommentWrite(
  request: OversizedCommentRequest,
  ref: OversizedActivityReference,
): boolean {
  const root = `repos/${ref.repo}/issues/`.toLowerCase();
  const path = request.path.replace(/^\//, "").toLowerCase();
  return (
    ["POST", "PATCH", "DELETE"].includes(request.method) &&
    (path === `${root}${ref.number}/comments` ||
      new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}comments/[1-9]\\d*$`).test(path))
  );
}
export function ownedCommentWriteIntent(
  request: OversizedCommentRequest,
  before: unknown,
): OversizedAcknowledgementReceipt {
  const image = request.method === "POST" ? null : oversizedCommentImage(before);
  const body = recordOrEmpty(request.body).body;
  const previousBody = recordOrEmpty(before).body;
  if (
    (image &&
      (!/^(?:clawsweeper(?:\[bot\])?|openclaw-clawsweeper\[bot\])$/i.test(image.author) ||
        typeof previousBody !== "string" ||
        !previousBody.includes("<!-- clawsweeper-"))) ||
    (request.method !== "DELETE" &&
      (typeof body !== "string" || !body.includes("<!-- clawsweeper-")))
  )
    throw new Error("comment write is outside the owned acknowledgement/review contract");
  return {
    id: randomUUID(),
    kind: request.method as OversizedAcknowledgementReceipt["kind"],
    before: image,
    after: null,
    requestedBodyFingerprint: request.method === "DELETE" ? null : activityHash(body),
    startedAt: new Date().toISOString(),
    completedAt: null,
    pullAfter: null,
  };
}
export function ownedCommentWriteResult(
  intent: OversizedAcknowledgementReceipt,
  result: unknown,
  pull: unknown,
): OversizedAcknowledgementReceipt {
  const after = intent.kind === "DELETE" ? null : oversizedCommentImage(result);
  if (
    after &&
    (after.bodyFingerprint !== intent.requestedBodyFingerprint ||
      (intent.before && after.id !== intent.before.id))
  )
    throw new Error("comment write response does not match its intent");
  return {
    ...intent,
    after,
    completedAt: new Date().toISOString(),
    pullAfter: oversizedPrSourceSnapshot(recordOrEmpty(pull)),
  };
}
