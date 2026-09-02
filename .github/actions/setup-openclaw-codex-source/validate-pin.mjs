#!/usr/bin/env node

import { readFileSync } from "node:fs";

const SOURCE_INCOMPATIBLE_EXIT_CODE = 80;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function refuse() {
  console.error("OpenClaw must pin @openai/codex to one exact version.");
  process.exit(SOURCE_INCOMPATIBLE_EXIT_CODE);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
} catch {
  refuse();
}

const version = manifest?.dependencies?.["@openai/codex"];
if (typeof version !== "string" || !exactVersion.test(version)) refuse();
process.stdout.write(version);
