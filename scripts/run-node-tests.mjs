#!/usr/bin/env node

/**
 * Definition: expand one named ClawSweeper test target and run it with Node's
 * built-in test runner. The script does not build sources or mutate fixtures.
 * It owns each target's coverage thresholds, can run one round-robin shard of
 * a target while recording raw V8 coverage profiles, and can enforce the
 * thresholds over every shard's profiles through Node's own coverage report.
 *
 * Parameters: a required target, an optional positive --test-concurrency (or
 * CLAWSWEEPER_TEST_CONCURRENCY), an optional --shard <index>/<total>, at most
 * one of --coverage, --coverage-out <dir>, or --coverage-from <dir>, and Node
 * test-runner arguments after `--`.
 *
 * Outputs: the selected target/shard/coverage mode/concurrency/file count on
 * stderr, inherited TAP output, and the child runner's exit code or
 * terminating signal.
 *
 * Examples:
 *   node scripts/run-node-tests.mjs unit
 *   node scripts/run-node-tests.mjs all --coverage
 *   node scripts/run-node-tests.mjs all --shard 2/4 --coverage-out .artifacts/coverage/2
 *   node scripts/run-node-tests.mjs all --coverage-from .artifacts/coverage
 */

import { spawn } from "node:child_process";
import {
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_TEST_CONCURRENCY = 16;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];
const TARGET_PATTERNS = Object.freeze({
  unit: ["test/*.test.ts"],
  repair: ["test/repair/*.test.ts", "dist/repair/*.test.js"],
  all: ["test/*.test.ts", "test/repair/*.test.ts", "dist/repair/*.test.js"],
  "fix-prompt-builder": ["dist/repair/fix-prompt-builder.test.js"],
});
// The single owner of the coverage gates: `--coverage` applies them to a full
// local run, and `--coverage-from` applies the same values to CI shard profiles.
const COVERAGE_POLICIES = Object.freeze({
  all: Object.freeze({
    include: ["dist/**/*.js"],
    exclude: ["dist/repair/*.test.js"],
    lines: 49,
    branches: 66,
    functions: 57,
  }),
  "fix-prompt-builder": Object.freeze({
    include: ["dist/repair/fix-prompt-builder.js"],
    exclude: [],
    lines: 85,
    branches: 85,
    functions: 85,
  }),
});
// Mirrors the profile names Node's coverage report reads (kCoverageFileRegex).
export const COVERAGE_PROFILE_PATTERN = /^coverage-\d+-(\d{13})-(\d+)\.json$/;
const COVERAGE_REPLAY_ENTRY = fileURLToPath(
  new URL("./replay-coverage-profiles.mjs", import.meta.url),
);

const HELP = `Usage:
  node scripts/run-node-tests.mjs <target> [--test-concurrency <count>] [--shard <index>/<total>]
    [--coverage | --coverage-out <dir> | --coverage-from <dir>] [-- <node-options...>]

Description:
  Expand a named ClawSweeper test target with node:fs globSync, sort the files,
  and invoke the Node test runner without building the repository.

Targets:
  unit                test/*.test.ts
  repair              test/repair/*.test.ts and dist/repair/*.test.js
  all                 all unit and repair targets
  fix-prompt-builder  dist/repair/fix-prompt-builder.test.js

Coverage policies (Node test-runner coverage over files relative to the cwd):
  all                 dist/**/*.js except dist/repair/*.test.js;
                      lines 49, branches 66, functions 57
  fix-prompt-builder  dist/repair/fix-prompt-builder.js;
                      lines 85, branches 85, functions 85

Options:
  --test-concurrency <count>  Positive integer overriding the adaptive default
  --shard <index>/<total>     Run every total-th sorted file starting at index,
                              the same partition as node --test-shard
  --coverage                  Enforce the target's coverage policy on this run
  --coverage-out <dir>        Record raw V8 coverage profiles for this run into an
                              empty directory, keeping only checkout scripts
  --coverage-from <dir>       Run no tests; enforce the target's coverage policy
                              over every profile recorded under <dir>
  -h, --help                  Show this help
  --                          Forward remaining arguments to node --test

Environment:
  CLAWSWEEPER_TEST_CONCURRENCY  Positive integer used when the CLI override is absent

Outputs:
  Writes the selected target, shard, coverage mode, concurrency, and file count
  to stderr. Test output uses inherited stdio. The process preserves the child
  exit code or signal.

Examples:
  node scripts/run-node-tests.mjs unit
  node scripts/run-node-tests.mjs all --test-concurrency 4
  node scripts/run-node-tests.mjs all --coverage
  node scripts/run-node-tests.mjs all --shard 2/4 --coverage-out .artifacts/coverage/2
  node scripts/run-node-tests.mjs all --coverage-from .artifacts/coverage
`;

export function calculateTestConcurrency(parallelism = availableParallelism()) {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new Error(`Available parallelism must be a positive integer, received ${parallelism}.`);
  }

  // Measurements on this suite show that higher fan-out increases Git fixture,
  // subprocess, and filesystem contention even on large hosts. Sixteen retains
  // useful parallelism without making that host-specific result a fixed demand.
  return Math.min(parallelism, MAX_TEST_CONCURRENCY);
}

export function configuredTestConcurrency(explicit, env = process.env) {
  if (explicit !== undefined) return explicit;
  const value = env.CLAWSWEEPER_TEST_CONCURRENCY;
  return value === undefined
    ? undefined
    : parsePositiveInteger(value, "CLAWSWEEPER_TEST_CONCURRENCY");
}

export function coverageArguments(target) {
  const policy = COVERAGE_POLICIES[target];
  if (!policy) {
    throw new Error(
      `Target ${target} has no coverage policy; use one of ${Object.keys(COVERAGE_POLICIES).join(", ")}.`,
    );
  }
  return [
    "--experimental-test-coverage",
    ...policy.include.map((glob) => `--test-coverage-include=${glob}`),
    ...policy.exclude.map((glob) => `--test-coverage-exclude=${glob}`),
    `--test-coverage-lines=${policy.lines}`,
    `--test-coverage-branches=${policy.branches}`,
    `--test-coverage-functions=${policy.functions}`,
  ];
}

export function parseArguments(argv) {
  const separatorIndex = argv.indexOf("--");
  const wrapperArguments = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  if (wrapperArguments.includes("--help") || wrapperArguments.includes("-h")) {
    return { help: true };
  }

  const [target, ...rest] = argv;
  if (!Object.hasOwn(TARGET_PATTERNS, target)) {
    throw new Error(
      `Target must be one of ${Object.keys(TARGET_PATTERNS).join(", ")}; received ${target ?? "nothing"}.`,
    );
  }

  let concurrency;
  let shard;
  let coverage;
  const selectCoverage = (selected) => {
    if (coverage !== undefined) {
      throw new Error("Choose at most one of --coverage, --coverage-out, or --coverage-from.");
    }
    coverage = selected;
  };
  const nodeArguments = [];
  let forwarding = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (forwarding) {
      if (
        argument === "--test" ||
        argument.startsWith("--test-concurrency") ||
        argument.startsWith("--test-shard")
      ) {
        throw new Error(
          "Do not forward --test, --test-concurrency, or --test-shard; the runner owns those options.",
        );
      }
      nodeArguments.push(argument);
      continue;
    }
    if (argument === "--") {
      forwarding = true;
      continue;
    }
    if (argument === "--coverage") {
      selectCoverage({ mode: "check" });
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!["--test-concurrency", "--shard", "--coverage-out", "--coverage-from"].includes(option)) {
      throw new Error(`Unknown option ${argument}. Put Node test-runner options after --.`);
    }
    let value;
    if (equalsIndex === -1) {
      value = rest[index + 1];
      index += 1;
    } else {
      value = argument.slice(equalsIndex + 1);
    }

    if (option === "--test-concurrency") {
      concurrency = parsePositiveInteger(value, "--test-concurrency");
    } else if (option === "--shard") {
      shard = parseShard(value);
    } else {
      if (!value) throw new Error(`${option} requires a directory.`);
      selectCoverage({ mode: option === "--coverage-out" ? "write" : "replay", directory: value });
    }
  }

  if (coverage && coverage.mode !== "write") {
    coverageArguments(target);
    if (shard) {
      throw new Error(
        "Coverage thresholds apply to the whole target; record shards with --coverage-out and check them with --coverage-from.",
      );
    }
  }

  return { help: false, target, concurrency, shard, coverage, nodeArguments };
}

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(total) || index > total) {
    throw new Error(
      `--shard must be <index>/<total> with 1 <= index <= total; received ${value ?? "nothing"}.`,
    );
  }
  return { index, total };
}

export function resolveTestFiles(target, cwd = process.cwd()) {
  const patterns = TARGET_PATTERNS[target];
  if (!patterns) throw new Error(`Unknown test target: ${target}.`);

  return [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd })))].sort();
}

export function selectShard(files, shard) {
  // Round-robin over the sorted list, like node --test-shard: every file lands
  // in exactly one shard, so shard test counts sum to the unsharded count.
  if (!shard) return files;
  return files.filter((_, position) => position % shard.total === shard.index - 1);
}

export function readCoverageProfile(path) {
  const text = readFileSync(path, "utf8");
  // Node's coverage report rejects the same empty or truncated profiles.
  if (text.length === 0) throw new Error(`coverage file is empty: ${path}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse coverage file ${path}: ${error.message}`, { cause: error });
  }
}

export function pruneCoverageProfiles(directory, cwd = process.cwd()) {
  // Node's report resolves coverage globs against the checkout and skips every
  // script outside it (mostly node: internals), so dropping those scripts here
  // leaves the merged report unchanged while shrinking each profile.
  const checkout = `${pathToFileURL(realpathSync(cwd)).href}/`;
  let profiles = 0;
  let scripts = 0;
  for (const name of readdirSync(directory)) {
    if (!COVERAGE_PROFILE_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const profile = readCoverageProfile(path);
    profile.result = profile.result.filter(({ url }) => url.startsWith(checkout));
    writeFileSync(path, JSON.stringify(profile));
    profiles += 1;
    scripts += profile.result.length;
  }
  if (profiles === 0) throw new Error(`No V8 coverage profiles were written to ${directory}.`);
  return { profiles, scripts };
}

export async function runNodeTests({
  target,
  concurrency = calculateTestConcurrency(),
  shard,
  coverage,
  nodeArguments = [],
  cwd = process.cwd(),
  spawnProcess = spawn,
  signalSource = process,
} = {}) {
  const files =
    coverage?.mode === "replay"
      ? [COVERAGE_REPLAY_ENTRY]
      : selectShard(resolveTestFiles(target, cwd), shard);
  const shardLabel = shard ? ` shard=${shard.index}/${shard.total}` : "";
  if (files.length === 0) {
    throw new Error(`Test target ${target}${shardLabel} did not match any files in ${cwd}.`);
  }

  const childOptions = { cwd, stdio: "inherit" };
  const runnerArguments = [];
  let profileDirectory;
  if (coverage?.mode === "write") {
    profileDirectory = resolve(cwd, coverage.directory);
    mkdirSync(profileDirectory, { recursive: true });
    if (readdirSync(profileDirectory).length > 0) {
      throw new Error(`--coverage-out directory ${profileDirectory} must be empty.`);
    }
    childOptions.env = { ...process.env, NODE_V8_COVERAGE: profileDirectory };
  } else if (coverage) {
    runnerArguments.push(...coverageArguments(target));
    if (coverage.mode === "replay") {
      childOptions.env = {
        ...process.env,
        CLAWSWEEPER_COVERAGE_REPLAY_DIR: resolve(cwd, coverage.directory),
      };
    }
  }

  console.error(
    `[run-node-tests] target=${target}${shardLabel}${coverage ? ` coverage=${coverage.mode}` : ""} concurrency=${concurrency} files=${files.length}`,
  );
  const child = spawnProcess(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...runnerArguments, ...nodeArguments, ...files],
    childOptions,
  );

  return new Promise((resolvePromise, reject) => {
    const signalHandlers = new Map(
      FORWARDED_SIGNALS.map((signal) => [signal, () => child.kill(signal)]),
    );
    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        signalSource.removeListener(signal, handler);
      }
    };
    for (const [signal, handler] of signalHandlers) signalSource.once(signal, handler);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (profileDirectory === undefined || signal) {
        resolvePromise({ code, signal });
        return;
      }
      try {
        const { profiles, scripts } = pruneCoverageProfiles(profileDirectory, cwd);
        console.error(
          `[run-node-tests] coverage-out=${profileDirectory} profiles=${profiles} checkout-scripts=${scripts}`,
        );
        resolvePromise({ code, signal });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function applyProcessOutcome(
  outcome,
  { setExitCode = (code) => (process.exitCode = code), signalProcess = process.kill } = {},
) {
  if (outcome.signal) {
    signalProcess(process.pid, outcome.signal);
    return;
  }
  setExitCode(outcome.code ?? 1);
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new Error(`${option} must be a positive integer; received ${value ?? "nothing"}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} must be a safe positive integer; received ${value}.`);
  }
  return parsed;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    applyProcessOutcome(
      await runNodeTests({
        ...options,
        concurrency: configuredTestConcurrency(options.concurrency),
      }),
    );
  } catch (error) {
    console.error(`run-node-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
