import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { tmpPrefix } from "./helpers.ts";

test("review runtime artifact carries the TypeScript compiler service", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-test-"));
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
    execFileSync(process.execPath, ["scripts/prepare-review-runtime.mjs", "--output", output], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "pipe" });
    mkdirSync(roundtrip);
    execFileSync("tar", ["-xzf", archive, "-C", roundtrip], { stdio: "pipe" });
    assert.equal(existsSync(join(roundtrip, "node_modules", "@typescript")), false);

    const typescriptSource = realpathSync(join(process.cwd(), "node_modules", "typescript"));
    const nativeSource = realpathSync(
      join(dirname(typescriptSource), "@typescript", nativePackageName),
    );
    const nativeDirectory = join(roundtrip, "node_modules", "@typescript", nativePackageName);
    mkdirSync(nativeDirectory, { recursive: true });
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const packageFile = execFileSync(
      npmCommand,
      ["pack", nativeSource, "--pack-destination", fixture, "--silent"],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/)
      .at(-1);
    assert.ok(packageFile);
    execFileSync(
      "tar",
      ["-xzf", join(fixture, packageFile), "-C", nativeDirectory, "--strip-components=1"],
      { stdio: "pipe" },
    );

    assert.equal(
      JSON.parse(
        readFileSync(join(roundtrip, "node_modules", "typescript", "package.json"), "utf8"),
      ).name,
      "typescript",
    );
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
    }],
    pullCommits: [],
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
      pullCommitsTruncated: false,
    },
  },
  git: { mainSha: "b".repeat(40), latestRelease: null },
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
  writeFileSync(sentinel, "keep");

  try {
    for (const output of [
      fixture,
      resolve(process.cwd(), ".."),
      join(process.cwd(), ".artifacts"),
      join(process.cwd(), ".artifacts", "nested", "runtime"),
    ]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/prepare-review-runtime.mjs", "--output", output],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, output);
    }
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
