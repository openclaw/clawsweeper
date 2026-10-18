import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringArg, type Args } from "./clawsweeper-args.js";
import { asRecord, nonBlankStringOrUndefined } from "./value-coerce.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { refreshReviewTargetBranch, ReviewGitError } from "./clawsweeper-review-blobs.js";
import { explainSpawnFailure, UserFacingCommandError } from "./command.js";
import type {
  GitInfo,
  LatestRelease,
  LocalPullMetadata,
  ManagedLocalReviewCheckoutOptions,
  ReviewCheckout,
  ReviewGitInfoOptions,
} from "./clawsweeper-types.js";
import {
  createReviewCoreRuntime,
  isSafeGitBranchName,
  type ReviewRuntimeDependencies,
} from "./clawsweeper-review-core.js";
export { isSafeGitBranchName } from "./clawsweeper-review-core.js";
export type { CodexFailureLogKind, ReviewItemPrompts } from "./clawsweeper-review-core.js";

export function createReviewRuntime(dependencies: ReviewRuntimeDependencies) {
  const { targetRepo, run, ghJson, ensureDir } = dependencies;
  const core = createReviewCoreRuntime(dependencies);
  const { displayPath, localExactReviewItem } = core;
  function gitInfo(openclawDir: string, options: ReviewGitInfoOptions = {}): GitInfo {
    const targetBranch = options.targetBranch ?? reviewTargetBranch(openclawDir);
    requireSafeGitBranchName(targetBranch, "target branch");
    try {
      refreshReviewTargetBranch(openclawDir, targetBranch);
    } catch (error) {
      if (
        !options.classifyFetchFailure &&
        error instanceof ReviewGitError &&
        error.cause instanceof Error
      ) {
        throw explainSpawnFailure(error.cause, "git", openclawDir);
      }
      throw error;
    }
    const mainSha = run("git", ["rev-parse", `refs/remotes/origin/${targetBranch}`], {
      cwd: openclawDir,
    });
    let latestRelease: LatestRelease | null = null;
    let releaseStateComplete = true;
    try {
      const releases = ghJson<LatestRelease[]>([
        "release",
        "list",
        "--exclude-drafts",
        "--exclude-pre-releases",
        "--limit",
        "100",
        "--json",
        "tagName,name,publishedAt,isLatest",
      ]);
      if (!Array.isArray(releases)) throw new Error("release list response was not an array");
      latestRelease = releases.find((release) => release.isLatest === true) ?? null;
      if (releases.length > 0 && !latestRelease) {
        throw new Error("release list response did not identify the latest release");
      }
    } catch {
      latestRelease = null;
      releaseStateComplete = false;
    }
    if (latestRelease?.tagName) {
      try {
        run(
          "git",
          [
            "fetch",
            "--force",
            "--filter=blob:none",
            "--recurse-submodules=no",
            "origin",
            "tag",
            latestRelease.tagName,
          ],
          {
            cwd: openclawDir,
            timeoutMs: 30_000,
          },
        );
        latestRelease.sha = run("git", ["rev-list", "-n", "1", latestRelease.tagName], {
          cwd: openclawDir,
        });
      } catch {
        latestRelease.sha = null;
        releaseStateComplete = false;
      }
    } else if (latestRelease) {
      releaseStateComplete = false;
    }
    return { mainSha, targetBranch, releaseStateComplete, latestRelease };
  }

  function reviewTargetBranch(openclawDir: string): string {
    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: openclawDir });
    if (isSafeGitBranchName(branch) && branch !== "HEAD") return branch;
    return "main";
  }

  function requireSafeGitBranchName(branch: string, label: string): string {
    if (isSafeGitBranchName(branch) && branch !== "HEAD") return branch;
    throw new UserFacingCommandError(`Invalid ${label}: ${branch}`);
  }

  function localPullMetadata(itemNumber: number): LocalPullMetadata {
    try {
      const pull = asRecord(ghJson<unknown>(["api", `repos/${targetRepo()}/pulls/${itemNumber}`]));
      const baseRef = nonBlankStringOrUndefined(asRecord(pull.base).ref);
      if (!baseRef) throw new Error("pull request base ref was missing");
      return { baseRef: requireSafeGitBranchName(baseRef, "pull request base branch") };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UserFacingCommandError(
        `Could not load pull request #${itemNumber} from ${targetRepo()} for managed local checkout. ` +
          `Pass --target-dir to review an existing checkout. ${reason}`,
      );
    }
  }

  function tryLocalPullBaseBranch(itemNumber: number): string | undefined {
    try {
      return localPullMetadata(itemNumber).baseRef;
    } catch {
      return undefined;
    }
  }

  function hasExplicitReviewTargetDir(args: Args): boolean {
    return typeof args.target_dir === "string" || typeof args.openclaw_dir === "string";
  }

  function resolveReviewCheckout(options: {
    args: Args;
    artifactDir: string;
    humanLocalReview?: boolean;
    itemNumber: number | undefined;
    itemNumbers: number[] | undefined;
    localRange?: boolean;
    localOnly: boolean;
    profile: RepositoryProfile;
    verbose?: boolean;
  }): ReviewCheckout {
    const {
      args,
      artifactDir,
      humanLocalReview,
      itemNumber,
      itemNumbers,
      localOnly,
      localRange,
      profile,
    } = options;
    const explicitTargetDir = hasExplicitReviewTargetDir(args);
    if (localExactReviewItem(localOnly, itemNumber, itemNumbers) && !explicitTargetDir) {
      const pull = localPullMetadata(itemNumber);
      const openclawDir = join(artifactDir, "target");
      if (humanLocalReview) {
        console.error("  mode: managed PR checkout");
        console.error(`  path: ${displayPath(openclawDir)}`);
        console.error(`  base: ${pull.baseRef}`);
      }
      prepareManagedLocalReviewCheckout({
        baseBranch: pull.baseRef,
        itemNumber,
        targetDir: openclawDir,
        targetRepo: targetRepo(),
        verbose: options.verbose,
      });
      return { mode: "managed", openclawDir, gitTargetBranch: pull.baseRef };
    }

    const openclawDir = resolve(
      stringArg(
        args.target_dir,
        stringArg(args.openclaw_dir, localRange ? process.cwd() : `../${profile.checkoutDir}`),
      ),
    );
    if (humanLocalReview) {
      console.error(`  mode: ${explicitTargetDir ? "supplied checkout" : "default checkout"}`);
      console.error(`  path: ${displayPath(openclawDir)}`);
    }
    if (localExactReviewItem(localOnly, itemNumber, itemNumbers)) {
      const baseBranch = tryLocalPullBaseBranch(itemNumber);
      if (baseBranch) {
        if (humanLocalReview) console.error(`  base: ${baseBranch}`);
        return {
          mode: explicitTargetDir ? "supplied" : "default",
          openclawDir,
          gitTargetBranch: baseBranch,
        };
      }
    }
    return { mode: explicitTargetDir ? "supplied" : "default", openclawDir };
  }

  function prepareManagedLocalReviewCheckout(options: ManagedLocalReviewCheckoutOptions): void {
    const { baseBranch, cloneUrl, itemNumber, targetDir, targetRepo, verbose } = options;
    const remoteUrl = cloneUrl ?? githubCloneUrl(targetRepo);
    ensureDir(dirname(targetDir));
    const targetExists = existsSync(targetDir);
    if (targetExists && !isGitWorkTree(targetDir)) {
      const entries = readdirSync(targetDir);
      if (entries.length > 0) {
        throw new UserFacingCommandError(
          `Managed local checkout target already exists and is not a git checkout: ${targetDir}. ` +
            "Pass --target-dir to use an existing checkout or choose a different --artifact-dir.",
        );
      }
    }
    if (!targetExists || !isGitWorkTree(targetDir)) {
      run("git", ["clone", "--filter=blob:none", "--no-checkout", remoteUrl, targetDir]);
    } else {
      ensureGitOriginRemote(targetDir, remoteUrl);
    }

    const cacheRef = `refs/clawsweeper/review-cache/head-${itemNumber}`;
    if (verbose) {
      console.error(
        `[review] ${new Date().toISOString()} local-checkout=managed target=${targetDir} pr=#${itemNumber} base=${baseBranch}`,
      );
    }
    // The managed checkout already has complete base history. A depth-limited PR fetch
    // writes repository-wide shallow boundaries and can truncate that ancestry when the
    // PR has merged the base branch. Keep the blobless fetch time-bounded instead.
    const unshallow = run("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: targetDir,
    });
    run(
      "git",
      [
        "fetch",
        "--force",
        "origin",
        `refs/pull/${itemNumber}/head:${cacheRef}`,
        ...(unshallow === "true" ? ["--unshallow"] : []),
      ],
      { cwd: targetDir, timeoutMs: 30_000 },
    );
  }

  function isGitWorkTree(dir: string): boolean {
    try {
      return run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }) === "true";
    } catch {
      return false;
    }
  }

  function githubCloneUrl(targetRepo: string): string {
    return `https://github.com/${targetRepo}.git`;
  }

  function ensureGitOriginRemote(dir: string, remoteUrl: string): void {
    try {
      run("git", ["remote", "set-url", "origin", remoteUrl], { cwd: dir });
    } catch {
      run("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
    }
  }

  function prepareManagedLocalReviewCheckoutForTest(
    options: ManagedLocalReviewCheckoutOptions,
  ): void {
    prepareManagedLocalReviewCheckout(options);
  }

  return {
    ...core,
    gitInfo,
    isSafeGitBranchName,
    resolveReviewCheckout,
    prepareManagedLocalReviewCheckoutForTest,
  };
}
