#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRepairExecutionBlockReason } from "./execute-fix-policy.js";
import { parseJob } from "./lib.js";

export function runRepositoryRepairCommand(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const separator = args.indexOf("--");
  const jobPath = args
    .slice(0, separator >= 0 ? separator : args.length)
    .find((arg) => arg !== "--");
  const command = separator >= 0 ? args[separator + 1] : undefined;
  const commandArgs = separator >= 0 ? args.slice(separator + 2) : [];
  if (!jobPath || !command) {
    throw new Error("usage: node dist/repair/repair-policy-run.js <job.md> -- <command> [args...]");
  }

  const job = parseJob(path.resolve(jobPath));
  const reason = repositoryRepairExecutionBlockReason(job.frontmatter.repo);
  if (reason) {
    console.log(`::notice title=ClawSweeper repair policy::${reason}; skipped final repair I/O.`);
    return { allowed: false, reason, status: 0 };
  }

  const result = spawnSync(command, commandArgs, {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`repair policy child terminated by ${result.signal}`);
  return { allowed: true, reason: null, status: result.status ?? 1 };
}

async function main() {
  const result = runRepositoryRepairCommand(process.argv.slice(2));
  process.exitCode = result.status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
