import { assertGitHubItemIdentity, GitHubItemMovedError } from "../github-item-identity.js";
import { ghErrorText, ghTextWithRetry } from "./github-cli.js";

export function readExactReviewLiveItem(
  repository: string,
  number: number,
  repositoryToken?: string,
): Record<string, unknown> | null {
  let issue: Record<string, unknown>;
  try {
    issue = JSON.parse(
      ghTextWithRetry(["api", `repos/${repository}/issues/${number}`], { attempts: 1 }),
    );
  } catch (error) {
    if (!/HTTP 404|Not Found/i.test(ghErrorText(error))) throw error;
    // A hidden repository also returns 404. Only a readable repository proves
    // that the requested item identity is absent.
    try {
      ghTextWithRetry(["api", `repos/${repository}`], {
        attempts: 1,
        ...(repositoryToken ? { env: { GH_TOKEN: repositoryToken } } : {}),
      });
    } catch (repositoryError) {
      console.error(ghErrorText(repositoryError));
      throw error;
    }
    return null;
  }
  try {
    assertGitHubItemIdentity(issue, repository, number);
  } catch (error) {
    if (!(error instanceof GitHubItemMovedError)) throw error;
    console.error(
      `::notice::${error.message} Completing the old identity without review or mutation.`,
    );
    return null;
  }
  return issue;
}

export function exactReviewLiveItemState() {
  const repository = process.env.TARGET_REPO ?? "";
  const number = Number(process.env.ITEM_NUMBER);
  if (!repository || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("An exact live-item check requires a repository and positive item number");
  }
  const issue = readExactReviewLiveItem(repository, number);
  return { state: issue === null ? "missing" : issue.state, locked: issue?.locked === true };
}
