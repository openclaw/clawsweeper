import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.resolve(process.argv[2] ?? "dist");
const before = process.argv[3] === "before";
const commandOverride = process.argv[4];
const api = await import(pathToFileURL(path.join(dist, "repair/target-validation.js")));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "validation-restoration-proof-"));
const roots = [
  "packages/plugin-sdk/dist",
  ".artifacts/extension-package-boundary",
  ".artifacts/tsgo-cache",
];
const owners = [".artifacts/dist-artifacts.lock", ".artifacts/vitest-workers"];
const packageManager = JSON.parse(fs.readFileSync("package.json", "utf8")).packageManager;
const gate = `
import fs from "node:fs";
import path from "node:path";
for (const directory of ${JSON.stringify([...roots, ...owners])}) fs.mkdirSync(directory, {recursive:true});
fs.writeFileSync("packages/plugin-sdk/dist/index.d.ts", "export declare const fixture: true;\\n");
fs.writeFileSync(".artifacts/extension-package-boundary/plugin-sdk.json", JSON.stringify({fixture:true,output:"packages/plugin-sdk/dist/index.d.ts"}));
fs.writeFileSync(".artifacts/tsgo-cache/generated", "compiler cache");
fs.writeFileSync(path.join(process.env.HOME,"profile-evidence"),"command ran");
console.log("boundary fixture completed");
`;
const git = (cwd, ...args) =>
  childProcess
    .execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .trim();
const retained = new Set();
let cleanupAllowed = true;
try {
  for (const scenario of before
    ? commandOverride
      ? ["existing"]
      : ["empty", "lost-receipt"]
    : ["empty", "absent", "existing", "lost-receipt"]) {
    const cwd = path.join(root, scenario);
    fs.mkdirSync(path.join(cwd, "packages/plugin-sdk"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "packages/plugin-sdk/package.json"),
      JSON.stringify({ name: "proof-sdk", private: true }),
    );
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "validation-proof",
        private: true,
        type: "module",
        packageManager,
        scripts: { "check:changed": "node gate.mjs" },
      }),
    );
    fs.writeFileSync(
      path.join(cwd, ".gitignore"),
      ".artifacts/\nnode_modules/\npackages/plugin-sdk/dist/\n",
    );
    fs.writeFileSync(path.join(cwd, "gate.mjs"), gate);
    childProcess.execFileSync(
      "corepack",
      ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
      {
        cwd,
        stdio: "pipe",
        env: { ...process.env, CI: "true" },
      },
    );
    git(cwd, "init", "-b", "main");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=Proof Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    if (scenario !== "absent") fs.mkdirSync(path.join(cwd, ".artifacts"));
    if (["existing", "lost-receipt"].includes(scenario)) {
      for (const directory of roots) {
        fs.mkdirSync(path.join(cwd, directory), { recursive: true });
        fs.writeFileSync(path.join(cwd, directory, "previous"), "previous state");
      }
    }
    const options = {
      targetRepo: "openclaw/openclaw",
      installTargetDeps: true,
      allowExpensiveValidation: false,
      strictTargetValidation: true,
      skipOpenClawChangedGate: true,
      pinnedBaseRef: "origin/main",
      toolchain: {
        packageManager: "pnpm",
        baseValidationCommands: [],
        changedGate: { command: "pnpm check:changed", requiredScript: "check:changed" },
      },
    };
    // The dependency-free fixture uses no dlx helper; prepare the real pinned pnpm runtime.
    cleanupAllowed = false;
    api.prepareTargetToolchain(
      cwd,
      {
        ...options,
        toolchain: { ...options.toolchain, changedGate: null },
      },
      [],
    );
    cleanupAllowed = true;
    const validationCommand =
      commandOverride ??
      (["empty", "lost-receipt"].includes(scenario)
        ? "pnpm check:changed"
        : "pnpm check:changed -- gate.mjs");
    let receipt;
    let profile;
    let callsAfterReceipt = 0;
    const originalSpawn = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, spawnOptions) => {
      if (receipt) callsAfterReceipt++;
      const result = originalSpawn(command, args, spawnOptions);
      if (args?.some((arg) => String(arg).endsWith("contained-command-worker.js"))) {
        cleanupAllowed = false;
        profile = path.dirname(spawnOptions.env.HOME);
        retained.add(profile);
        if (!result.error && result.status === 0) {
          try {
            receipt = JSON.parse(result.stdout);
            cleanupAllowed =
              receipt?.status === 0 &&
              receipt.backgroundProcesses === 0 &&
              Boolean(receipt.capabilitySummary);
          } catch {
            // Preserve the real transport failure for the production caller.
          }
        }
        if (cleanupAllowed && scenario === "lost-receipt")
          return { ...result, stdout: "truncated receipt" };
      }
      return result;
    };
    syncBuiltinESMExports();
    let error;
    let commands;
    try {
      commands = api.runAllowedValidationCommands([validationCommand], cwd, options);
    } catch (caught) {
      error = caught;
    } finally {
      childProcess.spawnSync = originalSpawn;
      syncBuiltinESMExports();
    }
    assert.ok(cleanupAllowed, error?.message ?? "native containment completion was not verified");
    const boundaryExists = fs.existsSync(path.join(cwd, roots[1], "plugin-sdk.json"));
    if (scenario === "lost-receipt") {
      if (before) {
        assert.ok(error);
        assert.equal(fs.existsSync(profile), false);
        assert.equal(boundaryExists, true);
      } else {
        assert.equal(error?.name, "ValidationRecoveryRequiredError");
        for (const saved of error.recoveryPaths) retained.add(saved);
        assert.equal(callsAfterReceipt, 0);
        assert.ok(boundaryExists && fs.existsSync(profile));
        assert.ok(
          [...error.recoveryPaths].some((saved) =>
            fs.existsSync(path.join(saved, "packages/plugin-sdk/dist/previous")),
          ),
        );
        assert.throws(
          () => api.runAllowedValidationCommands(["pnpm check:changed"], cwd, options),
          (next) => next === error,
        );
        assert.throws(
          () =>
            api.reproduceValidationFailureAtPinnedBase({
              commands: ["pnpm check:changed"],
              targetDir: cwd,
              options,
            }),
          (next) => next === error,
        );
      }
    } else if (before) {
      assert.match(error?.message ?? "", /mutated checkout identity/);
      assert.equal(boundaryExists, true);
    } else {
      assert.ifError(error);
      assert.deepEqual(commands, [validationCommand]);
      assert.equal(boundaryExists, false);
      for (const directory of owners) assert.equal(fs.existsSync(path.join(cwd, directory)), false);
      for (const directory of roots) {
        if (scenario === "existing")
          assert.deepEqual(fs.readdirSync(path.join(cwd, directory)), ["previous"]);
        else assert.equal(fs.existsSync(path.join(cwd, directory)), false);
      }
      assert.equal(fs.existsSync(path.join(cwd, ".artifacts")), scenario !== "absent");
    }
    console.log(
      JSON.stringify({
        phase: before ? "before" : "after",
        scenario,
        validationCommand,
        commands,
        boundaryExists,
        profileRetained: fs.existsSync(profile),
        callsAfterReceipt,
        containment: receipt.capabilitySummary,
        backgroundProcesses: receipt.backgroundProcesses,
        error: error?.name,
        sourceSha256: createHash("sha256")
          .update(fs.readFileSync(path.join(dist, "repair/target-validation.js")))
          .digest("hex"),
      }),
    );
  }
} finally {
  if (cleanupAllowed) {
    // Every actual command joined before the deliberately lost receipt.
    for (const saved of retained) fs.rmSync(saved, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } else {
    console.error(
      `Proof completion unverified; preserve checkout and reported recovery paths: ${root}`,
    );
  }
}
