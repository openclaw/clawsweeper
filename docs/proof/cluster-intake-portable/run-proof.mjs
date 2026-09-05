import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";

const [materializerPath, outputPath, baselineRef] = process.argv.slice(2);
assert.ok(
  materializerPath && outputPath,
  "usage: run-proof.mjs <materializer> <output> [baseline-ref]",
);
const root = process.cwd();
const materializer = fs.readFileSync(materializerPath);
const workflowPath = ".github/workflows/repair-cluster-intake.yml";
const source = baselineRef
  ? execFileSync("git", ["show", `${baselineRef}:${workflowPath}`], { encoding: "utf8" })
  : fs.readFileSync(workflowPath, "utf8");
const prepare = parse(source).jobs.intake.steps.find((step) => step.name === "Prepare intake").run;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-intake-proof-"));
const importer = path.join(
  root,
  "dist/repair",
  baselineRef ? `intake-proof-${randomUUID()}.ts` : "import-gitcrawl-clusters.js",
);
const results = [];

try {
  if (baselineRef) {
    fs.writeFileSync(
      importer,
      execFileSync("git", ["show", `${baselineRef}:src/repair/import-gitcrawl-clusters.ts`]),
      { flag: "wx" },
    );
  }
  scenario("raw", { compression: false });
  scenario("compressed", { compression: true });
  scenario("empty-portable", { compression: false, empty: true });
  if (!baselineRef) {
    scenario("empty-compressed", { compression: true, empty: true });
    scenario("unreviewed-materializer", { compression: true, corruptMaterializer: true });
    scenario("archive-hash-mismatch", { compression: true, corruptArchiveHash: true });
    scenario("decoded-hash-mismatch", { compression: true, corruptDecodedHash: true });
    scenario("already-processed", { compression: true, processed: true, corruptArchiveHash: true });
    scenario("forced-reimport", { compression: true, processed: true, force: true });
  }
  const receipt = {
    source: baselineRef ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    variant: baselineRef ? "baseline" : "candidate",
    runtime: process.version,
    working_tree_dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    ),
    importer_sha256: sha256(fs.readFileSync(importer)),
    importer_source_sha256: sha256(
      baselineRef
        ? execFileSync("git", ["show", `${baselineRef}:src/repair/import-gitcrawl-clusters.ts`])
        : fs.readFileSync("src/repair/import-gitcrawl-clusters.ts"),
    ),
    materializer_sha256: sha256(materializer),
    workflow_sha256: sha256(Buffer.from(source)),
    results,
    limits:
      "Synthetic SQLite snapshots; actual preparation, importer and empty selector. Baseline entrypoint shares current compiled dependencies. No inference, GitHub mutation, or production state. Empty upstream cluster exports remain empty.",
  };
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (baselineRef) fs.rmSync(importer, { force: true });
}

function scenario(name, options) {
  const cwd = path.join(fixtureRoot, name);
  const dataDir = path.join(cwd, "gitcrawl-store/data");
  const scriptsDir = path.join(cwd, "gitcrawl-store/scripts");
  const runnerTemp = path.join(cwd, "tmp");
  for (const dir of [dataDir, scriptsDir, runnerTemp]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "portable-artifact.mjs"),
    options.corruptMaterializer
      ? 'import fs from "node:fs"; fs.writeFileSync("unreviewed-code-ran", "");\n'
      : materializer,
  );
  const dbName = "openclaw__fixture.sync.db";
  const dbPath = path.join(dataDir, dbName);
  const database = new DatabaseSync(dbPath);
  database.exec(`
    create table threads (id integer primary key, number integer, kind text, state text,
      title text, body_excerpt text, labels_json text, updated_at text);
    create table cluster_groups (id integer primary key, created_at text, closed_at text,
      status text, representative_thread_id integer);
    create table cluster_memberships (cluster_id integer, thread_id integer, state text);
  `);
  if (!options.empty)
    database.exec(`
    insert into threads values (1, 70001, 'issue', 'open', 'Synthetic intake fixture',
      'Synthetic input only', '["bug"]', '2026-09-01T00:00:00Z');
    insert into cluster_groups values (7, '2026-09-01T00:00:00Z', null, 'active', 1);
    insert into cluster_memberships values (7, 1, 'active');
  `);
  database.close();
  const bytes = fs.readFileSync(dbPath);
  const manifest = {
    sha256: sha256(bytes),
    outputBytes: bytes.length,
    exportedAt: "2026-09-01T00:00:00Z",
  };
  if (options.compression) {
    const archive = gzipSync(bytes);
    Object.assign(manifest, {
      compression: "gzip",
      archivePath: `${dbName}.gz`,
      archiveBytes: archive.length,
      archiveSha256: options.corruptArchiveHash ? "0".repeat(64) : sha256(archive),
      maxArchiveBytes: 100000000,
    });
    fs.writeFileSync(`${dbPath}.gz`, archive);
    fs.rmSync(dbPath);
  }
  if (options.corruptDecodedHash) manifest.sha256 = "0".repeat(64);
  fs.writeFileSync(`${dbPath}.manifest.json`, JSON.stringify(manifest));
  if (options.processed) {
    const ledger = path.join(cwd, "results/cluster-repair-intake/openclaw-fixture.json");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({ last_processed_store_sha256: manifest.sha256 }));
  }
  const githubOutput = path.join(cwd, "outputs");
  const prepared = spawnSync("bash", ["-c", prepare], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      ENABLED: "1",
      SCHEDULE_ENABLED: "0",
      TARGET_REPO: "openclaw/fixture",
      FORCE_STORE: options.force ? "1" : "0",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_OUTPUT: githubOutput,
      RUNNER_TEMP: runnerTemp,
    },
  });
  const outputs = fs.existsSync(githubOutput)
    ? Object.fromEntries(
        fs
          .readFileSync(githubOutput, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const split = line.indexOf("=");
            return [line.slice(0, split), line.slice(split + 1)];
          }),
      )
    : {};
  const rejected = baselineRef
    ? options.compression
    : !options.processed &&
      (options.corruptMaterializer || options.corruptArchiveHash || options.corruptDecodedHash);
  if (rejected) {
    assert.notEqual(prepared.status, 0, name);
    assert.notEqual(outputs.should_import, "true", name);
    assert.equal(outputs.db_path, undefined, name);
    assert.match(
      prepared.stderr + prepared.stdout,
      baselineRef
        ? /Missing gitcrawl-store DB/
        : options.corruptMaterializer
          ? /materializer does not match the reviewed digest/
          : /manifest (?:archiveSha256|sha256) mismatch/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "gitcrawl-store/unreviewed-code-ran")), false);
    results.push({ name, admission: "rejected", jobs: 0 });
    return;
  }
  assert.equal(prepared.status, 0, `${name}: ${prepared.stderr}`);
  if (options.processed && !options.force) {
    assert.equal(outputs.should_import, "false");
    assert.equal(fs.readdirSync(runnerTemp).length, 0, "skip must precede materialization");
    results.push({ name, admission: "skipped", jobs: 0 });
    return;
  }
  assert.equal(outputs.should_import, "true");
  assert.equal(outputs.store_sha, manifest.sha256);
  assert.equal(outputs.manifest_path, `gitcrawl-store/data/${dbName}.manifest.json`);
  const materialized = path.resolve(cwd, outputs.db_path);
  assert.equal(sha256(fs.readFileSync(materialized)), sha256(bytes));
  const outDir = path.join(cwd, "jobs");
  const imported = spawnSync(
    process.execPath,
    [
      importer,
      "--from-gitcrawl",
      "--allow-empty",
      "--repo",
      "openclaw/fixture",
      "--db",
      materialized,
      "--out",
      outDir,
      "--skip-existing",
      "false",
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    },
  );
  if (baselineRef && options.empty) {
    assert.notEqual(imported.status, 0);
    assert.match(imported.stderr, /no such table: clusters/);
    results.push({ name, admission: "accepted", import: "legacy-table-error", jobs: 0 });
    return;
  }
  assert.equal(imported.status, 0, `${name}: ${imported.stderr}`);
  const jobs = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0;
  assert.equal(jobs, options.empty ? 0 : 1, name);
  if (options.empty) {
    const pathsFile = path.join(cwd, "generated-paths.txt");
    const selectedFile = path.join(cwd, "selected.txt");
    const reportFile = path.join(cwd, "selection.json");
    fs.writeFileSync(pathsFile, "\n");
    const selected = spawnSync(
      process.execPath,
      [
        path.join(root, "dist/repair/select-cluster-candidate.js"),
        "--repo",
        "openclaw/fixture",
        "--paths-file",
        pathsFile,
        "--out",
        selectedFile,
        "--report",
        reportFile,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 30000,
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
      },
    );
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(fs.readFileSync(selectedFile, "utf8"), "");
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    assert.equal(report.selected, 0);
    assert.equal(report.evaluated, 0);
    assert.equal(report.decision, null);
  } else {
    const job = fs.readFileSync(path.join(outDir, fs.readdirSync(outDir)[0]), "utf8");
    assert.match(job, /repo: openclaw\/fixture/);
    assert.match(job, /#70001/);
  }
  results.push({ name, admission: "accepted", import: "success", jobs });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
