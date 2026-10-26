import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { materializeWorkerRecords, signedPost } from "../../../scripts/worker-records.ts";
const require = createRequire(path.resolve(process.env.PROOF_TOOL_ROOT || ".", "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const scratch = path.resolve(".artifacts/record-hydration");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(path.join(scratch, "native-"));
const baselineSha = "118a07468663a22e9cc0e3fd76dfe2f17532eec0";
const archive = process.env.PROOF_BASELINE_ARCHIVE || path.join(scratch, "baseline.tar");
if (!existsSync(archive))
  writeFileSync(
    archive,
    execFileSync("git", ["archive", baselineSha, "dashboard", "src", "config", "package.json"], {
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
mkdirSync(path.join(root, "baseline"));
execFileSync("tar", ["-xf", archive, "-C", path.join(root, "baseline")]);
const secret = "synthetic-record-export-secret",
  repoSlug = "example-project";
const report = {
  baselineSha,
  baselineArchiveSha256: hash(readFileSync(archive)),
  sourceHead:
    process.env.PROOF_SOURCE_HEAD ||
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  provider: process.env.PROOF_PROVIDER || "host diagnostic only",
  lease: process.env.PROOF_LEASE || null,
  image: process.env.PROOF_IMAGE || null,
  sourceSha256: hash(readFileSync("dashboard/exact-review-direct-publication.ts")),
  fixtureSha256: hash(readFileSync("docs/proof/record-export-concurrency/worker.ts")),
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  esbuild: require("esbuild/package.json").version,
  node: process.version,
  delayMs: 20,
  deadlineMs: 1000,
  variants: {},
  limits:
    "Controlled latency, loopback HTTP, native SQLite/R2; no production capacity, introduction commit, or recovery claim.",
};
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
let mf;
try {
  for (const variant of process.env.PROOF_BASELINE_ONLY
    ? ["baseline"]
    : ["baseline", "candidate"]) {
    const bundle = await build({
      entryPoints: ["docs/proof/record-export-concurrency/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:*", "node:*"],
      plugins:
        variant === "baseline"
          ? [
              {
                name: "frozen-source",
                setup(api) {
                  api.onResolve({ filter: /\.ts$/ }, (args) => {
                    const resolved = path.resolve(args.resolveDir, args.path),
                      relative = path.relative(process.cwd(), resolved);
                    if (/^(dashboard|src|config)\//.test(relative))
                      return { path: path.join(root, "baseline", relative) };
                  });
                },
              },
            ]
          : [],
    });
    const options = {
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-05-11",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      host: "127.0.0.1",
      durableObjects: {
        EXACT_REVIEW_QUEUE: { className: "Queue", useSQLite: true },
        STATUS_STORE: { className: "StatusStore", useSQLite: true },
      },
      r2Buckets: ["STATE_SNAPSHOTS"],
      bindings: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
      outboundService: () => new Response("external fetch prohibited", { status: 503 }),
    };
    mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    const baseUrl = (await mf.ready).origin;
    async function fixture(route, body = {}) {
      const res = await fetch(baseUrl + "/fixture" + route, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 1000));
      return JSON.parse(text);
    }
    async function signed(endpoint, body = {}) {
      return signedPost({ baseUrl, webhookSecret: secret, path: endpoint, body });
    }
    async function allRecords() {
      const records = [],
        cursors = [];
      let cursor = 0,
        revision;
      for (let i = 0; i < 10; i++) {
        const page = await signed("/internal/state/records/export", {
          repoSlug,
          cursor,
          limit: 200,
        });
        revision ??= page.revision;
        assert.equal(page.revision, revision);
        records.push(...page.records);
        cursors.push(page.nextCursor);
        if (page.nextCursor === null) return { records, revision, cursors };
        assert.ok(page.nextCursor > cursor);
        cursor = page.nextCursor;
      }
      throw Error("export cursor stalled");
    }
    await fixture("/fixture-seed");
    const facts = await fixture("/inspect");
    assert.ok(facts.v1 > 0 && facts.v2 > 0);
    await fixture("/r2-controls", { delayMs: report.delayMs });
    const list = await signed("/internal/state/records/list", {
      repoSlug,
      section: "items",
      limit: 500,
    });
    const listMetrics = await fixture("/r2-metrics");
    assert.equal(listMetrics.calls, 0);
    const started = performance.now();
    const exported = await allRecords();
    const wallMs = Math.round(performance.now() - started),
      metrics = await fixture("/r2-metrics");
    assert.equal(metrics.active, 0);
    assert.equal(exported.records.length, 135);
    assert.ok(exported.cursors.length > 1);
    for (const record of exported.records)
      if (!record.deleted) assert.equal(hash(record.content), record.digest);
    const entry = (report.variants[variant] = {
      wallMs,
      withinDeadline: wallMs < report.deadlineMs,
      metrics,
      listCount: list.records.length,
      listMetrics,
      v1: facts.v1,
      v2: facts.v2,
      watermark: exported.revision,
      coverageDigest: hash(JSON.stringify(await fixture("/facts"))),
      digest: hash(JSON.stringify(exported)),
    });
    if (variant === "baseline") assert.equal(metrics.peak, 1);
    else {
      assert.ok(metrics.peak > 1 && metrics.peak <= 4);
      assert.equal(entry.digest, report.variants.baseline.digest);
      assert.equal(report.variants.baseline.withinDeadline, false);
      assert.equal(entry.withinDeadline, true);
      assert.equal(entry.coverageDigest, report.variants.baseline.coverageDigest);
    }
    if (!process.env.PROOF_BASELINE_ONLY) {
      await fixture("/r2-controls");
      // Actual CLI, not a synthetic snapshot writer. Environment contains only fixture auth.
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "scripts/worker-records.ts",
            "snapshot-upload",
            "--repo-slug",
            repoSlug,
            "--records-url",
            baseUrl,
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              CLAWSWEEPER_WEBHOOK_SECRET: secret,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (b) => (output += b));
        child.stderr.on("data", (b) => (output += b));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve(output) : reject(Error(output))));
      });
      await fixture("/fixture-delta");
      const current = await allRecords();
      const hydrated = await materializeWorkerRecords({
        worktreeRoot: path.join(root, "hydrated"),
        baseUrl,
        webhookSecret: secret,
        repoSlugs: [repoSlug],
        log: () => {},
      });
      for (const record of current.records.filter((r) => !r.deleted))
        assert.equal(
          readFileSync(
            path.join(
              hydrated.recordsRoot,
              repoSlug,
              record.section,
              record.id + (record.section === "decision-packets" ? ".json" : ".md"),
            ),
            "utf8",
          ),
          record.content,
        );
      entry.snapshotCliRoundtrip = hydrated.repositories[repoSlug];
      assert.ok(entry.snapshotCliRoundtrip.deltaRecords > 0);
      for (const record of current.records.filter((r) => r.deleted))
        assert.equal(
          existsSync(
            path.join(
              hydrated.recordsRoot,
              repoSlug,
              record.section,
              record.id + (record.section === "decision-packets" ? ".json" : ".md"),
            ),
          ),
          false,
        );
      if (variant === "candidate") {
        await fixture("/r2-controls", { delayMs: 20, failAt: 2 });
        const body = JSON.stringify({ repoSlug, limit: 200 });
        const failed = await fetch(baseUrl + "/internal/state/records/export", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature":
              "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
          },
        });
        assert.equal(failed.status, 500);
        await failed.text();
        entry.failureDrain = await fixture("/r2-metrics");
        assert.equal(entry.failureDrain.active, 0);
        assert.ok(entry.failureDrain.calls <= 4);
        await fixture("/r2-controls");
        for (const fault of [{ sameSize: true }, { missing: true }]) {
          await fixture("/corrupt", { id: 3, ...fault });
          const res = await fetch(baseUrl + "/internal/state/records/export", {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-clawsweeper-exact-review-signature":
                "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
            },
          });
          assert.equal(res.status, 500);
          await res.text();
          assert.equal((await fixture("/r2-metrics")).active, 0);
        }
        entry.missingAndCorruptRefused = true;
      }
    }
    console.log(variant, JSON.stringify(entry));
    await mf.dispose();
    mf = null;
  }
  report.passed = true;
} finally {
  if (mf) await mf.dispose();
  writeFileSync(
    process.env.PROOF_OUTPUT || path.join(scratch, "native-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  rmSync(root, { recursive: true, force: true });
}
