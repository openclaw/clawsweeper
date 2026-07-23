#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const isolateHistoricalIndexFailure =
  process.env.CLAWSWEEPER_E2E_COREPACK_PNPM_ONLY === "1" &&
  args[0] === "enable" &&
  !args.some((arg) => ["pnpm", "pnpx", "yarn", "yarnpkg"].includes(arg));

// The historical run had two independent runtime-freezer defects. Supplying
// pnpm here bypasses only the earlier Yarn-shim defect so the same production
// CLI can reach and reproduce the linked Git-index identity failure.
const delegatedArgs = isolateHistoricalIndexFailure ? [...args, "pnpm"] : args;
const realCorepack = process.env.CLAWSWEEPER_E2E_REAL_COREPACK;
if (!realCorepack) fail("CLAWSWEEPER_E2E_REAL_COREPACK is required");

const child = spawnSync(realCorepack, delegatedArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (child.error) fail(child.error.message);
process.exit(child.status ?? 1);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
