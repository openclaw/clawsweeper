import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Action,
  CloseReason,
  Decision,
  GitInfo,
  Item,
  ItemKind,
  ReviewRuntime,
} from "./clawsweeper-types.js";
import { ghJson, ghObservedMutationCommand } from "./clawsweeper-github-execution.js";
import {
  hasUsableCloseComment,
  isImplementationCloseReason,
  validateCloseDecision,
} from "./clawsweeper-close-decision.js";
import { isMaintainerAuthored, isVerifiedFixedCloseReason } from "./clawsweeper-item-policy.js";
import { ROOT } from "./clawsweeper-repository-paths.js";
import { targetProfile, targetRepo } from "./repository-profiles.js";
import { normalizeComment } from "./clawsweeper-report-comment-helpers.js";
import { asRecord } from "./value-coerce.js";

export function pullRequestHeadSha(number: number): string {
  const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
  const sha = asRecord(pull.head).sha;
  return typeof sha === "string" ? sha.trim().toLowerCase() : "";
}

export function currentReviewRevision(
  item: Item,
  collectItemContext: (
    item: Item,
    options: { fullTimelineForRelations: boolean },
  ) => { sourceRevision?: string },
): string {
  if (item.kind === "pull_request") return pullRequestHeadSha(item.number);
  const revision = collectItemContext(item, { fullTimelineForRelations: true }).sourceRevision;
  return typeof revision === "string" ? revision : "";
}

export function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
  if (options.kind === "pull_request") {
    ghObservedMutationCommand({
      identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
      args: ["pr", "close", String(options.number)],
    });
  } else {
    const reason = isImplementationCloseReason(options.reason) ? "completed" : "not_planned";
    const closePayloadFile = join(ROOT, ".artifacts", `close-${options.number}.json`);
    writeFileSync(
      closePayloadFile,
      JSON.stringify({ state: "closed", state_reason: reason }),
      "utf8",
    );
    ghObservedMutationCommand({
      identity: `item_close:${options.number}:${options.kind}:${options.reason}`,
      args: [
        "api",
        `repos/${targetRepo()}/issues/${options.number}`,
        "--method",
        "PATCH",
        "--input",
        closePayloadFile,
      ],
    });
  }
}

export function reviewActionForDecision(options: {
  item: Item;
  decision: Decision;
  git: GitInfo;
  runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
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
  });
  if (!validation.ok) return { actionTaken: validation.actionTaken, closeComment: "" };
  const closeComment = normalizeComment(
    options.decision,
    options.git,
    options.runtime,
    options.item,
    targetProfile(),
  );
  if (!hasUsableCloseComment(closeComment)) {
    return { actionTaken: "skipped_invalid_decision", closeComment: "" };
  }
  return { actionTaken: "proposed_close", closeComment };
}
