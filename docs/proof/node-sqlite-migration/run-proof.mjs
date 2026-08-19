import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { querySqliteRows, querySqliteScalar } from "../../../dist/sqlite-readonly.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-node-sqlite-proof-"));
const dbPath = path.join(tempDir, "gitcrawl.db");
const writer = createFixture(dbPath);

try {
  assert.equal(fs.existsSync(`${dbPath}-wal`), true, "fixture must retain committed WAL rows");
  const oldSources = [
    "src/clawsweeper-related-context.ts",
    "src/repair/import-gitcrawl-clusters.ts",
    "src/repair/import-gitcrawl-low-signal-prs.ts",
  ].map((file) => ({ file, source: gitShow(file) }));
  assert.equal(oldSources[0].source.match(/spawnSync\("sqlite3"/g)?.length, 2);
  assert.equal(oldSources[1].source.match(/execFileSync\("sqlite3"/g)?.length, 2);
  assert.equal(oldSources[2].source.match(/execFileSync\("sqlite3"/g)?.length, 1);

  const scalarQueries = [
    "select count(*) from sqlite_master where type = 'table' and name = 'cluster_groups';",
    "select count(*) from cluster_groups;",
    "select 9007199254740993;",
  ];
  const jsonQueries = [relatedContextQuery(), clusterImporterQuery(), lowSignalImporterQuery()];

  const scalarEquivalence = scalarQueries.map((sql) => {
    const oldResult = oldScalar(dbPath, sql);
    const newResult = querySqliteScalar(dbPath, sql);
    assert.equal(newResult, oldResult);
    return {
      sql_sha256: sha256(sql),
      old: oldResult,
      new: newResult,
      byte_identical: true,
    };
  });
  const jsonEquivalence = jsonQueries.map(({ site, sql }) => {
    const oldResult = oldJson(dbPath, sql);
    const newResult = querySqliteRows(dbPath, sql);
    const oldBytes = JSON.stringify(oldResult);
    const newBytes = JSON.stringify(newResult);
    assert.equal(newBytes, oldBytes);
    return {
      site,
      sql_sha256: sha256(sql),
      rows: newResult.length,
      parsed_sha256: sha256(newBytes),
      byte_identical: true,
    };
  });

  const failures = {
    missing: compareFailure(
      "missing",
      path.join(tempDir, "old-missing.db"),
      path.join(tempDir, "new-missing.db"),
    ),
    corrupt: compareFailure(
      "corrupt",
      path.join(tempDir, "old-corrupt.db"),
      path.join(tempDir, "new-corrupt.db"),
    ),
  };
  assert.equal(failures.missing.old_failed, true);
  assert.equal(failures.missing.new_failed, true);
  assert.equal(failures.missing.new_created_file, false);
  assert.equal(failures.corrupt.old_failed, true);
  assert.equal(failures.corrupt.new_failed, true);

  const artifact = {
    schema: "clawsweeper-node-sqlite-equivalence/v1",
    base_ref: baseRef,
    base_sha: execFileSync("git", ["rev-parse", baseRef], { cwd: root, encoding: "utf8" }).trim(),
    current_head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    runtime: {
      node: process.version,
      sqlite3: execFileSync("sqlite3", ["--version"], { encoding: "utf8" }).trim(),
    },
    old_path_extraction: oldSources.map(({ file, source }) => ({
      file,
      source_sha256: sha256(source),
      sqlite3_invocations: (source.match(/(?:spawnSync|execFileSync)\("sqlite3"/g) ?? []).length,
    })),
    fixture: {
      kind: "real node:sqlite portable gitcrawl store",
      journal_mode: "wal",
      wal_sidecar_present_during_reads: fs.existsSync(`${dbPath}-wal`),
    },
    equivalence: {
      scalar: scalarEquivalence,
      json: jsonEquivalence,
    },
    integer_contract: {
      sqlite_integer: "9007199254740993",
      scalar_string: querySqliteScalar(dbPath, "select 9007199254740993;"),
      json_number: querySqliteRows(dbPath, "select 9007199254740993 as value;")[0].value,
      decision:
        "JSON rows preserve sqlite3 -json plus JSON.parse number coercion; scalar reads preserve exact decimal text until callers apply Number().",
    },
    error_mapping: failures,
    limits: [
      "The host proof requires sqlite3 only for the extracted old-path side of the comparison.",
      "Fixtures are disposable local files and do not contact GitHub, Gitcrawl, Worker storage, or any production service.",
      "Read-only node:sqlite no longer creates a missing database file; importer caller-visible failure remains nonzero while related-context maps query errors to its existing empty/null fallbacks.",
    ],
  };

  const output = path.join(root, "docs/proof/node-sqlite-migration/equivalence.json");
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
} finally {
  writer.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function oldScalar(database, sql) {
  return execFileSync("sqlite3", [database, sql], { encoding: "utf8" }).trim();
}

function oldJson(database, sql) {
  const output = execFileSync("sqlite3", ["-json", database, sql], { encoding: "utf8" }).trim();
  return JSON.parse(output || "[]");
}

function compareFailure(kind, oldPath, newPath) {
  if (kind === "corrupt") {
    fs.writeFileSync(oldPath, "not a sqlite database\n");
    fs.writeFileSync(newPath, "not a sqlite database\n");
  }
  const sql = "select * from clusters;";
  const oldResult = spawnSync("sqlite3", ["-json", oldPath, sql], { encoding: "utf8" });
  let newError;
  try {
    querySqliteRows(newPath, sql);
  } catch (error) {
    newError = error;
  }
  return {
    old_failed: oldResult.status !== 0,
    old_status: oldResult.status,
    old_error_class: classifyMessage(oldResult.stderr),
    old_created_file: fs.existsSync(oldPath),
    new_failed: Boolean(newError),
    new_error_code: typeof newError?.code === "string" ? newError.code : null,
    new_error_class: classifyMessage(newError instanceof Error ? newError.message : ""),
    new_created_file: fs.existsSync(newPath),
    related_context_mapping:
      kind === "missing"
        ? "[] / false before query because path is absent"
        : "[] / null after caught query failure",
    importer_mapping: "uncaught query failure and nonzero process exit",
  };
}

function classifyMessage(message) {
  if (/unable to open database/i.test(message)) return "cantopen";
  if (/not a database|file is not a database/i.test(message)) return "notadb";
  if (/no such table/i.test(message)) return "missing_table";
  return "other";
}

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], { cwd: root, encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relatedContextQuery() {
  return {
    site: "src/clawsweeper-related-context.ts sqliteJsonProbe",
    sql: `
      select
        cg.id as cluster_id,
        (select count(*) from cluster_memberships cm_count where cm_count.cluster_id = cg.id and cm_count.state = 'active') as member_count,
        rt.number as representative_number,
        rt.kind as representative_kind,
        rt.state as representative_state,
        rt.title as representative_title,
        t.number,
        t.kind,
        t.state,
        t.title,
        t.body_excerpt as body,
        t.labels_json,
        t.updated_at
      from cluster_groups cg
      join cluster_memberships cm_self on cm_self.cluster_id = cg.id and cm_self.state = 'active'
      join threads self on self.id = cm_self.thread_id
      join repositories self_repo on self_repo.id = self.repo_id
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      join repositories thread_repo on thread_repo.id = t.repo_id
      left join threads rt on rt.id = cg.representative_thread_id
      where cg.status = 'active' and cg.repo_id = self.repo_id
        and self_repo.full_name = 'openclaw/openclaw' and self.number = 42 and self.kind = 'issue'
        and thread_repo.full_name = 'openclaw/openclaw' and t.number != 42 and t.kind = 'issue'
      order by case when t.state = 'open' then 0 else 1 end, t.updated_at desc, t.number desc
      limit 6;
    `,
  };
}

function clusterImporterQuery() {
  return {
    site: "src/repair/import-gitcrawl-clusters.ts sqliteJson",
    sql: `
      select
        cg.id as cluster_id,
        (select count(*) from cluster_memberships cm_count where cm_count.cluster_id = cg.id and cm_count.state = 'active') as member_count,
        cg.created_at as cluster_created_at,
        cg.closed_at as closed_at_local,
        cg.status as close_reason_local,
        rt.number as representative_number,
        rt.kind as representative_kind,
        rt.state as representative_state,
        rt.title as representative_title,
        t.number,
        t.kind,
        t.state,
        t.title,
        t.body_excerpt as body,
        t.labels_json,
        t.updated_at
      from cluster_groups cg
      join cluster_memberships cm on cm.cluster_id = cg.id and cm.state = 'active'
      join threads t on t.id = cm.thread_id
      left join threads rt on rt.id = cg.representative_thread_id
      where cg.id in (7)
      order by cg.id, t.number;
    `,
  };
}

function lowSignalImporterQuery() {
  return {
    site: "src/repair/import-gitcrawl-low-signal-prs.ts sqliteJson",
    sql: `
      select
        t.id, t.number, t.state, t.title, t.body, t.author_login, t.author_type,
        t.labels_json, t.assignees_json, t.raw_json, t.is_draft, t.created_at_gh,
        t.updated_at_gh, t.last_pulled_at, group_concat(distinct f.path) as files
      from threads t
      join repositories r on r.id = t.repo_id
      left join thread_revisions tr on tr.thread_id = t.id
      left join thread_code_snapshots s on s.thread_revision_id = tr.id
      left join thread_changed_files f on f.snapshot_id = s.id
      where r.owner = 'openclaw' and r.name = 'openclaw'
        and t.kind = 'pull_request' and t.state = 'open' and t.closed_at_local is null
      group by t.id;
    `,
  };
}

function createFixture(dbPath) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    pragma journal_mode = WAL;
    pragma wal_autocheckpoint = 0;
    create table repositories (id integer primary key, owner text, name text, full_name text);
    create table threads (
      id integer primary key, repo_id integer, number integer, kind text, state text,
      title text, body text, body_excerpt text, author_login text, author_type text,
      labels_json text, assignees_json text, raw_json text, is_draft integer,
      created_at_gh text, updated_at_gh text, last_pulled_at text,
      closed_at_local text, updated_at text
    );
    create table cluster_groups (
      id integer primary key, repo_id integer, created_at text, closed_at text,
      status text, representative_thread_id integer
    );
    create table cluster_memberships (cluster_id integer, thread_id integer, state text);
    create table thread_revisions (id integer primary key, thread_id integer);
    create table thread_code_snapshots (id integer primary key, thread_revision_id integer);
    create table thread_changed_files (snapshot_id integer, path text);
    insert into repositories values (1, 'openclaw', 'openclaw', 'openclaw/openclaw');
    insert into threads values (1, 1, 42, 'issue', 'open', 'Target', 'Target body', 'Target body', 'a', 'User', '[]', '[]', '{}', 0, '2026-08-01', '2026-08-01', '2026-08-01', null, '2026-08-01');
    insert into threads values (2, 1, 43, 'issue', 'open', 'Related', 'Related body', 'Related body', 'b', 'User', '["bug"]', '[]', '{}', 0, '2026-08-02', '2026-08-02', '2026-08-02', null, '2026-08-02');
    insert into threads values (3, 1, 9007199254740993, 'pull_request', 'open', 'docs: fixture', 'Docs only.', 'Docs only.', 'c', 'User', '[]', '[]', '{"author_association":"NONE"}', 0, '2026-08-03', '2026-08-03', '2026-08-03', null, '2026-08-03');
    insert into cluster_groups values (7, 1, '2026-08-01', null, 'active', 2);
    insert into cluster_memberships values (7, 1, 'active'), (7, 2, 'active');
    insert into thread_revisions values (1, 3);
    insert into thread_code_snapshots values (1, 1);
    insert into thread_changed_files values (1, 'docs/fixture.md');
  `);
  return database;
}
