#!/usr/bin/env node
import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const recipe = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(recipe), "../../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (cwd, executable, args) =>
  execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

if (!process.env.VALIDATION_IDENTITY_PROOF_OUTPUT) {
  assert.ok(process.argv[2], "usage: node run-proof.mjs <new-output-directory>");
  const out = path.resolve(process.argv[2]);
  fs.mkdirSync(out); // A new directory preserves prior observations.
  for (const name of ["home", "tmp"]) fs.mkdirSync(path.join(out, name));
  const paths = [
    "src/repair/target-validation.ts",
    "test/repair/target-validation.test.ts",
    "dist/repair/target-validation.js",
    "dist/repair/command-runner.js",
    "dist/repair/contained-command-worker.js",
    "docs/proof/validation-identity-reuse/run-proof.mjs",
  ];
  fs.writeFileSync(
    path.join(out, "source.json"),
    JSON.stringify(
      {
        head: command(root, "git", ["rev-parse", "HEAD"]),
        productionDiffSha256: hash(
          execFileSync(
            "git",
            ["diff", "--binary", "HEAD", "--", "src/repair/target-validation.ts"],
            {
              cwd: root,
            },
          ),
        ),
        sha256: Object.fromEntries(
          paths.map((name) => [name, hash(fs.readFileSync(path.join(root, name)))]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  const child = spawnSync(process.execPath, ["--test", recipe], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(out, "home"),
      TMPDIR: path.join(out, "tmp"),
      LANG: "C",
      CI: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      VALIDATION_IDENTITY_PROOF_OUTPUT: out,
    },
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 1024 * 1024,
  });
  fs.writeFileSync(path.join(out, "driver.log"), child.stdout + child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  process.stdout.write(fs.readFileSync(path.join(out, "observations.json"), "utf8"));
} else {
  const { default: test } = await import("node:test");
  test("real pnpm setup binds installed runtime before allowed validation and tamper rejection", (t) => {
    assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
    const out = process.env.VALIDATION_IDENTITY_PROOF_OUTPUT;
    const phase = (name) =>
      fs.appendFileSync(
        path.join(out, "progress.jsonl"),
        JSON.stringify({ phase: name, at: new Date().toISOString() }) + "\n",
      );
    phase("fixture-start");
    const cwd = path.join(out, "package");
    fs.mkdirSync(path.join(cwd, "packages", "dependency"), { recursive: true });
    const write = (name, content) => fs.writeFileSync(path.join(cwd, name), content);
    write(".gitignore", "node_modules/\n");
    write(
      "package.json",
      JSON.stringify(
        {
          name: "validation-identity-proof",
          private: true,
          version: "1.0.0",
          packageManager: "pnpm@11.10.0",
          scripts: { verify: "node verify.cjs" },
          dependencies: { "fixture-dependency": "file:packages/dependency" },
        },
        null,
        2,
      ) + "\n",
    );
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(
      "packages/dependency/package.json",
      JSON.stringify({
        name: "fixture-dependency",
        version: "1.0.0",
        main: "index.js",
      }) + "\n",
    );
    write("packages/dependency/index.js", 'module.exports = "installed";\n');
    const stdoutMarker = "CLAWSWEEPER_IDENTITY_PROOF_DEPENDENCY_VERIFIED";
    write(
      "verify.cjs",
      [
        'const assert = require("node:assert/strict");',
        'assert.equal(require("fixture-dependency"), "installed");',
        `console.log(${JSON.stringify(stdoutMarker)});`,
      ].join("\n") + "\n",
    );
    const git = (...args) => command(cwd, "git", args);
    git("init", "-b", "main");
    git("config", "user.name", "ClawSweeper Proof");
    git("config", "user.email", "proof@example.invalid");
    phase("fixture-git-ready");
    const corepack = command(cwd, "corepack", ["--version"]);
    const pnpm = command(cwd, "corepack", ["pnpm", "--version"]);
    assert.equal(pnpm, "11.10.0");
    const pnpmEntrypoint = path.join(
      process.env.HOME,
      ".cache/node/corepack/v1/pnpm/11.10.0/bin/pnpm.mjs",
    );
    assert.ok(fs.statSync(pnpmEntrypoint).isFile(), "fresh Corepack cache needs pnpm.mjs");
    const pnpmEntrypointSha256 = hash(fs.readFileSync(pnpmEntrypoint));
    phase("toolchain-verified");
    // Generate only metadata with the actual package manager. Setup owns installation.
    command(cwd, "corepack", [
      "pnpm",
      "install",
      "--lockfile-only",
      "--offline",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
    assert.equal(fs.existsSync(path.join(cwd, "node_modules")), false);
    git("add", ".");
    git("commit", "-m", "fixture: local dependency validation");
    const fixtureHead = git("rev-parse", "HEAD");
    const fixtureFiles = git("ls-files").split("\n");
    const fixtureHashes = Object.fromEntries(
      fixtureFiles.map((name) => [name, hash(fs.readFileSync(path.join(cwd, name)))]),
    );
    const origin = path.join(out, "origin.git");
    command(out, "git", ["init", "--bare", "--initial-branch=main", origin]);
    git("remote", "add", "origin", origin);
    git("push", "-u", "origin", "main:main"); // Task-owned local origin only.

    return import(pathToFileURL(path.join(root, "dist/repair/target-validation.js")).href).then(
      ({ prepareTargetToolchain, runAllowedValidationCommands }) => {
        const options = {
          targetRepo: "example/validation-identity-proof",
          allowExpensiveValidation: false,
          installTargetDeps: true,
          strictTargetValidation: true,
          pinnedBaseRemoteUrl: origin,
          toolchain: { packageManager: "pnpm", baseValidationCommands: [], changedGate: null },
        };
        phase("setup-start");
        const started = Date.now();
        prepareTargetToolchain(cwd, options);
        const setupWallMs = Date.now() - started;
        phase("setup-complete");
        assert.equal(git("status", "--porcelain"), "");
        const installed = path.join(cwd, "node_modules", "fixture-dependency", "index.js");
        assert.equal(fs.readFileSync(installed, "utf8"), 'module.exports = "installed";\n');
        const installedSha256 = hash(fs.readFileSync(installed));
        const supervisor = path.join(root, "dist/repair/contained-command-worker.js");
        const receipts = [];
        const diagnostics = [];
        const boundaries = [];
        let dispatches = 0;
        const realSpawnSync = childProcess.spawnSync;
        const observer = t.mock.method(childProcess, "spawnSync", function (...invocation) {
          // Forward identical arguments and return the original result, including failures.
          const result = Reflect.apply(realSpawnSync, this, invocation);
          const [executable, args, spawnOptions] = invocation;
          if (
            executable !== process.execPath ||
            args?.length !== 1 ||
            args[0] !== supervisor ||
            spawnOptions?.cwd !== cwd
          )
            return result;
          try {
            const input = JSON.parse(spawnOptions.input);
            if (!Array.isArray(input.args)) throw new Error("invalid supervisor arguments");
            if (input.cwd !== cwd || !input.args.includes("verify")) return result;
            dispatches += 1;
            const receipt = JSON.parse(result.stdout);
            if (
              typeof receipt.stdout !== "string" ||
              !(receipt.status === null || Number.isInteger(receipt.status)) ||
              !Number.isInteger(receipt.backgroundProcesses)
            )
              throw new Error("invalid supervisor result");
            receipts.push({
              supervisorStatus: result.status,
              supervisorSignal: result.signal,
              supervisorError: Boolean(result.error),
              status: receipt.status,
              signal: receipt.signal,
              error: Boolean(receipt.error),
              backgroundProcesses: receipt.backgroundProcesses,
              stdoutMarker: receipt.stdout.split(/\r?\n/).includes(stdoutMarker),
              stdoutSha256: hash(receipt.stdout),
            });
          } catch {
            // Observation errors must never change the production call's outcome.
            diagnostics.push("malformed fixture supervisor observation");
          }
          return result;
        });
        const observeBoundary = (name, expectedDispatches) => {
          assert.deepEqual(diagnostics, []);
          assert.equal(dispatches, expectedDispatches);
          assert.equal(receipts.length, expectedDispatches);
          for (const receipt of receipts) {
            assert.equal(receipt.supervisorStatus, 0);
            assert.equal(receipt.supervisorSignal, null);
            assert.equal(receipt.supervisorError, false);
            assert.equal(receipt.status, 0);
            assert.equal(receipt.signal, null);
            assert.equal(receipt.error, false);
            assert.equal(receipt.backgroundProcesses, 0);
            assert.equal(receipt.stdoutMarker, true);
          }
          boundaries.push({ name, dispatches, stdoutMarkers: receipts.length });
        };
        let runtimeRejection;
        let sourceRejection;
        let allowed;
        try {
          syncBuiltinESMExports();
          phase("allowed-start");
          allowed = runAllowedValidationCommands(["pnpm verify"], cwd, options);
          assert.deepEqual(allowed, ["pnpm verify"]);
          observeBoundary("allowed", 1);
          phase("allowed-complete");
          const metadata = path.join(cwd, "node_modules", ".modules.yaml");
          const originalMetadata = fs.readFileSync(metadata);
          fs.appendFileSync(metadata, "\n# controlled runtime tamper\n");
          assert.equal(git("status", "--porcelain"), "");
          assert.throws(
            () => runAllowedValidationCommands(["pnpm verify"], cwd, options),
            (error) => {
              runtimeRejection = error.message;
              return (
                error.message ===
                "prepared target pnpm toolchain is stale; refresh dependencies before validation: runtimeInputsSha256"
              );
            },
          );
          observeBoundary("runtime-tamper-rejected", 1);
          phase("runtime-tamper-rejected");
          fs.writeFileSync(metadata, originalMetadata);
          assert.deepEqual(runAllowedValidationCommands(["pnpm verify"], cwd, options), [
            "pnpm verify",
          ]);
          observeBoundary("restored-runtime-allowed", 2);
          phase("restored-runtime-allowed");
          fs.appendFileSync(
            path.join(cwd, "verify.cjs"),
            "\n// controlled tracked-source tamper\n",
          );
          assert.throws(
            () => runAllowedValidationCommands(["pnpm verify"], cwd, options),
            (error) => {
              sourceRejection = error.message;
              return error.message.startsWith(
                "prepared target pnpm toolchain is stale; refresh dependencies before validation: ",
              );
            },
          );
          observeBoundary("source-tamper-rejected", 2);
          phase("source-tamper-rejected");
        } finally {
          observer.mock.restore();
          syncBuiltinESMExports();
          fs.writeFileSync(
            path.join(out, "supervisor-receipts.json"),
            JSON.stringify({ dispatches, receipts, diagnostics, boundaries }, null, 2) + "\n",
          );
        }
        assert.equal(childProcess.spawnSync, realSpawnSync);
        assert.equal(spawnSync, realSpawnSync);
        const observations = {
          provider: "local-node-test-harness",
          image: null,
          lease: null,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          corepack,
          pnpm,
          pnpmEntrypointSha256,
          clock: "real",
          injectedToolProcesses: false,
          observer:
            "transparent spawnSync observer; identical invocation and original result, recording only real verify supervisor receipts",
          observerRestored: true,
          containment:
            "Node test-runner process fallback; Linux namespace containment not exercised",
          budgets: "unchanged production defaults; no setup/install/validation overrides",
          fixtureHead,
          fixtureHashes,
          setupWallMs,
          installedSha256,
          allowed,
          dispatches,
          receipts,
          boundaries,
          diagnostics,
          runtimeRejection,
          restoredRuntimeAllowed: true,
          sourceRejection,
        };
        fs.writeFileSync(
          path.join(out, "observations.json"),
          JSON.stringify(observations, null, 2) + "\n",
        );
      },
    );
  });
}
