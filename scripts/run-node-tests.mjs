#!/usr/bin/env node

/**
 * Definition: expand one named ClawSweeper test target and run it with Node's
 * built-in test runner. The script does not build sources or mutate fixtures.
 *
 * Parameters: a required target, an optional positive --test-concurrency, and
 * optional Node test-runner arguments after `--`.
 *
 * Outputs: the selected target/concurrency/file count on stderr, inherited TAP
 * output, and the child runner's exit code or terminating signal.
 *
 * Examples:
 *   node scripts/run-node-tests.mjs unit
 *   node scripts/run-node-tests.mjs all --test-concurrency 4 -- --experimental-test-coverage
 */

import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { availableParallelism } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_TEST_CONCURRENCY = 16;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];
const TARGET_PATTERNS = Object.freeze({
  unit: ["test/*.test.ts"],
  repair: ["test/repair/*.test.ts", "dist/repair/*.test.js"],
  all: ["test/*.test.ts", "test/repair/*.test.ts", "dist/repair/*.test.js"],
  "fix-prompt-builder": ["dist/repair/fix-prompt-builder.test.js"],
});

const HELP = `Usage:
  node scripts/run-node-tests.mjs <target> [--test-concurrency <count>] [-- <node-options...>]

Description:
  Expand a named ClawSweeper test target with node:fs globSync, sort the files,
  and invoke the Node test runner without building the repository.

Targets:
  unit                test/*.test.ts
  repair              test/repair/*.test.ts and dist/repair/*.test.js
  all                 all unit and repair targets
  fix-prompt-builder  dist/repair/fix-prompt-builder.test.js

Options:
  --test-concurrency <count>  Positive integer overriding the adaptive default
  -h, --help                  Show this help
  --                          Forward remaining arguments to node --test

Outputs:
  Writes the selected target, concurrency, and file count to stderr. Test output
  uses inherited stdio. The process preserves the child exit code or signal.

Examples:
  node scripts/run-node-tests.mjs unit
  node scripts/run-node-tests.mjs all --test-concurrency 4
  node scripts/run-node-tests.mjs all -- --experimental-test-coverage
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
  const nodeArguments = [];
  let forwarding = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (forwarding) {
      if (argument === "--test" || argument.startsWith("--test-concurrency")) {
        throw new Error(
          "Do not forward --test or --test-concurrency; the runner owns those options.",
        );
      }
      nodeArguments.push(argument);
      continue;
    }
    if (argument === "--") {
      forwarding = true;
      continue;
    }
    if (argument === "--test-concurrency") {
      concurrency = parsePositiveInteger(rest[index + 1], "--test-concurrency");
      index += 1;
      continue;
    }
    if (argument.startsWith("--test-concurrency=")) {
      concurrency = parsePositiveInteger(
        argument.slice(argument.indexOf("=") + 1),
        "--test-concurrency",
      );
      continue;
    }
    throw new Error(`Unknown option ${argument}. Put Node test-runner options after --.`);
  }

  return { help: false, target, concurrency, nodeArguments };
}

export function resolveTestFiles(target, cwd = process.cwd()) {
  const patterns = TARGET_PATTERNS[target];
  if (!patterns) throw new Error(`Unknown test target: ${target}.`);

  return [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd })))].sort();
}

export async function runNodeTests({
  target,
  concurrency = calculateTestConcurrency(),
  nodeArguments = [],
  cwd = process.cwd(),
  spawnProcess = spawn,
  signalSource = process,
} = {}) {
  const files = resolveTestFiles(target, cwd);
  if (files.length === 0) {
    throw new Error(`Test target ${target} did not match any files in ${cwd}.`);
  }

  console.error(
    `[run-node-tests] target=${target} concurrency=${concurrency} files=${files.length}`,
  );
  const child = spawnProcess(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...nodeArguments, ...files],
    { cwd, stdio: "inherit" },
  );

  return new Promise((resolve, reject) => {
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
      resolve({ code, signal });
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
    applyProcessOutcome(await runNodeTests(options));
  } catch (error) {
    console.error(`run-node-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
