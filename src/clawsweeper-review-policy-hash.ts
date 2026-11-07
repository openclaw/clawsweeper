import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";
import { REVIEW_POLICY_VERSION, FRESH_DAYS } from "./clawsweeper-policy.js";
import { targetRepo, targetProfile } from "./repository-profiles.js";
import type { createReviewCoreRuntime } from "./clawsweeper-review-core.js";

export function reviewPolicyHash(
  options: { model?: string; sandboxMode?: string },
  {
    reviewPromptTemplates,
    reviewDecisionSchemaText,
    reviewProcedureTemplate,
  }: Pick<
    ReturnType<typeof createReviewCoreRuntime>,
    "reviewPromptTemplates" | "reviewDecisionSchemaText" | "reviewProcedureTemplate"
  >,
): string {
  const policyTargetRepo = targetRepo();
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      // Model changes roll through normal review cadence. Keep this sentinel
      // stable; bump REVIEW_POLICY_VERSION to invalidate stored reviews.
      model: "model-excluded-2026-07",
      reasoningEffort: "per-item-author-profile-v1",
      itemExecutionProfile: "maintainer-high-fast-otherwise-medium-standard-v1",
      sandboxMode: options.sandboxMode ?? "read-only",
      // Keep the historical hash value so service tier changes do not invalidate reviews.
      serviceTier: "",
      targetRepo: policyTargetRepo,
      ...(policyTargetRepo.toLowerCase() === "openclaw/openclaw"
        ? { openclawCodexSourceProvisioning: "v1" }
        : {}),
      repositoryProfile: targetProfile(),
      prompts: reviewPromptTemplates(),
      procedures: {
        issue: reviewProcedureTemplate("issue"),
        pullRequest: reviewProcedureTemplate("pull_request"),
      },
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}
