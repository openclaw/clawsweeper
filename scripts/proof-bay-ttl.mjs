// Synthetic SQLite runtime proof: node scripts/proof-bay-ttl.mjs BASE_SHA OUTPUT_DIR
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [baseRef, output] = process.argv.slice(2);
assert.ok(baseRef && output, "expected BASE_SHA and fresh OUTPUT_DIR");
mkdirSync(output); // Never overwrite an earlier proof.
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const base = git("rev-parse", `${baseRef}^{commit}`);
const file = "dashboard/exact-review-lifecycle.ts";
const modules = {};
const hashes = {};
for (const variant of ["before", "after"]) {
  const source =
    variant === "before"
      ? git("show", `${base}:${file}`)
      : readFileSync(path.join(root, file), "utf8");
  const dest = path.resolve(output, `${variant}.ts`);
  writeFileSync(dest, source);
  hashes[variant] = createHash("sha256").update(source).digest("hex");
  modules[variant] = await import(pathToFileURL(dest).href);
}
const db = new DatabaseSync(":memory:");
let queries = 0;
let rows = 0;
let bytes = 0;
const storage = {
  sql: {
    exec(query, ...bindings) {
      queries++;
      const statement = db.prepare(query);
      if (!/^\s*SELECT\b/i.test(query)) {
        statement.run(...bindings);
        return [];
      }
      return (function* () {
        for (const row of statement.iterate(...bindings)) {
          rows++;
          bytes += Buffer.byteLength(String(row.projection_json ?? row.bay_json ?? ""));
          yield row;
        }
      })();
    },
  },
  transactionSync(callback) {
    db.exec("BEGIN");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
};
const now = Date.parse("2026-09-04T00:00:00Z");
const baseline = new modules.before.ExactReviewLifecycleProjectionStore(storage);
baseline.ensureSchemaSync();
baseline.recordAdmission({
  canonicalTargetKey: "openclaw/openclaw#1",
  fenceKey: "fence:1",
  revision: 1,
  deliveryId: "synthetic",
  sourceAction: "opened",
  commandOriginated: false,
  statusMarker: null,
  statusCommentId: null,
  observedAt: now,
});
const seed = baseline.read("openclaw/openclaw#1", "fence:1", 1);
db.exec("DELETE FROM exact_review_lifecycle_projection_v1");
const insert = db.prepare(
  "INSERT INTO exact_review_lifecycle_projection_v1 (canonical_target_key, fence_key, revision, projection_json, updated_at) VALUES (?, ?, ?, ?, ?)",
);
const kinds = [
  null,
  "review_completed_routed",
  "superseded",
  "requeue",
  "dead_letter",
  "failure",
  "guarded_open",
  "policy_noop",
  "target_closed",
  "target_missing",
];
const fixtureHash = createHash("sha256");
storage.transactionSync(() => {
  for (let n = 1; n <= 20_000; n++) {
    const repo = n % 5 === 0 ? "openclaw/clawhub" : "openclaw/openclaw";
    const projection = structuredClone(seed);
    Object.assign(projection, {
      canonicalTargetKey: `${repo}#${Math.ceil(n / 2)}`,
      fenceKey: `fence:${n}`,
      revision: (n % 2) + 1,
      updatedAt: now - n * 60_000,
    });
    projection.admission.commandOriginated = n % 3 === 0;
    projection.acknowledgement.required = n % 3 === 0;
    const kind = kinds[n % kinds.length];
    if (kind) {
      projection.terminalDisposition = { kind, observedAt: projection.updatedAt };
      projection.terminalDispositions = [projection.terminalDisposition];
    }
    projection.claims = Array.from({ length: n % 8 }, (_, i) => ({
      fenceKey: projection.fenceKey,
      claimGeneration: i + 1,
      runId: String(1000 + i),
      runAttempt: 1,
      claimedAt: projection.updatedAt,
    }));
    projection.reviewResults = projection.claims.map(({ claimedAt, ...claim }) => ({
      ...claim,
      observedAt: claimedAt,
      outcome: "completed",
    }));
    if (n % 4) {
      projection.canonicalReceipts = [
        {
          outcome: n % 2 ? "accepted" : "deduped",
          receiptId: `receipt:${n}`,
          observedAt: projection.updatedAt,
        },
      ];
      projection.routerReceipt = {
        outcome: "durable",
        receiptId: `router:${n}`,
        observedAt: projection.updatedAt,
      };
      projection.routerReceipts = [projection.routerReceipt];
    }
    if (n % 6 === 0)
      projection.acknowledgement.observed = {
        commandCommentId: n,
        completionCommentId: n + 1,
        statusMarker: null,
        observedAt: projection.updatedAt,
      };
    if (n % 7 === 0) {
      delete projection.routerReceipts;
      delete projection.terminalDispositions;
      delete projection.terminalOperationIds;
      delete projection.bayTelemetryPending;
    }
    const json = JSON.stringify(projection);
    fixtureHash.update(json);
    insert.run(
      projection.canonicalTargetKey,
      projection.fenceKey,
      projection.revision,
      json,
      projection.updatedAt,
    );
  }
});
const changes = db.prepare("SELECT total_changes() AS n").get().n;
db.exec("PRAGMA query_only = ON");
const results = {};
let reference;
for (const variant of ["before", "after"]) {
  const store = new modules[variant].ExactReviewLifecycleProjectionStore(storage);
  const times = [];
  const walls = [];
  queries = rows = bytes = 0;
  for (let i = 0; i < 11; i++) {
    const start = process.cpuUsage();
    const wall = performance.now();
    const snapshot = store.readBaySnapshot(now, new Set(["openclaw/openclaw", "openclaw/clawhub"]));
    walls.push(performance.now() - wall);
    const cpu = process.cpuUsage(start);
    times.push((cpu.user + cpu.system) / 1000);
    assert.equal(snapshot.collection.state, "complete");
    assert.equal(snapshot.inventory.lifecycle_records, 20_000);
    if (!reference) reference = snapshot;
    assert.deepEqual(snapshot, reference, "full and compact materialization must be identical");
  }
  times.sort((a, b) => a - b);
  walls.sort((a, b) => a - b);
  results[variant] = {
    median_cpu_ms: times[5],
    max_cpu_ms: times.at(-1),
    median_wall_ms: walls[5],
    queries_per_build: queries / 11,
    rows_per_build: rows / 11,
    json_bytes_per_build: bytes / 11,
  };
}
assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
const report = {
  base,
  head: git("rev-parse", "HEAD"),
  source_sha256: hashes,
  fixture_sha256: fixtureHash.digest("hex"),
  provider: "local-process",
  lease: null,
  runtime: process.version,
  platform: `${os.platform()}/${os.arch()}`,
  sqlite: db.prepare("SELECT sqlite_version() AS v").get().v,
  projections: 20_000,
  samples: 11,
  results,
  equivalence: true,
  read_only: true,
  limits:
    "Synthetic in-memory SQLite and real production projection code; not Cloudflare CPU or cross-colo cache proof. Projection history remains an unbounded scan. No live services contacted.",
};
writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
db.close();
