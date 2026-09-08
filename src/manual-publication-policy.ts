import { readReportFrontMatterField } from "./report-front-matter.ts";

export const MANUAL_REVIEW_SOURCE_ACTION = "manual_explicit_review";
export const RECORD_COMMENT_ONLY = "record_comment_only";
export type PublicationPolicy = typeof RECORD_COMMENT_ONLY;

// Authenticated request metadata only. Receipts and reports are not ownership.
export type ManualPublicationOwner =
  | { leaseId: string; runId: string; runAttempt: number }
  | { batchId: string; leaseOwner: string; runId: string; runAttempt: number };

export function manualPublicationOwnerFrom(value: unknown): ManualPublicationOwner {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("manual publication requires current owner identity");
  const owner = value as Record<string, unknown>;
  const identifier = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\r\n]/.test(value) &&
    !value.includes("\0");
  if (
    !identifier(owner.runId) ||
    !/^\d+$/.test(owner.runId) ||
    !Number.isSafeInteger(owner.runAttempt) ||
    Number(owner.runAttempt) < 1
  )
    throw new Error("manual publication requires current run identity");
  const run = { runId: owner.runId, runAttempt: Number(owner.runAttempt) };
  if (identifier(owner.batchId) && identifier(owner.leaseOwner) && !Object.hasOwn(owner, "leaseId"))
    return { batchId: owner.batchId, leaseOwner: owner.leaseOwner, ...run };
  if (
    identifier(owner.leaseId) &&
    !Object.hasOwn(owner, "batchId") &&
    !Object.hasOwn(owner, "leaseOwner")
  )
    return { leaseId: owner.leaseId, ...run };
  throw new Error("manual publication requires unambiguous owner identity");
}

// Compatibility boundary: only an absent field on an ordinary pre-policy
// decision/report retains ordinary publication. Unknown values are never defaults.
export function decisionPublicationPolicy(value: unknown): PublicationPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("publication policy requires a decision object");
  }
  const decision = value as Record<string, unknown>;
  if (Object.hasOwn(decision, "publication_policy")) {
    throw new Error("decision publication policy uses publicationPolicy");
  }
  const present = Object.hasOwn(decision, "publicationPolicy");
  if (present && decision.publicationPolicy !== RECORD_COMMENT_ONLY) {
    throw new Error("unknown decision publication policy");
  }
  if (decision.sourceAction === MANUAL_REVIEW_SOURCE_ACTION && !present) {
    throw new Error("explicit manual review requires publication policy");
  }
  if (
    present &&
    ![MANUAL_REVIEW_SOURCE_ACTION, "exact_review_artifact_publish"].includes(
      String(decision.sourceAction),
    )
  ) {
    throw new Error("publication policy source action mismatch");
  }
  const policy = present ? RECORD_COMMENT_ONLY : undefined;
  if (Object.hasOwn(decision, "publication")) {
    const publication = decision.publication as Record<string, unknown> | null;
    if (!publication || decisionPublicationPolicy(publication.producerDecision) !== policy) {
      throw new Error("producer publication policy mismatch");
    }
  }
  return policy;
}

export function reportPublicationPolicy(markdown: string): PublicationPolicy | undefined {
  const field = readReportFrontMatterField(markdown, "publication_policy");
  const alternate = readReportFrontMatterField(markdown, "publicationPolicy");
  if (alternate.status !== "absent") throw new Error("ambiguous report publication policy");
  if (field.status === "absent") return undefined;
  if (field.status === "value" && field.value.trim() === RECORD_COMMENT_ONLY)
    return RECORD_COMMENT_ONLY;
  throw new Error("unknown or ambiguous report publication policy");
}

export function reportMatchesPublicationPolicy(
  markdown: string,
  policy: PublicationPolicy | undefined,
): boolean {
  try {
    return reportPublicationPolicy(markdown) === policy;
  } catch {
    return false;
  }
}

export function reportAllowsAutomation(markdown: string): boolean {
  return reportMatchesPublicationPolicy(markdown, undefined);
}

export function assertReportPublicationPolicy(
  markdown: string,
  policy: PublicationPolicy | undefined,
): void {
  if (reportPublicationPolicy(markdown) !== policy)
    throw new Error("report publication policy differs from producer decision");
}
