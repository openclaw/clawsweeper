#!/usr/bin/env node
import fs from "node:fs";

import { repositoryRepairExecutionBlockReason } from "./execute-fix-policy.js";
import { parseJob } from "./lib.js";

const jobPath = process.argv.slice(2).find((argument) => argument !== "--");
if (!jobPath) {
  console.error("usage: node dist/repair/repair-policy-gate.js <job.md>");
  process.exit(2);
}

const job = parseJob(jobPath);
const reason = repositoryRepairExecutionBlockReason(job.frontmatter.repo);
writeOutput("allowed", reason ? "0" : "1");
writeOutput("reason", reason ?? "");

if (!reason) {
  console.log(`repair execution allowed for ${job.frontmatter.repo}`);
  process.exit(0);
}

writeEnvironment("CLAWSWEEPER_ALLOW_EXECUTE", "0");
writeEnvironment("CLAWSWEEPER_ALLOW_FIX_PR", "0");
writeEnvironment("CLAWSWEEPER_ALLOW_MERGE", "0");
console.log(`::notice title=ClawSweeper repair policy::${reason}; skipping queued repair effects.`);

function writeOutput(name: string, value: string) {
  appendKeyValue(process.env.GITHUB_OUTPUT, name, value);
}

function writeEnvironment(name: string, value: string) {
  appendKeyValue(process.env.GITHUB_ENV, name, value);
}

function appendKeyValue(filePath: string | undefined, name: string, value: string) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${name}=${value}\n`);
}
