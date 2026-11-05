import type { Action, Decision, GitInfo, Item, ReviewRuntime } from "./clawsweeper-types.js";
import { hasUsableCloseComment, validateCloseDecision } from "./clawsweeper-close-decision.js";
import { isMaintainerAuthored, isVerifiedFixedCloseReason } from "./clawsweeper-item-policy.js";
import { normalizeComment } from "./clawsweeper-report-comment-helpers.js";
import { targetProfile, type RepositoryProfile } from "./repository-profiles.js";

export function reviewActionForDecision(options: {
  item: Item;
  decision: Decision;
  git: GitInfo;
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
  profile?: RepositoryProfile;
}): Action {
  if (options.decision.decision !== "close") return { actionTaken: "kept_open", closeComment: "" };
  if (
    isMaintainerAuthored(options.item) &&
    options.decision.closeReason !== "oversized_pull_request" &&
    !isVerifiedFixedCloseReason(options.decision.closeReason)
  ) {
    return { actionTaken: "skipped_maintainer_authored", closeComment: "" };
  }
  const validation = validateCloseDecision(options.item, options.decision, {
    requireCloseComment: false,
    ...(options.profile ? { profile: options.profile } : {}),
  });
  if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
  const closeComment = normalizeComment(
    options.decision,
    options.git,
    options.runtime,
    options.item,
    options.profile ?? targetProfile(),
  );
  if (!hasUsableCloseComment(closeComment)) {
    return { actionTaken: "skipped_invalid_decision", closeComment: "" };
  }
  return { actionTaken: "proposed_close", closeComment };
}
