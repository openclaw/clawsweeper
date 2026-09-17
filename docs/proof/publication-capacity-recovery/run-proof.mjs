import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const source = process.cwd();
const out = path.join(source, ".artifacts/publication-capacity-recovery");
const baseline = process.env.CAPACITY_PROOF_BASELINE;
const wrangler = process.env.CAPACITY_PROOF_WRANGLER;
assert.ok(baseline && path.isAbsolute(baseline));
assert.ok(wrangler && path.isAbsolute(wrangler));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const trace = [];
const resultPath = path.join(out, "behavior.json");
const secret = "synthetic-publication-capacity-proof";
const base = "f8ec10f29bde7db20dcd442c5b7c64edfee2f976";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}

async function prove(name, root) {
  const candidate = name === "candidate";
  const directory = path.join(out, name);
  await mkdir(directory, { recursive: false });
  const nonce = randomUUID();
  const initialNow = Date.now() + 86_400_000;
  const config = path.join(directory, "wrangler.toml");
  await writeFile(
    config,
    [
      'name = "publication-capacity-local-proof"',
      "main = " +
        JSON.stringify(path.join(root, "docs/proof/publication-capacity-recovery/worker.ts")),
      'compatibility_date = "2026-05-11"',
      "[[durable_objects.bindings]]",
      'name = "EXACT_REVIEW_QUEUE"',
      'class_name = "ExactReviewQueue"',
      "[[durable_objects.bindings]]",
      'name = "STATUS_STORE"',
      'class_name = "StatusStore"',
      "[[migrations]]",
      'tag = "v1"',
      'new_sqlite_classes = ["ExactReviewQueue", "StatusStore"]',
      "[vars]",
      "PROOF_NONCE = " + JSON.stringify(nonce),
      "PROOF_NOW = " + JSON.stringify(String(initialNow)),
      "CLAWSWEEPER_WEBHOOK_SECRET = " + JSON.stringify(secret),
      'TARGET_REPOS = "openclaw/clawsweeper"',
      'PUBLIC_BAY_REPOS = "openclaw/clawsweeper"',
      'EXACT_REVIEW_ACTIONS_BUDGET = "194"',
      'EXACT_REVIEW_QUEUE_MAX_CONCURRENT = "32"',
      'EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT = "8"',
      'EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT = "32"',
      'EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT = "32"',
      'EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED = "1"',
      'EXACT_REVIEW_PUBLICATION_BATCH_SIZE = "8"',
      'EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT = "8"',
    ].join("\n") + "\n",
  );
  let server;
  let serverExit;
  let serverLog;
  let origin;
  let starts = 0;
  let nextItem = 9000;
  let nextBatch = 0;

  async function request(route, body, expected = 200) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers =
      raw === undefined
        ? {}
        : {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature":
              "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
          };
    const response = await fetch(origin + route, {
      method: raw === undefined ? "GET" : "POST",
      headers,
      body: raw,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    assert.ok(text.length < 2_000_000, "bounded response");
    trace.push({
      variant: name,
      route,
      method: raw === undefined ? "GET" : "POST",
      status: response.status,
      body_sha256: digest(text),
    });
    assert.ok(trace.length <= 200, "bounded request trace");
    assert.equal(response.status, expected, route + ": " + text.slice(0, 1000));
    if (expected !== 200 && expected !== 202) return text;
    return JSON.parse(text);
  }

  async function start() {
    const listenPort = await port();
    origin = "http://127.0.0.1:" + listenPort;
    serverLog = createWriteStream(path.join(directory, "worker-" + starts++ + ".log"), {
      flags: "wx",
    });
    server = spawn(
      wrangler,
      [
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(listenPort),
        "--inspector-port",
        "0",
        "--persist-to",
        path.join(directory, "sqlite"),
        "--config",
        config,
      ],
      { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    server.stdout.pipe(serverLog, { end: false });
    server.stderr.pipe(serverLog, { end: false });
    serverExit = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.once("exit", (code, signal) => resolve({ code, signal }));
    });
    serverExit.catch(() => {});
    const deadline = Date.now() + 45_000;
    while (true) {
      assert.equal(server.exitCode, null, "Worker exited during readiness");
      try {
        const response = await fetch(origin + "/__proof/ready", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          const ready = await response.json();
          assert.equal(ready.nonce, nonce);
          assert.equal(ready.deniedNetwork, 0);
          return;
        }
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      assert.ok(Date.now() < deadline, "Worker readiness deadline");
      await wait(100);
    }
  }

  async function stop() {
    if (!server) return;
    const running = server;
    try {
      process.kill(-running.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    let timer;
    try {
      await Promise.race([
        serverExit,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker did not stop gracefully")), 5000);
        }),
      ]);
    } catch (error) {
      try {
        process.kill(-running.pid, "SIGKILL");
      } catch (killError) {
        if (killError.code !== "ESRCH") throw killError;
      }
      await serverExit;
      throw error;
    } finally {
      clearTimeout(timer);
      await new Promise((resolve) => serverLog.end(resolve));
      server = null;
    }
  }

  const inspect = () => request("/__proof/inspect");
  const advance = (milliseconds) => request("/__proof/advance", { milliseconds });
  async function enqueue() {
    const number = nextItem++;
    const run = String(number * 10);
    const producerDecision = {
      targetRepo: "openclaw/clawsweeper",
      targetBranch: "main",
      itemNumber: number,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
      supersedesInProgress: false,
    };
    const result = await request(
      "/internal/exact-review/enqueue",
      {
        delivery_id: name + "-" + number,
        decision: {
          ...producerDecision,
          sourceAction: "exact_review_artifact_publish",
          publication: {
            artifactName: "exact-review-" + run + "-1",
            producerRunId: run,
            producerRunAttempt: 1,
            sourceSha: "a".repeat(40),
            itemKey: "openclaw/clawsweeper#" + number,
            protocolVersion: 2,
            leaseRevision: 1,
            claimGeneration: 1,
            liveProceeded: true,
            liveTerminalNoop: false,
            liveTerminalMissing: false,
            liveGuardedOpen: false,
            producerDecision,
          },
        },
      },
      202,
    );
    assert.equal(result.queued, true);
  }
  async function claim(count, fresh = true) {
    if (fresh) for (let i = 0; i < count; i++) await enqueue();
    const result = await request("/internal/exact-review/publication-batches/claim", {
      claim_id: name + "-batch-" + nextBatch++,
      lease_owner: "proof-owner",
      max_items: count,
    });
    assert.equal(result.claimed, true, JSON.stringify(result));
    assert.equal(result.batch.items.length, count);
    return result.batch;
  }
  const published = (batch) =>
    batch.items.map((member) => ({ ...member, terminal_outcome: "published" }));
  const complete = (batch, items = published(batch), extra = {}, expected = 200) =>
    request(
      "/internal/exact-review/publication-batches/complete",
      {
        batch_id: batch.batch_id,
        lease_owner: "proof-owner",
        items,
        ...extra,
      },
      expected,
    );
  async function quota(letter) {
    const { now } = await inspect();
    return {
      github_telemetry_id: letter.repeat(64),
      github_rate_limit_observations: [
        {
          scope: "repository_actions",
          observed_at: new Date(now).toISOString(),
          retry_at: new Date(now + 60_000).toISOString(),
          provenance: "retry_after",
          authoritative: true,
        },
      ],
    };
  }
  async function successes(count) {
    while (count > 0) {
      const size = Math.min(8, count);
      assert.equal((await complete(await claim(size))).accepted, size);
      count -= size;
    }
  }

  try {
    await start();
    const pressure = await claim(1);
    assert.equal(
      (
        await complete(
          pressure,
          pressure.items.map((member) => ({
            ...member,
            terminal_outcome: "superseded",
          })),
          await quota("a"),
        )
      ).accepted,
      1,
    );
    await complete(pressure, [], await quota("b"));
    assert.equal((await inspect()).control.capacityCeiling, 8);
    await advance(16 * 60_000);
    const first = await claim(8);
    const half = published(first).slice(0, 4);
    assert.equal((await complete(first, half)).accepted, 4);
    assert.equal((await complete(first, half)).accepted, 0);
    assert.equal((await complete(first)).accepted, 4);
    const beforeRestart = await inspect();
    assert.equal(beforeRestart.deniedNetwork, 0);
    await stop();
    await start();
    const afterRestart = await inspect();
    assert.deepEqual(afterRestart.control, beforeRestart.control);
    assert.deepEqual(afterRestart.memberships, beforeRestart.memberships);
    const last = await claim(2);
    assert.equal(
      (
        await complete(
          last,
          published(last).map((member) => ({
            ...member,
            claim_generation: member.claim_generation + 1,
          })),
        )
      ).accepted,
      0,
    );
    await complete(last, [published(last)[0], published(last)[0]], {}, 400);
    assert.equal((await complete(last)).accepted, 2);
    assert.equal((await complete(last)).accepted, 0);
    const recovered = await inspect();
    assert.equal(recovered.control.capacityCeiling, candidate ? 16 : 8);
    assert.equal(recovered.control.recoverySuccesses, 0);
    assert.equal(beforeRestart.control.recoverySuccesses, candidate ? 8 : 0);
    const publicQueue = await request("/api/exact-review-queue");
    assert.equal(publicQueue.lanes.publication.capacity, candidate ? 16 : 8);
    const result = {
      variant: name,
      base,
      ten_published_members: true,
      capacity_before: 8,
      capacity_after: recovered.control.capacityCeiling,
      restored_after_restart: true,
      duplicate_and_stale_credit: false,
      public_capacity: publicQueue.lanes.publication.capacity,
    };

    if (candidate) {
      await successes(9);
      const beforeMixed = await inspect();
      assert.equal(beforeMixed.control.capacityCeiling, 16);
      assert.equal(beforeMixed.control.recoverySuccesses, 9);
      const mixed = await claim(2);
      const mixedItems = published(mixed);
      mixedItems[1] = {
        ...mixed.items[1],
        terminal_outcome: "retryable_failure",
        reason_code: "github_rate_limit",
      };
      const feedback = await quota("c");
      assert.equal((await complete(mixed, mixedItems, feedback)).accepted, 2);
      const afterMixed = await inspect();
      assert.equal(afterMixed.control.capacityCeiling, 8);
      assert.equal(afterMixed.control.recoverySuccesses, 0);
      assert.equal((await complete(mixed, mixedItems, feedback)).accepted, 0);
      assert.deepEqual((await inspect()).control, afterMixed.control);
      await advance(16 * 60_000);
      const retry = await claim(1, false);
      await complete(
        retry,
        retry.items.map((member) => ({ ...member, terminal_outcome: "superseded" })),
      );
      await successes(9);
      const rollbackBatch = await claim(2);
      const beforeRollback = await inspect();
      assert.equal(beforeRollback.control.recoverySuccesses, 9);
      assert.equal(beforeRollback.triggerFailures, 0);
      await request("/__proof/fail-membership", { key: rollbackBatch.items[1].item_key });
      await complete(rollbackBatch, published(rollbackBatch), {}, 500);
      const afterRollback = await inspect();
      assert.equal(afterRollback.triggerFailures, 1);
      assert.equal(afterRollback.deniedNetwork, 0);
      assert.deepEqual(afterRollback.control, beforeRollback.control);
      assert.deepEqual(afterRollback.items, beforeRollback.items);
      assert.deepEqual(afterRollback.memberships, beforeRollback.memberships);
      await request("/__proof/clear-failure", {});
      await stop();
      await start();
      assert.deepEqual((await inspect()).control, beforeRollback.control);
      assert.equal((await complete(rollbackBatch)).accepted, 2);
      assert.equal((await complete(rollbackBatch)).accepted, 0);
      const afterReplay = await inspect();
      assert.equal(afterReplay.control.capacityCeiling, 16);
      assert.equal(afterReplay.control.recoverySuccesses, 1);
      Object.assign(result, {
        mixed_quota: { before: 16, prior_credits: 9, after: 8 },
        durable_sql_kv_rollback: true,
        replay_after_restart: { ceiling: 16, credits: 1 },
      });
    }
    assert.equal((await inspect()).deniedNetwork, 0);
    return result;
  } finally {
    await stop();
  }
}

try {
  results.push(await prove("baseline", baseline));
  results.push(await prove("candidate", source));
  const summary = {
    schema: "publication-capacity-behavior/v1",
    result: "passed",
    base,
    runtime: { node: process.version, wrangler: "4.131.1", workerd: "1.20260911.1" },
    results,
    trace,
    limits: [
      "synthetic publications",
      "controlled future clock",
      "loopback only",
      "no live GitHub publication",
      "no production queue mutation",
      "no throughput measurement",
    ],
  };
  await writeFile(resultPath, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({
      result: "passed",
      results,
      requests: trace.length,
      summary_sha256: digest(await readFile(resultPath)),
    }),
  );
} catch (error) {
  await writeFile(
    path.join(out, "behavior-failure.json"),
    JSON.stringify(
      {
        result: "hold",
        error: String(error),
        stack: error.stack,
        results,
        trace,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  throw error;
}
