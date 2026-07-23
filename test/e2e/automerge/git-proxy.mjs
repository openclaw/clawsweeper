#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const rawArgs = process.argv.slice(2);
const needsNetworkRewrite = rawArgs.some((arg) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(arg),
);
const statePath = process.env.CLAWSWEEPER_E2E_GITHUB_STATE;
if (needsNetworkRewrite && !statePath) fail("CLAWSWEEPER_E2E_GITHUB_STATE is required");
// Contained validation intentionally cannot see the simulator state outside
// its writable roots. Local Git commands need no simulation, so delegate them
// without opening that external file; network commands still fail closed.
const state = needsNetworkRewrite ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
const githubUrl = state ? `https://github.com/${state.repo}.git` : "";
const args = rawArgs.map((arg) => (state && arg === githubUrl ? state.remote : arg));

const child = spawnSync("/usr/bin/git", args, {
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
