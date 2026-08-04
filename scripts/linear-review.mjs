#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Routes all CLI arguments to the read-only snapshot command, then feeds its
 * JSON to deterministic review-only triage. No shell pipeline is used, so pnpm
 * argument forwarding cannot accidentally send snapshot flags to triage.
 */
export function runLinearReview(argv, deps = {}) {
  const run = deps.run ?? spawnSync;
  const nodePath = deps.nodePath ?? process.execPath;
  const scriptsDir = deps.scriptsDir ?? SCRIPTS_DIR;
  const common = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

  const snapshot = run(nodePath, [join(scriptsDir, "linear-snapshot.mjs"), ...argv], common);
  assertSucceeded("Linear snapshot", snapshot);

  const triage = run(nodePath, [join(scriptsDir, "linear-triage.mjs"), "--review-only", "--json"], {
    ...common,
    input: snapshot.stdout,
  });
  assertSucceeded("Linear triage", triage);
  return triage;
}

function assertSucceeded(label, result) {
  if (!result.error && result.status === 0) return;
  const detail = result.error?.message ?? String(result.stderr ?? "").trim();
  throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

function main() {
  try {
    const result = runLinearReview(process.argv.slice(2));
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
