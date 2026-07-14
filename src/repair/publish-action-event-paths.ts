#!/usr/bin/env node
import { publishActionEventPaths } from "./action-event-publisher.js";

type Args = {
  pathsFile: string;
  message: string;
};

const args = parseArgs(process.argv.slice(2));
const result = publishActionEventPaths({
  pathsFile: args.pathsFile,
  message: args.message,
});
console.log(
  JSON.stringify({
    result: result.result,
    path_count: result.pathCount,
    coordination: result.coordination,
  }),
);

function parseArgs(rawArgv: readonly string[]): Args {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const parsed: Args = { pathsFile: "", message: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--paths-file") parsed.pathsFile = requiredValue(argv, ++index, arg);
    else if (arg === "--message") parsed.message = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.pathsFile) throw new Error("--paths-file is required");
  if (!parsed.message) throw new Error("--message is required");
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
