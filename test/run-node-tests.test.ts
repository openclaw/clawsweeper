import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyProcessOutcome,
  calculateTestConcurrency,
  parseArguments,
  resolveTestFiles,
  runNodeTests,
} from "../scripts/run-node-tests.mjs";

function createFixture(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-node-test-runner-"));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// fixture\n");
  }
  return root;
}

test("test runner caps adaptive concurrency at sixteen", () => {
  assert.equal(calculateTestConcurrency(1), 1);
  assert.equal(calculateTestConcurrency(4), 4);
  assert.equal(calculateTestConcurrency(16), 16);
  assert.equal(calculateTestConcurrency(32), 16);
});

test("test runner expands named targets with sorted de-duplicated files", () => {
  const root = createFixture([
    "test/z.test.ts",
    "test/a.test.ts",
    "test/repair/b.test.ts",
    "dist/repair/z.test.js",
    "dist/repair/fix-prompt-builder.test.js",
  ]);
  try {
    assert.deepEqual(resolveTestFiles("unit", root), ["test/a.test.ts", "test/z.test.ts"]);
    assert.deepEqual(resolveTestFiles("repair", root), [
      "dist/repair/fix-prompt-builder.test.js",
      "dist/repair/z.test.js",
      "test/repair/b.test.ts",
    ]);
    assert.deepEqual(resolveTestFiles("all", root), [
      "dist/repair/fix-prompt-builder.test.js",
      "dist/repair/z.test.js",
      "test/a.test.ts",
      "test/repair/b.test.ts",
      "test/z.test.ts",
    ]);
    assert.deepEqual(resolveTestFiles("fix-prompt-builder", root), [
      "dist/repair/fix-prompt-builder.test.js",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test runner parses CLI concurrency overrides and forwarded Node options", () => {
  assert.deepEqual(
    parseArguments([
      "all",
      "--test-concurrency=4",
      "--",
      "--experimental-test-coverage",
      "--test-coverage-lines=49",
    ]),
    {
      help: false,
      target: "all",
      concurrency: 4,
      nodeArguments: ["--experimental-test-coverage", "--test-coverage-lines=49"],
    },
  );
  assert.deepEqual(parseArguments(["unit", "--test-concurrency", "1"]), {
    help: false,
    target: "unit",
    concurrency: 1,
    nodeArguments: [],
  });
  assert.deepEqual(parseArguments(["all", "--", "--help", "-h"]), {
    help: false,
    target: "all",
    concurrency: undefined,
    nodeArguments: ["--help", "-h"],
  });
  assert.throws(() => parseArguments(["unit", "--test-concurrency", "0"]), /positive integer/);
  assert.throws(
    () => parseArguments(["unit", "--", "--test-concurrency=32"]),
    /runner owns those options/,
  );
});

test("composed no-build scripts preserve standalone build contracts", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const scripts = packageJson.scripts as Record<string, string>;

  assert.match(scripts.test, /^pnpm run build:all && pnpm run test:no-build$/);
  assert.match(scripts["test:repair"], /^pnpm run build:repair && pnpm run test:repair:no-build$/);
  assert.match(scripts["test:coverage"], /^pnpm run build:all && pnpm run test:coverage:no-build$/);
  assert.match(
    scripts["test:coverage:changed"],
    /^pnpm run build:repair && pnpm run test:coverage:changed:no-build$/,
  );

  for (const name of [
    "test:no-build",
    "test:repair:no-build",
    "test:coverage:no-build",
    "test:coverage:changed:no-build",
  ]) {
    assert.doesNotMatch(scripts[name], /\b(?:build|tsc)\b/, `${name} must not start a build`);
  }
});

test("test runner fails clearly when a target has no files", async () => {
  const root = createFixture([]);
  try {
    await assert.rejects(
      runNodeTests({ target: "unit", cwd: root }),
      /target unit did not match any files/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test runner preserves child arguments, exit codes, and terminating signals", async () => {
  const root = createFixture(["test/a.test.ts"]);
  const signalSource = new EventEmitter();
  const spawned: { command?: string; arguments?: string[]; killed?: NodeJS.Signals } = {};
  const child = new EventEmitter() as EventEmitter & { kill(signal: NodeJS.Signals): boolean };
  child.kill = (signal) => {
    spawned.killed = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  try {
    const exitPromise = runNodeTests({
      target: "unit",
      concurrency: 4,
      cwd: root,
      signalSource,
      spawnProcess(command: string, arguments_: string[]) {
        spawned.command = command;
        spawned.arguments = arguments_;
        queueMicrotask(() => child.emit("exit", 23, null));
        return child;
      },
    });
    assert.deepEqual(await exitPromise, { code: 23, signal: null });
    assert.equal(spawned.command, process.execPath);
    assert.deepEqual(spawned.arguments, ["--test", "--test-concurrency=4", "test/a.test.ts"]);

    const signalPromise = runNodeTests({
      target: "unit",
      cwd: root,
      signalSource,
      spawnProcess: () => child,
    });
    signalSource.emit("SIGTERM");
    assert.deepEqual(await signalPromise, { code: null, signal: "SIGTERM" });
    assert.equal(spawned.killed, "SIGTERM");

    let exitCode;
    let signal;
    applyProcessOutcome({ code: 23, signal: null }, { setExitCode: (value) => (exitCode = value) });
    applyProcessOutcome(
      { code: null, signal: "SIGTERM" },
      { signalProcess: (_pid, value) => (signal = value) },
    );
    assert.equal(exitCode, 23);
    assert.equal(signal, "SIGTERM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
