import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { LiveProofPlan } from "../clawsweeper-types.js";
import {
  materializePullRequestReviewTree,
  removePullRequestReviewTree,
} from "../clawsweeper-review-blobs.js";
import type { RepositoryProfile } from "../repository-profiles.js";
import { sanitizedLiveProofEnvironment } from "./environment.js";

const HEAD_SHA = /^[0-9a-f]{40}$/;
const PUBLIC_BUNDLE_FILES = [
  "live-verification.json",
  "live-proof-manifest.json",
  "live-proof.mp4",
  "poster.jpg",
] as const;

export interface ReviewLiveProofInspection {
  candidates: number[];
  recordMedia: boolean;
  requiresBrowser: boolean;
  requiresTerminal: boolean;
}

export interface ReviewLiveProofOptions {
  checkoutPath: string;
  entrypoint: string;
  itemNumbers: readonly number[];
  outputRoot: string;
  recordsDir: string;
  repo: string;
}

export interface ReviewLiveProofDependencies {
  env?: NodeJS.ProcessEnv;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  log?: (message: string) => void;
  reportLiveProofPlan: (markdown: string) => LiveProofPlan;
  repositoryProfileFor: (repo: string) => RepositoryProfile;
}

export const reviewLiveProofGoEnvironment = (environment: NodeJS.ProcessEnv, profile: string) => ({
  GOFLAGS: [environment.GOFLAGS, "-modcacherw"].filter(Boolean).join(" "),
  GOMODCACHE: join(profile, "go-mod-cache"),
});

export function inspectReviewLiveProofs(
  options: Pick<ReviewLiveProofOptions, "itemNumbers" | "recordsDir" | "repo">,
  dependencies: ReviewLiveProofDependencies,
): ReviewLiveProofInspection {
  const profile = dependencies.repositoryProfileFor(options.repo);
  const candidates: number[] = [];
  let recordMedia = false;
  let requiresBrowser = false;
  let requiresTerminal = false;
  if (!profile.liveTest?.enabled) {
    return { candidates, recordMedia, requiresBrowser, requiresTerminal };
  }
  for (const item of options.itemNumbers) {
    const recordPath = join(resolve(options.recordsDir), `${item}.md`);
    if (!existsSync(recordPath)) continue;
    const markdown = readFileSync(recordPath, "utf8");
    if (dependencies.frontMatterValue(markdown, "type") !== "pull_request") continue;
    const plan = dependencies.reportLiveProofPlan(markdown);
    if (plan.status !== "recommended" || plan.surface === "none") continue;
    candidates.push(item);
    recordMedia ||= plan.payoff.kind !== "static_text";
    requiresBrowser ||= plan.surface === "browser";
    requiresTerminal ||= plan.surface === "terminal";
  }
  return { candidates, recordMedia, requiresBrowser, requiresTerminal };
}

export function executeReviewLiveProofs(
  options: ReviewLiveProofOptions,
  dependencies: ReviewLiveProofDependencies,
): ReviewLiveProofInspection {
  const inspection = inspectReviewLiveProofs(options, dependencies);
  const log = dependencies.log ?? console.log;
  for (const item of inspection.candidates) {
    executeReviewLiveProof(options, item, dependencies, log);
  }
  return inspection;
}

function executeReviewLiveProof(
  options: ReviewLiveProofOptions,
  item: number,
  dependencies: ReviewLiveProofDependencies,
  log: (message: string) => void,
): void {
  const recordPath = join(resolve(options.recordsDir), `${item}.md`);
  const markdown = readFileSync(recordPath, "utf8");
  const headSha = (dependencies.frontMatterValue(markdown, "pull_head_sha") ?? "").toLowerCase();
  if (!HEAD_SHA.test(headSha)) {
    throw new Error(`live proof review artifact ${item} is missing a full pull_head_sha`);
  }

  const scratch = mkdtempSync(join(tmpdir(), `clawsweeper-live-proof-${item}-`));
  const worktree = join(scratch, "target");
  const profile = join(scratch, "profile");
  const temporaryBundle = join(scratch, "bundle");
  const copiedRecordPath = join(scratch, "review.md");
  const publishedBundle = join(resolve(options.outputRoot), String(item));
  mkdirSync(profile, { recursive: true });
  mkdirSync(temporaryBundle, { recursive: true });
  copyFileSync(recordPath, copiedRecordPath);
  try {
    if (
      !materializePullRequestReviewTree({
        targetDir: resolve(options.checkoutPath),
        worktreeDir: worktree,
        itemNumber: item,
        headSha,
      })
    ) {
      throw new Error(
        `could not materialize reviewed pull request head ${headSha} for item ${item}`,
      );
    }
    const environment = sanitizedLiveProofEnvironment(dependencies.env ?? process.env);
    Object.assign(environment, {
      CLAWSWEEPER_LIVE_PROOF_ENABLED: "1",
      CLAWSWEEPER_SANITIZED_LIVE_PROOF: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...reviewLiveProofGoEnvironment(environment, profile),
      HOME: profile,
      npm_config_cache: join(profile, "npm-cache"),
      PNPM_HOME: join(profile, "pnpm"),
      TMPDIR: join(profile, "tmp"),
      XDG_CACHE_HOME: join(profile, "cache"),
      XDG_CONFIG_HOME: join(profile, "config"),
    });
    for (const directory of [
      environment.npm_config_cache!,
      environment.PNPM_HOME!,
      environment.TMPDIR!,
      environment.XDG_CACHE_HOME!,
      environment.XDG_CONFIG_HOME!,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    const result = spawnSync(
      process.execPath,
      [
        resolve(options.entrypoint),
        "live-proof",
        "--repo",
        options.repo,
        "--item",
        String(item),
        "--record",
        copiedRecordPath,
        "--checkout",
        worktree,
        "--output",
        temporaryBundle,
      ],
      {
        cwd: worktree,
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 25 * 60_000,
      },
    );
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    if (result.error || result.status !== 0) {
      throw new Error(
        detail ||
          result.error?.message ||
          `live proof failed with status ${result.status ?? result.signal ?? "unknown"}`,
      );
    }
    const assertion = "[live-proof] sanitized environment assertion passed: credentials=0";
    if (!result.stdout.includes(assertion)) {
      throw new Error("live proof child did not confirm its sanitized environment");
    }
    if (!existsSync(join(temporaryBundle, "live-verification.json"))) {
      throw new Error(`live proof produced no verification result for item ${item}`);
    }
    rmSync(publishedBundle, { force: true, recursive: true });
    mkdirSync(publishedBundle, { recursive: true });
    for (const name of PUBLIC_BUNDLE_FILES) {
      const source = join(temporaryBundle, name);
      if (existsSync(source)) copyFileSync(source, join(publishedBundle, name));
    }
    log(assertion);
    log(`[live-proof] item=${item} head=${headSha} execution=unsandboxed credentials=0`);
  } finally {
    removePullRequestReviewTree({
      targetDir: resolve(options.checkoutPath),
      worktreeDir: worktree,
    });
    rmSync(scratch, { force: true, recursive: true });
  }
}
