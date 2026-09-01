export type ReviewSourcePreparationFailureReason =
  | "configuration_missing"
  | "setup_script_failed"
  | "review_commits_unavailable"
  | "review_history_unavailable"
  | "review_blob_metadata_unavailable"
  | "review_blobs_unavailable"
  | "review_checkout_unavailable";

export class ReviewSourcePreparationError extends Error {
  readonly diagnosticStage = "source_preparation";

  constructor(
    readonly diagnosticReason: ReviewSourcePreparationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ReviewSourcePreparationError";
  }
}
