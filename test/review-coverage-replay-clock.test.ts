import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureCompatibilityBrowser } from "../docs/proof/review-coverage-census/compatibility-browser.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  verifiedCoverageBuildRead,
  syntheticPublicMetadata,
} from "../docs/proof/ui-live-coverage/coverage-build-read.mjs";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import { REVIEW_COVERAGE_INVENTORY_KEY } from "../dashboard/exact-review-direct-publication.ts";
import { liveCoverage } from "../dashboard-site/src/lib/live-coverage.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import {
  installReplayClock,
  replayCaption,
  withReplayClock,
} from "../docs/proof/ui-live-coverage/replay-clock.mjs";

const evaluationAt = "2026-11-02T21:55:57.211Z";
const captured = Date.parse(evaluationAt);
const later = captured + 3 * 86400000;
const OriginalDate = Date;

function fixture() {
  // Synthetic, count-only OCM/CodexBar-shaped witness. Not newly fetched data.
  const inventory = {
    generated_at: evaluationAt,
    repositories: [
      ["openclaw/ocm", 7],
      ["steipete/codexbar", 98],
    ].map(([repo, count]) => ({
      repo,
      repo_slug: String(repo).replace("/", "-"),
      visibility: "public",
      observation_scope: "observed",
      open_issues: count,
      open_pull_requests: 0,
      counts_observed_at: evaluationAt,
      complete: false,
      missing_fields: ["labels", "latest_reopen"],
    })),
  };
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  storage.kv.put(REVIEW_COVERAGE_INVENTORY_KEY, inventory);
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-clock-build-secret",
    EXACT_REVIEW_QUEUE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => queue.fetch(request) }),
    },
  };
  const read = async () => {
    // Canonical evidence was not captured; do not infer missing reviews from an empty DB.
    storage.failNextSqlMatching(/SELECT MIN\(repo_slug\)/);
    return await verifiedCoverageBuildRead(
      (url: string, init: RequestInit) => worker.fetch(new Request(String(url), init), env),
      "synthetic-clock-build-secret",
      syntheticPublicMetadata("openclaw/ocm", "steipete/codexbar"),
    );
  };
  return { inventory, storage, read };
}

test("scoped replay controls Date reads but preserves native timing and restores after success", async () => {
  const timeout = setTimeout,
    interval = setInterval,
    monotonic = performance.now(),
    hr = process.hrtime.bigint();
  await withReplayClock(captured, async () => {
    assert.equal(Date.now(), captured);
    assert.equal(new Date().toISOString(), evaluationAt);
    assert.equal(new Date(123).getTime(), 123);
    assert.equal(Date.parse(evaluationAt), captured);
    assert.equal(typeof Date(), "string");
    assert.equal(setTimeout, timeout);
    assert.equal(setInterval, interval);
    await new Promise((done) => setTimeout(done, 5));
    assert.ok(performance.now() > monotonic);
    assert.ok(process.hrtime.bigint() > hr);
    assert.equal(Date.now(), captured);
  });
  assert.equal(Date, OriginalDate);
});

test("replay clock restores through failures and nested scopes; invalid time cannot install a clock", async () => {
  const failure = new Error("synthetic failure");
  await assert.rejects(
    withReplayClock(captured, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(Date, OriginalDate);
  await assert.rejects(
    withReplayClock(captured, async () => {
      await Promise.resolve();
      throw failure;
    }),
  );
  assert.equal(Date, OriginalDate);
  await withReplayClock(later, async () => {
    await assert.rejects(
      withReplayClock(captured, async () => {
        throw failure;
      }),
    );
    assert.equal(Date.now(), later);
  });
  assert.equal(Date, OriginalDate);
  assert.throws(() => installReplayClock("invalid"), /valid explicit replay/);
  assert.equal(Date, OriginalDate);
});

test("same untouched count observations are stale three days later but actual Worker and consumer render 7 and98 at captured evaluation", async () => {
  const f = fixture(),
    original = JSON.stringify(f.inventory);
  await withReplayClock(later, async () => {
    const stale = await f.read();
    assert.equal(stale.totals.open_records, null);
    assert.equal(liveCoverage(stale).countKnown, false);
    const replay = await withReplayClock(captured, f.read);
    assert.equal(replay.generated_at, evaluationAt);
    assert.equal(replay.counts_observed_at, evaluationAt);
    assert.deepEqual(
      replay.fleets.map((row: any) => row.open_records),
      [7, 98],
    );
    assert.equal(liveCoverage(replay, captured).open_records, 105);
    assert.equal(
      liveCoverage(replay).open_records,
      null,
      "unchanged real-time consumer rejects old observations at simulated later wall time",
    );
    assert.equal(Date.now(), later);
  });
  assert.equal(Date, OriginalDate);
  assert.equal(JSON.stringify(f.inventory), original);
  assert.deepEqual(f.storage.kv.get(REVIEW_COVERAGE_INVENTORY_KEY), f.inventory);
  assert.equal(
    f.inventory.repositories.some(
      (row) => "labels" in row || "timelineItems" in row || "head_sha" in row,
    ),
    false,
  );
});

test("explicit child preload fixes the actual production UI consumer without changing observation timestamps", async () => {
  const input = await withReplayClock(captured, fixture().read);
  const serialized = JSON.stringify(input);
  const preload = resolve("docs/proof/ui-live-coverage/replay-clock-preload.mjs");
  const modelUrl = pathToFileURL(resolve("dashboard-site/src/lib/live-coverage.ts")).href;
  const program =
    'import{readFileSync}from"node:fs";import{liveCoverage}from' +
    JSON.stringify(modelUrl) +
    ';const input=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({now:Date.now(),iso:new Date().toISOString(),model:liveCoverage(input),input}))';
  for (const at of [evaluationAt, new OriginalDate(later).toISOString()]) {
    const run = spawnSync(
      process.execPath,
      ["--import", preload, "--input-type=module", "-e", program],
      {
        input: serialized,
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH, CLAWSWEEPER_PROOF_EVALUATION_AT: at },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.iso, at);
    assert.equal(result.now, OriginalDate.parse(at));
    assert.deepEqual(result.input, input);
    assert.equal(result.model.open_records, at === evaluationAt ? 105 : null);
    if (at === evaluationAt)
      assert.deepEqual(
        result.model.rows.map((row: any) => row.open_records),
        [7, 98],
      );
  }
  const missing = spawnSync(process.execPath, ["--import", preload, "-e", ""], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Explicit CLAWSWEEPER_PROOF_EVALUATION_AT/);
  const failed = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      "-e",
      'const real=Date.prototype.constructor;process.on("exit",()=>console.log(Date===real));throw new Error("synthetic child failure")',
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CLAWSWEEPER_PROOF_EVALUATION_AT: evaluationAt },
    },
  );
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout.trim(), "true", "preload restores Date on failing child exit");
  assert.match(failed.stderr, /synthetic child failure/);
  assert.equal(Date, OriginalDate);
});

test("native socket inactivity expiry still fires under a controlled wall clock", async () => {
  const server = createServer((socket) => socket.unref());
  let client: ReturnType<typeof createConnection> | undefined;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await withReplayClock(
      captured,
      () =>
        new Promise<void>((done, reject) => {
          const guard = setTimeout(
            () => reject(new Error("native socket timer did not expire")),
            5000,
          );
          client = createConnection((server.address() as any).port, "127.0.0.1");
          client.once("error", (error) => {
            clearTimeout(guard);
            reject(error);
          });
          client.setTimeout(10, () => {
            clearTimeout(guard);
            done();
          });
        }),
    );
  } finally {
    client?.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
  assert.equal(Date, OriginalDate);
});

test("proof caption separates real execution from as-of evaluation and leaves browser clock real", () => {
  const caption = replayCaption(captured, new OriginalDate(later).toISOString());
  assert.match(caption, /FROZEN INPUT REPLAY/);
  assert.ok(caption.includes(evaluationAt));
  assert.ok(caption.includes(new OriginalDate(later).toISOString()));
  assert.match(caption, /browser uses real wall time/);
  assert.match(caption, /not a newly observed production outage/);
  const source = readFileSync("docs/proof/ui-live-coverage/post-producer-replay.mjs", "utf8");
  assert.match(source, /withReplayClock\(sourceNow, \(\) => module.fetch/);
  assert.match(source, /"--import",/);
  assert.match(source, /CLAWSWEEPER_PROOF_EVALUATION_AT: evaluationAt/);
  assert.match(source, /executionStartedAt/);
  assert.match(source, /proofCaption: caption/);
  assert.doesNotMatch(source, /addInitScript|page\.clock|context\.clock/);
});

test("compatibility Astro build handoff executes the actual ISO replay preload without replacing native timers", async () => {
  const root = process.cwd(),
    artifacts = join(root, ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const scratch = mkdtempSync(join(artifacts, "compatibility-clock-")),
    site = join(scratch, "dashboard-site"),
    docs = join(scratch, "docs/proof/ui-live-coverage"),
    data = join(site, "src/data/dashboard.json"),
    savedData = '{"source":"restore-this-exact-byte-snapshot"}\n';
  mkdirSync(join(site, "fixtures"), { recursive: true });
  mkdirSync(join(site, "src/data"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  copyFileSync(
    join(root, "dashboard-site/fixtures/dashboard.json"),
    join(site, "fixtures/dashboard.json"),
  );
  for (const name of ["replay-clock-preload.mjs", "replay-clock.mjs"])
    copyFileSync(join(root, "docs/proof/ui-live-coverage", name), join(docs, name));
  writeFileSync(data, savedData);
  const evaluation = "2026-10-31T05:12:34.000Z",
    originalSpawn = childProcess.spawnSync,
    originalDate = Date,
    priorEvaluation = process.env.CLAWSWEEPER_PROOF_EVALUATION_AT,
    stop = new Error("controlled stop after the real child preload");
  let child: ReturnType<typeof originalSpawn> | undefined,
    observedCommand: string | undefined,
    observedEnvironment: NodeJS.ProcessEnv | undefined;
  delete process.env.CLAWSWEEPER_PROOF_EVALUATION_AT;
  childProcess.spawnSync = ((command, args, options) => {
    observedCommand = String(command);
    observedEnvironment = options?.env;
    child = originalSpawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {setTimeout as nativeTimeout,setInterval as nativeInterval} from'node:timers';const before=performance.now();await new Promise(resolve=>nativeTimeout(resolve,15));console.log(JSON.stringify({evaluation:process.env.CLAWSWEEPER_PROOF_EVALUATION_AT,now:Date.now(),iso:new Date().toISOString(),nativeTimeout:globalThis.setTimeout===nativeTimeout,nativeInterval:globalThis.setInterval===nativeInterval,realPerformanceAdvanced:performance.now()>before}));",
      ],
      { cwd: options?.cwd, env: options?.env, encoding: "utf8" },
    );
    throw stop;
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  process.chdir(scratch);
  try {
    await assert.rejects(
      captureCompatibilityBrowser({
        selected: {},
        output: join(scratch, "evidence"),
        evaluation,
        executionStartedAt: new originalDate().toISOString(),
        complete: true,
      }),
      (error) => error === stop,
    );
    assert.equal(observedCommand, "pnpm");
    assert.ok(child);
    assert.equal(child.status, 0, String(child.stderr));
    assert.equal(observedEnvironment?.CLAWSWEEPER_PROOF_EVALUATION_AT, evaluation);
    assert.deepEqual(JSON.parse(String(child.stdout)), {
      evaluation,
      now: Date.parse(evaluation),
      iso: evaluation,
      nativeTimeout: true,
      nativeInterval: true,
      realPerformanceAdvanced: true,
    });
    assert.equal(Date, originalDate, "the parent clock must stay real");
    assert.equal(
      readFileSync(data, "utf8"),
      savedData,
      "actual helper finally restores its input file",
    );
    assert.equal(
      existsSync(join(scratch, "evidence/coverage.png")),
      false,
      "this child-contract test does not claim browser execution",
    );
  } finally {
    process.chdir(root);
    childProcess.spawnSync = originalSpawn;
    syncBuiltinESMExports();
    if (priorEvaluation === undefined) delete process.env.CLAWSWEEPER_PROOF_EVALUATION_AT;
    else process.env.CLAWSWEEPER_PROOF_EVALUATION_AT = priorEvaluation;
    rmSync(scratch, { recursive: true, force: true });
  }
});
