// workerd/SQLite before/after proof: a retained stale-revision publication row.
// Usage: node docs/proof/stale-revision-hold/run-proof.mjs <label> <source-dir> <tools-dir> <output-json>
// The source dir is bundled through esbuild stdin; nothing is written into it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [label, source, tools, output] = process.argv.slice(2);
assert.ok(label && source && tools && output, "expected LABEL SOURCE TOOLS OUTPUT_JSON");
const require = createRequire(path.join(tools, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const START = Date.parse("2030-01-01T00:00:00.000Z");
const NUMBER = 108769;
const TARGET = `openclaw/openclaw#${NUMBER}`;
const DEAD_LETTER_KEY = "openclaw/openclaw#108770@publish:1087701:1";

const entry = `
import { ExactReviewQueue } from "./dashboard/exact-review-queue.ts";
import { publicExactReviewQueueProjection } from "./dashboard/worker.ts";
let clock = ${START};
Date.now = () => clock;
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/proof/clock") {
      clock = Number(url.searchParams.get("at"));
      return Response.json({ clock });
    }
    if (url.pathname === "/proof/drop-witness") {
      const state = this.readStateSync();
      const key = url.searchParams.get("key");
      if (!state.items[key]) return Response.json({ ok: false }, { status: 404 });
      delete state.items[key].publicationSuccessorWitness;
      this.writeStateSync(state);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/proof/add-dead-letter") {
      // Synthetic stand-in for an exhausted publication: parked dead_letter_capacity.
      const state = this.readStateSync();
      const template = state.items[url.searchParams.get("template")];
      const decision = structuredClone(template.decision);
      decision.itemNumber = 108770;
      decision.publication.itemKey = "openclaw/openclaw#108770";
      decision.publication.producerRunId = "1087701";
      decision.publication.producerDecision = { ...decision.publication.producerDecision, itemNumber: 108770 };
      delete decision.publication.producerDecision.commandStatusMarker;
      delete decision.publication.producerDecision.statusCommentId;
      delete decision.commandStatusMarker;
      delete decision.statusCommentId;
      state.items["${DEAD_LETTER_KEY}"] = {
        key: "${DEAD_LETTER_KEY}", decision, state: "parked", parkedReason: "dead_letter_capacity",
        revision: 1, attempts: 0, createdAt: clock, updatedAt: clock, nextAttemptAt: clock,
      };
      this.writeStateSync(state);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/proof/alarm") {
      await this.alarm();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/proof/items") {
      return Response.json(Object.values(this.readStateSync().items).map((item) => ({
        key: item.key, state: item.state, parked_reason: item.parkedReason ?? null,
        created_at: item.createdAt, next_attempt_at: item.nextAttemptAt,
        terminal_finalization: Boolean(item.terminalFinalization),
      })));
    }
    if (url.pathname === "/proof/public-stats") {
      const stats = await (await super.fetch(new Request("https://queue/stats"))).json();
      return Response.json({ stats, public: publicExactReviewQueueProjection(stats) });
    }
    return super.fetch(request);
  }
}
export default { fetch(request, env) { return env.QUEUE.get(env.QUEUE.idFromName("proof")).fetch(request); } };
`;

function publicationBody(delivery, runId, rev, markerChar, commentId, number = NUMBER) {
  const producerDecision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: number,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
    ...(markerChar
      ? {
          commandStatusMarker: `<!-- clawsweeper-command-status:${number}:re_review:${markerChar.repeat(40)} -->`,
          statusCommentId: commentId,
        }
      : {}),
  };
  return {
    delivery_id: delivery,
    decision: {
      ...producerDecision,
      sourceAction: "exact_review_artifact_publish",
      publication: {
        artifactName: `exact-review-${runId}-1`,
        producerRunId: runId,
        producerRunAttempt: 1,
        sourceSha: "a".repeat(40),
        itemKey: `openclaw/openclaw#${number}`,
        protocolVersion: 2,
        leaseRevision: rev,
        claimGeneration: 1,
        liveProceeded: true,
        liveTerminalNoop: false,
        liveTerminalMissing: false,
        liveGuardedOpen: false,
        producerDecision,
      },
    },
  };
}

function directPlan(revision, fenceKey, claimGeneration, number = NUMBER) {
  const content = Buffer.from(`result-${revision}`);
  const target = `openclaw/openclaw#${number}`;
  return {
    canonicalTargetKey: target,
    fenceKey,
    revision,
    identity: { canonicalTargetKey: target, fenceKey, revision, claimGeneration },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${number}.md`,
        deleted: false,
        mode: "100644",
        bytes: content.byteLength,
        contentBase64: content.toString("base64"),
      },
    ],
    totalBytes: content.byteLength,
  };
}

const gitHead = () => {
  if (process.env.PROOF_SOURCE_HEAD)
    return {
      head: process.env.PROOF_SOURCE_HEAD,
      working_tree_dirty: false,
      source_kind: "git archive",
    };
  try {
    return {
      head: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      working_tree_dirty: Boolean(
        execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim(),
      ),
    };
  } catch {
    return { head: null, working_tree_dirty: null };
  }
};

const bundle = await build({
  stdin: { contents: entry, resolveDir: source, sourcefile: "proof-entry.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
});
let outbound = 0;
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-08",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { QUEUE: { className: "ProofQueue", useSQLite: true } },
  bindings: {
    EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
    EXACT_REVIEW_PUBLICATION_BATCH_MAX_CONCURRENT: "2",
    EXACT_REVIEW_PUBLICATION_BATCH_LEASE_MS: "60000",
  },
  outboundService: () => {
    outbound += 1;
    return new Response("blocked", { status: 599 });
  },
});
const receipt = {
  label,
  // Local checkout paths stay out of committed receipts; the head SHA identifies the source.
  source: "<checkout>",
  ...gitHead(),
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  runtime:
    "workerd / SQLite Durable Object (Miniflare), synthetic 2030 clock, outbound network blocked",
  source_sha256: Object.fromEntries(
    [
      "dashboard/exact-review-queue.ts",
      "dashboard/exact-review-read-model.ts",
      "dashboard/exact-review-health.ts",
      "dashboard/worker.ts",
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(source, file)))
        .digest("hex"),
    ]),
  ),
  observations: [],
};
try {
  await mf.ready;
  const call = async (p, body) => {
    const response = await mf.dispatchFetch(
      `https://queue${p}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return response.json();
  };
  const at = (ms) => call(`/proof/clock?at=${ms}`);
  const observe = async (phase, now, rowKey) => {
    const claim = await call("/publication-batches/claim", {
      claim_id: `probe-${phase}`,
      lease_owner: `probe-${phase}`,
      max_items: 50,
    });
    const { stats, public: projected } = await call("/proof/public-stats");
    const items = await call("/proof/items");
    const row = items.find((item) => item.key === rowKey);
    const lane = stats.lanes.publication;
    const pub = projected.lanes.publication;
    const observation = {
      phase,
      row_retained: Boolean(row),
      row_state: row?.state ?? null,
      claim: {
        claimed: claim.claimed,
        items: claim.batch?.items?.length ?? 0,
        includes_row: Boolean(claim.batch?.items?.some((item) => item.item_key === rowKey)),
        preflight_required: claim.preflight_required ?? false,
        reason: claim.reason ?? null,
      },
      private_lane: {
        pending: lane.pending,
        ready: lane.ready,
        backoff: lane.backoff,
        parked: lane.parked,
        parked_reasons: lane.parked_reasons,
        oldest_ready_at: lane.oldest_ready_at,
        next_attempt_at: lane.next_attempt_at,
        health: lane.health,
      },
      public_lane: {
        collection: projected.collection.state,
        pending: pub.pending,
        ready: pub.ready,
        parked: pub.parked,
        parked_reasons_nonzero: Object.fromEntries(
          Object.entries(pub.parked_reasons).filter(([, count]) => count > 0),
        ),
        oldest_ready_at: pub.oldest_ready_at,
      },
      row_pins_oldest_ready: row
        ? lane.oldest_ready_at === new Date(row.created_at).toISOString()
        : false,
      queue_items: items.map((item) => ({
        key: item.key.replace(/#\d+/, "#N"),
        state: item.state,
        parked_reason: item.parked_reason,
      })),
    };
    receipt.observations.push(observation);
    return observation;
  };
  await at(START);
  const a = await call("/enqueue", publicationBody("a", `${NUMBER}1`, 1, "a", NUMBER * 10 + 1));
  assert.equal(a.queued, true, JSON.stringify(a));
  const batchA = (
    await call("/publication-batches/claim", { claim_id: "a", lease_owner: "w-a", max_items: 1 })
  ).batch;
  assert.equal(batchA.items[0].item_key, a.item_key);
  const b = await call("/enqueue", publicationBody("b", `${NUMBER}2`, 2, null, null));
  assert.equal(b.queued, true, JSON.stringify(b));
  // Pre-#1475 historical row: no retained successor witness.
  assert.equal((await call(`/proof/drop-witness?key=${encodeURIComponent(a.item_key)}`)).ok, true);
  const claimB = await call("/publication-batches/claim", {
    claim_id: "b",
    lease_owner: "w-b",
    max_items: 1,
    runner_run_id: String(NUMBER),
    runner_run_attempt: 1,
    runner_started_at: new Date(START).toISOString(),
  });
  const memberB = claimB.batch.items[0];
  assert.equal(memberB.item_key, b.item_key);
  assert.equal(
    (
      await call(
        "/publication-batch-results",
        directPlan(memberB.revision, memberB.item_key, memberB.claim_generation),
      )
    ).accepted,
    true,
  );
  assert.equal(
    (
      await call("/lifecycle/router-receipt", {
        canonical_target_key: TARGET,
        fence_key: memberB.item_key,
        revision: memberB.revision,
        receipt_id: "router-b",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call("/publication-batches/complete", {
        batch_id: "b",
        lease_owner: "w-b",
        items: [{ ...memberB, terminal_outcome: "published" }],
      })
    ).accepted,
    1,
  );
  await at(Date.parse(batchA.lease_expires_at) + 1);
  await call("/proof/alarm");
  const createdAt = (await call("/proof/items")).find((item) => item.key === a.item_key).created_at;
  for (const [phase, hours] of [
    ["held_90m", 1.5],
    ["held_24h", 24],
    ["held_40d", 24 * 40],
  ]) {
    const now = createdAt + hours * 3_600_000;
    await at(now);
    await call("/proof/alarm");
    const observation = await observe(phase, now, a.item_key);
    assert.ok(
      observation.row_retained && observation.row_state === "pending",
      `${phase}: row retained`,
    );
    assert.equal(observation.claim.claimed, false, `${phase}: row never claimable`);
  }
  // Positive control: at the same time an unrelated fresh publication is claimable
  // through the same route, and the claim still leaves the held row out.
  const control = await call(
    "/enqueue",
    publicationBody("control", "1087711", 1, null, null, 108771),
  );
  assert.equal(control.queued, true, JSON.stringify(control));
  const controlClaim = await call("/publication-batches/claim", {
    claim_id: "control",
    lease_owner: "w-control",
    max_items: 50,
    runner_run_id: "1087711",
    runner_run_attempt: 1,
    runner_started_at: new Date(createdAt + 24 * 40 * 3_600_000).toISOString(),
  });
  const controlMembers = controlClaim.batch?.items ?? [];
  receipt.control_claim = {
    claimed: controlClaim.claimed,
    member_keys: controlMembers.map((item) => item.item_key.replace(/#\d+/, "#N")),
    includes_held_row: controlMembers.some((item) => item.item_key === a.item_key),
  };
  assert.equal(controlClaim.claimed, true, JSON.stringify(controlClaim));
  assert.deepEqual(
    controlMembers.map((item) => item.item_key),
    [control.item_key],
  );
  const controlMember = controlMembers[0];
  assert.equal(
    (
      await call(
        "/publication-batch-results",
        directPlan(
          controlMember.revision,
          controlMember.item_key,
          controlMember.claim_generation,
          108771,
        ),
      )
    ).accepted,
    true,
  );
  assert.equal(
    (
      await call("/lifecycle/router-receipt", {
        canonical_target_key: "openclaw/openclaw#108771",
        fence_key: controlMember.item_key,
        revision: controlMember.revision,
        receipt_id: "router-control",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call("/publication-batches/complete", {
        batch_id: "control",
        lease_owner: "w-control",
        items: [{ ...controlMember, terminal_outcome: "published" }],
      })
    ).accepted,
    1,
  );
  // A real dead letter must keep its own parked reason and critical severity.
  await call(`/proof/add-dead-letter?template=${encodeURIComponent(a.item_key)}`);
  await observe("held_plus_dead_letter", createdAt + 24 * 40 * 3_600_000, a.item_key);
  // A newer revision still owns fenced cleanup of the held row.
  await call("/enqueue", publicationBody("d", `${NUMBER}4`, 4, null, null));
  await call("/proof/alarm");
  const cleanup = await observe(
    "after_newer_revision",
    createdAt + 24 * 40 * 3_600_000,
    a.item_key,
  );
  assert.equal(cleanup.row_retained, false, "newer revision terminalizes the held row");
  receipt.outbound_requests = outbound;
  receipt.limits =
    "Synthetic inputs and 2030 clock; the pre-#1475 witness loss is simulated by deleting the retained witness, and the dead letter is injected as a parked dead_letter_capacity row. Hosted-target probes are injected as public; outbound HTTP is blocked. No production state, GitHub, or inference.";
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        head: receipt.head,
        control_claim: receipt.control_claim,
        observations: receipt.observations.map((o) => ({
          phase: o.phase,
          retained: o.row_retained,
          claim: o.claim,
          private: o.private_lane,
          public: o.public_lane,
          pins: o.row_pins_oldest_ready,
        })),
      },
      null,
      1,
    ),
  );
} finally {
  await mf.dispose();
}
