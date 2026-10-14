import { readFileSync } from "node:fs";
import { dirtyWorktree } from "./commit-sweeper.js";
import { runText, UserFacingCommandError } from "./command.js";
import { reviewStatusForDecision } from "./clawsweeper-report-document.js";
import type { Decision } from "./clawsweeper-types.js";

export type ReviewPreflight = { block: string; error?: never } | { block: null; error: string };

type PreflightPayload = {
  v: 1;
  repo: string;
  base: string;
  head: string;
  tool: { name: "clawsweeper"; version: string };
  completion: "complete" | "failed";
  summary: string;
};

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function serializeReviewPreflight(payload: PreflightPayload): string {
  if (
    payload.v !== 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repo) ||
    !/^[0-9a-f]{40}$/.test(payload.base) ||
    !/^[0-9a-f]{40}$/.test(payload.head) ||
    payload.tool.name !== "clawsweeper" ||
    !/^[A-Za-z0-9.+-]{1,64}$/.test(payload.tool.version) ||
    !["complete", "failed"].includes(payload.completion) ||
    !payload.summary ||
    Buffer.byteLength(escapedJson(payload.summary)) > 512
  ) {
    throw new UserFacingCommandError("Preflight fields are invalid or exceed their byte limit.");
  }
  // Reconstruct the closed payload: caller extras cannot leak into the PR body.
  const block = `<!-- openclaw-preflight:v1\n${escapedJson({
    v: 1,
    repo: payload.repo,
    base: payload.base,
    head: payload.head,
    tool: { name: payload.tool.name, version: payload.tool.version },
    completion: payload.completion,
    summary: payload.summary,
  })}\n-->`;
  if (Buffer.byteLength(block) > 4096) {
    throw new UserFacingCommandError("Preflight block exceeds 4096 bytes.");
  }
  return block;
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
