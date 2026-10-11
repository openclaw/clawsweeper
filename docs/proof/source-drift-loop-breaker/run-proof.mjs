// Worker/workerd proof. Usage: node run-proof.mjs BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR [direct|direct-upgrade]
// Uses a loopback GitHub fixture, a fake clock, and disk-backed SQLite for upgrade/rollback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const [baseRef, toolPrefix, output, mode = "source-drift"] = process.argv.slice(2);
assert.ok(baseRef && toolPrefix && output, "expected BASE_REF TOOL_PREFIX FRESH_OUTPUT_DIR");
const root = process.cwd();
const out = path.resolve(output);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out);
const require = createRequire(path.resolve(toolPrefix, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const T0 = Date.parse("2030-01-01T00:00:00Z");
const MINUTE = 60_000;
const REPO = "openclaw/openclaw";
const SOURCE_DRIFT_CYCLES = 6;
const RUNAWAY_REVIEWS = 25;

const FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-read-model.ts",
  "dashboard/worker.ts",
  "dashboard/wrangler.toml",
  "dashboard/dashboard-health.ts",
];

function wranglerVars(text) {
  const start = text.indexOf("\n[vars]\n");
  assert.ok(start >= 0, "wrangler.toml has no [vars] section");
  const vars = {};
  for (const line of text.slice(start + "\n[vars]\n".length).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^([A-Z0-9_]+) = "([^"]*)"$/.exec(line.trim());
    if (match && (match[1].startsWith("EXACT_REVIEW_") || match[1] === "PUBLIC_BAY_REPOS")) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha256(JSON.stringify(value));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const dispatches = [];
const unexpected = [];
let liveHead = "e".repeat(40);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let text = "";
  for await (const chunk of request) text += chunk;
  let body = {};
  let code = 200;
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
    body = { private: false, visibility: "public", full_name: url.pathname.slice(7) };
  } else if (/^\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/\d+$/.test(url.pathname)) {
    body = {
      state: "open",
      updated_at: "2029-12-31T00:00:00Z",
      head: { sha: liveHead },
      base: { ref: "main" },
      draft: false,
    };
  } else if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname)) body = [];
  else if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
    dispatches.push(JSON.parse(text).client_payload);
    code = 204;
  } else {
    unexpected.push(`${request.method} ${url.pathname}`);
    code = 501;
  }
  response.writeHead(code, { "content-type": "application/json" });
  response.end(code === 204 ? undefined : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `127.0.0.1:${server.address().port}`;

const receipt = {
  claim:
    mode === "source-drift"
      ? "Automatic source-drift loops stop after three generations; organic events and commands release them, and runaway review activity is visible."
      : "Direct publication completion and reconciliation count automatic generations, stop at the source-drift limit, preserve command exemptions, and reopen persisted deployed state without migration.",
  base: git("rev-parse", baseRef),
  head: git("rev-parse", "HEAD"),
  working_tree_dirty: Boolean(git("status", "--porcelain", "--", ...FILES)),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / real dashboard Worker + ExactReviewQueue SQLite Durable Object persisted on disk / loopback GitHub fixture / fake clock",
  source_sha256: {},
  phases: {},
};

const factories = {};
const configs = {};
const persist = path.join(out, "durable-objects");
try {
  for (const variant of ["baseline", "candidate"]) {
    const dir = variant === "baseline" ? path.join(out, "baseline-src") : root;
    if (variant === "baseline") {
      mkdirSync(dir);
      execFileSync("tar", ["-x", "-C", dir], {
        input: execFileSync("git", ["archive", baseRef], { maxBuffer: 256 * 1024 * 1024 }),
      });
    }
    const read = (file) => readFileSync(path.join(dir, file), "utf8");
    receipt.source_sha256[variant] = Object.fromEntries(
      FILES.map((file) => [file, sha256(read(file))]),
    );
    const vars = wranglerVars(read("dashboard/wrangler.toml"));
    configs[variant] = vars;
    const entry = path.join(out, `${variant}-upgrade-worker.ts`);
    writeFileSync(
      entry,
      `
import worker from ${JSON.stringify(path.join(dir, "dashboard/worker.ts"))};
import { ExactReviewQueue } from ${JSON.stringify(path.join(dir, "dashboard/exact-review-queue.ts"))};
import { summarizeDashboardHealth } from ${JSON.stringify(path.join(dir, "dashboard/dashboard-health.ts"))};
let proofNow = ${T0};
Date.now = () => proofNow;
const stamp = (request) => {
  const header = request.headers.get('x-proof-now');
  if (header) proofNow = Number(header);
};
const rows = (sql, query) => Array.from(sql.exec(query));
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => 'public' }, () => 0.5);
    this.proofSql = ctx.storage.sql;
  }
  async alarm() {}
  async fetch(request) {
    stamp(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/__tick') {
      await super.alarm();
      return Response.json({ ok: true });
    }
    if (pathname === '/__rows') {
      // Raw persisted rows, read without routing through queue initialization.
      const tables = rows(this.proofSql, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
      const optional = (table, order) => tables.includes(table) ? rows(this.proofSql, 'SELECT * FROM ' + table + ' ORDER BY ' + order) : null;
      return Response.json({
        tables,
        items: optional('exact_review_queue_items', 'item_key'),
        deliveries: optional('exact_review_queue_deliveries', 'delivery_id'),
        source_drift_loops: optional('exact_review_queue_source_drift_loops', 'item_key'),
        review_generations: optional('exact_review_queue_review_generations', 'item_key, run_id, run_attempt'),
        lifecycle: optional('exact_review_lifecycle_projection_v1', 'canonical_target_key, fence_key, revision'),
      });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request, env, ctx) {
    stamp(request);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/q/')) {
      const stub = env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName('global'));
      return stub.fetch(new Request('https://clawsweeper-exact-review-queue/' + url.pathname.slice(3), {
        method: request.method,
        headers: { 'x-proof-now': String(proofNow) },
        body: request.method === 'POST' ? await request.text() : undefined,
      }));
    }
    if (url.pathname === "/__dashboard-health") {
      const stub = env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global"));
      const stats = await (await stub.fetch(new Request("https://queue/stats", { headers: { "x-proof-now": String(proofNow) } }))).json();
      return Response.json(summarizeDashboardHealth({ exact_review_queue: stats }));
    }
    return worker.fetch(request, { ...env, hostedTargetPredicate: () => true }, ctx);
  },
};
`,
    );
    const bundle = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
      logLevel: "silent",
    });
    factories[variant] = (persistPath) =>
      new Miniflare({
        ...convertV4MiniflareOptions({
          name: "direct-requeue-proof",
          modules: true,
          script: bundle.outputFiles[0].text,
          compatibilityDate: "2026-07-08",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { EXACT_REVIEW_QUEUE: { className: "ProofQueue", useSQLite: true } },
          bindings: {
            ...vars,
            CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-proof-secret",
            GITHUB_API_URL: `http://${address}`,
            CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
            CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
          },
          outboundService: async (request) => {
            const url = new URL(request.url);
            return fetch(`http://${address}${url.pathname}${url.search}`, {
              method: request.method,
              headers: request.headers,
              ...(request.method === "GET" || request.method === "HEAD"
                ? {}
                : { body: await request.arrayBuffer() }),
            });
          },
        }),
        resourcePersistencePath: persistPath,
      });
  }

  if (mode === "source-drift") {
    await runSourceDriftScenarios(factories, configs, receipt);
  } else {
    assert.ok(["direct", "direct-upgrade"].includes(mode), "unknown proof mode");
    const clock = { now: T0, run: 7_000_000 };
    const open = async (variant, persistPath) => {
      const mf = factories[variant](persistPath);
      await mf.ready;
      return mf;
    };
    const session = (mf) => {
      const call = async (route, body) => {
        const text = body === undefined ? undefined : JSON.stringify(body);
        const response = await mf.dispatchFetch(`http://proof${route}`, {
          method: text === undefined ? "GET" : "POST",
          headers: {
            "x-proof-now": String(clock.now),
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${createHmac(
              "sha256",
              "synthetic-proof-secret",
            )
              .update(text ?? "")
              .digest("hex")}`,
          },
          ...(text === undefined ? {} : { body: text }),
        });
        const value = await response.json();
        assert.ok(
          response.status < 400,
          `${route}: ${response.status} ${JSON.stringify(value)}; unexpected fixture requests: ${JSON.stringify(unexpected)}`,
        );
        return value;
      };
      const post = (route, body) => call(`/internal/exact-review/${route}`, body);
      const enqueue = (number, action = "opened", extra = {}) =>
        post("enqueue", {
          delivery_id: `proof:${number}:${clock.run++}`,
          decision: {
            targetRepo: REPO,
            targetBranch: "main",
            itemNumber: number,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: action,
            supersedesInProgress: action === "edited" || action === "synchronize",
            ...extra,
          },
        });
      const tick = async () => {
        const start = dispatches.length;
        clock.now += 11 * MINUTE;
        await call("/q/__tick", {});
        return dispatches.slice(start);
      };
      const claim = async (payload) => {
        assert.ok(payload, "expected an alarm dispatch");
        const tuple = {
          item_key: payload.queue_claim.item_key,
          lease_id: payload.queue_lease_id,
          lease_revision: payload.queue_claim.lease_revision,
          run_id: String(clock.run++),
          run_attempt: 1,
        };
        const result = await post("claim", tuple);
        assert.equal(result.ok, true);
        return { ...tuple, claim_generation: result.claim_generation, decision: result.decision };
      };
      const publication = async (lease) => {
        const key = lease.item_key;
        const result = await post("publication-results", {
          canonicalTargetKey: key,
          fenceKey: key,
          revision: lease.lease_revision,
          sourceSha: "e".repeat(40),
          identity: {
            canonicalTargetKey: key,
            fenceKey: key,
            revision: lease.lease_revision,
            claimGeneration: lease.claim_generation,
          },
          operations: [
            {
              path: `records/openclaw-openclaw/items/${lease.decision.itemNumber}.md`,
              deleted: false,
              mode: "100644",
              bytes: 1,
              contentBase64: "eA==",
            },
          ],
          totalBytes: 1,
          lifecycle: { kind: "requeue" },
        });
        assert.equal(result.accepted, true, JSON.stringify(result));
        await post("lifecycle/terminal-disposition", {
          canonical_target_key: key,
          fence_key: key,
          revision: lease.lease_revision,
          kind: "requeue",
        });
      };
      const finish = async (lease, reconcile = false) => {
        const { decision: _decision, ...tuple } = lease;
        clock.now += 5 * MINUTE;
        const result = reconcile
          ? await post("reconcile", {
              terminal_runs: [
                {
                  run_id: lease.run_id,
                  run_attempt: 1,
                  claimed_run_attempt: 1,
                  claim_generation: lease.claim_generation,
                  outcome: "success",
                },
              ],
            })
          : await post("complete", {
              ...tuple,
              outcome: "success",
              completion_kind: "published",
              reason_code: "publication_applied",
              direct_lifecycle_requeue: true,
              lifecycle_terminal_disposition: "requeue",
            });
        assert.equal(result.requeued, reconcile ? 1 : true, JSON.stringify(result));
        return result;
      };
      const rows = () => call("/q/__rows");
      const item = async (number) => {
        const row = (await rows()).items.find((row) => row.item_key === `${REPO}#${number}`);
        return row ? JSON.parse(row.item_json) : null;
      };
      const snapshot = async (number) => {
        const row = await item(number);
        const stats = await call("/q/stats");
        const publicView = await call("/api/exact-review-queue");
        return {
          state: row?.state,
          revision: row?.revision,
          parked_reason: row?.parkedReason ?? null,
          stats_parked_reasons: stats.lanes.review.parked_reasons,
          public_projection: publicView,
          loop_rows: (await rows()).source_drift_loops,
        };
      };
      return { call, post, enqueue, tick, claim, publication, finish, rows, item, snapshot };
    };
    const loop = async (s, number, reconcile = false, extra = {}) => {
      await s.enqueue(number, "opened", extra);
      let ready = await s.tick();
      const steps = [];
      const start = dispatches.length - ready.length;
      for (let cycle = 1; cycle <= 6 && ready.length; cycle++) {
        const lease = await s.claim(ready.find((p) => Number(p.item_number) === number));
        await s.publication(lease);
        const response = await s.finish(lease, reconcile);
        const state = await s.item(number);
        const completedLifecycle = (await s.rows()).lifecycle.find(
          (row) => row.fence_key === lease.item_key && row.revision === lease.lease_revision,
        );
        assert.equal(
          JSON.parse(completedLifecycle.projection_json).terminalDisposition.kind,
          "requeue",
        );
        ready = await s.tick();
        steps.push({
          cycle,
          completed_lifecycle: "requeue",
          response,
          state: state.state,
          revision: state.revision,
          parked_reason: state.parkedReason ?? null,
          successor_dispatches: ready.length,
        });
      }
      if (!ready.length) assert.equal((await s.tick()).length, 0);
      return { steps, dispatches: dispatches.length - start, final: await s.snapshot(number) };
    };
    const finishBaselineSuccessor = async (s, variant) => {
      if (variant !== "baseline") return;
      // The baseline never parks. Finish its last dispatched generation before
      // comparing the next organic event or command with a candidate release.
      const lease = await s.claim(dispatches.at(-1));
      const { decision: _decision, ...tuple } = lease;
      await s.post("complete", { ...tuple, outcome: "success" });
    };
    if (mode === "direct") {
      receipt.variants = {};
      for (const variant of ["baseline", "candidate"]) {
        const scenarios = {};
        for (const [name, reconcile, extra] of [
          ["direct_completion", false, {}],
          ["reconciliation", true, {}],
          [
            "pr_synchronize",
            false,
            {
              itemKind: "pull_request",
              sourceEvent: "pull_request",
              sourceHeadSha: "e".repeat(40),
              sourceHeadVerified: true,
              sourceAuthoritySeq: 1,
              sourceUpdatedAt: new Date(clock.now).toISOString(),
            },
          ],
        ]) {
          const mf = await open(variant);
          try {
            const s = session(mf);
            liveHead = "e".repeat(40);
            const number = name === "pr_synchronize" ? 132957 : reconcile ? 132956 : 132955;
            const result = await loop(s, number, reconcile, extra);
            const expected = variant === "candidate" ? 4 : 7;
            assert.equal(result.dispatches, expected, `${variant} ${name} dispatch count`);
            assert.equal(result.final.state, variant === "candidate" ? "parked" : "dispatching");
            if (variant === "candidate") {
              assert.equal(result.final.parked_reason, "source_drift_loop");
              assert.equal(result.final.stats_parked_reasons.source_drift_loop, 1);
              assert.ok(
                JSON.stringify(result.final.public_projection).includes('"source_drift_loop":1'),
              );
            }
            const action = name === "pr_synchronize" ? "synchronize" : "edited";
            await finishBaselineSuccessor(s, variant);
            clock.now += MINUTE;
            if (name === "pr_synchronize") liveHead = "f".repeat(40);
            const releaseResponse = await s.enqueue(number, action, {
              ...extra,
              ...(name === "pr_synchronize"
                ? {
                    sourceHeadSha: liveHead,
                    sourceHeadVerified: true,
                    sourceAuthoritySeq: 2,
                    sourceUpdatedAt: new Date(clock.now).toISOString(),
                  }
                : {}),
            });
            const released = await s.item(number);
            const releasedReady = await s.tick();
            assert.ok(
              releasedReady.length,
              `${variant} ${name}: ${JSON.stringify({ releaseResponse, released })}`,
            );
            const lease = await s.claim(
              releasedReady.find((p) => Number(p.item_number) === number),
            );
            await s.publication(lease);
            await s.finish(lease, reconcile);
            const after = await s.item(number);
            assert.equal(after.state, "pending");
            if (variant === "candidate") {
              const counter = (await s.rows()).source_drift_loops.find(
                (row) => row.item_key === lease.item_key,
              );
              assert.equal(counter.consecutive, 1, "organic release resets the counter");
            }
            const next = await s.tick();
            assert.equal(next.length, 1);
            result.release = {
              action,
              state: released.state,
              dispatches: releasedReady.length,
              next_direct_requeue_state: after.state,
              next_dispatches: next.length,
              loop_rows: (await s.rows()).source_drift_loops,
            };
            scenarios[name] = result;
          } finally {
            await mf.dispose();
          }
        }
        const mf = await open(variant);
        try {
          const s = session(mf);
          const result = await loop(s, 132958);
          await finishBaselineSuccessor(s, variant);
          await s.enqueue(132958, "re_review", {
            commandStatusMarker: "<!-- clawsweeper-command-status:132958:re_review:proof -->",
            statusCommentId: 9001,
          });
          const before = await s.item(132958);
          const ready = await s.tick();
          const lease = await s.claim(ready[0]);
          assert.ok(lease.decision.commandStatusMarker);
          await s.publication(lease);
          await s.finish(lease);
          result.command = {
            released_state: before.state,
            successor: await s.snapshot(132958),
            dispatches: (await s.tick()).length,
          };
          assert.equal(result.command.successor.state, "pending");
          assert.equal(
            result.command.successor.loop_rows.length,
            0,
            "command requeue is not counted",
          );
          scenarios.command_release = result;
        } finally {
          await mf.dispose();
        }
        receipt.variants[variant] = scenarios;
      }
    }
    if (mode === "direct-upgrade") {
      // The baseline creates the counters through /enqueue, not raw SQL. It
      // then saves an accepted direct publication and its terminal disposition.
      const number = 133001;
      let oldLease;
      let beforeUpgrade;
      {
        const mf = await open("baseline", persist);
        try {
          const s = session(mf);
          await s.enqueue(number);
          const lease = await s.claim((await s.tick())[0]);
          const { decision: _decision, ...tuple } = lease;
          await s.post("complete", { ...tuple, outcome: "success" });
          await s.enqueue(number, "source_drift_requeue", { supersedesInProgress: true });
          oldLease = await s.claim((await s.tick())[0]);
          await s.publication(oldLease);
          await s.enqueue(133002, "source_drift_requeue", { supersedesInProgress: true });
          await s.call("/q/stats");
          beforeUpgrade = await s.rows();
          assert.equal(beforeUpgrade.source_drift_loops.length, 2);
          receipt.phases.baseline_create = {
            item_states: beforeUpgrade.items.map((row) => ({
              key: row.item_key,
              state: JSON.parse(row.item_json).state,
              action: JSON.parse(row.item_json).decision.sourceAction,
            })),
            loop_rows: beforeUpgrade.source_drift_loops,
            raw_rows_sha256: digest(beforeUpgrade),
          };
        } finally {
          await mf.dispose();
        }
      }
      let beforeRollback;
      {
        const mf = await open("candidate", persist);
        try {
          const s = session(mf);
          const opened = await s.rows();
          assert.deepEqual(
            opened,
            beforeUpgrade,
            "upgrade raw rows unchanged before first request",
          );
          await s.call("/q/stats");
          assert.deepEqual(await s.rows(), beforeUpgrade, "upgrade read does not change rows");
          await s.finish(oldLease);
          const first = await s.item(number);
          assert.equal(first.state, "pending");
          const existingCounter = (await s.rows()).source_drift_loops.find(
            (row) => row.item_key === oldLease.item_key,
          );
          assert.equal(existingCounter.consecutive, 2, "old lease advances the existing counter");
          let ready = await s.tick();
          const steps = [];
          // Finish unrelated pending work so it cannot affect dispatch counts.
          const pending = ready.find((p) => Number(p.item_number) === 133002);
          const pendingLease = await s.claim(pending);
          const { decision: _decision, ...tuple } = pendingLease;
          await s.post("complete", { ...tuple, outcome: "success" });
          for (let cycle = 1; cycle <= 2; cycle++) {
            const lease = await s.claim(ready.find((p) => Number(p.item_number) === number));
            await s.publication(lease);
            await s.finish(lease, cycle === 2);
            const item = await s.item(number);
            ready = await s.tick();
            steps.push({
              cycle,
              state: item.state,
              parked_reason: item.parkedReason ?? null,
              dispatches: ready.length,
            });
          }
          assert.equal(steps[0].state, "pending");
          assert.equal(steps[1].parked_reason, "source_drift_loop");
          assert.equal(steps[1].dispatches, 0);
          beforeRollback = await s.rows();
          receipt.phases.candidate_upgrade = {
            raw_rows_preserved: true,
            rows_preserved_after_read: true,
            old_lease_successor: { state: first.state, revision: first.revision },
            counter_after_old_lease: existingCounter,
            steps,
            final: await s.snapshot(number),
            raw_rows_sha256: digest(beforeRollback),
          };
        } finally {
          await mf.dispose();
        }
      }
      {
        const mf = await open("baseline", persist);
        try {
          const s = session(mf);
          assert.deepEqual(await s.rows(), beforeRollback, "rollback raw rows unchanged");
          const snapshot = await s.snapshot(number);
          assert.deepEqual(await s.rows(), beforeRollback, "rollback read does not change rows");
          assert.equal(snapshot.parked_reason, "source_drift_loop");
          assert.equal(snapshot.stats_parked_reasons.source_drift_loop, 1);
          await s.enqueue(number, "edited");
          const released = await s.item(number);
          const ready = await s.tick();
          assert.equal(released.state, "pending");
          assert.equal(ready.length, 1);
          receipt.phases.baseline_rollback = {
            raw_rows_preserved: true,
            rows_preserved_after_read: true,
            parked: snapshot,
            organic_release: released.state,
            release_dispatches: ready.length,
          };
        } finally {
          await mf.dispose();
        }
      }
    }
    assert.deepEqual(unexpected, [], "unexpected external requests");
    receipt.assertions = {
      ...(mode === "direct"
        ? {
            direct_completion_limit: true,
            reconciliation_limit: true,
            organic_edited_reset: true,
            pr_synchronize_reset: true,
            command_release_and_not_counted: true,
          }
        : {
            upgrade_raw_rows_unchanged: true,
            upgrade_uses_existing_counter: true,
            rollback_reads_and_releases: true,
          }),
    };
    receipt.limits =
      "Real Worker routes and real DO alarm dispatcher in workerd; synthetic loopback GitHub responses, RSA credential and review publications; no GitHub Actions execution, inference, production state or GitHub mutation. Clock and alarm scheduling are controlled by the harness. Proof-only routes tick the real alarm and read raw SQLite rows; they do not write queue state.";
  }
  const receiptName =
    mode === "source-drift"
      ? "result.json"
      : mode === "direct"
        ? "direct-requeue-result.json"
        : "direct-requeue-upgrade-and-rollback.json";
  writeFileSync(path.join(out, receiptName), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.assertions, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function runSourceDriftScenarios(factories, configs, receipt) {
  receipt.variants = {};
  for (const variant of ["baseline", "candidate"]) {
    const result = {
      source_sha256: receipt.source_sha256[variant],
      config: configs[variant],
      scenarios: {},
    };
    for (const [name, scenario] of Object.entries({
      self_requeue_then_release: selfRequeueThenRelease,
      scheduled_release: scheduledRelease,
      command: commandPath,
      runaway: runawayAlert,
    })) {
      const mf = factories[variant]();
      try {
        await mf.ready;
        dispatches.length = 0;
        result.scenarios[name] = await scenario(createDriver(mf));
      } finally {
        await mf.dispose();
      }
    }
    receipt.variants[variant] = result;
  }
  assert.deepEqual(unexpected, []);
  receipt.assertions = verify(receipt.variants);
  receipt.limits =
    "Synthetic loopback GitHub fixture and RSA credential; issue items only; source drift reproduced by its workflow payload; no GitHub Actions execution, inference, production state, or GitHub mutation. The harness controls the clock and invokes the real Durable Object alarm.";
}
function createDriver(mf) {
  const driver = {
    now: T0,
    runId: 4_000_000,
    seenDispatches: 0,
    async call(pathname, body) {
      const response = await mf.dispatchFetch(`http://proof${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-proof-now": String(driver.now), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      return { status: response.status, body: value };
    },
    async enqueue(deliveryId, decision) {
      const { status, body } = await driver.call("/q/enqueue", {
        delivery_id: deliveryId,
        decision,
      });
      assert.equal(status, 202, JSON.stringify(body));
      return body;
    },
    /** Advance past the debounce, tick, and claim+complete any newly dispatched review. */
    async runDispatchedReview(itemNumber) {
      driver.now += 11 * MINUTE;
      await driver.call("/q/__tick", {});
      const fresh = dispatches.slice(driver.seenDispatches);
      driver.seenDispatches = dispatches.length;
      const payload = fresh.find((entry) => Number(entry.item_number) === itemNumber);
      if (!payload) return null;
      driver.now += MINUTE;
      const tuple = {
        item_key: payload.queue_claim.item_key,
        lease_id: payload.queue_lease_id,
        lease_revision: payload.queue_claim.lease_revision,
        run_id: String(driver.runId++),
        run_attempt: 1,
      };
      const claim = await driver.call("/q/claim", tuple);
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      driver.now += 5 * MINUTE;
      const complete = await driver.call("/q/complete", {
        ...tuple,
        claim_generation: claim.body.claim_generation,
        outcome: "success",
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      return { runId: tuple.run_id, decision: claim.body.decision };
    },
    async item(itemNumber) {
      const stats = (await driver.call("/q/stats")).body;
      const review = stats.lanes.review;
      const key = `${REPO}#${itemNumber}`;
      const bay = (stats.bay_projection?.items ?? []).find((entry) => entry.item_key === key);
      return {
        review_lane_parked: review.parked,
        review_lane_parked_reasons: Object.fromEntries(
          Object.entries(review.parked_reasons ?? {}).filter(([, count]) => count > 0),
        ),
        queue_state: bay?.queue_state ?? null,
        bay_stage: bay?.stage ?? null,
      };
    },
  };
  return driver;
}

function issue(itemNumber, sourceAction, extra = {}) {
  return {
    targetRepo: REPO,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress: sourceAction === "edited",
    ...extra,
  };
}

function disposition(body) {
  if (body.queued === true) return "queued";
  if (body.deduped === true) {
    return body.dedupe_scope ? `deduped:${body.dedupe_scope}:${body.dedupe_reason}` : "deduped";
  }
  if (body.shed === true) return `shed:${body.reason}`;
  return JSON.stringify(body);
}

async function selfRequeue(driver, itemNumber, cycles) {
  const steps = [];
  let reviewed = await driver.runDispatchedReview(itemNumber);
  assert.ok(reviewed, "organic review generation dispatched");
  let reviews = 1;
  let last = reviewed;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    // sweep.yml: Queue fresh review after source drift (remote-newer publication).
    const requeue = await driver.enqueue(`publisher-source-drift:${last.runId}:${cycle}`, {
      ...last.decision,
      sourceAction: "source_drift_requeue",
      supersedesInProgress: true,
    });
    const state = await driver.item(itemNumber);
    reviewed = await driver.runDispatchedReview(itemNumber);
    if (reviewed) {
      reviews += 1;
      last = reviewed;
    }
    steps.push({
      cycle,
      requeue: disposition(requeue),
      queue_state_after_requeue: state.queue_state,
      parked_reasons: state.review_lane_parked_reasons,
      review_dispatched: Boolean(reviewed),
    });
  }
  return { steps, reviews, last };
}

async function selfRequeueThenRelease(driver) {
  const itemNumber = 97616;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, SOURCE_DRIFT_CYCLES);
  const beforeRelease = await driver.item(itemNumber);
  driver.now += MINUTE;
  const organic = await driver.enqueue("organic-edited", issue(itemNumber, "edited"));
  const afterRelease = await driver.item(itemNumber);
  const releasedReview = await driver.runDispatchedReview(itemNumber);
  const nextRequeue = releasedReview
    ? await driver.enqueue(`publisher-source-drift:${releasedReview.runId}:after-release`, {
        ...releasedReview.decision,
        sourceAction: "source_drift_requeue",
        supersedesInProgress: true,
      })
    : null;
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps,
    review_generations_spent: loop.reviews,
    before_release: beforeRelease,
    organic_edited: disposition(organic),
    after_release: afterRelease,
    released_review_dispatched: Boolean(releasedReview),
    next_source_drift_after_release: nextRequeue ? disposition(nextRequeue) : null,
  };
}

async function scheduledRelease(driver) {
  const itemNumber = 97618;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, 4);
  // A scheduled backfill offer whose source update is later than the park, as
  // hot intake would send after ClawSweeper's own post-review writes.
  driver.now += MINUTE;
  const offer = await driver.enqueue(
    "scheduled-newer",
    issue(itemNumber, "scheduled_normal_backfill", {
      sourceUpdatedAt: new Date(driver.now).toISOString(),
    }),
  );
  const afterOffer = await driver.item(itemNumber);
  const reviewed = await driver.runDispatchedReview(itemNumber);
  const requeue = reviewed
    ? await driver.enqueue(`publisher-source-drift:${reviewed.runId}:after-scheduled`, {
        ...reviewed.decision,
        sourceAction: "source_drift_requeue",
        supersedesInProgress: true,
      })
    : null;
  const afterRequeue = await driver.item(itemNumber);
  const further = await driver.runDispatchedReview(itemNumber);
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps.map((step) => step.requeue),
    scheduled_offer: disposition(offer),
    after_offer: afterOffer,
    scheduled_review_dispatched: Boolean(reviewed),
    drift_after_scheduled_review: requeue ? disposition(requeue) : null,
    after_drift: afterRequeue,
    further_review_dispatched: Boolean(further),
    review_generations_spent: loop.reviews + (reviewed ? 1 : 0) + (further ? 1 : 0),
  };
}

async function commandPath(driver) {
  const itemNumber = 123774;
  assert.equal(
    disposition(await driver.enqueue("organic-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  const loop = await selfRequeue(driver, itemNumber, 4);
  driver.now += MINUTE;
  const command = await driver.enqueue(
    "command-re-review",
    issue(itemNumber, "re_review", {
      commandStatusMarker: `<!-- clawsweeper-command-status:${itemNumber}:re_review:proof -->`,
      statusCommentId: 9001,
    }),
  );
  const afterCommand = await driver.item(itemNumber);
  driver.now += 2 * MINUTE;
  await driver.call("/q/__tick", {});
  const commandDispatch = dispatches
    .slice(driver.seenDispatches)
    .find((entry) => Number(entry.item_number) === itemNumber);
  return {
    item: `${REPO}#${itemNumber}`,
    source_drift_cycles: loop.steps.map((step) => step.requeue),
    command: disposition(command),
    after_command: afterCommand,
    command_review_dispatched: Boolean(commandDispatch),
    dispatched_command_marker_present: Boolean(
      commandDispatch &&
      JSON.stringify(commandDispatch).includes(`clawsweeper-command-status:${itemNumber}`),
    ),
  };
}

async function runawayAlert(driver) {
  const itemNumber = 200001;
  const start = driver.now;
  assert.equal(
    disposition(await driver.enqueue("runaway-opened", issue(itemNumber, "opened"))),
    "queued",
  );
  let reviews = 0;
  if (await driver.runDispatchedReview(itemNumber)) reviews += 1;
  for (let edit = 1; reviews < RUNAWAY_REVIEWS; edit += 1) {
    assert.ok(edit < 100, "runaway scenario did not converge");
    await driver.enqueue(`runaway-edit-${edit}`, issue(itemNumber, "edited"));
    if (await driver.runDispatchedReview(itemNumber)) reviews += 1;
  }
  const elapsedHours = (driver.now - start) / (60 * MINUTE);
  const publicQueue = await driver.call("/api/exact-review-queue");
  const health = (await driver.call("/__dashboard-health")).body;
  // The window is trailing: after 25 more hours the same history ages out.
  driver.now += 25 * 60 * MINUTE;
  const aged = await driver.call("/api/exact-review-queue");
  return {
    item: `${REPO}#${itemNumber}`,
    claimed_reviews: reviews,
    elapsed_hours: Math.round(elapsedHours * 10) / 10,
    public_status: publicQueue.status,
    public_collection: publicQueue.body.collection ?? null,
    public_review_runaway_health: publicQueue.body.review_runaway_health ?? "absent",
    dashboard_health: health,
    after_25_hours: aged.body.review_runaway_health ?? "absent",
  };
}

function verify(variants) {
  const base = variants.baseline.scenarios;
  const cand = variants.candidate.scenarios;
  const checks = {
    baseline_requeues_every_cycle: base.self_requeue_then_release.source_drift_cycles.every(
      (step) => step.requeue === "queued" && step.review_dispatched,
    ),
    baseline_review_generations: base.self_requeue_then_release.review_generations_spent,
    candidate_first_three_requeues_admitted: cand.self_requeue_then_release.source_drift_cycles
      .slice(0, 3)
      .every((step) => step.requeue === "queued" && step.review_dispatched),
    candidate_fourth_requeue_parks:
      cand.self_requeue_then_release.source_drift_cycles[3].requeue ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.self_requeue_then_release.source_drift_cycles[3].queue_state_after_requeue ===
        "parked" &&
      cand.self_requeue_then_release.source_drift_cycles[3].parked_reasons.source_drift_loop === 1,
    candidate_later_requeues_deduped: cand.self_requeue_then_release.source_drift_cycles
      .slice(4)
      .every(
        (step) =>
          step.requeue === "deduped:source_drift_loop:item_parked" && !step.review_dispatched,
      ),
    candidate_review_generations: cand.self_requeue_then_release.review_generations_spent,
    candidate_organic_release:
      cand.self_requeue_then_release.organic_edited === "queued" &&
      cand.self_requeue_then_release.after_release.queue_state === "pending" &&
      cand.self_requeue_then_release.released_review_dispatched &&
      cand.self_requeue_then_release.next_source_drift_after_release === "queued",
    baseline_scheduled_then_requeues:
      base.scheduled_release.scheduled_offer === "queued" &&
      base.scheduled_release.drift_after_scheduled_review === "queued" &&
      base.scheduled_release.further_review_dispatched,
    candidate_scheduled_releases_one_review_then_reparks:
      cand.scheduled_release.source_drift_cycles[3] ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.scheduled_release.scheduled_offer === "queued" &&
      cand.scheduled_release.after_offer.queue_state === "pending" &&
      cand.scheduled_release.scheduled_review_dispatched &&
      cand.scheduled_release.drift_after_scheduled_review ===
        "deduped:source_drift_loop:requeue_limit_reached" &&
      cand.scheduled_release.after_drift.queue_state === "parked" &&
      !cand.scheduled_release.further_review_dispatched,
    candidate_command_release:
      cand.command.command === "queued" &&
      cand.command.after_command.queue_state === "pending" &&
      cand.command.command_review_dispatched &&
      cand.command.dispatched_command_marker_present,
    baseline_command_admitted:
      base.command.command === "queued" && base.command.command_review_dispatched,
    baseline_runaway_field: base.runaway.public_review_runaway_health,
    candidate_runaway_degraded:
      cand.runaway.public_status === 200 &&
      cand.runaway.public_collection?.state === "complete" &&
      cand.runaway.public_review_runaway_health?.status === "degraded" &&
      cand.runaway.public_review_runaway_health?.reason === "review_runaway" &&
      cand.runaway.public_review_runaway_health?.runaway_items === 1 &&
      cand.runaway.public_review_runaway_health?.sample_item_keys?.[0] === `${REPO}#200001` &&
      cand.runaway.dashboard_health.reasons.includes("review_runaway"),
    candidate_runaway_ages_out: cand.runaway.after_25_hours?.status === "healthy",
  };
  assert.equal(checks.baseline_requeues_every_cycle, true, "baseline must requeue forever");
  assert.equal(checks.baseline_scheduled_then_requeues, true, "baseline keeps requeueing");
  for (const [name, value] of Object.entries(checks)) {
    if (name.startsWith("candidate_") && typeof value === "boolean")
      assert.equal(value, true, name);
  }
  assert.equal(checks.baseline_review_generations, SOURCE_DRIFT_CYCLES + 1);
  assert.equal(checks.candidate_review_generations, 4);
  return checks;
}
