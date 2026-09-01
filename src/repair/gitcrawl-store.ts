import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { repoRoot } from "./lib.js";

type GitcrawlStoreRuntime = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  homeDir?: string;
  existsSync?: (candidate: string) => boolean;
};

export function gitcrawlStoreDbFileName(repoFullName: string): string {
  return `${repoFullName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "__")}.sync.db`;
}

export function resolveGitcrawlDbPath(
  repoFullName: string,
  explicitDb?: string,
  runtime: GitcrawlStoreRuntime = {},
): string {
  const env = runtime.env ?? process.env;
  const configured = explicitDb?.trim() || env.CLAWSWEEPER_GITCRAWL_DB?.trim();
  if (configured) return path.resolve(configured);
  const storeDbFileName = gitcrawlStoreDbFileName(repoFullName);
  const root = runtime.root ?? repoRoot();
  const homeDir = runtime.homeDir ?? os.homedir();
  const existsSync = runtime.existsSync ?? fs.existsSync;
  const candidates = [
    path.join(root, "..", "gitcrawl-store", "data", storeDbFileName),
    path.join(homeDir, ".config", "gitcrawl", "stores", "gitcrawl-store", "data", storeDbFileName),
    path.join(homeDir, ".config", "gitcrawl", "gitcrawl.db"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
}
