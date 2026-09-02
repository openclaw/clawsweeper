import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

import { resolveGitcrawlDbPath } from "../../../../dist/repair/gitcrawl-store.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const repo = "openclaw/openclaw";
const storeFile = "openclaw__openclaw.sync.db";
const importerFiles = [
  "src/repair/import-gitcrawl-clusters.ts",
  "src/repair/import-gitcrawl-low-signal-prs.ts",
];
const oldResolvers = importerFiles.map((file) => {
  const source = gitShow(file);
  const endMarker = file.endsWith("clusters.ts") ? "\nfs.mkdirSync" : "\nconst candidates";
  const extracted = extractBetween(source, "function gitcrawlStoreDbFileName(", endMarker);
  return { file, source, extracted, resolve: compileResolver(extracted) };
});
const tempRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "clawsweeper-gitcrawl-store-proof-")),
);
const adapterDir = path.join(tempRoot, "sqlite-adapter");
const adapterPath = path.join(adapterDir, "sqlite3");
const results = [];

assert.equal(
  fs.existsSync(path.join(root, "dist/repair/import-gitcrawl-clusters.js")),
  true,
  "build the repair CLIs before running this proof",
);

await mkdir(adapterDir, { recursive: true });
await writeFile(adapterPath, sqliteAdapterSource(), { mode: 0o755 });
await chmod(adapterPath, 0o755);

try {
  for (const scenario of [
    { name: "portable-store present", selected: "portable" },
    { name: "portable absent -> legacy fallback", selected: "legacy" },
    { name: "env override set", selected: "override" },
  ]) {
    results.push(await runScenario(scenario));
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const artifact = {
  base_ref: baseRef,
  base_sha: execFileSync("git", ["rev-parse", baseRef], { cwd: root, encoding: "utf8" }).trim(),
  fixtures: {
    storage: "real SQLite files created with node:sqlite DatabaseSync",
    query_boundary:
      "both built importer entry points spawn a proof-local sqlite3-compatible CLI backed by node:sqlite",
    path_observation: "the SQLite CLI trace records the database path opened by each importer",
  },
  extractions: oldResolvers.map(({ file, extracted }) => ({
    file,
    sha256: sha256(extracted),
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
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

async function runScenario(scenario) {
  const scenarioSlug = scenario.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const scenarioRoot = path.join(tempRoot, scenarioSlug);
  const runtimeRoot = path.join(scenarioRoot, "clawsweeper");
  const homeDir = path.join(scenarioRoot, "home");
  const portablePath = path.join(scenarioRoot, "gitcrawl-store", "data", storeFile);
  const legacyPath = path.join(homeDir, ".config", "gitcrawl", "gitcrawl.db");
  const overridePath = path.join(scenarioRoot, "override", "configured.db");
  const tracePath = path.join(scenarioRoot, "sqlite-path-trace.jsonl");
  await mkdir(runtimeRoot, { recursive: true });
  await cp(path.join(root, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
  await cp(path.join(root, "config"), path.join(runtimeRoot, "config"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');

  if (scenario.selected === "portable") {
    createFixtureDatabase(portablePath, "portable-store", "portable");
    createFixtureDatabase(legacyPath, "competing-legacy", "legacy");
  } else if (scenario.selected === "legacy") {
    createFixtureDatabase(legacyPath, "legacy-fallback", "legacy");
  } else {
    createFixtureDatabase(portablePath, "competing-portable", "portable");
    createFixtureDatabase(legacyPath, "competing-legacy", "legacy");
    createFixtureDatabase(overridePath, "env-override", "portable");
  }

  const resolverEnv =
    scenario.selected === "override" ? { CLAWSWEEPER_GITCRAWL_DB: overridePath } : {};
  const expectedPath =
    scenario.selected === "portable"
      ? portablePath
      : scenario.selected === "legacy"
        ? legacyPath
        : overridePath;
  const current = resolveGitcrawlDbPath(repo, undefined, {
    env: resolverEnv,
    root: runtimeRoot,
    homeDir,
  });
  const old = oldResolvers.map(({ resolve }) =>
    resolve(repo, undefined, { env: resolverEnv, root: runtimeRoot, homeDir }),
  );
  assert.equal(current, expectedPath);
  assert.deepEqual(old, [expectedPath, expectedPath]);

  const childEnv = {
    ...process.env,
    HOME: homeDir,
    NODE_NO_WARNINGS: "1",
    PATH: `${adapterDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PROOF_SQLITE_TRACE: tracePath,
  };
  if (scenario.selected === "override") {
    childEnv.CLAWSWEEPER_GITCRAWL_DB = overridePath;
  } else {
    delete childEnv.CLAWSWEEPER_GITCRAWL_DB;
  }

  const clusterOut = path.join(scenarioRoot, "cluster-out");
  const clusterRun = await runProcess(
    process.execPath,
    [
      path.join(runtimeRoot, "dist/repair/import-gitcrawl-clusters.js"),
      "1",
      "--repo",
      repo,
      "--out",
      clusterOut,
      "--skip-existing",
      "false",
    ],
    { cwd: runtimeRoot, env: childEnv },
  );
  assert.equal(clusterRun.exitCode, 0, clusterRun.stderr);
  const clusterFiles = await readdir(clusterOut);
  assert.equal(clusterFiles.length, 1);
  const clusterOutput = await readFile(path.join(clusterOut, clusterFiles[0]), "utf8");

  const lowSignalRun = await runProcess(
    process.execPath,
    [
      path.join(runtimeRoot, "dist/repair/import-gitcrawl-low-signal-prs.js"),
      "--repo",
      repo,
      "--out",
      path.join(scenarioRoot, "low-signal-out"),
      "--skip-existing",
      "false",
      "--dry-run",
      "--json",
      "--min-score",
      "1",
    ],
    { cwd: runtimeRoot, env: childEnv },
  );
  assert.equal(lowSignalRun.exitCode, 0, lowSignalRun.stderr);
  const lowSignalOutput = JSON.parse(lowSignalRun.stdout);
  const expectedMarker =
    scenario.selected === "portable"
      ? "portable-store"
      : scenario.selected === "legacy"
        ? "legacy-fallback"
        : "env-override";
  assert.match(clusterOutput, new RegExp(expectedMarker));
  assert.match(lowSignalOutput.candidates[0].title, new RegExp(expectedMarker));

  const trace = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(trace.length >= 4);
  assert(trace.every((entry) => entry.db_path === expectedPath));

  return {
    scenario: scenario.name,
    resolved_store_path: displayPath(scenarioRoot, current),
    old_resolver_paths: old.map((candidate) => displayPath(scenarioRoot, candidate)),
    identical: true,
    real_file: {
      exists: fs.existsSync(current),
      sha256: sha256(await readFile(current)),
    },
    importer_entry_points: [
      {
        cli: "dist/repair/import-gitcrawl-clusters.js",
        exit_code: clusterRun.exitCode,
        opened_store_paths: unique(
          trace.slice(0, trace.length - 1).map((entry) => displayPath(scenarioRoot, entry.db_path)),
        ),
        observed_fixture_marker: expectedMarker,
      },
      {
        cli: "dist/repair/import-gitcrawl-low-signal-prs.js",
        exit_code: lowSignalRun.exitCode,
        opened_store_paths: unique(
          trace.map((entry) => displayPath(scenarioRoot, entry.db_path)),
        ),
        observed_fixture_marker: expectedMarker,
      },
    ],
    sqlite_queries: trace.map((entry) => ({
      json: entry.json,
      db_path: displayPath(scenarioRoot, entry.db_path),
      sql_sha256: entry.sql_sha256,
    })),
  };
}

function createFixtureDatabase(file, marker, clusterKind) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      create table repositories (id integer primary key, owner text, name text);
      create table threads (
        id integer primary key,
        repo_id integer,
        number integer,
        kind text,
        state text,
        title text,
        body text,
        body_excerpt text,
        author_login text,
        author_type text,
        labels_json text,
        assignees_json text,
        raw_json text,
        is_draft integer,
        created_at_gh text,
        updated_at_gh text,
        last_pulled_at text,
        closed_at_local text,
        updated_at text
      );
      create table thread_revisions (id integer primary key, thread_id integer);
      create table thread_code_snapshots (id integer primary key, thread_revision_id integer);
      create table thread_changed_files (snapshot_id integer, path text);
      insert into repositories values (1, 'openclaw', 'openclaw');
      insert into threads values (
        1, 1, 9001, 'pull_request', 'open', 'docs: ${marker}',
        'Small documentation cleanup.', 'Small documentation cleanup.', 'proof-author', 'User',
        '[]', '[]', '{"author_association":"NONE"}', 0,
        '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z', null, '2026-08-02T00:00:00.000Z'
      );
      insert into thread_revisions values (1, 1);
      insert into thread_code_snapshots values (1, 1);
      insert into thread_changed_files values (1, 'docs/proof.md');
    `);
    if (clusterKind === "portable") {
      database.exec(`
        create table cluster_groups (
          id integer primary key,
          created_at text,
          closed_at text,
          status text,
          representative_thread_id integer
        );
        create table cluster_memberships (cluster_id integer, thread_id integer, state text);
        insert into cluster_groups values (1, '2026-08-01T00:00:00.000Z', null, 'active', 1);
        insert into cluster_memberships values (1, 1, 'active');
      `);
    } else {
      database.exec(`
        create table clusters (
          id integer primary key,
          member_count integer,
          created_at text,
          closed_at_local text,
          close_reason_local text,
          representative_thread_id integer
        );
        create table cluster_members (cluster_id integer, thread_id integer);
        insert into clusters values (1, 1, '2026-08-01T00:00:00.000Z', null, null, 1);
        insert into cluster_members values (1, 1);
      `);
    }
  } finally {
    database.close();
  }
}

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], {
    cwd: root,
    encoding: "utf8",
  });
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
  return (repoFullName, explicitDb, runtime) => {
    const context = {
      exports: {},
      fs,
      os: { homedir: () => runtime.homeDir },
      path,
      process: { env: runtime.env },
      repoRoot: () => runtime.root,
    };
    vm.runInNewContext(`${javascript}\nexports.proof = resolveGitcrawlDbPath;`, context);
    return context.exports.proof(repoFullName, explicitDb);
  };
}

function extractSqliteBuffer(source) {
  const sqliteJson = extractBetween(source, "function sqliteJson(", "\nfunction ");
  const match = sqliteJson.match(/maxBuffer:\s*([^,\n]+)/);
  assert(match?.[1], "sqliteJson maxBuffer not found");
  return match[1].trim();
}

function sqliteAdapterSource() {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const json = args[0] === "-json";
if (json) args.shift();
const [dbPath, sql] = args;
if (!dbPath || !sql) throw new Error("usage: sqlite3 [-json] <database> <sql>");
const database = new DatabaseSync(dbPath, { readOnly: true });
try {
  const statement = database.prepare(sql);
  const rows = statement.all();
  if (json) {
    process.stdout.write(JSON.stringify(rows));
  } else if (rows.length > 0) {
    process.stdout.write(String(Object.values(rows[0])[0] ?? ""));
  }
  appendFileSync(
    process.env.PROOF_SQLITE_TRACE,
    JSON.stringify({
      json,
      db_path: dbPath,
      sql_sha256: createHash("sha256").update(sql).digest("hex"),
    }) + "\\n",
  );
} finally {
  database.close();
}
`;
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

function displayPath(scenarioRoot, candidate) {
  return `$FIXTURE_ROOT/${path.relative(scenarioRoot, candidate).split(path.sep).join("/")}`;
}

function unique(values) {
  return [...new Set(values)];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
