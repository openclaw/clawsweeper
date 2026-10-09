// This module owns the Git work of the fix executor: the target checkout, remote
// branch reads, rebase completion, checkpoint commits, history compaction and
// branch pushes.
import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "../command-runner.js";
import { coAuthorTrailers, fetchPullRequest } from "../execute-fix-github.js";
import { shouldSeedReplacementBranchFromSource } from "../execute-fix-policy.js";
import { runIsolatedGitNetwork } from "../git-network-isolation.js";
import {
  currentHead,
  isAncestor,
  type RebaseOntoBaseResult,
  runGit,
  unmergedPaths,
} from "../git.js";
import type { JsonValue, LooseRecord } from "../json-types.js";
import { repoRoot } from "../lib.js";
import { tryResolveMechanicalRebaseConflicts } from "../mechanical-rebase-conflicts.js";
import {
  clawsweeperGitUserEmail,
  clawsweeperGitUserName,
  repairGhEnv as ghEnv,
} from "../process-env.js";
import {
  checkoutSourcePullRequestHead,
  fetchSourcePullRequestHead,
  firstTargetSourcePullRequest,
} from "../source-pr-checkout.js";
import {
  assertTargetCheckoutBinding,
  assertTargetPublicationGitConfiguration,
  captureTargetCheckoutBinding,
  compactTargetHistoryWithPlumbing,
  completeTargetRebaseWithIsolation,
  createTargetCheckpointWithPlumbing,
  materializeTargetCommitWithIsolation,
  switchTargetBranchWithPlumbing,
} from "../target-validation.js";
import { compactText } from "../text-utils.js";
import { uniqueStrings } from "../validation-command-utils.js";
import { logProgress } from "./progress.js";

// The run values that the Git work reads. The timeouts are functions because the
// remaining run budget gets smaller while the executor runs.
export interface ExecuteFixGitRun {
  targetRepo: string;
  targetValidationTimeoutMs: number;
  currentNetworkCommandTimeoutMs: () => number;
  currentCheckoutCloneTimeoutMs: () => number;
  // Refuse a branch push when the source issue is closed, paused or bulk-filed.
  assertIssueImplementationNotPaused: () => void;
}

export function createExecuteFixGitOps({
  targetRepo,
  targetValidationTimeoutMs,
  currentNetworkCommandTimeoutMs,
  currentCheckoutCloneTimeoutMs,
  assertIssueImplementationNotPaused,
}: ExecuteFixGitRun) {
  function runGitNetwork(args: string[], cwd: string) {
    const timeoutMs = currentNetworkCommandTimeoutMs();
    assertTargetPublicationGitConfiguration(cwd, timeoutMs);
    const env = ghEnv();
    const token =
      String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim() ||
      run("gh", ["auth", "token"], { cwd, env, timeoutMs }).trim();
    return runIsolatedGitNetwork({ args, cwd, env, timeoutMs, token });
  }

  function ensureTargetCheckout(repo: string, targetDir: string) {
    if (!fs.existsSync(targetDir)) {
      cloneTargetCheckout(repo, targetDir);
      return;
    }
    if (!fs.existsSync(path.join(targetDir, ".git"))) {
      throw new Error(`target dir is not a git checkout: ${targetDir}`);
    }
    const status = runGit(["status", "--porcelain"], { cwd: targetDir }).trim();
    if (status) throw new Error(`target checkout has uncommitted changes: ${targetDir}`);
  }

  function cloneTargetCheckout(repo: string, targetDir: string) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    setupGitHubCredentialHelper();
    const timeoutMs = currentCheckoutCloneTimeoutMs();
    const attempts = Math.max(1, Number(process.env.CLAWSWEEPER_CHECKOUT_CLONE_ATTEMPTS ?? 3));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      try {
        runGit(bloblessCloneArgs(repo, targetDir), {
          cwd: repoRoot(),
          env: ghEnv(),
          timeoutMs,
        });
        return;
      } catch (error) {
        lastError = error;
        logProgress("target checkout clone attempt failed", {
          repo,
          attempt,
          attempts,
          timeout_ms: timeoutMs,
          error: compactText(String(error?.message ?? error), 500),
        });
        if (attempt === attempts) break;
      }
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function setupGitHubCredentialHelper() {
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return;
    try {
      run("gh", ["auth", "setup-git", "--hostname", "github.com"], {
        cwd: repoRoot(),
        env: ghEnv(),
        timeoutMs: Math.min(30_000, currentNetworkCommandTimeoutMs()),
      });
    } catch (error) {
      logProgress("GitHub git credential setup failed; continuing", {
        error: compactText(String(error?.message ?? error), 500),
      });
    }
  }

  function completeMechanicallyResolvedRebase({ targetDir }: { targetDir: string }) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        return completeTargetRebaseWithIsolation({
          cwd: targetDir,
          timeoutMs: targetValidationTimeoutMs,
        });
      } catch (error) {
        const paths = unmergedPaths(targetDir);
        if (paths.length === 0) throw error;
        const current = currentHead(targetDir);
        const resolved = tryResolveMechanicalRebaseConflicts({
          targetDir,
          rebaseResult: {
            status: "conflicts",
            base_ref: "",
            base_sha: "",
            previous_head: current,
            current_head: current,
            detail: String((error as Error).message ?? error),
          },
        });
        if (resolved.status !== "resolved") throw error;
        logProgress("mechanically resolved additional rebase conflicts", {
          attempt,
          paths: resolved.paths,
          reason: resolved.reason,
        });
      }
    }
    throw new Error("mechanical rebase did not complete after resolving repeated conflicts");
  }

  function resolveAndCompleteMechanicalRebase({
    targetDir,
    rebaseResult,
    progressLabel,
  }: {
    targetDir: string;
    rebaseResult: RebaseOntoBaseResult;
    progressLabel: string;
  }): RebaseOntoBaseResult {
    const resolution = tryResolveMechanicalRebaseConflicts({ targetDir, rebaseResult });
    if (resolution.status !== "resolved") return rebaseResult;
    logProgress(progressLabel, resolution);
    const completed = completeMechanicallyResolvedRebase({ targetDir });
    if (completed.status !== "continued") {
      throw new Error("mechanically resolved rebase was not continued");
    }
    return {
      ...rebaseResult,
      status: "rebased",
      current_head: completed.current_head,
      detail: [rebaseResult.detail, resolution.reason, completed.detail].filter(Boolean).join("\n"),
    };
  }

  function assertRepairBranchWritable({ targetDir, pull, sourceRef }: LooseRecord) {
    assertTargetPublicationGitConfiguration(targetDir, targetValidationTimeoutMs);
    const args = repairBranchPushArgs({ pull, sourceRef });
    runGitNetwork(["push", "--dry-run", ...args.slice(1)], targetDir);
  }

  function trustedRemoteBranchSha(branch: string, cwd: string) {
    try {
      const sha = run(
        "gh",
        [
          "api",
          `repos/${targetRepo}/git/ref/heads/${encodeURIComponent(branch)}`,
          "--jq",
          ".object.sha",
        ],
        { cwd, env: ghEnv(), timeoutMs: currentNetworkCommandTimeoutMs() },
      ).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
    } catch (error) {
      if (/\b404\b|not found/i.test(String((error as Error).message ?? error))) return "";
      throw error;
    }
  }

  function checkoutRecoverableReplacementBranch({
    targetDir,
    branch,
    baseBranch,
    fixArtifact,
  }: LooseRecord) {
    const sourcePr = shouldSeedReplacementBranchFromSource(fixArtifact)
      ? firstTargetSourcePullRequest(fixArtifact.source_prs ?? [], targetRepo)
      : null;
    const remoteLeaseSha = trustedRemoteBranchSha(branch, targetDir);
    if (remoteLeaseSha) {
      runGitNetwork(
        [
          "fetch",
          `https://github.com/${targetRepo}.git`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        targetDir,
      );
      const recoveredHeadSha = runGit(["rev-parse", `origin/${branch}`], {
        cwd: targetDir,
      }).trim();
      if (recoveredHeadSha !== remoteLeaseSha) {
        throw new Error(
          `recoverable branch ${branch} changed between API lease and fetch: expected ${remoteLeaseSha}, fetched ${recoveredHeadSha}`,
        );
      }
      materializeFetchedReplacementCommit({
        targetDir,
        sourceSha: recoveredHeadSha,
        remoteRef: `refs/remotes/origin/${branch}`,
      });
      switchTargetBranchWithPlumbing({
        cwd: targetDir,
        branch,
        expectedHeadSha: recoveredHeadSha,
        timeoutMs: targetValidationTimeoutMs,
      });
      if (sourcePr) {
        const sourceRef = fetchSourcePullRequestHead({ targetDir, sourcePr });
        const sourceHeadSha = runGit(["rev-parse", sourceRef], { cwd: targetDir }).trim();
        if (!isAncestor({ targetDir, ancestor: sourceHeadSha, descendant: "HEAD" })) {
          const pull = fetchPullRequest(targetRepo, sourcePr.number);
          if (pull.state !== "open")
            throw new Error(`source PR #${sourcePr.number} is ${pull.state}`);
          checkoutSourcePullRequestHead({
            targetDir,
            repo: targetRepo,
            branch,
            sourcePr,
            pull,
          });
          return {
            resumed: false,
            remote_lease_sha: remoteLeaseSha,
            source_head: currentHead(targetDir),
          };
        }
      }
      return {
        resumed: true,
        remote_lease_sha: remoteLeaseSha,
        source_head: recoveredHeadSha,
      };
    }
    if (sourcePr) {
      const pull = fetchPullRequest(targetRepo, sourcePr.number);
      if (pull.state !== "open") throw new Error(`source PR #${sourcePr.number} is ${pull.state}`);
      checkoutSourcePullRequestHead({
        targetDir,
        repo: targetRepo,
        branch,
        sourcePr,
        pull,
      });
      return {
        resumed: false,
        remote_lease_sha: remoteLeaseSha,
        source_head: currentHead(targetDir),
      };
    }
    // Fetch can advance the base ref without moving the fresh clone's HEAD.
    const fetchedBaseSha = runGit(["rev-parse", `origin/${baseBranch}`], {
      cwd: targetDir,
    }).trim();
    materializeFetchedReplacementCommit({
      targetDir,
      sourceSha: fetchedBaseSha,
      remoteRef: `refs/remotes/origin/${baseBranch}`,
    });
    switchTargetBranchWithPlumbing({
      cwd: targetDir,
      branch,
      expectedHeadSha: fetchedBaseSha,
      timeoutMs: targetValidationTimeoutMs,
    });
    return {
      resumed: false,
      remote_lease_sha: remoteLeaseSha,
      source_head: fetchedBaseSha,
    };
  }

  function materializeFetchedReplacementCommit({
    targetDir,
    sourceSha,
    remoteRef,
  }: {
    targetDir: string;
    sourceSha: string;
    remoteRef: string;
  }) {
    // Hydrate one pinned tree here; isolated checkout cannot perform lazy fetches.
    runGitNetwork(
      [
        "fetch",
        "--no-tags",
        "--refetch",
        "--no-filter",
        "--depth=1",
        `https://github.com/${targetRepo}.git`,
        `+${sourceSha}:${remoteRef}`,
      ],
      targetDir,
    );
    materializeTargetCommitWithIsolation({
      cwd: targetDir,
      expectedHeadSha: sourceSha,
      timeoutMs: targetValidationTimeoutMs,
    });
  }

  function commitCheckpointIfNeeded({ targetDir, message, trailers = [] }: LooseRecord) {
    const checkpoint = createTargetCheckpointWithPlumbing({
      cwd: targetDir,
      messages: [message, ...uniqueStrings(trailers)],
      identity: {
        name: clawsweeperGitUserName(),
        email: clawsweeperGitUserEmail(),
      },
      timeoutMs: targetValidationTimeoutMs,
    });
    return checkpoint.status === "committed" ? checkpoint.commit : "";
  }

  function compactReplacementHistory({
    targetDir,
    baseSha,
    fixArtifact,
    contributorCredits,
    checkpointCommits,
  }: LooseRecord) {
    const compaction = compactTargetHistoryWithPlumbing({
      cwd: targetDir,
      baseRef: baseSha,
      messages: [fixArtifact.pr_title, ...uniqueStrings(coAuthorTrailers(contributorCredits))],
      identity: {
        name: clawsweeperGitUserName(),
        email: clawsweeperGitUserEmail(),
      },
      timeoutMs: targetValidationTimeoutMs,
    });
    if (compaction.status === "compacted") {
      checkpointCommits.splice(0, checkpointCommits.length, compaction.commit);
      logProgress("compacted generated replacement branch history", {
        previous_head: compaction.previous_head,
        previous_commit_count: compaction.previous_commit_count,
        commit: compaction.commit,
      });
    }
    return compaction;
  }

  function pushRecoverableBranch({
    targetDir,
    branch,
    checkoutBinding = null,
    expectedRemoteSha,
  }: LooseRecord) {
    const binding =
      checkoutBinding ?? captureTargetCheckoutBinding(targetDir, targetValidationTimeoutMs);
    assertTargetCheckoutBinding(targetDir, binding, targetValidationTimeoutMs);
    assertTargetPublicationGitConfiguration(targetDir, targetValidationTimeoutMs);
    if (typeof expectedRemoteSha !== "string") {
      throw new Error(`cannot push recoverable branch ${branch}: captured remote lease is missing`);
    }
    const remoteSha = expectedRemoteSha;
    if (remoteSha !== "" && !/^[0-9a-f]{40}$/.test(remoteSha)) {
      throw new Error(`cannot push recoverable branch ${branch}: captured remote lease is invalid`);
    }
    const targetRef = `refs/heads/${branch}`;
    const remote = `https://github.com/${targetRepo}.git`;
    const sourceRef = String(binding.headSha);
    const args = [
      "push",
      "--no-verify",
      `--force-with-lease=${targetRef}:${remoteSha}`,
      remote,
      `${sourceRef}:${targetRef}`,
    ];
    assertIssueImplementationNotPaused();
    runGitNetwork(args, targetDir);
    const publishedSha = fetchRemoteRecoverableBranch({ targetDir, branch, required: false });
    if (!publishedSha) {
      throw new Error(
        `git push reported success, but refs/heads/${branch} was not visible on origin`,
      );
    }
    if (publishedSha !== sourceRef) {
      throw new Error(
        `published replacement branch moved after validation: expected ${sourceRef}, found ${publishedSha}`,
      );
    }
  }

  function fetchRemoteRecoverableBranch({ targetDir, branch, required = true }: LooseRecord) {
    try {
      runGitNetwork(
        [
          "fetch",
          `https://github.com/${targetRepo}.git`,
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        targetDir,
      );
      const sha = runGit(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
        cwd: targetDir,
      }).trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) {
        throw new Error(`fetched replacement branch has an invalid object id: ${branch}`);
      }
      return sha;
    } catch (error) {
      const detail = String((error as Error).message ?? error);
      if (
        !required &&
        /couldn't find remote ref|could not find remote ref|not found/i.test(detail)
      ) {
        return "";
      }
      throw error;
    }
  }

  return {
    assertRepairBranchWritable,
    checkoutRecoverableReplacementBranch,
    commitCheckpointIfNeeded,
    compactReplacementHistory,
    completeMechanicallyResolvedRebase,
    ensureTargetCheckout,
    pushRecoverableBranch,
    resolveAndCompleteMechanicalRebase,
    runGitNetwork,
    trustedRemoteBranchSha,
  };
}

export function setupGitIdentity(cwd: JsonValue) {
  runGit(["config", "user.name", clawsweeperGitUserName()], { cwd });
  runGit(["config", "user.email", clawsweeperGitUserEmail()], { cwd });
}

export function branchUpdateState({ targetDir, sourceHead }: LooseRecord) {
  const rewritten =
    /^[0-9a-f]{40}$/i.test(String(sourceHead ?? "")) &&
    !isAncestor({ targetDir, ancestor: sourceHead, descendant: "HEAD" });
  return { rewritten };
}

export function repairBranchPushArgs({ pull, sourceRef = "HEAD" }: LooseRecord) {
  const remote = `https://github.com/${pull.head.repo.full_name}.git`;
  if (!/^(?:HEAD|[0-9a-f]{40})$/i.test(String(sourceRef))) {
    throw new Error("cannot push repair branch: validated source ref is missing");
  }
  const headSha = String(pull.head?.sha ?? "");
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(
      `cannot force-with-lease repair branch ${pull.head.ref}: source head sha is missing`,
    );
  }
  return [
    "push",
    "--no-verify",
    `--force-with-lease=refs/heads/${pull.head.ref}:${headSha}`,
    remote,
    `${sourceRef}:${pull.head.ref}`,
  ];
}

export function replacementBranchName(clusterId: string) {
  return safeBranchName(`clawsweeper/${clusterId}`);
}

export function safeBranchName(value: JsonValue) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function bloblessCloneArgs(repo: string, targetDir: string) {
  return [
    "clone",
    "--filter=blob:none",
    "--depth=1",
    "--single-branch",
    githubRepoCloneUrl(repo),
    targetDir,
  ];
}

function githubRepoCloneUrl(repo: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid GitHub repository: ${repo}`);
  }
  return `https://github.com/${repo}.git`;
}
