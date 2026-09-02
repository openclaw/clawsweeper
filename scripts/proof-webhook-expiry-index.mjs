// Local production-store proof. Usage: node scripts/proof-webhook-expiry-index.mjs BASE_SHA /tmp/FRESH_DIR
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [baseRef, outputPath, extra] = process.argv.slice(2);
assert.ok(baseRef && outputPath && !extra, "expected BASE_SHA and a fresh /tmp output directory");
assert.equal(process.version, "v24.19.0", "use the measured Node 24.19 runtime");
const out = path.resolve(outputPath);
assert.ok(out.startsWith("/tmp/") || out.startsWith(`${os.tmpdir()}/`), "output must be temporary");
mkdirSync(out); // Fail if output exists: never overwrite earlier evidence.
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const base = git("rev-parse", "--verify", `${baseRef}^{commit}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) =>
  writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const table = "github_webhook_read_model_deliveries_v1";
const index = "github_webhook_read_model_deliveries_received_at_v1";
const meta = "github_webhook_read_model_meta_v1";
const classes = "github_webhook_read_model_classes_v1";
const items = "github_webhook_read_model_items_v1";
const workflows = "github_webhook_read_model_workflows_v1";
const now = Date.parse("2026-08-26T12:00:00Z");
const cutoff = now - 30 * 24 * 60 * 60_000;
const sources = ["dashboard/github-webhook-read-model.ts", "src/stable-json.ts"];
const manifest = {
  base,
  head: git("rev-parse", "HEAD"),
  sources: {},
  harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
};
const modules = {};
for (const variant of ["baseline", "patched"]) {
  const dir = path.join(out, variant);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  manifest.sources[variant] = {};
  for (const file of sources) {
    const bytes =
      variant === "baseline"
        ? execFileSync("git", ["show", `${base}:${file}`], { cwd: root })
        : readFileSync(path.join(root, file));
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    manifest.sources[variant][file] = { sha256: hash(bytes), bytes: bytes.length };
  }
  modules[variant] = await import(pathToFileURL(path.join(dir, sources[0])).href);
}
const baselineSource = readFileSync(path.join(out, "baseline", sources[0]), "utf8");
const patchedSource = readFileSync(path.join(out, "patched", sources[0]), "utf8");
const addition = `    this.storage.sql.exec(
      \`CREATE INDEX IF NOT EXISTS ${index}
         ON ${table} (received_at)\`,
    );
`;
assert.ok(!baselineSource.includes(index), "baseline already contains the index");
assert.ok(patchedSource.includes(addition));
assert.equal(
  patchedSource.replace(addition, ""),
  baselineSource,
  "only the frozen index addition may differ",
);
assert.deepEqual(manifest.sources.baseline[sources[1]], manifest.sources.patched[sources[1]]);
save("source-manifest.json", manifest);

function timed(fn) {
  const cpu = process.cpuUsage();
  const start = process.hrtime.bigint();
  const value = fn();
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const usage = process.cpuUsage(cpu);
  return { wallMs, cpuMs: (usage.user + usage.system) / 1000, value };
}
function summary(samples) {
  return Object.fromEntries(
    ["wallMs", "cpuMs"].map((field) => {
      const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
      return [
        field,
        {
          median: values[Math.floor(values.length / 2)],
          p95: values[Math.ceil(values.length * 0.95) - 1],
          min: values[0],
          max: values.at(-1),
        },
      ];
    }),
  );
}
function connect(variant, file = ":memory:") {
  const db = new DatabaseSync(file);
  const adapter = {
    trace: null,
    deleted: 0,
    failAfterPrune: false,
    indexBuild: null,
    sql: {
      exec(query, ...bindings) {
        if (adapter.failAfterPrune && query.startsWith(`DELETE FROM ${workflows}`)) {
          adapter.failAfterPrune = false;
          throw new Error("injected failure after receipt prune");
        }
        const run = () => {
          const stmt = db.prepare(query);
          if (/^\s*(?:SELECT|WITH|EXPLAIN)\b/i.test(query)) return stmt.all(...bindings);
          const changes = Number(stmt.run(...bindings).changes);
          if (query.startsWith(`DELETE FROM ${table} `)) adapter.deleted = changes;
          return [];
        };
        const rows = query.includes(`CREATE INDEX IF NOT EXISTS ${index}`)
          ? (adapter.indexBuild = timed(run)).value
          : run();
        adapter.trace?.push({ query, bindings });
        return rows;
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const store = new modules[variant].GithubWebhookReadModelStore(adapter);
  return { db, adapter, store };
}
function delivery(id = "new-delivery", received = now, updated = received) {
  const iso = new Date(updated).toISOString();
  const value = modules.patched.githubWebhookReadModelDeliveryFromWebhook({
    event: "issues",
    deliveryId: id,
    receivedAt: new Date(received).toISOString(),
    payload: {
      action: "edited",
      repository: { full_name: "openclaw/openclaw", private: false, default_branch: "main" },
      issue: {
        number: 1,
        title: id,
        body: "synthetic local issue ".repeat(100),
        state: "open",
        locked: false,
        comments: 0,
        updated_at: iso,
        created_at: iso,
        labels: [],
        user: { login: "fixture" },
      },
    },
  });
  assert.ok(value);
  return value;
}
const guid = (i) => {
  const hex = hash(`receipt:${i}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const sql = {};
for (const variant of Object.keys(modules)) {
  const c = connect(variant);
  c.adapter.trace = [];
  c.store.ensureSchemaSync();
  c.store.ingest(delivery(), now);
  const trace = c.adapter.trace;
  sql[variant] = {
    schema: trace.filter(({ query }) => query.startsWith("CREATE ")),
    insert: trace.find(({ query }) => query.startsWith(`INSERT INTO ${table}`)).query,
    item: trace.find(({ query }) => query.startsWith(`INSERT INTO ${items}`)).query,
    prune: trace.find(({ query }) => query.startsWith(`DELETE FROM ${table} `)),
  };
  c.db.close();
}
assert.deepEqual(sql.baseline.prune, sql.patched.prune);
assert.equal(sql.baseline.insert, sql.patched.insert);
save("production-sql.json", sql);
const prune = sql.baseline.prune.query;
const select = prune.slice(prune.indexOf("SELECT delivery_id"), prune.lastIndexOf(")")).trim();
function snapshot(db) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'github_webhook_read_model_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
  );
}
function seed(c, n, expired, tied = false) {
  c.store.ensureSchemaSync();
  c.adapter.transactionSync(() => {
    const insert = c.db.prepare(sql.baseline.insert);
    for (let i = 0; i < n; i += 1) {
      insert.run(
        guid(i),
        "issues",
        "edited",
        i < expired ? cutoff - (tied ? 1 : expired - i) : now - 7 * 86400000 + i * 1000,
        i + 1,
      );
    }
    c.db
      .prepare(`UPDATE ${meta} SET watermark=?, created_at=?, updated_at=?`)
      .run(n, now - 31 * 86400000, now - 1000);
    c.db
      .prepare(`INSERT INTO ${classes} VALUES ('issues',?,?,?,?)`)
      .run(n, cutoff - 600, now - 1000, n);
    const insertItem = c.db.prepare(sql.baseline.item);
    for (let i = 1; i <= 128; i += 1)
      insertItem.run(
        "openclaw/openclaw",
        i,
        "issue",
        now - 1000,
        JSON.stringify(delivery().objects[0].snapshot),
        guid(n - i),
        n - i + 1,
        now - 1000,
      );
    const insertWorkflow = c.db.prepare(`INSERT INTO ${workflows} VALUES (?,?,?,?,?,?,?,?,?)`);
    for (let i = 1; i <= 100; i += 1)
      insertWorkflow.run(
        "openclaw/openclaw",
        "workflow_job",
        i,
        1,
        now - 1000,
        JSON.stringify({ id: i, status: "completed" }),
        guid(n - i),
        n - i + 1,
        now - 1000,
      );
  });
  assert.equal(c.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, n);
  assert.equal(
    c.db.prepare(`SELECT count(*) n FROM ${table} WHERE received_at < ?`).get(cutoff).n,
    expired,
  );
}
function plans(c, variant) {
  const result = {
    delete: c.db.prepare(`EXPLAIN QUERY PLAN ${prune}`).all(cutoff),
    select: c.db.prepare(`EXPLAIN QUERY PLAN ${select}`).all(cutoff),
  };
  const details = result.select.map((row) => row.detail).join("\n");
  if (variant === "patched") {
    assert.match(details, new RegExp(`SEARCH ${table} USING INDEX ${index} \\(received_at<\\?\\)`));
    assert.doesNotMatch(details, /SCAN |USE TEMP B-TREE/);
  } else {
    assert.match(details, new RegExp(`SCAN ${table}`));
    assert.match(details, /USE TEMP B-TREE FOR ORDER BY/);
  }
  return result;
}
// Restore exact rowids and touched rows outside timings; each ingest still commits normally.
function restorer(c) {
  const expiredRows = c.db
    .prepare(`SELECT rowid AS rid,* FROM ${table} WHERE delivery_id IN (${select})`)
    .all(cutoff);
  const insert = c.db.prepare(
    `INSERT INTO ${table}(rowid,delivery_id,event,action,received_at,watermark) VALUES(?,?,?,?,?,?)`,
  );
  const rows = [
    [meta, "singleton_id=1"],
    [classes, "event_class='issues'"],
    [items, "repository='openclaw/openclaw' AND number=1"],
  ].map(([name, where]) => {
    const row = c.db.prepare(`SELECT rowid AS rid,* FROM ${name} WHERE ${where}`).get();
    const columns = Object.keys(row).filter((key) => key !== "rid");
    const stmt = c.db.prepare(
      `UPDATE ${name} SET ${columns.map((key) => `${key}=?`).join(",")} WHERE rowid=?`,
    );
    return () => stmt.run(...columns.map((key) => row[key]), row.rid);
  });
  const remove = c.db.prepare(`DELETE FROM ${table} WHERE delivery_id='new-delivery'`);
  return () =>
    c.adapter.transactionSync(() => {
      remove.run();
      for (const row of expiredRows)
        insert.run(row.rid, row.delivery_id, row.event, row.action, row.received_at, row.watermark);
      for (const restore of rows) restore();
    });
}
const probe = new DatabaseSync(":memory:");
const result = {
  manifest,
  startedAt: new Date().toISOString(),
  provider: "local Node DatabaseSync",
  runtime: process.version,
  sqlite: probe.prepare("SELECT sqlite_version() version, sqlite_source_id() source_id").get(),
  compileOptions: probe.prepare("PRAGMA compile_options").all(),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model,
  loadStart: os.loadavg(),
  method:
    "5 warmups + 60 alternating rounds; wall/process CPU; DELETE prepare/execute excludes transaction; ingest includes commit; exact restore and assertions outside timing. File copies are reopened connections, not disk-cold. No global SQLite changes or scan-count claims.",
  limits:
    "Synthetic local Node SQLite only, not Cloudflare capacity, production cardinality/rate, or sole overload cause. Tied IDs compare this runtime only. No Bay schema, public fields, UI or controls change.",
  cases: [],
  semantics: [],
};
probe.close();
const payload = delivery();
for (const n of [1000, 10000, 100000])
  for (const expired of [0, 600]) {
    const seedFile = path.join(out, `seed-${n}-${expired}.sqlite`);
    const diskSeed = connect("baseline", seedFile);
    seed(diskSeed, n, expired);
    diskSeed.db.close();
    const pairs = Object.keys(modules).map((variant) => {
      const c = connect(variant);
      seed(c, n, expired);
      return { variant, c, restore: restorer(c), before: snapshot(c.db), delete: [], ingest: [] };
    });
    for (let round = 0; round < 65; round += 1)
      for (const row of round % 2 ? [...pairs].reverse() : pairs) {
        const { c } = row;
        c.db.exec("BEGIN IMMEDIATE");
        const deletion = timed(() => c.adapter.sql.exec(prune, cutoff));
        assert.equal(c.adapter.deleted, expired ? 256 : 0);
        c.db.exec("ROLLBACK");
        const ingest = timed(() => c.store.ingest(payload, now));
        assert.deepEqual(ingest.value, { accepted: true, deduped: false, watermark: n + 1 });
        assert.equal(c.adapter.deleted, expired ? 256 : 0);
        row.restore();
        if (round >= 5) {
          row.delete.push(deletion);
          row.ingest.push(ingest);
        }
      }
    const states = [];
    for (const row of pairs) {
      const { c, variant } = row;
      assert.deepEqual(snapshot(c.db), row.before);
      const entry = {
        n,
        expired,
        variant,
        plans: plans(c, variant),
        delete: { summary: summary(row.delete), samples: row.delete },
        ingest: { summary: summary(row.ingest), samples: row.ingest },
        initialization: [],
        drain: [],
      };
      for (let i = 0; i < 4; i += 1) {
        const before = c.db
          .prepare(`SELECT delivery_id FROM ${table}`)
          .all()
          .map((r) => r.delivery_id);
        c.store.ingest(delivery(`drain-${i}`, now + i), now + i);
        const retained = new Set(
          c.db
            .prepare(`SELECT delivery_id FROM ${table}`)
            .all()
            .map((r) => r.delivery_id),
        );
        const deleted = before.filter((id) => !retained.has(id)).sort();
        assert.deepEqual(
          deleted,
          Array.from({ length: Math.min(256, Math.max(0, expired - i * 256)) }, (_, j) =>
            guid(i * 256 + j),
          ).sort(),
        );
        const state = snapshot(c.db);
        if (variant === "baseline") states.push(state);
        else assert.deepEqual(state, states[i]);
        entry.drain.push({ deleted, stateSha256: hash(JSON.stringify(state)) });
      }
      c.db.close();
      for (let repeat = 0; repeat < 5; repeat += 1) {
        const file = path.join(out, `${n}-${expired}-${variant}-${repeat}.sqlite`);
        copyFileSync(seedFile, file);
        const reopened = connect(variant, file);
        const before = snapshot(reopened.db);
        const pagesBefore = reopened.db.prepare("PRAGMA page_count").get().page_count;
        const init = timed(() => reopened.store.ensureSchemaSync());
        const indexBuild = reopened.adapter.indexBuild;
        const repeated = Array.from({ length: 5 }, () =>
          timed(() => reopened.store.ensureSchemaSync()),
        );
        assert.deepEqual(snapshot(reopened.db), before);
        const pagesAfter = reopened.db.prepare("PRAGMA page_count").get().page_count;
        const pageSize = reopened.db.prepare("PRAGMA page_size").get().page_size;
        const ingest = timed(() => reopened.store.ingest(payload, now));
        assert.deepEqual(ingest.value, { accepted: true, deduped: false, watermark: n + 1 });
        assert.equal(reopened.adapter.deleted, expired ? 256 : 0);
        assert.equal(reopened.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        entry.initialization.push({
          init,
          indexBuild,
          repeated,
          addedBytes: (pagesAfter - pagesBefore) * pageSize,
          reopenedIngest: ingest,
        });
        reopened.db.close();
      }
      result.cases.push(entry);
      console.log(
        JSON.stringify({
          n,
          expired,
          variant,
          delete: entry.delete.summary,
          ingest: entry.ingest.summary,
        }),
      );
    }
  }
// Runtime controls complement the existing test owner's late-object/watermark coverage.
for (const tied of [false, true]) {
  const controls = [];
  for (const variant of Object.keys(modules)) {
    const c = connect(variant);
    seed(c, 1000, 600, tied);
    c.db.prepare(`UPDATE ${table} SET received_at=? WHERE delivery_id=?`).run(cutoff, guid(600));
    c.db
      .prepare(`UPDATE ${table} SET received_at=? WHERE delivery_id=?`)
      .run(cutoff + 1, guid(601));
    const before = snapshot(c.db);
    assert.deepEqual(c.store.ingest(delivery(guid(0)), now), {
      accepted: true,
      deduped: true,
      watermark: 1,
    });
    assert.deepEqual(snapshot(c.db), before);
    c.adapter.failAfterPrune = true;
    assert.throws(() => c.store.ingest(payload, now), /injected failure after receipt prune/);
    assert.equal(c.adapter.deleted, 256);
    assert.deepEqual(snapshot(c.db), before);
    const batches = [];
    for (let i = 0; i < 4; i += 1) {
      const previous = new Set(
        c.db
          .prepare(`SELECT delivery_id FROM ${table}`)
          .all()
          .map((r) => r.delivery_id),
      );
      assert.deepEqual(c.store.ingest(delivery(`semantic-${i}`), now), {
        accepted: true,
        deduped: false,
        watermark: 1001 + i,
      });
      const remaining = new Set(
        c.db
          .prepare(`SELECT delivery_id FROM ${table}`)
          .all()
          .map((r) => r.delivery_id),
      );
      const deleted = [...previous].filter((id) => !remaining.has(id)).sort();
      assert.equal(deleted.length, [256, 256, 88, 0][i]);
      batches.push({ deleted, state: snapshot(c.db) });
    }
    assert.deepEqual(
      c.db
        .prepare(`SELECT delivery_id FROM ${table} WHERE received_at<=? ORDER BY received_at`)
        .all(cutoff + 1)
        .map((r) => r.delivery_id),
      [guid(600), guid(601)],
    );
    const drained = snapshot(c.db);
    assert.deepEqual(c.store.ingest(delivery("semantic-0"), now), {
      accepted: true,
      deduped: true,
      watermark: 1001,
    });
    assert.deepEqual(snapshot(c.db), drained);
    assert.deepEqual(c.store.ingest(delivery(guid(0)), now), {
      accepted: true,
      deduped: false,
      watermark: 1005,
    });
    controls.push({ batches, replayed: snapshot(c.db) });
    c.db.close();
  }
  assert.deepEqual(controls[1], controls[0]);
  result.semantics.push({
    tied,
    rollbackAndReplay: "passed",
    batches: controls[0].batches.map(({ deleted, state }) => ({
      deleted,
      stateSha256: hash(JSON.stringify(state)),
    })),
    replayedSha256: hash(JSON.stringify(controls[0].replayed)),
  });
}
for (const file of sources)
  assert.equal(
    hash(readFileSync(path.join(root, file))),
    manifest.sources.patched[file].sha256,
    "working source changed during proof",
  );
assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), manifest.harnessSha256);
result.finishedAt = new Date().toISOString();
result.loadEnd = os.loadavg();
result.result = "PASS";
save("results.json", result);
console.log(
  `PASS: source identity, indexed plans, exact deleted IDs/full states, upgrade/idempotence, cutoff/replay and rollback. Artifacts: ${out}`,
);
