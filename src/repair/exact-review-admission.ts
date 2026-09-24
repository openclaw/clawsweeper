import { mkdirSync, writeFileSync } from "node:fs";
import { oversizedPullRequestAdmission } from "../clawsweeper-oversized-pr-policy.js";
import { classifyScheduledReviewNoop } from "../scheduled-review-noop.js";
import { ghRetryKind } from "../github-retry.js";
import { ghErrorText, ghTextWithRetry } from "./github-cli.js";
import { deferAutomaticEndorReview } from "./endor-automerge-intake.js";
import { issueSourceRevisionSha256 } from "./issue-source-guard.js";

type Output = (values: Record<string, string>) => void;

function usableBranch(branch: string): boolean {
  return /^[A-Za-z0-9_./-]+$/.test(branch) && !/^\d+$/.test(branch) && !branch.includes("..");
}

export function exactReviewAdmission(output: Output): void {
  const repo = process.env.TARGET_REPO ?? "";
  const number = process.env.ITEM_NUMBER ?? "";
  const core = repo === "openclaw/openclaw";
  const rootToken = (core ? process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN : process.env.GH_TOKEN)?.trim();
  if (!rootToken) throw new Error("The live-item check requires its target read token");

  const decision = JSON.parse(process.env.CLAIM_DECISION || "{}");
  let targetBranch = process.env.CLAIM_TARGET_BRANCH ?? "";
  const read = (endpoint: string, ...args: string[]) =>
    ghTextWithRetry(["api", `repos/${repo}/${endpoint}`, ...args], { attempts: 1 });
  // Repository metadata is outside the public-read classifier. Preserve its
  // original credential even when the optional App token is unavailable.
  const readRepository = (...args: string[]) =>
    ghTextWithRetry(["api", `repos/${repo}`, ...args], {
      attempts: 1,
      env: { GH_TOKEN: rootToken },
    });
  const terminal = {
    proceed: "false",
    terminal_noop: "false",
    terminal_missing: "false",
    guarded_open: "false",
    guarded_open_action: "",
  };
  const retry = (minutes: number, throttle = false) => {
    const retryAt = new Date(Date.now() + minutes * 60_000).toISOString();
    output({
      admission_retry: "true",
      ...(throttle ? { retry_kind: "throttle" } : {}),
      retry_at: retryAt,
      ...terminal,
    });
    return retryAt;
  };

  if (!usableBranch(targetBranch)) {
    const queuedBranch = targetBranch;
    try {
      targetBranch = readRepository("--jq", ".default_branch // empty");
      if (!usableBranch(targetBranch)) throw new Error("Repository default branch is unusable");
    } catch (error) {
      console.error(
        `::warning::Unable to resolve a usable default branch for ${repo} after queued target branch '${queuedBranch}' was rejected; releasing the claim for retry.`,
      );
      console.error(ghErrorText(error));
      retry(5);
      return;
    }
    console.error(
      `::warning::Resolved invalid queued target branch '${queuedBranch}' to default branch '${targetBranch}' for ${repo}.`,
    );
  }
  decision.targetBranch = targetBranch;
  output({
    admission_retry: "false",
    target_branch: targetBranch,
    decision: JSON.stringify(decision),
  });

  let issue: Record<string, unknown>;
  try {
    // Keep every admission read in this process so the native public-read
    // owner can spend its single App fallback allowance across the whole step.
    issue = JSON.parse(read(`issues/${number}`));
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(ghErrorText(error))) {
      try {
        readRepository();
      } catch (repositoryError) {
        console.error(ghErrorText(repositoryError));
        throw error;
      }
      output({ ...terminal, terminal_missing: "true" });
      console.error(
        `::notice::Completing ${repo}#${number} because the repository is accessible but the item is missing.`,
      );
      return;
    }
    if (ghRetryKind(error) === "throttle") {
      console.error(ghErrorText(error));
      const retryAt = retry(20, true);
      console.error(
        `::notice::GitHub throttled the live-item check for ${repo}#${number}; releasing the claim for retry at ${retryAt} without spending failure budget.`,
      );
      return;
    }
    throw error;
  }

  const open = issue.state === "open";
  const locked = issue.locked === true;
  const pullRequest = Boolean(issue.pull_request);
  if (open && !locked && !pullRequest) {
    const pages: unknown[] = JSON.parse(
      read(`issues/${number}/comments?per_page=100`, "--paginate", "--slurp"),
    );
    output({ source_revision: issueSourceRevisionSha256(issue, pages.flat()) });
  }
  output({ item_kind: pullRequest ? "pull_request" : "issue" });
  if (open && !locked && deferAutomaticEndorReview(repo, issue, decision)) {
    // Reuse the early policy no-op path: no write token, checkout or review lease.
    output({ ...terminal, scheduled_semantic_noop: "true" });
    console.error(
      `::notice::Deferring automatic review of ${repo}#${number} to Endor automerge enrollment.`,
    );
    return;
  }
  let liveHeadSha = "";
  if (open && !locked && pullRequest) {
    const observedAt = new Date().toISOString();
    let pull: Record<string, unknown> | undefined;
    try {
      pull = JSON.parse(read(`pulls/${number}`));
    } catch (error) {
      console.error(ghErrorText(error));
      console.error(
        "::warning::Unable to read PR admission metadata; preserving normal review admission.",
      );
    }
    if (pull) {
      liveHeadSha = String((pull.head as { sha?: unknown } | undefined)?.sha ?? "");
      const artifact = ".artifacts/exact-pr-admission.json";
      mkdirSync(".artifacts", { recursive: true });
      writeFileSync(artifact, JSON.stringify({ repo, pull, observedAt }));
      const oversized = !oversizedPullRequestAdmission(pull).admitted;
      output({ pr_admission_file: artifact, oversized: String(oversized) });
      if (oversized) {
        output({ ...terminal, proceed: "true", scheduled_semantic_noop: "false" });
        return;
      }
    }
  }

  if (open && !locked && decision.sourceAction === "scheduled_hot_intake") {
    let comments: unknown[] | undefined;
    try {
      const pages: unknown[] = JSON.parse(
        read(`issues/${number}/comments?per_page=100`, "--paginate", "--slurp"),
      );
      comments = pages.flat();
    } catch (error) {
      console.error(
        "::warning::Unable to read comments for scheduled no-op classification; preserving normal review admission.",
      );
      console.error(ghErrorText(error));
    }
    if (comments) {
      try {
        const classification = classifyScheduledReviewNoop({
          decision,
          issue,
          comments,
          liveHeadSha,
        });
        output({
          scheduled_noop: String(classification.noop),
          scheduled_noop_reason: classification.reason,
        });
        if (classification.noop) {
          output({ ...terminal, scheduled_semantic_noop: "true" });
          console.error(
            `::notice::Completing ${repo}#${number} as a scheduled no-op before target checkout because ${classification.reason}.`,
          );
          return;
        }
      } catch (error) {
        console.error(
          "::warning::Scheduled no-op classification failed; preserving normal review admission.",
        );
        console.error(ghErrorText(error));
      }
    }
  }
  if (open) {
    output({
      ...terminal,
      scheduled_semantic_noop: "false",
      proceed: String(!locked),
      guarded_open: String(locked),
      guarded_open_action: locked ? "skipped_locked_conversation" : "",
    });
    if (locked) {
      console.error(
        `::notice::Completing ${repo}#${number} without Codex because the open conversation is locked.`,
      );
    }
  } else if (issue.state === "closed") {
    output({ ...terminal, scheduled_semantic_noop: "false", terminal_noop: "true" });
    console.error(`::notice::Skipping terminal ${repo}#${number} because it is already closed.`);
  } else {
    throw new Error(`Unexpected live state for ${repo}#${number}: ${String(issue.state)}`);
  }
}
