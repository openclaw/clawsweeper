#!/usr/bin/env node
import { ensureManagedTruffleHog } from "../dist/review-tool-bootstrap.js";

const args = process.argv.slice(2);
const index = args.indexOf("--timeout-ms");
const timeoutMs = index === -1 ? 120_000 : Number(args[index + 1]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) process.exit(2);

try {
  const scanner = await ensureManagedTruffleHog({ timeoutMs });
  process.stdout.write(`${scanner}\n`);
} catch {
  // Scanner diagnostics can include network or platform details. The admission
  // boundary intentionally exposes only the fail-closed reason to callers.
  process.exitCode = 1;
}
