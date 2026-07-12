import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { tmpPrefix } from "./helpers.ts";

const recordsPath = "records/openclaw-openclaw/items";

function reviewRuntimeArgs(output: string, plan: string, stateRoot: string): string[] {
  return [
    "scripts/prepare-review-runtime.mjs",
    "--output",
    output,
    "--plan",
    plan,
    "--state-root",
    stateRoot,
    "--records-path",
    recordsPath,
  ];
}

test("review runtime artifact carries the TypeScript compiler service", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-test-"));
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  const archive = join(fixture, "review-runtime.tar.gz");
  const roundtrip = join(fixture, "roundtrip");
  const nativePackageName = `typescript-${process.platform}-${process.arch}`;
  const nativeCompiler = join(
    roundtrip,
    "node_modules",
    "@typescript",
    nativePackageName,
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  );

  try {
    mkdirSync(stateRoot);
    writeFileSync(plan, '{"shards":[{"shard":0,"itemNumbers":[]}]}\n');
    execFileSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "pipe" });
    mkdirSync(roundtrip);
    execFileSync("tar", ["-xzf", archive, "-C", roundtrip], { stdio: "pipe" });
    assert.equal(existsSync(join(roundtrip, "node_modules", "@typescript")), false);

    const typescriptPackage = JSON.parse(
      readFileSync(join(roundtrip, "node_modules", "typescript", "package.json"), "utf8"),
    );
    assert.equal(typescriptPackage.name, "typescript");
    assert.equal(
      JSON.parse(readFileSync(join(roundtrip, "node_modules", "yaml", "package.json"), "utf8"))
        .name,
      "yaml",
    );
    const typescriptSource = realpathSync(join(process.cwd(), "node_modules", "typescript"));
    const nativeSource = realpathSync(
      join(dirname(typescriptSource), "@typescript", nativePackageName),
    );
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = JSON.parse(
      execFileSync(
        npmCommand,
        ["pack", nativeSource, "--pack-destination", fixture, "--ignore-scripts", "--json"],
        { encoding: "utf8" },
      ),
    )[0];
    assert.equal(typeof packed?.filename, "string");
    assert.equal(typeof packed?.integrity, "string");
    const packageFile = join(fixture, packed.filename);
    writeFileSync(
      join(roundtrip, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
packages:
  '@typescript/${nativePackageName}@${typescriptPackage.version}':
    resolution: {integrity: ${packed.integrity}}
`,
    );
    mkdirSync(join(roundtrip, "scripts"));
    const installerPath = join(roundtrip, "scripts", "install-review-native-compiler.mjs");
    copyFileSync("scripts/install-review-native-compiler.mjs", installerPath);

    const tamperedPackage = join(fixture, "tampered.tgz");
    copyFileSync(packageFile, tamperedPackage);
    appendFileSync(tamperedPackage, "tampered");
    const rejected = spawnSync(process.execPath, [installerPath], {
      cwd: roundtrip,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWSWEEPER_NATIVE_PACKAGE_TARBALL: tamperedPackage,
      },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /integrity mismatch/i);
    assert.equal(existsSync(nativeCompiler), false);

    const externalNamespace = join(fixture, "external-typescript-namespace");
    const externalSentinel = join(externalNamespace, "keep.txt");
    mkdirSync(externalNamespace);
    writeFileSync(externalSentinel, "keep");
    const namespaceLink = join(roundtrip, "node_modules", "@typescript");
    symlinkSync(
      externalNamespace,
      namespaceLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const symlinkedParent = spawnSync(process.execPath, [installerPath], {
      cwd: roundtrip,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWSWEEPER_NATIVE_PACKAGE_TARBALL: packageFile,
      },
    });
    assert.notEqual(symlinkedParent.status, 0);
    assert.match(symlinkedParent.stderr, /symbolic-link @typescript namespace/i);
    assert.equal(readFileSync(externalSentinel, "utf8"), "keep");
    unlinkSync(namespaceLink);

    execFileSync(process.execPath, [installerPath], {
      cwd: roundtrip,
      env: {
        ...process.env,
        CLAWSWEEPER_NATIVE_PACKAGE_TARBALL: packageFile,
      },
      stdio: "pipe",
    });

    assert.equal(
      JSON.parse(
        readFileSync(
          join(roundtrip, "node_modules", "@typescript", nativePackageName, "package.json"),
          "utf8",
        ),
      ).name,
      `@typescript/${nativePackageName}`,
    );
    assert.equal(existsSync(nativeCompiler), true);
    if (process.platform !== "win32") {
      assert.notEqual(statSync(nativeCompiler).mode & 0o111, 0);
    }
    execFileSync(nativeCompiler, ["--version"], { stdio: "pipe" });

    writeFileSync(join(roundtrip, "package.json"), '{"type":"module"}\n');
    const smokePath = join(roundtrip, "semantic-smoke.mjs");
    writeFileSync(
      smokePath,
      `
import { createReviewSemanticRecord } from "./dist/review-semantic-cache.js";

const record = createReviewSemanticRecord({
  item: { repo: "openclaw/openclaw", number: 1, kind: "pull_request" },
  context: {
    issue: { title: "Cache" },
    comments: [],
    timeline: [],
    pullRequest: { base: { ref: "main", sha: "a".repeat(40) } },
    pullFiles: [{
      filename: "src/cache.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\\n-const value = 1;\\n+const value = 2;",
      baseMode: "100644",
      baseType: "blob",
      headMode: "100644",
      headType: "blob",
      treeModesComplete: true,
    }],
    pullCommits: [],
    pullCommitsRevision: "d".repeat(64),
    pullReviewComments: [],
    pullChecks: {
      complete: true,
      checkRuns: [],
      checkRunsTruncated: false,
      statuses: [],
      statusesTruncated: false,
    },
    counts: {
      pullFiles: 1,
      pullFilesHydrated: 1,
      pullFilesTruncated: false,
      pullCommits: 0,
      pullCommitsHydrated: 0,
      pullCommitsTruncated: false,
    },
  },
  git: { mainSha: "b".repeat(40), releaseStateComplete: true, latestRelease: null },
  structuralContextRevision: "c".repeat(64),
  reviewPolicy: "policy",
  reviewModel: "model",
});

if (!record.eligible) throw new Error(record.eligibilityReason);
`,
    );
    execFileSync(process.execPath, [smokePath], {
      cwd: roundtrip,
      env: { ...process.env, NODE_PATH: "" },
      stdio: "pipe",
    });
  } finally {
    rmSync(output, { force: true, recursive: true });
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("review runtime staging rejects destructive output paths", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const sentinel = join(fixture, "keep.txt");
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  writeFileSync(sentinel, "keep");
  writeFileSync(plan, '{"shards":[{"shard":0,"itemNumbers":[]}]}\n');
  mkdirSync(stateRoot);

  try {
    for (const output of [
      fixture,
      resolve(process.cwd(), ".."),
      join(process.cwd(), ".artifacts"),
      join(process.cwd(), ".artifacts", "nested", "runtime"),
    ]) {
      const result = spawnSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, output);
    }
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("review runtime staging copies only reports selected by the review plan", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-records-test-"));
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  const recordsRoot = join(stateRoot, ...recordsPath.split("/"));

  try {
    mkdirSync(recordsRoot, { recursive: true });
    writeFileSync(
      plan,
      JSON.stringify({
        shards: [
          { shard: 0, itemNumbers: [1, 2] },
          { shard: 1, itemNumbers: [2, 3] },
        ],
      }),
    );
    writeFileSync(join(recordsRoot, "1.md"), "selected one\n");
    writeFileSync(join(recordsRoot, "2.md"), "selected two\n");
    writeFileSync(join(recordsRoot, "4.md"), "not selected\n");

    execFileSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const packagedRecords = join(output, ...recordsPath.split("/"));
    assert.equal(readFileSync(join(packagedRecords, "1.md"), "utf8"), "selected one\n");
    assert.equal(readFileSync(join(packagedRecords, "2.md"), "utf8"), "selected two\n");
    assert.equal(existsSync(join(packagedRecords, "3.md")), false);
    assert.equal(existsSync(join(packagedRecords, "4.md")), false);
  } finally {
    rmSync(output, { force: true, recursive: true });
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("review runtime staging rejects malformed plans and unsafe report paths", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-unsafe-test-"));
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  const recordsRoot = join(stateRoot, ...recordsPath.split("/"));

  try {
    mkdirSync(recordsRoot, { recursive: true });
    writeFileSync(plan, '{"shards":[{"shard":0,"itemNumbers":[0]}]}\n');
    const malformed = spawnSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /invalid review plan item number/i);

    writeFileSync(plan, '{"shards":[{"shard":0,"itemNumbers":[1]}]}\n');
    const traversalArgs = reviewRuntimeArgs(output, plan, stateRoot);
    traversalArgs[traversalArgs.indexOf(recordsPath)] = "records/../private/items";
    const traversal = spawnSync(process.execPath, traversalArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /records path must match/i);

    const external = join(fixture, "external.md");
    writeFileSync(external, "external\n");
    symlinkSync(external, join(recordsRoot, "1.md"));
    const symlinked = spawnSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /regular file/i);
  } finally {
    rmSync(output, { force: true, recursive: true });
    rmSync(fixture, { force: true, recursive: true });
  }
});
