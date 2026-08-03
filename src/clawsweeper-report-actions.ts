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
import type { CreateReportRenderingDependencies } from "./clawsweeper-report-rendering-dependencies.js";
import type { createReportContextRendering } from "./clawsweeper-report-context.js";
import type { createReportCommentHelpers } from "./clawsweeper-report-comment-helpers.js";

export function createReportActionRendering(
  dependencies: CreateReportRenderingDependencies &
    ReturnType<typeof createReportContextRendering> &
    ReturnType<typeof createReportCommentHelpers>,
) {
  const {
    ROOT,
    asRecord,
    collectItemContext,
    ghJson,
    ghObservedMutationCommand,
    hasUsableCloseComment,
    isImplementationCloseReason,
    isMaintainerAuthored,
    isVerifiedFixedCloseReason,
    normalizeComment,
    targetRepo,
    validateCloseDecision,
  } = dependencies;

  function pullRequestHeadSha(number: number): string {
    const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${number}`]));
    const sha = asRecord(pull.head).sha;
    return typeof sha === "string" ? sha.trim().toLowerCase() : "";
  }

  function currentReviewRevision(item: Item): string {
    if (item.kind === "pull_request") return pullRequestHeadSha(item.number);
    const revision = collectItemContext(item, { fullTimelineForRelations: true }).sourceRevision;
    return typeof revision === "string" ? revision : "";
  }

  function closeItem(options: { number: number; kind: ItemKind; reason: CloseReason }): void {
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

  function reviewActionForDecision(options: {
    item: Item;
    decision: Decision;
    git: GitInfo;
    runtime?: Pick<ReviewRuntime, "model" | "reasoningEffort">;
  }): Action {
    if (options.decision.decision !== "close")
      return { actionTaken: "kept_open", closeComment: "" };
    if (
      isMaintainerAuthored(options.item) &&
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
    );
    if (!hasUsableCloseComment(closeComment)) {
      return { actionTaken: "skipped_invalid_decision", closeComment: "" };
    }
    return { actionTaken: "proposed_close", closeComment };
  }

  return { pullRequestHeadSha, currentReviewRevision, closeItem, reviewActionForDecision };
}
