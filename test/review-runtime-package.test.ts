import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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

test("review runtime archive loads without a compiler or install step", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-test-"));
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  const archive = join(fixture, "review-runtime.tar.gz");
  const roundtrip = join(fixture, "roundtrip");
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
    assert.equal(existsSync(join(roundtrip, "node_modules", "typescript")), false);
    assert.equal(existsSync(join(roundtrip, "node_modules", "@typescript")), false);
    const loaded = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const runtime = await import(${JSON.stringify(pathToFileURL(join(roundtrip, "dist/clawsweeper.js")).href)}); if (typeof runtime.main !== "function") throw new Error("missing CLI"); console.log("runtime loaded");`,
      ],
      {
        cwd: fixture,
        env: { ...process.env, NODE_PATH: "" },
        encoding: "utf8",
      },
    );
    assert.match(loaded, /runtime loaded/);
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

test("review runtime staging includes bounded title-related reports from open and closed state", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const artifactsRoot = join(process.cwd(), ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const output = mkdtempSync(join(artifactsRoot, "review-runtime-relations-test-"));
  const plan = join(fixture, "plan.json");
  const stateRoot = join(fixture, "state");
  const recordsRoot = join(stateRoot, "records", "openclaw-openclaw");
  const itemsRoot = join(recordsRoot, "items");
  const closedRoot = join(recordsRoot, "closed");
  const report = (number: number, title: string): string => `---
number: ${number}
repository: openclaw/openclaw
type: issue
title: ${JSON.stringify(title)}
review_status: complete
---

## Summary

Report ${number}.
`;

  try {
    mkdirSync(itemsRoot, { recursive: true });
    mkdirSync(closedRoot, { recursive: true });
    writeFileSync(
      plan,
      JSON.stringify({
        shards: [{ shard: 0, itemNumbers: [1] }],
        candidates: [
          {
            number: 1,
            repo: "openclaw/openclaw",
            title: "Provider authentication retry failure",
          },
        ],
      }),
    );
    writeFileSync(join(itemsRoot, "1.md"), report(1, "Provider authentication retry failure"));
    writeFileSync(join(itemsRoot, "2.md"), report(2, "Provider authentication timeout"));
    writeFileSync(join(itemsRoot, "3.md"), report(3, "Provider authentication refresh"));
    writeFileSync(join(itemsRoot, "4.md"), report(4, "Provider authentication fallback"));
    writeFileSync(join(itemsRoot, "5.md"), report(5, "Provider authentication session"));
    writeFileSync(join(itemsRoot, "6.md"), report(6, "Provider authentication token"));
    writeFileSync(join(itemsRoot, "7.md"), report(7, "Provider authentication credentials"));
    writeFileSync(join(itemsRoot, "8.md"), report(8, "Unrelated scheduler behavior"));
    writeFileSync(
      join(closedRoot, "9.md"),
      report(9, "Provider authentication retry failure cache"),
    );

    execFileSync(process.execPath, reviewRuntimeArgs(output, plan, stateRoot), {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const packagedRoot = join(output, "records", "openclaw-openclaw");
    assert.equal(existsSync(join(packagedRoot, "items", "1.md")), true);
    assert.equal(existsSync(join(packagedRoot, "items", "2.md")), true);
    assert.equal(existsSync(join(packagedRoot, "items", "3.md")), true);
    assert.equal(existsSync(join(packagedRoot, "items", "4.md")), true);
    assert.equal(existsSync(join(packagedRoot, "items", "5.md")), true);
    assert.equal(existsSync(join(packagedRoot, "items", "6.md")), false);
    assert.equal(existsSync(join(packagedRoot, "items", "7.md")), false);
    assert.equal(existsSync(join(packagedRoot, "items", "8.md")), false);
    assert.equal(existsSync(join(packagedRoot, "closed", "9.md")), true);
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
