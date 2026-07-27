#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { allowedRepairOwners } from "./lib.js";
import { findResultPaths } from "./publish-files.js";

const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ResolvedResultTargets = {
  owner: string;
  repositories: string[];
};

// Result publication must mint its target-read token for the repositories the
// workers actually operated on, never a hard-coded default. The worker
// artifacts carry `result.repo`; every value is validated against the shared
// CLAWSWEEPER_ALLOWED_OWNER contract (a comma- or whitespace-separated owner
// list, issue #604) and the resolver fails closed on anything else. One
// publication mints one reader token, so all results must share one owner.
export function resolveResultTargets(options: {
  artifactsDir: string;
  allowedOwner: string;
  fallbackRepo: string;
}): ResolvedResultTargets {
  const allowedOwners = allowedRepairOwners(options.allowedOwner);
  if (allowedOwners.length === 0 || allowedOwners.some((owner) => !OWNER_PATTERN.test(owner))) {
    throw new Error(`invalid allowed repository owner: ${JSON.stringify(options.allowedOwner)}`);
  }
  const isAllowed = (owner: string) => allowedOwners.includes(owner.toLowerCase());
  const fallbackRepo = options.fallbackRepo.trim();
  if (!REPO_PATTERN.test(fallbackRepo)) {
    throw new Error(`invalid fallback repository: ${JSON.stringify(options.fallbackRepo)}`);
  }
  if (!isAllowed(fallbackRepo.split("/")[0]!)) {
    throw new Error(
      `fallback repository must be owned by ${allowedOwners.join(",")}: ${fallbackRepo}`,
    );
  }

  let resolvedOwner = "";
  const names = new Set<string>();
  for (const resultPath of findResultPaths(resolve(options.artifactsDir))) {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as { repo?: unknown };
    const repo = String(parsed.repo ?? "").trim();
    if (!REPO_PATTERN.test(repo)) {
      throw new Error(`worker result has an invalid target repository: ${JSON.stringify(repo)}`);
    }
    const [owner, name] = repo.split("/") as [string, string];
    if (!isAllowed(owner)) {
      throw new Error(
        `worker result targets a repository outside ${allowedOwners.join(",")}: ${repo}`,
      );
    }
    if (!resolvedOwner) {
      resolvedOwner = owner;
    } else if (resolvedOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `worker results span multiple owners (${resolvedOwner}, ${owner}); one publication mints one reader token`,
      );
    }
    names.add(name);
  }
  if (names.size === 0) {
    resolvedOwner = fallbackRepo.split("/")[0]!;
    names.add(fallbackRepo.split("/")[1]!);
  }
  return { owner: resolvedOwner, repositories: [...names].sort() };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const values = process.argv.slice(2);
  const value = (name: string): string => {
    const index = values.indexOf(name);
    if (index < 0 || !values[index + 1]) throw new Error(`${name} is required`);
    return values[index + 1]!;
  };
  try {
    const resolved = resolveResultTargets({
      artifactsDir: value("--artifacts"),
      allowedOwner: value("--allowed-owner"),
      fallbackRepo: value("--fallback"),
    });
    process.stdout.write(`owner=${resolved.owner}\n`);
    process.stdout.write(`repositories=${resolved.repositories.join(",")}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
