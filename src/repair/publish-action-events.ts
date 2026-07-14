#!/usr/bin/env node
import path from "node:path";

import { importWorkflowActionEvents } from "./action-event-importer.js";
import { repoRoot } from "./paths.js";

type Args = {
  sourceRoot: string;
  stateRoot: string;
  expectedProducerJob: string;
};

const args = parseArgs(process.argv.slice(2));
const result = importWorkflowActionEvents(args);
console.log(JSON.stringify(result, null, 2));

function parseArgs(rawArgv: readonly string[]): Args {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const parsed: Args = {
    sourceRoot: path.join(repoRoot(), ".clawsweeper-repair", "action-ledger-download"),
    stateRoot: repoRoot(),
    expectedProducerJob: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-root") {
      parsed.sourceRoot = path.resolve(requiredValue(argv, ++index, arg));
    } else if (arg === "--state-root") {
      parsed.stateRoot = path.resolve(requiredValue(argv, ++index, arg));
    } else if (arg === "--expected-producer-job") {
      parsed.expectedProducerJob = requiredValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.expectedProducerJob) throw new Error("--expected-producer-job is required");
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
