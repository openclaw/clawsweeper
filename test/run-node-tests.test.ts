import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  applyProcessOutcome,
  calculateTestConcurrency,
  configuredTestConcurrency,
  coverageArguments,
  parseArguments,
  resolveTestFiles,
  runNodeTests,
  selectShard,
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

test("test runner environment override is validated and CLI choice takes precedence", () => {
  assert.equal(configuredTestConcurrency(undefined, {}), undefined);
  assert.equal(configuredTestConcurrency(undefined, { CLAWSWEEPER_TEST_CONCURRENCY: "8" }), 8);
  assert.equal(configuredTestConcurrency(2, { CLAWSWEEPER_TEST_CONCURRENCY: "invalid" }), 2);
  for (const value of ["", "0", "-1", "1.5", "invalid", "9007199254740992"]) {
    assert.throws(
      () => configuredTestConcurrency(undefined, { CLAWSWEEPER_TEST_CONCURRENCY: value }),
      /CLAWSWEEPER_TEST_CONCURRENCY must be/,
    );
  }
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
      shard: undefined,
      coverage: undefined,
      nodeArguments: ["--experimental-test-coverage", "--test-coverage-lines=49"],
    },
  );
  assert.deepEqual(parseArguments(["unit", "--test-concurrency", "1"]), {
    help: false,
    target: "unit",
    concurrency: 1,
    shard: undefined,
    coverage: undefined,
    nodeArguments: [],
  });
  assert.deepEqual(parseArguments(["all", "--", "--help", "-h"]), {
    help: false,
    target: "all",
    concurrency: undefined,
    shard: undefined,
    coverage: undefined,
    nodeArguments: ["--help", "-h"],
  });
  assert.throws(() => parseArguments(["unit", "--test-concurrency", "0"]), /positive integer/);
  for (const forwarded of ["--test-concurrency=32", "--test-shard=1/2"]) {
    assert.throws(() => parseArguments(["unit", "--", forwarded]), /runner owns those options/);
  }
});

test("test runner parses shard and coverage modes", () => {
  assert.deepEqual(parseArguments(["all", "--shard", "2/4", "--coverage-out", "profiles/2"]), {
    help: false,
    target: "all",
    concurrency: undefined,
    shard: { index: 2, total: 4 },
    coverage: { mode: "write", directory: "profiles/2" },
    nodeArguments: [],
  });
  assert.deepEqual(parseArguments(["all", "--coverage-from=profiles"]).coverage, {
    mode: "replay",
    directory: "profiles",
  });
  assert.deepEqual(parseArguments(["fix-prompt-builder", "--coverage"]).coverage, {
    mode: "check",
  });
  assert.deepEqual(parseArguments(["unit", "--shard=1/1"]).shard, { index: 1, total: 1 });

  for (const shard of ["0/4", "5/4", "1/0", "1", "a/b", "1/2/3"]) {
    assert.throws(() => parseArguments(["all", "--shard", shard]), /--shard must be/);
  }
  assert.throws(() => parseArguments(["all", "--shard"]), /received nothing/);
  assert.throws(() => parseArguments(["all", "--coverage-out"]), /requires a directory/);
  assert.throws(
    () => parseArguments(["all", "--coverage", "--coverage-from", "profiles"]),
    /at most one/,
  );
  assert.throws(() => parseArguments(["unit", "--coverage"]), /no coverage policy/);
  assert.throws(
    () => parseArguments(["all", "--shard", "1/4", "--coverage"]),
    /apply to the whole target/,
  );
  assert.throws(
    () => parseArguments(["all", "--shard", "1/4", "--coverage-from", "profiles"]),
    /apply to the whole target/,
  );
});

test("test runner shards partition every file exactly once", () => {
  const files = Array.from({ length: 11 }, (_, index) => `test/${index}.test.ts`);
  assert.deepEqual(selectShard(files, undefined), files);
  for (const total of [1, 2, 4, 11, 12]) {
    const shards = Array.from({ length: total }, (_, index) =>
      selectShard(files, { index: index + 1, total }),
    );
    assert.deepEqual(shards.flat().sort(), [...files].sort(), `total ${total}`);
    assert.ok(
      shards.every((shard) => shard.length <= Math.ceil(files.length / total)),
      `total ${total} stays balanced by count`,
    );
  }
  assert.deepEqual(selectShard(files, { index: 2, total: 4 }), [
    "test/1.test.ts",
    "test/5.test.ts",
    "test/9.test.ts",
  ]);
});

test("coverage policies keep the established thresholds", () => {
  assert.deepEqual(coverageArguments("all"), [
    "--experimental-test-coverage",
    "--test-coverage-include=dist/**/*.js",
    "--test-coverage-exclude=dist/repair/*.test.js",
    "--test-coverage-lines=49",
    "--test-coverage-branches=66",
    "--test-coverage-functions=57",
  ]);
  assert.deepEqual(coverageArguments("fix-prompt-builder"), [
    "--experimental-test-coverage",
    "--test-coverage-include=dist/repair/fix-prompt-builder.js",
    "--test-coverage-lines=85",
    "--test-coverage-branches=85",
    "--test-coverage-functions=85",
  ]);
  assert.throws(() => coverageArguments("repair"), /no coverage policy/);
});

test("composed no-build scripts preserve standalone build contracts", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const scripts = packageJson.scripts as Record<string, string>;

  assert.match(scripts.test, /^pnpm run build:all && pnpm run test:no-build$/);
  assert.match(scripts["test:repair"], /^pnpm run build:node && pnpm run test:repair:no-build$/);
  assert.match(scripts["test:coverage"], /^pnpm run build:all && pnpm run test:coverage:no-build$/);
  assert.match(
    scripts["test:coverage:changed"],
    /^pnpm run build:repair && pnpm run test:coverage:changed:no-build$/,
  );
  assert.equal(scripts["test:coverage:no-build"], "node scripts/run-node-tests.mjs all --coverage");
  assert.equal(
    scripts["test:coverage:changed:no-build"],
    "node scripts/run-node-tests.mjs fix-prompt-builder --coverage",
  );
  assert.equal(scripts.check, "pnpm run check:parallel");
  assert.equal(
    scripts["check:fast"],
    "pnpm run check:static && pnpm run build:all && pnpm run lint && pnpm run test:coverage:changed:no-build",
  );
  assert.equal(scripts["check:parallel"], "pnpm run check:fast && pnpm run test:coverage:no-build");

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

async function runQuietly(options: Record<string, unknown>) {
  let output = "";
  const closed = Promise.withResolvers<void>();
  const outcome = await runNodeTests({
    concurrency: 2,
    nodeArguments: ["--test-reporter=spec"],
    ...options,
    spawnProcess(command: string, arguments_: string[], spawnOptions: SpawnOptions) {
      const env = { ...(spawnOptions.env ?? process.env) };
      // Run the nested runner as a top-level `node --test`, and keep its
      // profiles out of an outer coverage run while preserving the shard's own
      // --coverage-out directory.
      delete env.NODE_TEST_CONTEXT;
      if (env.NODE_V8_COVERAGE === process.env.NODE_V8_COVERAGE) delete env.NODE_V8_COVERAGE;
      const child = spawn(command, arguments_, { ...spawnOptions, env, stdio: "pipe" });
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.once("close", () => closed.resolve());
      return child;
    },
  }).catch((error: unknown) => {
    closed.resolve();
    throw error;
  });
  await closed.promise;
  return { ...outcome, output };
}

test("sharded raw coverage replays into the whole-target thresholds", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-coverage-shards-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "clawsweeper-coverage-elsewhere-"));
  try {
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "test"));
    writeFileSync(
      join(root, "dist/library.js"),
      [
        "export function first(value) {",
        "  const doubled = value * 2;",
        "  return doubled + 1;",
        "}",
        "export function second(value) {",
        "  const tripled = value * 3;",
        "  return tripled - 1;",
        "}",
        "",
      ].join("\n"),
    );
    for (const [file, name] of [
      ["a", "first"],
      ["b", "second"],
    ]) {
      writeFileSync(
        join(root, `test/${file}.test.ts`),
        [
          'import assert from "node:assert/strict";',
          'import test from "node:test";',
          `import { ${name} } from "../dist/library.js";`,
          `test("${name}", () => assert.equal(${name}(2), 5));`,
          "",
        ].join("\n"),
      );
    }

    const checkout = `${pathToFileURL(realpathSync(root)).href}/`;
    for (const index of [1, 2]) {
      const shard = await runQuietly({
        target: "all",
        cwd: root,
        shard: { index, total: 2 },
        coverage: { mode: "write", directory: `profiles/${index}` },
      });
      assert.deepEqual([shard.code, shard.signal], [0, null], shard.output);
      assert.match(shard.output, /ℹ tests 1\n/);
      const profiles = readdirSync(join(root, "profiles", String(index)));
      assert.ok(profiles.length > 0);
      for (const name of profiles) {
        const { result } = JSON.parse(
          readFileSync(join(root, "profiles", String(index), name), "utf8"),
        ) as { result: Array<{ url: string }> };
        assert.ok(
          result.every(({ url }) => url.startsWith(checkout)),
          name,
        );
      }
    }
    await assert.rejects(
      runQuietly({
        target: "all",
        cwd: root,
        coverage: { mode: "write", directory: "profiles/1" },
      }),
      /must be empty/,
    );

    const merged = await runQuietly({
      target: "all",
      cwd: root,
      coverage: { mode: "replay", directory: "profiles" },
    });
    assert.equal(merged.code, 0, merged.output);
    assert.match(merged.output, /library\.js +\| +100\.00 \| +100\.00 \| +100\.00 \|/);

    const oneShard = await runQuietly({
      target: "all",
      cwd: root,
      coverage: { mode: "replay", directory: "profiles/1" },
    });
    assert.equal(oneShard.code, 1, oneShard.output);
    assert.match(oneShard.output, /50\.00% function coverage does not meet threshold of 57%/);

    const foreign = await runQuietly({
      target: "all",
      cwd: elsewhere,
      coverage: { mode: "replay", directory: join(root, "profiles") },
    });
    assert.equal(foreign.code, 1, foreign.output);
    assert.match(foreign.output, /cover no script in/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
