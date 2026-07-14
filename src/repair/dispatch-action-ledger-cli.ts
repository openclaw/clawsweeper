#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { importActionEventShards } from "../action-ledger-runtime.js";
import {
  finalizeDispatchActionLedgerManifest,
  parseDispatchActionLedgerManifest,
  serializeDispatchActionLedgerManifest,
} from "./dispatch-action-ledger-manifest.js";
import { repoRoot } from "./paths.js";

const rawArgv = process.argv.slice(2);
const [command, ...argv] = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
const args = parseArgs(argv);

if (command === "finalize") {
  const lane = requiredArg(args.lane, "--lane");
  const manifest = await finalizeDispatchActionLedgerManifest(lane, {
    allowEmpty: args.allowEmpty === true,
  });
  if (manifest) process.stdout.write(serializeDispatchActionLedgerManifest(manifest));
} else if (command === "bundle") {
  const lane = requiredArg(args.lane, "--lane");
  const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
  const manifest = parseDispatchActionLedgerManifest(fs.readFileSync(manifestPath, "utf8"), lane);
  const sourceRoot = path.resolve(args.sourceRoot ?? actionLedgerOutputRoot());
  const bundleRoot = path.resolve(requiredArg(args.bundleRoot, "--bundle-root"));
  const bundleSourceRoot = path.join(bundleRoot, "source");
  fs.rmSync(bundleRoot, { force: true, recursive: true });
  fs.mkdirSync(bundleSourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    serializeDispatchActionLedgerManifest(manifest),
    { flag: "wx" },
  );
  for (const relativePath of manifest.event_paths) {
    const source = resolveInside(sourceRoot, relativePath, "dispatch bundle source");
    const target = resolveInside(bundleSourceRoot, relativePath, "dispatch bundle target");
    if (!fs.statSync(source).isFile()) {
      throw new Error(`dispatch bundle source is not a file: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  console.log(
    JSON.stringify(
      {
        eventPaths: manifest.event_paths,
        manifest: "manifest.json",
        sourceRoot: "source",
      },
      null,
      2,
    ),
  );
} else if (command === "publish" || command === "replay") {
  const lane = requiredArg(args.lane, "--lane");
  const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
  const manifest = parseDispatchActionLedgerManifest(
    fs.readFileSync(manifestPath, "utf8"),
    lane,
    process.env,
    { validateCurrentProducer: command !== "replay" },
  );
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
    "usage: dispatch-action-ledger-cli.ts <finalize|bundle|publish|replay> --lane name [--allow-empty --manifest path --source-root path --state-root path --bundle-root path]",
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
    bundleRoot?: string;
    allowEmpty?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lane") parsed.lane = requiredValue(argv, ++index, arg);
    else if (arg === "--manifest") parsed.manifest = requiredValue(argv, ++index, arg);
    else if (arg === "--source-root") parsed.sourceRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--bundle-root") parsed.bundleRoot = requiredValue(argv, ++index, arg);
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

function resolveInside(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`${label} path is invalid: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes its root: ${relativePath}`);
  }
  return target;
}
