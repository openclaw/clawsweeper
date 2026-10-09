import type { JsonValue } from "./json-types.js";
import { repositoryProfileFor } from "../repository-profiles.js";
import { parseBooleanEnv } from "./env-utils.js";
import {
  isCodexContextLimitError,
  isRetryableCodexErrorMessage,
  isRetryableCodexTransportError,
  isTerminalCodexErrorMessage,
} from "../codex-transient.js";
import { isRepairBranchPushBlocked, isRepairBranchPushRace } from "./repair-branch-push-errors.js";

export function repositoryRepairExecutionBlockReason(repo: JsonValue) {
  const targetRepo = String(repo ?? "").trim();
  if (!targetRepo) return "repair execution requires a target repository";
  const profile = repositoryProfileFor(targetRepo);
  return profile.allowRepairCommands === false
    ? `repair execution is disabled for ${profile.targetRepo} by repository profile`
    : null;
}

export function shouldCloseSupersededSourcePrs(value: JsonValue) {
  return parseBooleanEnv(value, true);
}

export function shouldSeedReplacementBranchFromSource(fixArtifact: JsonValue) {
  return String(fixArtifact?.repair_strategy ?? "") === "replace_uneditable_branch";
}

export function sourceBranchWriteBlockReason(repo: string, pullRequest: JsonValue) {
  const headRepo = String(pullRequest?.head?.repo?.full_name ?? "");
  const headRef = String(pullRequest?.head?.ref ?? "");
  if (!headRepo || !headRef) return "source PR is missing head repo/ref";
  if (headRepo === repo) return null;
  if (pullRequest?.maintainer_can_modify === true) return null;
  return "source PR branch is a fork with maintainer_can_modify=false";
}

// A retryable failure asks the router to requeue the repair job.
export function isRetryableCodexFailure(...values: JsonValue[]) {
  const messages = values.flat().map(String);
  const message = messages.join("\n");
  if (messages.some((value) => isTerminalCodexErrorMessage(value))) return false;
  if (isPersistentCodexSetupFailure(message)) return false;
  return (
    isRetryableCodexTransportError(message) ||
    /Codex .*(?:timed out|failed|exited)|Codex produced no structured result/i.test(message)
  );
}

function isPersistentCodexSetupFailure(message: string) {
  return /can(?:not|'t|’t)\s+create\s+files?\s+in\s+this\s+mode|switch\s+to\s+execution\s+mode|bwrap|loopback|uid map|sandbox (?:wrapper|startup)|operation not permitted|auth(?:entication)? unavailable|login required|api key|401|403|unauthorized|forbidden/i.test(
    message,
  );
}

// A blocked failure becomes a reported repair outcome instead of a crash.
export function isBlockedFixError(error: JsonValue) {
  if (isRepairBranchPushRace(error)) return true;
  if (isRepairBranchPushBlocked(error)) return true;
  if (isRetryableCodexErrorMessage(String(error?.message ?? error))) return true;
  if (isCodexContextLimitError(String(error?.message ?? error))) return true;
  return /external base blocker|Codex produced no target repo changes|Codex \/review did not pass|Codex (?:fix worker|review-fix worker|validation-fix worker|\/review) timed out|Codex (?:fix worker|review-fix worker|validation-fix worker|\/review) failed|validation command failed|command timed out after \d+ms: git (?:fetch|push)|rebase (?:conflicts remain unresolved|produced additional conflicts)/i.test(
    String(error?.message ?? error),
  );
}
