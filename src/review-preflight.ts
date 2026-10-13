import {
  serializeReviewPreflightPayload,
  type ReviewPreflightPayload,
} from "./review-preflight-contract.js";
import { readFileSync } from "node:fs";
import { dirtyWorktree } from "./commit-sweeper.js";
import { runText, UserFacingCommandError } from "./command.js";
import { reviewStatusForDecision } from "./clawsweeper-report-document.js";
import type { Decision } from "./clawsweeper-types.js";

export type ReviewPreflight = { block: string; error?: never } | { block: null; error: string };

export function serializeReviewPreflight(payload: ReviewPreflightPayload): string {
  try {
    return serializeReviewPreflightPayload(payload);
  } catch {
    throw new UserFacingCommandError("Preflight fields are invalid or exceed their byte limit.");
  }
}

export function localRangeReviewPreflight(options: {
  targetDir: string;
  baseRef: string;
  repo: string;
  base: string;
  head: string;
  decision: Pick<Decision, "localCheckoutAccess" | "summary" | "reviewFindings"> | undefined;
}): ReviewPreflight {
  if (!options.decision) {
    return {
      block: null,
      error: "No validated native assessment is available for preflight export.",
    };
  }
  try {
    // Recheck the reviewed range at export. Never restamp old evidence with a new HEAD.
    const currentHead = runText("git", ["rev-parse", "HEAD"], { cwd: options.targetDir });
    const currentBase = runText("git", ["merge-base", options.baseRef, "HEAD"], {
      cwd: options.targetDir,
    });
    if (
      currentHead !== options.head ||
      currentBase !== options.base ||
      dirtyWorktree(options.targetDir)
    ) {
      return {
        block: null,
        error: "Reviewed source changed or is dirty; preflight was not exported.",
      };
    }
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    const completion = reviewStatusForDecision(options.decision);
    const count = options.decision.reviewFindings.length;
    const summary = `Native review ${completion}; ${count} reported finding${count === 1 ? "" : "s"}. No summary priority filter. ${completion === "failed" ? "Findings may be incomplete. " : ""}See the native report for coverage and policy caveats. Self-reported completion is not a clean verdict.`;
    return {
      block: serializeReviewPreflight({
        v: 1,
        repo: options.repo,
        base: options.base,
        head: options.head,
        tool: { name: "clawsweeper", version },
        completion,
        summary,
      }),
    };
  } catch {
    // Keep native output usable; do not copy Git errors or private paths into the block.
    return {
      block: null,
      error: "Preflight export failed; the native review report remains available.",
    };
  }
}
