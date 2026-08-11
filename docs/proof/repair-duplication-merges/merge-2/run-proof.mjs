import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { resolveGitcrawlDbPath } from "../../../../dist/repair/gitcrawl-store.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const files = [
  "src/repair/import-gitcrawl-clusters.ts",
  "src/repair/import-gitcrawl-low-signal-prs.ts",
];
const oldResolvers = files.map((file) => {
  const source = gitShow(file);
  const endMarker = file.endsWith("clusters.ts") ? "\nfs.mkdirSync" : "\nconst candidates";
  const extracted = extractBetween(source, "function gitcrawlStoreDbFileName(", endMarker);
  return { file, source, extracted, resolve: compileResolver(extracted) };
});

const proofRoot = path.resolve("/proof/clawsweeper");
const proofHome = path.resolve("/proof/home");
const storeFile = "openclaw__openclaw.sync.db";
const siblingStore = path.join(proofRoot, "..", "gitcrawl-store", "data", storeFile);
const userStore = path.join(
  proofHome,
  ".config",
  "gitcrawl",
  "stores",
  "gitcrawl-store",
  "data",
  storeFile,
);
const cases = [
  {
    name: "explicit override wins",
    repo: " OpenClaw/OpenClaw ",
    explicitDb: " ./explicit.db ",
    env: { CLAWSWEEPER_GITCRAWL_DB: "/ignored.db" },
    existing: [],
  },
  {
    name: "environment override",
    repo: "OpenClaw/OpenClaw",
    env: { CLAWSWEEPER_GITCRAWL_DB: " ./configured.db " },
    existing: [],
  },
  {
    name: "sibling portable store precedes user store",
    repo: "OpenClaw/OpenClaw",
    env: {},
    existing: [siblingStore, userStore],
  },
  {
    name: "user portable store precedes legacy store",
    repo: "OpenClaw/OpenClaw",
    env: {},
    existing: [userStore, path.join(proofHome, ".config", "gitcrawl", "gitcrawl.db")],
  },
  {
    name: "missing stores fall back to legacy path",
    repo: "OpenClaw/OpenClaw",
    env: {},
    existing: [],
  },
];

const results = cases.map((scenario) => {
  const existing = new Set(scenario.existing);
  const old = oldResolvers.map(({ resolve }) =>
    resolve(scenario.repo, scenario.explicitDb, {
      env: scenario.env,
      existing,
      root: proofRoot,
      homeDir: proofHome,
    }),
  );
  const current = resolveGitcrawlDbPath(scenario.repo, scenario.explicitDb, {
    env: scenario.env,
    root: proofRoot,
    homeDir: proofHome,
    existsSync: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(old, [current, current]);
  return { scenario: scenario.name, old, current, identical: true };
});

const artifact = {
  base_ref: baseRef,
  base_sha: execFileSync("git", ["rev-parse", baseRef], { encoding: "utf8" }).trim(),
  extractions: oldResolvers.map(({ file, extracted }) => ({
    file,
    sha256: createHash("sha256").update(extracted).digest("hex"),
  })),
  results,
  caller_local_sqlite_buffers: oldResolvers.map(({ file, source }) => ({
    file,
    max_buffer_expression: extractSqliteBuffer(source),
  })),
};

const outputPath = path.join(
  root,
  "docs/proof/repair-duplication-merges/merge-2/artifacts/equivalence.json",
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], { encoding: "utf8" });
}

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0 && endIndex > startIndex, `could not extract ${start}`);
  return source.slice(startIndex, endIndex);
}

function compileResolver(source) {
  const javascript = source
    .replaceAll("repoFullName: string", "repoFullName")
    .replaceAll("explicitDb?: string", "explicitDb")
    .replaceAll("): string", ")")
    .replaceAll("at(-1)!", "at(-1)");
  return (repo, explicitDb, runtime) => {
    const context = {
      exports: {},
      fs: { existsSync: (candidate) => runtime.existing.has(candidate) },
      os: { homedir: () => runtime.homeDir },
      path,
      process: { env: runtime.env },
      repoRoot: () => runtime.root,
    };
    vm.runInNewContext(`${javascript}\nexports.proof = resolveGitcrawlDbPath;`, context);
    return context.exports.proof(repo, explicitDb);
  };
}

function extractSqliteBuffer(source) {
  const sqliteJson = extractBetween(source, "function sqliteJson(", "\nfunction ");
  const match = sqliteJson.match(/maxBuffer:\s*([^,\n]+)/);
  assert(match?.[1], "sqliteJson maxBuffer not found");
  return match[1].trim();
}
