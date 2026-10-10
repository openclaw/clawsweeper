import { runGit } from "./git.js";
import { repoRoot } from "./paths.js";

export function currentProjectRepo() {
  return (
    process.env.CLAWSWEEPER_REPO ||
    process.env.GITHUB_REPOSITORY ||
    repoFromOriginRemote() ||
    "openclaw/clawsweeper"
  );
}

export function githubActionsRunUrl(runId: string) {
  return `https://github.com/${currentProjectRepo()}/actions/runs/${runId}`;
}

function repoFromOriginRemote() {
  try {
    const remote = runGit(["config", "--get", "remote.origin.url"], { cwd: repoRoot() }).trim();
    const sshMatch = remote.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    return null;
  }
  return null;
}
