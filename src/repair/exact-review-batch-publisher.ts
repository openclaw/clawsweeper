export type ExactReviewBatchMember = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
};

export type ExactReviewBatchTerminalOutcome =
  | "published"
  | "superseded"
  | "retryable_failure"
  | "refresh_required"
  | "permanent_failure";

export type ExactReviewBatchCompletion = ExactReviewBatchMember & {
  terminalOutcome: ExactReviewBatchTerminalOutcome;
  reasonCode?: string;
  errorFingerprint?: string;
  retryAt?: string;
  attempted?: boolean;
  poolClass?: "repository_actions" | "target_app";
};
