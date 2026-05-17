import type { JsonValue } from "./json-types.js";

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

function parseBooleanEnv(value: JsonValue, fallback: boolean) {
  if (value == null || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  return fallback;
}
