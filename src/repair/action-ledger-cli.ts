#!/usr/bin/env node
import path from "node:path";

import { importActionEventShards } from "../action-ledger-runtime.js";
import { flushCommandActionEvents } from "./command-action-ledger.js";
import { repoRoot } from "./paths.js";

const [command, ...argv] = process.argv.slice(2);

if (command === "finalize") {
  const paths = await flushCommandActionEvents();
  console.log(JSON.stringify({ paths }, null, 2));
} else if (command === "publish") {
  const args = parseArgs(argv);
  const sourceRoot = path.resolve(args.sourceRoot ?? actionLedgerOutputRoot());
  const stateRoot = path.resolve(args.stateRoot ?? repoRoot());
  console.log(JSON.stringify(importActionEventShards(sourceRoot, stateRoot), null, 2));
} else {
  throw new Error(
    "usage: action-ledger-cli.ts <finalize|publish> [--source-root path --state-root path]",
  );
}

function actionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    path.join(repoRoot(), ".clawsweeper-repair", "action-ledger-state")
  );
}

function parseArgs(argv: readonly string[]) {
  const parsed: { sourceRoot?: string; stateRoot?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-root") parsed.sourceRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(argv, ++index, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
