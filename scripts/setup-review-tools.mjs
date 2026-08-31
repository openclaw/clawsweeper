#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { ensureManagedTruffleHog } from "../dist/review-tool-bootstrap.js";
import { managedScannerCacheRoot } from "../dist/agent-input-scan.js";

const args = process.argv.slice(2);
const index = args.indexOf("--timeout-ms");
const timeoutMs = index === -1 ? 120_000 : Number(args[index + 1]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) process.exit(2);

try {
  const cwd = realpathSync(process.cwd());
  const cacheRoot = managedScannerCacheRoot(process.env, cwd, process.cwd());
  const scanner = await ensureManagedTruffleHog({
    timeoutMs,
    env: { ...process.env, CLAWSWEEPER_REVIEW_TOOLS_DIR: cacheRoot },
  });
  process.stdout.write(`${scanner}\n`);
} catch {
  // Scanner diagnostics can include network or platform details. The admission
  // boundary intentionally exposes only the fail-closed reason to callers.
  process.exitCode = 1;
}
