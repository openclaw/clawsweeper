#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const GENERATED_PATHS = [
  "records",
  "jobs",
  "results",
  "assets",
  "apply-report.json",
  "repair-apply-report.json",
];

type Args = {
  stateDir?: string;
  worktree?: string;
};

const args = parseArgs(process.argv.slice(2));
const stateRoot = path.resolve(
  args.stateDir ?? process.env.CLAWSWEEPER_STATE_DIR ?? "../clawsweeper-state",
);
const worktreeRoot = path.resolve(args.worktree ?? process.cwd());

if (!existsSync(stateRoot)) {
  throw new Error(`State directory does not exist: ${stateRoot}`);
}

if (!GENERATED_PATHS.some((relativePath) => existsSync(path.join(stateRoot, relativePath)))) {
  throw new Error(
    `State directory has no generated paths: ${stateRoot}. Check out the generated state branch first, for example: git -C ${stateRoot} switch state`,
  );
}

for (const relativePath of GENERATED_PATHS) {
  const source = path.join(stateRoot, relativePath);
  const destination = path.join(worktreeRoot, relativePath);
  rmSync(destination, { force: true, recursive: true });
  if (!existsSync(source)) continue;
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

console.log(JSON.stringify({ hydrated: GENERATED_PATHS, source: stateRoot, target: worktreeRoot }));

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--worktree") parsed.worktree = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
