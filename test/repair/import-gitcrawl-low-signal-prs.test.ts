import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const IMPORTER = path.join(process.cwd(), "dist/repair/import-gitcrawl-low-signal-prs.js");
const STALE = "2026-01-01T00:00:00Z";

function gitcrawlDb(dir: string, threads: Record<string, unknown>[]) {
  const dbPath = path.join(dir, "gitcrawl.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table repositories (id integer primary key, owner text, name text);
    create table threads (
      id integer primary key, repo_id integer, kind text, number integer, state text,
      title text, body text, author_login text, author_type text, labels_json text,
      assignees_json text, raw_json text, is_draft integer, created_at_gh text,
      updated_at_gh text, last_pulled_at text, closed_at_local text
    );
    create table thread_revisions (id integer primary key, thread_id integer);
    create table thread_code_snapshots (id integer primary key, thread_revision_id integer);
    create table thread_changed_files (snapshot_id integer, path text);
    insert into repositories values (1, 'openclaw', 'openclaw');
  `);
  const insert = db.prepare(
    "insert into threads values (?, 1, 'pull_request', ?, 'open', ?, ?, 'author', 'User', ?, ?, ?, ?, ?, ?, ?, null)",
  );
  for (const thread of threads) {
    insert.run(
      thread.number as number,
      thread.number as number,
      thread.title as string,
      (thread.body as string) ?? "",
      JSON.stringify(thread.labels ?? []),
      JSON.stringify(thread.assignees ?? []),
      JSON.stringify({ author_association: thread.association ?? "NONE" }),
      thread.draft ? 1 : 0,
      STALE,
      (thread.updated as string) ?? STALE,
      (thread.updated as string) ?? STALE,
    );
  }
  db.close();
  return dbPath;
}

test("low-signal selection scores facts, not title or body keywords", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitcrawl-low-signal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = gitcrawlDb(dir, [
    // Bug/fix wording no longer holds a PR back; the worker judges it.
    { number: 1, title: "Fixes the root cause of a regression", body: "Repro inside." },
    // Docs/refactor wording no longer counts toward selection.
    { number: 2, title: "docs: refactor cleanup", association: "MEMBER" },
    { number: 3, title: "chore: cleanup", assignees: [{ login: "maintainer" }] },
    { number: 4, title: "Add new plugin", updated: new Date().toISOString() },
  ]);
  const result = spawnSync(
    process.execPath,
    [
      IMPORTER,
      "--db",
      dbPath,
      "--dry-run",
      "--json",
      "--skip-existing",
      "false",
      "--out",
      path.join(dir, "out"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const candidates = JSON.parse(result.stdout).candidates as {
    number: number;
    signals: string[];
  }[];
  assert.deepEqual(
    candidates.map((candidate) => [candidate.number, candidate.signals]),
    [[1, ["no_update_30d", "outside_author"]]],
  );
});

test("low-signal importer excludes exact security labels, not prefixes or prose", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitcrawl-security-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const labels = [
    "security",
    "security-sensitive",
    "security sensitive",
    "type: security",
    "type:security",
    "kind: security",
    "kind:security",
  ];
  const dbPath = gitcrawlDb(dir, [
    ...labels.map((label, index) => ({
      number: index + 1,
      title: "Small change",
      labels: [{ name: label.toUpperCase() }],
    })),
    { number: 8, title: "Security advisory CVE-2026-12345", body: "GHSA-1234-5678-abcd" },
    { number: 9, title: "Small change", labels: ["security/internal", "security:sensitive"] },
    { number: 10, title: "Small change", body: "<!-- clawsweeper-security:security -->" },
  ]);
  const result = spawnSync(
    process.execPath,
    [
      IMPORTER,
      "--db",
      dbPath,
      "--dry-run",
      "--json",
      "--skip-existing",
      "false",
      "--out",
      path.join(dir, "out"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const candidates = JSON.parse(result.stdout).candidates as { number: number }[];
  assert.deepEqual(candidates.map((candidate) => candidate.number).sort(), [8, 9, 10].sort());
});
