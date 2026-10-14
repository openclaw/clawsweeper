import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloseReason, Item, ItemKind } from "./clawsweeper-types.js";
import { ghJson, ghObservedMutationCommand } from "./clawsweeper-github-execution.js";
import { isImplementationCloseReason } from "./clawsweeper-close-decision.js";

import { ROOT } from "./clawsweeper-repository-paths.js";
import { targetRepo } from "./repository-profiles.js";

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

export { reviewActionForDecision } from "./clawsweeper-review-action.js";
