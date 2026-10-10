import { createItemContext } from "../dist/clawsweeper-item-context.js";
import { createRelatedContext } from "../dist/clawsweeper-related-context.js";
import { compactIssue, compactPullRequest } from "../dist/clawsweeper-context-hydration.js";
import { ghJsonEach, ghJsonOnce } from "../dist/clawsweeper-github-execution.js";
import { GitHubRuntimeBudgetError } from "../dist/clawsweeper-github-runtime.js";
import { reportUrl } from "../dist/clawsweeper-links.js";
import {
  ROOT,
  defaultClosedDir,
  defaultItemsDir,
  isMarkdownForActiveRepo,
  repoRelativePath,
} from "../dist/clawsweeper-repository-paths.js";
import { displayTitle } from "../dist/clawsweeper-status-context.js";
import { targetRepo } from "../dist/repository-profiles.js";

export function createContextState() {
  return createItemContext(
    createRelatedContext({
      root: ROOT,
      targetRepo,
      reportUrl,
      defaultItemsDir,
      defaultClosedDir,
      isMarkdownForActiveRepo,
      gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
      ghJsonEach,
      ghJsonOnce,
      compactIssue,
      compactPullRequest,
      displayTitle,
      repoRelativePath,
    }),
  );
}
