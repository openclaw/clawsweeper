#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { importActionEventShards } from "../action-ledger-runtime.js";
import {
  finalizeCommandActionLedgerManifest,
  parseCommandActionLedgerManifest,
  serializeCommandActionLedgerManifest,
} from "./command-action-ledger-manifest.js";
import { repoRoot } from "./paths.js";

const rawArgv = process.argv.slice(2);
const [command, ...argv] = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
const args = parseArgs(argv);

if (command === "finalize") {
  const lane = requiredArg(args.lane, "--lane");
  const manifest = await finalizeCommandActionLedgerManifest(lane, {
    allowEmpty: args.allowEmpty === true,
  });
  if (manifest) process.stdout.write(serializeCommandActionLedgerManifest(manifest));
} else if (command === "publish") {
  const lane = requiredArg(args.lane, "--lane");
  const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
  const manifest = parseCommandActionLedgerManifest(fs.readFileSync(manifestPath, "utf8"), lane);
  const sourceRoot = path.resolve(args.sourceRoot ?? actionLedgerOutputRoot());
  const stateRoot = path.resolve(args.stateRoot ?? repoRoot());
  console.log(
    JSON.stringify(
      importActionEventShards(sourceRoot, stateRoot, {
        expectedProducer: {
          repository: manifest.repository,
          sha: manifest.sha,
          workflow: manifest.workflow,
          job: manifest.job,
          runId: manifest.run_id,
          runAttempt: manifest.run_attempt,
        },
        expectedEventPaths: manifest.event_paths,
      }),
      null,
      2,
    ),
  );
} else {
  throw new Error(
    "usage: action-ledger-cli.ts <finalize|publish> --lane name [--allow-empty --manifest path --source-root path --state-root path]",
  );
}

function actionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    path.join(repoRoot(), ".clawsweeper-repair", "action-ledger-state")
  );
}

function parseArgs(argv: readonly string[]) {
  const parsed: {
    lane?: string;
    manifest?: string;
    sourceRoot?: string;
    stateRoot?: string;
    allowEmpty?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lane") parsed.lane = requiredValue(argv, ++index, arg);
    else if (arg === "--manifest") parsed.manifest = requiredValue(argv, ++index, arg);
    else if (arg === "--source-root") parsed.sourceRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--allow-empty") parsed.allowEmpty = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requiredArg(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
