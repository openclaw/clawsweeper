import { ghWithRetry } from "../clawsweeper-github-execution.js";
import { withGitHubRun } from "../clawsweeper-github-runtime.js";
import { setTargetRepo } from "../repository-profiles.js";
import { requiredEnv } from "../required-env.js";

const repo = requiredEnv("TARGET_REPO");
const number = Number(requiredEnv("ITEM_NUMBER"));
if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid item number");
setTargetRepo(repo);
const state = withGitHubRun(() =>
  ghWithRetry(["api", `repos/${repo}/issues/${number}`, "--jq", ".state"]),
);
if (state !== "closed")
  throw new Error(`Cannot complete closed review on ${state} item ${repo}#${number}`);
