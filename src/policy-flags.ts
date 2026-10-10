import { DEFAULT_AUTHOR_PR_BUDGET } from "./clawsweeper-policy.js";

type PolicyEnv = Readonly<Record<string, unknown>>;

/** Return true only when the flag is set to an "on" word. */
export function envFlagEnabled(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Return true only when the flag is set to an "off" word. */
export function envFlagDisabled(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

export function unconfirmedProductDirectionCloseEnabled(env: PolicyEnv = process.env): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED);
}

export function unsponsoredFeatureCloseEnabled(env: PolicyEnv = process.env): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED);
}

export function authorPrBudgetCloseEnabled(env: PolicyEnv = process.env): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED);
}

export function staleVersionBugCloseEnabled(env: PolicyEnv = process.env): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED);
}

export function obsoleteFixPrCloseEnabled(env: PolicyEnv = process.env): boolean {
  return envFlagEnabled(env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED);
}

export function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function authorPrBudget(env: Record<string, string | undefined> = process.env): number {
  return positiveIntegerEnv(env.CLAWSWEEPER_AUTHOR_PR_BUDGET, DEFAULT_AUTHOR_PR_BUDGET);
}
