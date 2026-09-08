import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createRelatedContext } from "../../dist/clawsweeper-related-context.js";
import { querySqliteRows, querySqliteScalar } from "../../dist/sqlite-readonly.js";

const ROOT = process.cwd();
const CLUSTER_IMPORTER = path.join(ROOT, "dist/repair/import-gitcrawl-clusters.js");
const LOW_SIGNAL_IMPORTER = path.join(ROOT, "dist/repair/import-gitcrawl-low-signal-prs.js");

test("read-only SQLite queries preserve sqlite3 JSON integer behavior", (t) => {
  const tempDir = temporaryDirectory(t);
  const dbPath = path.join(tempDir, "integers.db");
  const database = new DatabaseSync(dbPath);
  database.exec(
    "create table values_table (value integer); insert into values_table values (9007199254740993);",
  );
  database.close();

  assert.deepEqual(querySqliteRows(dbPath, "select value, count(*) as count from values_table;"), [
    { value: 9_007_199_254_740_992, count: 1 },
  ]);
  assert.equal(querySqliteScalar(dbPath, "select value from values_table;"), "9007199254740993");
});

test("related-context reads portable gitcrawl rows committed in a WAL sidecar", (t) => {
  const tempDir = temporaryDirectory(t);
  const dbPath = path.join(tempDir, "gitcrawl.db");
  const writer = createPortableStore(dbPath);
  t.after(() => writer.close());

  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
  const relatedContext = relatedContextFor(tempDir, dbPath);
  const related = relatedContext.relatedItemsContext({
    item: { kind: "issue", number: 42, title: "Portable store target" },
    issue: {},
    comments: [],
    timeline: [],
  });

  assert.equal(
    relatedContext.structuralExternalRelationSensitivity({
      kind: "issue",
      number: 42,
      title: "Portable store target",
    }),
    true,
  );
  assert.deepEqual(related, [
    {
      mentionedIn: ["gitcrawl cluster"],
      gitcrawlCluster: {
        id: 7,
        source: "portable",
        memberCount: 2,
        representative: {
          number: 43,
          kind: "issue",
          state: "open",
          title: "Related portable issue",
        },
      },
      gitcrawlThread: {
        number: 43,
        kind: "issue",
        state: "open",
        title: "Related portable issue",
        updatedAt: "2026-08-02T00:00:00.000Z",
        labels: ["bug"],
        body: "Related body",
      },
    },
  ]);
});

test("related-context and cluster importer query the legacy gitcrawl schema", (t) => {
  const tempDir = temporaryDirectory(t);
  const dbPath = path.join(tempDir, "legacy-gitcrawl.db");
  const writer = createLegacyStore(dbPath);
  t.after(() => writer.close());

  const relatedContext = relatedContextFor(tempDir, dbPath);
  const related = relatedContext.relatedItemsContext({
    item: { kind: "issue", number: 42, title: "Legacy store target" },
    issue: {},
    comments: [],
    timeline: [],
  });
  assert.equal(related[0].gitcrawlCluster.source, "legacy");
  assert.equal(related[0].gitcrawlThread.number, 43);

  const clusterOut = path.join(tempDir, "legacy-clusters");
  const cluster = runCli(CLUSTER_IMPORTER, [
    "7",
    "--db",
    dbPath,
    "--repo",
    "openclaw/openclaw",
    "--out",
    clusterOut,
    "--skip-existing",
    "false",
  ]);
  assert.equal(cluster.status, 0, cluster.stderr);
  assert.match(
    fs.readFileSync(path.join(clusterOut, fs.readdirSync(clusterOut)[0]!), "utf8"),
    /Related portable issue/,
  );
});

test("related-context preserves empty, missing, and corrupt database fallbacks", (t) => {
  const tempDir = temporaryDirectory(t);
  const validPath = path.join(tempDir, "valid.db");
  const writer = createPortableStore(validPath);
  t.after(() => writer.close());

  const emptyContext = relatedContextFor(tempDir, validPath);
  assert.deepEqual(
    emptyContext.relatedItemsContext({
      item: { kind: "issue", number: 999, title: "No cluster" },
      issue: {},
      comments: [],
      timeline: [],
    }),
    [],
  );
  assert.equal(
    emptyContext.structuralExternalRelationSensitivity({
      kind: "issue",
      number: 999,
      title: "No cluster",
    }),
    false,
  );

  const missingPath = path.join(tempDir, "missing.db");
  const missingContext = relatedContextFor(tempDir, missingPath);
  assert.deepEqual(
    missingContext.relatedItemsContext({
      item: { kind: "issue", number: 42, title: "Missing store" },
      issue: {},
      comments: [],
      timeline: [],
    }),
    [],
  );
  assert.equal(
    missingContext.structuralExternalRelationSensitivity({
      kind: "issue",
      number: 42,
      title: "Missing store",
    }),
    false,
  );
  assert.equal(fs.existsSync(missingPath), false);

  const corruptPath = path.join(tempDir, "corrupt.db");
  fs.writeFileSync(corruptPath, "not a sqlite database\n");
  const corruptContext = relatedContextFor(tempDir, corruptPath);
  assert.deepEqual(
    corruptContext.relatedItemsContext({
      item: { kind: "issue", number: 42, title: "Corrupt store" },
      issue: {},
      comments: [],
      timeline: [],
    }),
    [],
  );
  assert.equal(
    corruptContext.structuralExternalRelationSensitivity({
      kind: "issue",
      number: 42,
      title: "Corrupt store",
    }),
    null,
  );
});

test("gitcrawl importer CLIs query real WAL-backed fixtures without sqlite3", (t) => {
  const tempDir = temporaryDirectory(t);
  const dbPath = path.join(tempDir, "gitcrawl.db");
  const writer = createPortableStore(dbPath);
  t.after(() => writer.close());
  assert.equal(fs.existsSync(`${dbPath}-wal`), true);

  const clusterOut = path.join(tempDir, "clusters");
  const cluster = runCli(
    CLUSTER_IMPORTER,
    [
      "7",
      "--db",
      dbPath,
      "--repo",
      "openclaw/openclaw",
      "--out",
      clusterOut,
      "--skip-existing",
      "false",
    ],
    { PATH: "" },
  );
  assert.equal(cluster.status, 0, cluster.stderr);
  const clusterFiles = fs.readdirSync(clusterOut);
  assert.equal(clusterFiles.length, 1);
  assert.match(
    fs.readFileSync(path.join(clusterOut, clusterFiles[0]!), "utf8"),
    /Related portable issue/,
  );

  const lowSignal = runCli(
    LOW_SIGNAL_IMPORTER,
    [
      "--db",
      dbPath,
      "--repo",
      "openclaw/openclaw",
      "--out",
      path.join(tempDir, "low-signal"),
      "--skip-existing",
      "false",
      "--dry-run",
      "--json",
      "--min-score",
      "1",
    ],
    { PATH: "" },
  );
  assert.equal(lowSignal.status, 0, lowSignal.stderr);
  const parsed = JSON.parse(lowSignal.stdout);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].ref, "#9007199254740992");
  assert.deepEqual(parsed.candidates[0].files, ["docs/fixture.md"]);
});

test("gitcrawl importer CLIs preserve empty-result and database failure outcomes", (t) => {
  const tempDir = temporaryDirectory(t);
  const dbPath = path.join(tempDir, "gitcrawl.db");
  const writer = createPortableStore(dbPath);
  t.after(() => writer.close());

  const emptyCluster = runCli(CLUSTER_IMPORTER, [
    "999",
    "--db",
    dbPath,
    "--out",
    path.join(tempDir, "empty-cluster"),
    "--skip-existing",
    "false",
  ]);
  assert.equal(emptyCluster.status, 0, emptyCluster.stderr);
  assert.match(emptyCluster.stderr, /cluster not found: 999/);

  const emptyLowSignal = runCli(LOW_SIGNAL_IMPORTER, [
    "--db",
    dbPath,
    "--repo",
    "openclaw/empty",
    "--out",
    path.join(tempDir, "empty-low-signal"),
    "--dry-run",
    "--json",
  ]);
  assert.equal(emptyLowSignal.status, 0, emptyLowSignal.stderr);
  assert.deepEqual(JSON.parse(emptyLowSignal.stdout), { generated: [], candidates: [] });

  for (const [name, prepare] of [
    ["missing", (file: string) => assert.equal(fs.existsSync(file), false)],
    ["corrupt", (file: string) => fs.writeFileSync(file, "not a sqlite database\n")],
  ] as const) {
    for (const importer of [CLUSTER_IMPORTER, LOW_SIGNAL_IMPORTER]) {
      const file = path.join(tempDir, `${name}-${path.basename(importer)}.db`);
      prepare(file);
      const result = runCli(
        importer,
        importer === CLUSTER_IMPORTER
          ? ["7", "--db", file, "--out", path.join(tempDir, `${name}-cluster`)]
          : ["--db", file, "--out", path.join(tempDir, `${name}-low`), "--dry-run", "--json"],
      );
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /ERR_SQLITE_(?:CANTOPEN|ERROR|CORRUPT)/);
      if (name === "missing") assert.equal(fs.existsSync(file), false);
    }
  }
});

test("cluster intake accepts empty portable and legacy stores", (t) => {
  const tempDir = temporaryDirectory(t);
  for (const schema of ["portable", "legacy"] as const) {
    const dbPath = path.join(tempDir, `${schema}.db`);
    const database = createGitcrawlStore(dbPath, schema);
    database.exec(
      schema === "portable"
        ? "delete from cluster_memberships; delete from cluster_groups;"
        : "delete from cluster_members; delete from clusters;",
    );
    database.close();
    const outDir = path.join(tempDir, `${schema}-jobs`);
    const result = runCli(CLUSTER_IMPORTER, [
      "--from-gitcrawl",
      "--allow-empty",
      "--db",
      dbPath,
      "--out",
      outDir,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no unprocessed gitcrawl clusters found/);
    assert.equal(fs.existsSync(outDir), false);
  }
});

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-sqlite-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createPortableStore(dbPath: string): DatabaseSync {
  return createGitcrawlStore(dbPath, "portable");
}

function createLegacyStore(dbPath: string): DatabaseSync {
  return createGitcrawlStore(dbPath, "legacy");
}

function createGitcrawlStore(dbPath: string, clusterSchema: "legacy" | "portable"): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    pragma journal_mode = WAL;
    pragma wal_autocheckpoint = 0;
    create table repositories (id integer primary key, owner text, name text, full_name text);
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
    insert into repositories values (1, 'openclaw', 'openclaw', 'openclaw/openclaw');
    insert into threads values (
      1, 1, 42, 'issue', 'open', 'Portable store target', 'Target body', 'Target body',
      'target-author', 'User', '[]', '[]', '{}', 0,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', null, '2026-08-01T00:00:00.000Z'
    );
    insert into threads values (
      2, 1, 43, 'issue', 'open', 'Related portable issue', 'Related body', 'Related body',
      'related-author', 'User', '["bug"]', '[]', '{}', 0,
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z', null, '2026-08-02T00:00:00.000Z'
    );
    insert into threads values (
      3, 1, 9007199254740993, 'pull_request', 'open', 'docs: real fixture',
      'Documentation-only update.', 'Documentation-only update.', 'pr-author', 'User',
      '[]', '[]', '{"author_association":"NONE"}', 0,
      '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z', null, '2026-08-03T00:00:00.000Z'
    );
    insert into thread_revisions values (1, 3);
    insert into thread_code_snapshots values (1, 1);
    insert into thread_changed_files values (1, 'docs/fixture.md');
  `);
  if (clusterSchema === "portable") {
    database.exec(`
      create table cluster_groups (
        id integer primary key,
        repo_id integer,
        created_at text,
        closed_at text,
        status text,
        representative_thread_id integer
      );
      create table cluster_memberships (cluster_id integer, thread_id integer, state text);
      insert into cluster_groups values (7, 1, '2026-08-01T00:00:00.000Z', null, 'active', 2);
      insert into cluster_memberships values (7, 1, 'active'), (7, 2, 'active');
    `);
  } else {
    database.exec(`
      create table clusters (
        id integer primary key,
        repo_id integer,
        member_count integer,
        created_at text,
        closed_at_local text,
        close_reason_local text,
        representative_thread_id integer
      );
      create table cluster_members (cluster_id integer, thread_id integer);
      insert into clusters values (7, 1, 2, '2026-08-01T00:00:00.000Z', null, null, 2);
      insert into cluster_members values (7, 1), (7, 2);
    `);
  }
  return database;
}

function relatedContextFor(root: string, dbPath: string) {
  fs.mkdirSync(path.join(root, "items"), { recursive: true });
  fs.mkdirSync(path.join(root, "closed"), { recursive: true });
  const context = createRelatedContext({
    root,
    targetRepo: () => "openclaw/openclaw",
    reportUrl: (value: string) => value,
    defaultItemsDir: () => path.join(root, "items"),
    defaultClosedDir: () => path.join(root, "closed"),
    isMarkdownForActiveRepo: () => false,
    gitHubRuntimeBudgetError: class GitHubRuntimeBudgetError extends Error {},
    ghJson: () => {
      throw new Error("unexpected GitHub request");
    },
    ghJsonOnce: () => {
      throw new Error("unexpected GitHub request");
    },
    asRecord: (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    login: () => undefined,
    compactIssue: (value: unknown) => value,
    compactPullRequest: (value: unknown) => value,
    envFlagEnabled: () => false,
    envFlagDisabled: () => false,
    frontMatterValue: () => undefined,
    reviewSectionValue: () => "",
    effectiveReviewStatus: () => "",
    displayTitle: (value: string) => value,
    markdownFiles: () => [],
    numberForMarkdownFile: () => 0,
    repoRelativePath: (value: string) => value,
  });
  const withDatabase = <T>(operation: () => T): T => {
    const previous = process.env.CLAWSWEEPER_GITCRAWL_DB;
    process.env.CLAWSWEEPER_GITCRAWL_DB = dbPath;
    try {
      return operation();
    } finally {
      if (previous === undefined) delete process.env.CLAWSWEEPER_GITCRAWL_DB;
      else process.env.CLAWSWEEPER_GITCRAWL_DB = previous;
    }
  };
  return {
    relatedItemsContext: (...args: Parameters<typeof context.relatedItemsContext>) =>
      withDatabase(() => context.relatedItemsContext(...args)),
    structuralExternalRelationSensitivity: (
      ...args: Parameters<typeof context.structuralExternalRelationSensitivity>
    ) => withDatabase(() => context.structuralExternalRelationSensitivity(...args)),
  };
}

function runCli(file: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
