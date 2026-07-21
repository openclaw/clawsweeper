import type { PreparedStateMutationPlan } from "./state-publication-mutation.js";

export type ExactReviewBatchMember = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
};

export type ExactReviewBatchTerminalOutcome = "published" | "superseded";

export type ExactReviewBatchCompletion = ExactReviewBatchMember & {
  terminalOutcome: ExactReviewBatchTerminalOutcome;
};

export type ExactReviewBatchItemResult =
  | { kind: "superseded" }
  | { kind: "retryable"; reason: string }
  | { kind: "eligible"; plan: PreparedStateMutationPlan };

export type ExactReviewBatchPublisherDependencies = {
  prepare: (member: ExactReviewBatchMember) => Promise<ExactReviewBatchItemResult>;
  // GitHub delivery deliberately precedes state publication. A visible comment or
  // label is independently recoverable when the shared state push later fails.
  deliverGithubEffects: (member: ExactReviewBatchMember) => Promise<"ready" | "superseded">;
  commit: (plans: readonly PreparedStateMutationPlan[]) => Promise<{ commitSha: string }>;
  assertLease?: () => Promise<void>;
};

export type ExactReviewBatchPublisherResult = {
  completions: ExactReviewBatchCompletion[];
  retryable: Array<ExactReviewBatchMember & { reason: string }>;
  stateCommitSha: string | null;
};

/**
 * Consumes one already-leased batch. It intentionally owns neither queue I/O nor
 * GitHub API calls: the workflow supplies those boundaries, while this function
 * protects the central invariant that eligible mutations reach one committer call.
 */
export async function publishExactReviewBatch(
  members: readonly ExactReviewBatchMember[],
  dependencies: ExactReviewBatchPublisherDependencies,
): Promise<ExactReviewBatchPublisherResult> {
  const completions: ExactReviewBatchCompletion[] = [];
  const retryable: Array<ExactReviewBatchMember & { reason: string }> = [];
  const eligible: Array<{ member: ExactReviewBatchMember; plan: PreparedStateMutationPlan }> = [];

  for (const member of members) {
    try {
      await dependencies.assertLease?.();
      const prepared = await dependencies.prepare(member);
      if (prepared.kind === "superseded") {
        completions.push({ ...member, terminalOutcome: "superseded" });
      } else if (prepared.kind === "retryable") {
        retryable.push({ ...member, reason: prepared.reason });
      } else {
        eligible.push({ member, plan: prepared.plan });
      }
    } catch (error) {
      retryable.push({ ...member, reason: errorMessage(error) });
    }
  }

  const commitPlans: PreparedStateMutationPlan[] = [];
  const commitMembers: ExactReviewBatchMember[] = [];
  for (const candidate of eligible) {
    try {
      await dependencies.assertLease?.();
      const delivered = await dependencies.deliverGithubEffects(candidate.member);
      if (delivered === "superseded") {
        completions.push({ ...candidate.member, terminalOutcome: "superseded" });
      } else {
        commitMembers.push(candidate.member);
        commitPlans.push(candidate.plan);
      }
    } catch (error) {
      retryable.push({ ...candidate.member, reason: errorMessage(error) });
    }
  }

  if (!commitPlans.length) return { completions, retryable, stateCommitSha: null };
  try {
    await dependencies.assertLease?.();
    const committed = await dependencies.commit(commitPlans);
    for (const member of commitMembers)
      completions.push({ ...member, terminalOutcome: "published" });
    return { completions, retryable, stateCommitSha: committed.commitSha };
  } catch (error) {
    // An ambiguous push is deliberately retried as one stable batch; callers must
    // reconcile the PR2 receipt before invoking this publisher again.
    for (const member of commitMembers) retryable.push({ ...member, reason: errorMessage(error) });
    return { completions, retryable, stateCommitSha: null };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
