#!/usr/bin/env node
// Build both explicit source archives in disposable directories; never install tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "baseline-archive",
      "baseline-id",
      "baseline-sha256",
      "candidate-archive",
      "candidate-id",
      "candidate-sha256",
      "deps-root",
      "out",
    ].map((key) => [key, { type: "string" }]),
  ),
});
for (const [key, value] of Object.entries(values)) assert(value, `Empty --${key}`);
for (const key of [
  "baseline-archive",
  "baseline-id",
  "baseline-sha256",
  "candidate-archive",
  "candidate-id",
  "candidate-sha256",
  "deps-root",
  "out",
]) {
  assert(values[key], `Required --${key}; see README.md`);
}
assert.equal(process.versions.node, "24.20.0", "Use the reviewed Node version");
assert(
  isAbsolute(values.out) && !existsSync(values.out),
  "Output must be a new absolute directory",
);
const out = values.out;
const dependencies = realpathSync(join(resolve(values["deps-root"]), "node_modules"));
const compiler = realpathSync(join(dependencies, "typescript/bin/tsc"));
const proof = dirname(fileURLToPath(import.meta.url));
mkdirSync(out, { recursive: true });
const runtime = mkdtempSync(join(tmpdir(), "clawsweeper-metadata-proof-"));
const cleanEnv = { PATH: process.env.PATH, CI: "1", COREPACK_ENABLE_NETWORK: "0" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const commands = [];
const dependencyFiles = [".modules.yaml", "typescript/package.json", "typescript/bin/tsc"];
const dependencyHashes = () =>
  Object.fromEntries(
    dependencyFiles.map((name) => [
      name,
      {
        path: realpathSync(join(dependencies, name)),
        sha256: hash(readFileSync(join(dependencies, name))),
      },
    ]),
  );
const dependenciesBefore = dependencyHashes();

function run(command, argv, cwd, log) {
  const result = spawnSync(command, argv, { cwd, env: cleanEnv, encoding: "utf8" });
  assert.ifError(result.error);
  commands.push({
    command,
    argv,
    argvSha256: hash(JSON.stringify([command, ...argv])),
    cwd,
    exit: result.status,
  });
  if (log) writeFileSync(join(out, log), result.stdout + result.stderr);
  assert.equal(result.status, 0, `${command} failed; inspect ${log ?? "command output"}`);
  return result.stdout;
}

function sourceHashes(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !["node_modules", "dist"].includes(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      assert(!entry.isSymbolicLink(), `Unexpected source link: ${entry.name}`);
      const relative = prefix + entry.name;
      return entry.isDirectory()
        ? sourceHashes(join(root, entry.name), relative + "/")
        : [{ path: relative, sha256: hash(readFileSync(join(root, entry.name))) }];
    });
}

const manifest = {
  node: process.version,
  pnpm: null,
  platform: `${process.platform}/${process.arch}`,
  dependencyHashes: dependenciesBefore,
  proofHashes: Object.fromEntries(
    ["run-proof.sh", "run-proof.mjs", "runtime-proof.mjs", "README.md"].map((name) => [
      name,
      hash(readFileSync(join(proof, name))),
    ]),
  ),
  modes: {},
  commands,
  limits:
    "Synthetic CLI/export proof only. No cloud allocation, dependency installation, Git history lookup, live GitHub, model invocation, real job creation, deployed Worker, or complete hosted workflow. Provider/image/lease are supplied by the operator after execution.",
};

try {
  // Resolve the repository pin; outside a project Corepack may select its global default.
  manifest.pnpm = run("pnpm", ["--version"], resolve(values["deps-root"])).trim();
  assert.equal(manifest.pnpm, "11.10.0");
  for (const mode of ["baseline", "candidate"]) {
    const id = values[`${mode}-id`];
    assert(
      /^(?:commit|tree):[0-9a-f]{40}$/.test(id),
      "Source ID must explicitly identify a commit or an uncommitted Git tree",
    );
    const archive = realpathSync(resolve(values[`${mode}-archive`]));
    const digest = values[`${mode}-sha256`];
    assert(/^[0-9a-f]{64}$/.test(digest), "Expected archive SHA-256 is required");
    assert.equal(hash(readFileSync(archive)), digest, `${mode} archive digest differs`);
    const names = run("tar", ["-tf", archive], runtime).trim().split("\n");
    for (const name of names) {
      assert(
        !isAbsolute(name) && !name.split("/").includes(".."),
        `Unsafe archive member: ${name}`,
      );
      assert(
        /^(?:src\/|config\/|schema\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(?:\.repair)?\.json$)/.test(
          name,
        ),
        `Outside the reviewed build closure: ${name}`,
      );
    }
    for (const entry of run("tar", ["-tvf", archive], runtime).trim().split("\n")) {
      assert(["-", "d"].includes(entry[0]), "Archive links and special files are prohibited");
    }
    const source = join(runtime, mode);
    mkdirSync(source);
    run("tar", ["-xf", archive, "-C", source], runtime);
    symlinkSync(dependencies, join(source, "node_modules"), "dir");
    const before = sourceHashes(source);
    const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    assert.equal(packageJson.packageManager, "pnpm@11.10.0");
    assert.equal(packageJson.scripts["build:node"], "pnpm run build && pnpm run build:repair");
    assert.equal(packageJson.scripts.build, "tsc -p tsconfig.json");
    assert.equal(packageJson.scripts["build:repair"], "tsc -p tsconfig.repair.json");
    assert.equal(run("pnpm", ["--version"], source).trim(), manifest.pnpm);
    assert.equal(
      hash(readFileSync(join(source, "pnpm-lock.yaml"))),
      hash(readFileSync(join(resolve(values["deps-root"]), "pnpm-lock.yaml"))),
      "Dependencies must match the source lockfile",
    );
    assert(!existsSync(join(source, "dist")), "Fresh build directory required");
    // These are the exact compiler commands behind build:node. Running pnpm scripts
    // in a copied source tree can auto-install and relink shared node_modules.
    run(process.execPath, [compiler, "-p", "tsconfig.json"], source, `${mode}-build-primary.log`);
    run(
      process.execPath,
      [compiler, "-p", "tsconfig.repair.json"],
      source,
      `${mode}-build-repair.log`,
    );
    const output = run(
      process.execPath,
      [
        join(proof, "runtime-proof.mjs"),
        "--root",
        source,
        "--out",
        out,
        "--expect",
        mode,
        "--baseline-id",
        values["baseline-id"],
        "--candidate-id",
        values["candidate-id"],
        "--archive-sha256",
        digest,
      ],
      source,
      `${mode}-runtime.log`,
    );
    const result = JSON.parse(output);
    assert.equal(result.scenarios, 13);
    assert.equal(result.assertions, mode === "baseline" ? 138 : 152);
    assert.equal(result.tripwireSelfChecks, 2);
    assert.equal(result.applicationInvocations, 22);
    assert.deepEqual(sourceHashes(source), before, `${mode} source changed during execution`);
    assert.deepEqual(
      dependencyHashes(),
      dependenciesBefore,
      "Shared dependency links or files changed",
    );
    manifest.modes[mode] = { sourceId: id, archiveSha256: digest, sources: before, result };
  }
  console.log(
    JSON.stringify(
      {
        baseline: manifest.modes.baseline.result,
        candidate: manifest.modes.candidate.result,
        manifest: join(out, "manifest.json"),
      },
      null,
      2,
    ),
  );
} finally {
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  rmSync(runtime, { recursive: true, force: true });
}
