export type ReviewSourcePreparationFailureReason =
  | "configuration_missing"
  | "setup_script_failed"
  | "review_commits_unavailable"
  | "review_history_unavailable"
  | "review_blob_metadata_unavailable"
  | "review_blobs_unavailable"
  | "review_checkout_unavailable"
  | "review_commit_fetch_failed"
  | "review_checkout_failed"
  | "review_git_inspection_failed";

export class ReviewSourcePreparationError extends UserFacingCommandError {
  readonly diagnosticStage = "source_preparation";
  reviewedHeadSha?: string;

  constructor(
    readonly diagnosticReason: ReviewSourcePreparationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ReviewSourcePreparationError";
  }
}
import { UserFacingCommandError } from "./command.js";
