#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argNumber, argString, parseArgs, type Args } from "./clawsweeper-args.js";
import { isUserFacingCommandError, runText } from "./command.js";
import { parseGhJson } from "./github-json.js";
import { ghRetryKind, ghRetryWaitMs, summarizeGhArgs } from "./github-retry.js";
import {
  buildPrInterferenceReport,
  prRadarFileFromApi,
  renderPrInterferenceMarkdown,
  type PrRadarPr,
} from "./pr-interference.js";
import { DEFAULT_TARGET_REPO } from "./repository-profiles.js";

const TARGET_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PAGE_SIZE = 100;

interface GitHubPullListItem {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: { login: string } | null;
  base: { ref: string };
  head: { sha: string };
}

interface GitHubPullFile {
  filename: string;
  status: string;
  previous_filename?: string | undefined;
  patch?: string | undefined;
}

function ghJson<T>(args: string[], attempts = 3): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return parseGhJson<T>(runText("gh", args, { trim: "both" }), args);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (retryKind === "none" || attempt === attempts - 1) throw error;
      const waitMs = ghRetryWaitMs(retryKind, attempt);
      console.error(
        `Transient GitHub API failure; retrying ${summarizeGhArgs(args)} in ${Math.round(waitMs / 1000)}s`,
      );
      sleepMs(waitMs);
    }
  }
  throw lastError;
}

function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fetchOpenPrs(
  targetRepo: string,
  maxPrs: number,
  maxFilePages: number,
): { prs: PrRadarPr[]; truncated: boolean } {
  const items: GitHubPullListItem[] = [];
  let lastPageFull = false;
  for (let page = 1; items.length < maxPrs; page += 1) {
    const batch = ghJson<GitHubPullListItem[]>([
      "api",
      `repos/${targetRepo}/pulls?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
    ]);
    items.push(...batch);
    lastPageFull = batch.length === PAGE_SIZE;
    if (!lastPageFull) break;
  }
  const truncated = items.length > maxPrs || (lastPageFull && items.length === maxPrs);
  const prs = items.slice(0, maxPrs).map((item) => {
    const files = fetchPrFiles(targetRepo, item.number, maxFilePages);
    return {
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user?.login ?? "",
      draft: item.draft === true,
      base_ref: item.base.ref,
      head_sha: item.head.sha,
      files: files.files.map(prRadarFileFromApi),
      files_truncated: files.truncated,
    };
  });
  return { prs, truncated };
}

function fetchPrFiles(
  targetRepo: string,
  pullNumber: number,
  maxFilePages: number,
): { files: GitHubPullFile[]; truncated: boolean } {
  const files: GitHubPullFile[] = [];
  let lastPageFull = false;
  for (let page = 1; page <= maxFilePages; page += 1) {
    const batch = ghJson<GitHubPullFile[]>([
      "api",
      `repos/${targetRepo}/pulls/${pullNumber}/files?per_page=${PAGE_SIZE}&page=${page}`,
    ]);
    files.push(...batch);
    lastPageFull = batch.length === PAGE_SIZE;
    if (!lastPageFull) break;
  }
  return { files, truncated: lastPageFull };
}

function scanCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  if (!TARGET_REPO_PATTERN.test(targetRepo))
    throw new Error("--target-repo must be owner/repo with GitHub-safe characters");
  const maxPrs = positiveIntegerArg(args, "max_prs", 200);
  const maxFilePages = positiveIntegerArg(args, "max_file_pages", 3);
  const maxPairs = positiveIntegerArg(args, "max_pairs", 50);
  const slug = targetRepo.replaceAll("/", "-");
  const outDir = argString(args, "out_dir", join("artifacts", "pr-radar", slug));

  const { prs, truncated } = fetchOpenPrs(targetRepo, maxPrs, maxFilePages);
  const report = buildPrInterferenceReport({
    targetRepo,
    prs,
    limits: { max_prs: maxPrs, max_file_pages_per_pr: maxFilePages, max_pairs: maxPairs },
    prsTruncated: truncated,
    updatedAt: new Date().toISOString(),
  });
  const markdown = renderPrInterferenceMarkdown(report);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "report.md"), `${markdown}\n`, "utf8");
  console.log(markdown);
  console.error(`Wrote report.json and report.md to ${outDir}`);
}

function positiveIntegerArg(args: Args, key: string, fallback: number): number {
  const value = argNumber(args, key, fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${key.replaceAll("_", "-")} must be a positive integer`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const command = args._[0] ?? "scan";
  if (command === "scan") scanCommand(args);
  else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(formatFatalError(error));
    process.exit(1);
  });
}

function formatFatalError(error: unknown): string {
  if (isUserFacingCommandError(error)) return `Error: ${error.message}`;
  return error instanceof Error ? error.stack || error.message : String(error);
}
