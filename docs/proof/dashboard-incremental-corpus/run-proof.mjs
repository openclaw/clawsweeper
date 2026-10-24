// End-to-end proof of the incremental dashboard corpus against the real exact-review queue.
//
//   pnpm run build && pnpm --dir dashboard-site install --frozen-lockfile
//   node docs/proof/dashboard-incremental-corpus/run-proof.mjs
//
// Drives the real CLIs against the local production Worker (fixture.mjs):
// scripts/worker-records.ts snapshot-upload, scripts/dashboard-corpus.ts refresh/pack/unpack and
// dashboard-site/scripts/build-corpus.ts, counting every Worker request per phase, then builds
// the static site from the produced corpus.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { combineCorpus } from "../../../dashboard-site/scripts/records.ts";
import {
  afterSnapshotWrites,
  bin,
  busyHourWrites,
  PRIVATE_REPO,
  PUBLIC_REPOS,
  recordWriter,
  repoRoot,
  secret,
  seedWrites,
  startWorker,
} from "./fixture.mjs";

const execFileAsync = promisify(execFile);
const worker = await startWorker();
const { root, baseUrl } = worker;
const publishAll = recordWriter(worker.workerUrl);
const siteData = path.join(repoRoot, "dashboard-site/src/data/dashboard.json");
const siteDataBackup = path.join(root, "dashboard.json.backup");
const restoreSiteData = () => {
  if (existsSync(siteDataBackup)) copyFileSync(siteDataBackup, siteData);
  else rmSync(siteData, { force: true });
};

const cliEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CLAWSWEEPER_RECORDS_URL: baseUrl,
  CLAWSWEEPER_RECORDS_SECRET: secret,
};
async function node(args, env = cliEnv) {
  const started = performance.now();
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const last = stdout.trim().split("\n").at(-1);
  return { wallMs: Math.round(performance.now() - started), output: last ? JSON.parse(last) : null };
}
const phases = [];
async function phase(label, args, env) {
  worker.resetCounts();
  const result = await node(args, env);
  phases.push({ label, wallMs: result.wallMs, ...worker.counts, summary: result.output });
  return { ...worker.counts, output: result.output };
}
const refresh = (label, state, mode) =>
  phase(label, ["scripts/dashboard-corpus.ts", "refresh", "--state", state, "--mode", mode]);
// The workflow's visibility cache keeps public answers only, so the private fixture is answered
// again before every aggregate (GitHub's 404 in the workflow; offline here).
async function aggregate(label, state, out) {
  mkdirSync(out, { recursive: true });
  const visibilityPath = path.join(out, "visibility.json");
  const cached = existsSync(visibilityPath) ? JSON.parse(readFileSync(visibilityPath, "utf8")) : {};
  const checkedAt = new Date().toISOString();
  for (const repo of PUBLIC_REPOS) cached[repo] ??= { public: true, checkedAt };
  cached[PRIVATE_REPO] = { public: false, checkedAt };
  writeFileSync(visibilityPath, JSON.stringify(cached));
  await phase(label, [
    "dashboard-site/scripts/build-corpus.ts",
    "--records",
    path.join(state, "records"),
    "--out",
    out,
  ]);
  return JSON.parse(readFileSync(path.join(out, "corpus.json"), "utf8"));
}
function tree(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}
const withoutTime = (corpus) => ({ ...corpus, generatedAt: undefined });

try {
  // 1. Seed, store an R2 snapshot of the largest repository, then write past its watermark.
  const seed = seedWrites();
  let started = performance.now();
  await publishAll(seed);
  const seedMs = Math.round(performance.now() - started);
  const snapshot = await phase("snapshot upload (openclaw-openclaw)", [
    "scripts/worker-records.ts",
    "snapshot-upload",
    "--repo-slug",
    "openclaw-openclaw",
    "--records-url",
    baseUrl,
  ]);
  assert.ok(snapshot.output.fileCount >= 1500);
  const afterSnapshot = afterSnapshotWrites();
  await publishAll(afterSnapshot);

  // 2. Full rebuild, aggregate and seal; a fresh runner then unseals the archive.
  const live = path.join(root, "live");
  const full = await refresh("full rebuild", live, "full");
  assert.equal(full.output.mode, "full");
  const fullTree = tree(path.join(live, "records"));
  assert.equal(Object.keys(fullTree).length, 1960);
  assert.ok(Object.keys(fullTree).every((file) => /\/(items|closed)\/\d+\.md$/.test(file)));
  assert.ok(Object.values(fullTree).every((content) => !content.includes("Synthetic report body")));
  const out = path.join(root, "dashboard-corpus");
  assert.equal((await aggregate("aggregate after full rebuild", live, out)).excludedRepositories, 1);
  const archive = path.join(root, "corpus-cache", "tree.sealed");
  await phase("seal tree", ["scripts/dashboard-corpus.ts", "pack", "--state", live, "--archive", archive]);
  const sealed = readFileSync(archive);
  assert.equal(sealed.includes(Buffer.from("private-corpus-fixture")), false);
  assert.equal(sealed.includes(Buffer.from("Synthetic item")), false);
  rmSync(live, { recursive: true, force: true });
  started = performance.now();
  await node(["scripts/dashboard-corpus.ts", "unpack", "--archive", archive, "--state", live]);
  const unsealMs = Math.round(performance.now() - started);
  assert.deepEqual(tree(path.join(live, "records")), fullTree);

  // 3. Nothing changed: one slug listing and no export page.
  const idle = await refresh("incremental, nothing changed", live, "incremental");
  assert.equal(idle.requests, 1);
  assert.equal(idle.output.unchanged, 3);

  // 4. A busy hour through the production write path.
  const hour = busyHourWrites();
  await publishAll(hour);
  const busy = await refresh("incremental, busy hour", live, "incremental");
  assert.equal(busy.output.bootstrapped, 1);
  assert.equal(busy.output.refreshed, 3);

  // 5. A failing refresh (wrong secret) leaves tree and cursor untouched.
  const beforeFailure = tree(live);
  await assert.rejects(
    node(["scripts/dashboard-corpus.ts", "refresh", "--state", live, "--mode", "incremental"], {
      ...cliEnv,
      CLAWSWEEPER_RECORDS_SECRET: "wrong-secret",
    }),
  );
  assert.deepEqual(tree(live), beforeFailure);

  // 6. The incremental tree and corpus equal a fresh full rebuild of the same store.
  const incremental = await aggregate("aggregate after incremental", live, out);
  const fresh = path.join(root, "fresh");
  await refresh("fresh full rebuild (comparison)", fresh, "full");
  assert.deepEqual(tree(path.join(live, "records")), tree(path.join(fresh, "records")));
  const rebuilt = await aggregate("aggregate of fresh rebuild", fresh, path.join(root, "fresh-out"));
  assert.deepEqual(withoutTime(incremental), withoutTime(rebuilt));
  const totals = Object.fromEntries(incremental.repositories.map((part) => [part.stats.repo, part.totals]));
  assert.deepEqual(Object.keys(totals).sort(), ["openclaw/clawhub", "openclaw/fs-safe", "openclaw/openclaw"]);
  assert.equal(incremental.excludedRepositories, 1);
  for (const file of ["visibility.json", "corpus.json"])
    assert.equal(readFileSync(path.join(out, file), "utf8").includes("private-corpus-fixture"), false);

  // 7. Build the static site from the produced corpus, combined the way build-data.ts does;
  //    live queue, Actions and operations data come from the committed fixture.
  if (existsSync(siteData)) copyFileSync(siteData, siteDataBackup);
  const fixture = JSON.parse(readFileSync(path.join(repoRoot, "dashboard-site/fixtures/dashboard.json"), "utf8"));
  const corpus = combineCorpus(incremental, (repo) => PUBLIC_REPOS.includes(repo));
  mkdirSync(path.dirname(siteData), { recursive: true });
  writeFileSync(siteData, JSON.stringify({ ...fixture, generatedAt: new Date().toISOString(), corpus }));
  started = performance.now();
  await execFileAsync(bin("astro"), ["build"], {
    cwd: path.join(repoRoot, "dashboard-site"),
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const siteBuildMs = Math.round(performance.now() - started);
  const pages = tree(path.join(repoRoot, "dashboard-site/dist"));
  const html = Object.entries(pages)
    .filter(([file]) => file.endsWith(".html"))
    .map(([, content]) => content)
    .join("\n");
  assert.ok(html.includes("openclaw/fs-safe"), "the site lists the incrementally bootstrapped repository");
  assert.equal(html.includes("private-corpus-fixture"), false);
  const recordTotal = corpus.totals.records.toLocaleString("en-US");
  assert.ok(html.includes(recordTotal), "the site shows the corpus record total " + recordTotal);

  console.log(
    JSON.stringify(
      {
        source: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim(),
        runtime: "wrangler 4.131.1 dev --local (workerd, SQLite Durable Object, local R2)",
        node: process.version,
        seeded: { tuples: seed.length + afterSnapshot.length, ms: seedMs },
        busyHourTuples: hour.length,
        treeFiles: Object.keys(fullTree).length,
        sealedBytes: statSync(archive).size,
        unsealMs,
        phases,
        corpus: { totals, excludedRepositories: incremental.excludedRepositories },
        site: {
          buildMs: siteBuildMs,
          htmlPages: Object.keys(pages).filter((file) => file.endsWith(".html")).length,
          recordTotalShown: recordTotal,
        },
        limits: "controlled loopback fixture; no production Cloudflare, Actions cache or GitHub throughput claim",
      },
      null,
      2,
    ),
  );
} finally {
  await worker.cleanup(restoreSiteData);
}
