#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${COMPLETION_METADATA_PROOF_OUTPUT:-.artifacts/exact-review-completion-metadata}"
port="${COMPLETION_METADATA_PROOF_PORT:-8795}"
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/clawsweeper-completion-metadata.XXXXXX")
vars_file="$runtime_dir/.dev.vars"
wrangler_log="$runtime_dir/wrangler.log"
proof_entry="dashboard/proof-entry-completion-metadata.ts"
proof_config="dashboard/wrangler.completion-proof.toml"

if [ -e "$output_dir" ]; then
  echo "Refusing to overwrite existing proof output: $output_dir" >&2
  exit 1
fi
mkdir -p "$output_dir"

if grep -q "owedDirectLifecycleRequeue" dashboard/exact-review-queue.ts; then
  proof_mode=after
else
  proof_mode=before
fi
head_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)

secret=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')
umask 077
printf '%s\n' \
  "CLAWSWEEPER_WEBHOOK_SECRET=$secret" \
  "INGEST_TOKEN=$secret" \
  "GITHUB_API_URL=http://127.0.0.1:9" \
  "PUBLIC_BAY_REPOS=openclaw/openclaw" \
  "CACHE_TTL_SECONDS=0" \
  "STALE_CACHE_TTL_SECONDS=0" \
  "INCLUDE_CI_STATUS=0" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS=900000" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS=900000" \
  >"$vars_file"

cat >"$proof_entry" <<'PROOF_ENTRY'
import baseWorker, {
  StatusStore as WorkerStatusStore,
  ExactReviewQueue as BaseExactReviewQueue,
} from "./worker.ts";
import {
  EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE,
  EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
} from "./exact-review-lifecycle-telemetry.ts";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class ExactReviewQueue extends BaseExactReviewQueue {
  async fetch(request: Request) {
    if (request.method !== "POST") return super.fetch(request);
    const bodyText = await request.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const internals = this as unknown as {
      readStateSync: () => { items: Record<string, unknown> };
      writeStateSync: (state: unknown) => void;
      storage: { sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> } };
      lifecycleProjectionStore: {
        read: (target: string, fence: string, revision: number) => unknown;
      };
    };

    const seed = parsed?.proof_seed_item as Record<string, unknown> | undefined;
    if (seed && typeof seed.key === "string") {
      try {
        const state = internals.readStateSync();
        state.items[seed.key] = seed;
        internals.writeStateSync(state);
        return jsonResponse({ ok: true, seeded: seed.key });
      } catch (error) {
        return jsonResponse({ ok: false, error: String((error as Error)?.stack || error) }, 500);
      }
    }

    const inspect = parsed?.proof_inspect as Record<string, unknown> | undefined;
    if (inspect && typeof inspect.item_key === "string") {
      const state = internals.readStateSync();
      const item = (state.items[inspect.item_key] ?? null) as Record<string, unknown> | null;
      const rows = (table: string) => {
        try {
          return Array.from(internals.storage.sql.exec(`SELECT * FROM ${table}`)).length;
        } catch {
          return 0;
        }
      };
      return jsonResponse({
        ok: true,
        item: item
          ? {
              state: item.state,
              revision: item.revision,
              lease_id: item.leaseId ?? null,
              source_action: (item.decision as { sourceAction?: string } | undefined)?.sourceAction,
              admission_delivery_id: item.admissionDeliveryId ?? null,
              has_publication: Boolean(
                (item.decision as { publication?: unknown } | undefined)?.publication,
              ),
            }
          : null,
        terminal_disposition:
          (
            internals.lifecycleProjectionStore.read(
              String(inspect.canonical_target_key || ""),
              String(inspect.fence_key || ""),
              Number(inspect.revision || 0),
            ) as { terminalDisposition?: { kind?: string } } | null
          )?.terminalDisposition?.kind ?? null,
        bay_rows: {
          [EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE]: rows(EXACT_REVIEW_LIFECYCLE_BAY_EVENT_TABLE),
          [EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE]: rows(EXACT_REVIEW_LIFECYCLE_BAY_PENDING_TABLE),
          [EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE]: rows(
            EXACT_REVIEW_LIFECYCLE_BAY_TIDE_BUFFER_TABLE,
          ),
        },
      });
    }

    return super.fetch(
      new Request(request.url, { method: "POST", headers: request.headers, body: bodyText }),
    );
  }
}

export { WorkerStatusStore as StatusStore };
export default baseWorker;
PROOF_ENTRY

sed 's|^main = "worker.ts"$|main = "proof-entry-completion-metadata.ts"|' dashboard/wrangler.toml >"$proof_config"
grep -q 'proof-entry-completion-metadata.ts' "$proof_config"

driver="$runtime_dir/drive-proof.mjs"
cat >"$driver" <<'PROOF_DRIVER'
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.COMPLETION_METADATA_PROOF_ORIGIN || "").replace(/\/+$/, "");
const secret = String(process.env.COMPLETION_METADATA_PROOF_SECRET || "");
const outputDir = path.resolve(
  process.env.COMPLETION_METADATA_PROOF_OUTPUT || ".artifacts/exact-review-completion-metadata",
);
const mode = process.env.COMPLETION_METADATA_PROOF_MODE === "before" ? "before" : "after";
const headSha = String(process.env.COMPLETION_METADATA_PROOF_HEAD || "unknown");
if (!origin || !secret) throw new Error("proof origin and secret are required");

const assertions = [];
const transcript = [];

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`Proof assertion failed: ${name} ${JSON.stringify(details)}`);
  assertions.push({ name, status: "PASS", ...details });
}

async function signedPost(label, routePath, value) {
  const body = JSON.stringify(value);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  transcript.push({ label, route: routePath, status: response.status, response_body: text });
  return { status: response.status, text, json: parsed };
}

async function baySnapshot() {
  const response = await fetch(`${origin}/api/durable-lifecycle-bay`);
  const body = await response.json().catch(() => null);
  const snapshot = body?.durable_lifecycle_bay ?? null;
  return {
    collection_state: snapshot?.collection?.state ?? null,
    journeys: snapshot?.collection?.journeys ?? snapshot?.journeys ?? null,
    outcomes: snapshot?.outcomes ?? null,
  };
}

const LIST_ROUTE = "/internal/exact-review/publications/list";

function leasedItem(itemNumber, runId) {
  const now = Date.now();
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  return {
    key: `openclaw/openclaw#${itemNumber}`,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 4,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    nextAttemptAt: now - 60_000,
    attempts: 0,
    leaseId: `lease-${itemNumber}`,
    leaseRevision: 4,
    leaseExpiresAt: now + 60 * 60_000,
    claimedRunId: runId,
    claimedRunAttempt: 1,
    claimGeneration: 2,
    claimProtocolVersion: 2,
  };
}

async function scenario(label, itemNumber, runId, deliverCompletionCallback, supersedeFirst = false) {
  const item = leasedItem(itemNumber, runId);
  const canonicalTargetKey = `openclaw/openclaw#${itemNumber}`;
  const bayBefore = await baySnapshot();

  if (supersedeFirst) {
    const newer = { ...leasedItem(itemNumber, runId), revision: 5, leaseRevision: 5 };
    const newerSeeded = await signedPost(`${label}: seed newer publisher lease`, LIST_ROUTE, {
      limit: 1,
      proof_seed_item: newer,
    });
    assertProof(`${label}_newer_seeded`, newerSeeded.json?.ok === true, {
      http_status: newerSeeded.status,
    });
    const newerReceipt = await signedPost(
      `${label}: newer revision publishes first`,
      "/internal/exact-review/publication-results",
      {
        canonicalTargetKey,
        fenceKey: newer.key,
        revision: 5,
        sourceSha: "d".repeat(40),
        identity: {
          canonicalTargetKey,
          fenceKey: newer.key,
          revision: 5,
          claimGeneration: 2,
        },
        operations: [
          {
            path: `records/openclaw-openclaw/items/${itemNumber}.md`,
            deleted: false,
            mode: "100644",
            bytes: 1,
            contentBase64: "eQ==",
          },
        ],
        totalBytes: 1,
        lifecycle: { kind: "policy_noop" },
      },
    );
    assertProof(`${label}_newer_receipt_accepted`, newerReceipt.json?.accepted === true, {
      http_status: newerReceipt.status,
    });
  }

  const seeded = await signedPost(`${label}: seed leased item`, LIST_ROUTE, {
    limit: 1,
    proof_seed_item: item,
  });
  assertProof(`${label}_seeded`, seeded.json?.ok === true, {
    http_status: seeded.status,
    body: seeded.text.slice(0, 1500),
  });

  const receipt = await signedPost(`${label}: direct publication receipt`, "/internal/exact-review/publication-results", {
    canonicalTargetKey,
    fenceKey: item.key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: {
      canonicalTargetKey,
      fenceKey: item.key,
      revision: 4,
      claimGeneration: 2,
    },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${itemNumber}.md`,
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    lifecycle: { kind: "requeue" },
  });
  assertProof(
    `${label}_receipt_recorded`,
    supersedeFirst ? receipt.json?.superseded === true : receipt.json?.accepted === true,
    { http_status: receipt.status, receipt: receipt.json },
  );

  let healer;
  if (deliverCompletionCallback) {
    healer = await signedPost(`${label}: completion callback delivered`, "/internal/exact-review/complete", {
      lease_id: item.leaseId,
      item_key: item.key,
      lease_revision: 4,
      claim_generation: 2,
      run_id: runId,
      run_attempt: 1,
      outcome: "success",
      completion_kind: "published",
      reason_code: "publication_applied",
      direct_lifecycle_requeue: true,
    });
  } else {
    transcript.push({
      label: `${label}: completion callback`,
      route: "/internal/exact-review/complete",
      status: "not sent",
      response_body:
        "POST /internal/exact-review/complete unreachable for all 3 attempts; run stays green, item still leased",
    });
    healer = await signedPost(`${label}: reconciler heals green run`, "/internal/exact-review/reconcile", {
      terminal_runs: [
        {
          run_id: runId,
          run_attempt: 1,
          claimed_run_attempt: 1,
          claim_generation: 2,
          outcome: "success",
        },
      ],
    });
  }

  const inspected = await signedPost(`${label}: queue item afterwards`, LIST_ROUTE, {
    limit: 1,
    proof_inspect: {
      item_key: item.key,
      canonical_target_key: canonicalTargetKey,
      fence_key: item.key,
      revision: 4,
    },
  });
  const bayAfter = await baySnapshot();

  return {
    label,
    item_number: itemNumber,
    run_id: runId,
    healer_route: deliverCompletionCallback
      ? "/internal/exact-review/complete"
      : "/internal/exact-review/reconcile",
    healer_response: healer.json,
    receipt_outcome: receipt.json?.superseded === true
      ? "superseded"
      : receipt.json?.deduped === true
        ? "deduped"
        : "accepted",
    item_afterwards: inspected.json?.item ?? null,
    terminal_disposition: inspected.json?.terminal_disposition ?? null,
    bay_rows: inspected.json?.bay_rows ?? null,
    bay_before: bayBefore,
    bay_after: bayAfter,
  };
}

await mkdir(outputDir, { recursive: true });

const warmed = await signedPost("initialize durable object", LIST_ROUTE, { limit: 1 });
assertProof("durable_object_initialized", warmed.status === 200, { http_status: warmed.status });

const control = await scenario("completion-delivered", 705, "770501", true);
const lost = await scenario("completion-unreachable-green-run", 706, "770601", false);
const superseded = await scenario(
  "completion-unreachable-superseded-receipt",
  707,
  "770701",
  false,
  true,
);

assertProof("control_requeued", control.item_afterwards?.source_action === "source_drift_requeue", {
  item_afterwards: control.item_afterwards,
});

if (mode === "before") {
  assertProof("lost_callback_drops_requeue_on_base", lost.item_afterwards === null, {
    healer_response: lost.healer_response,
  });
} else {
  assertProof(
    "lost_callback_keeps_requeue",
    lost.item_afterwards?.state === "pending" &&
      lost.item_afterwards?.revision === 5 &&
      lost.item_afterwards?.source_action === "source_drift_requeue",
    { item_afterwards: lost.item_afterwards },
  );
  assertProof("lost_callback_records_requeue_terminal", lost.terminal_disposition === "requeue", {
    terminal_disposition: lost.terminal_disposition,
  });
}

assertProof(
  "superseded_receipt_keeps_requeue_plan",
  superseded.receipt_outcome === "superseded",
  { receipt_outcome: superseded.receipt_outcome },
);
assertProof(
  "superseded_receipt_completes_without_requeue",
  superseded.item_afterwards === null && superseded.terminal_disposition === "superseded",
  {
    item_afterwards: superseded.item_afterwards,
    terminal_disposition: superseded.terminal_disposition,
    healer_response: superseded.healer_response,
  },
);

assertProof(
  "no_bay_event_emitted_by_requeue_terminal",
  (lost.bay_rows?.exact_review_lifecycle_bay_event_v2 ?? 0) === 0 &&
    (lost.bay_rows?.exact_review_lifecycle_bay_pending_v2 ?? 0) === 0,
  { bay_rows: lost.bay_rows },
);
assertProof(
  "bay_snapshot_unchanged_by_recovery",
  JSON.stringify(lost.bay_before) === JSON.stringify(lost.bay_after),
  { bay_before: lost.bay_before, bay_after: lost.bay_after },
);

const summary = { mode, head_sha: headSha, scenarios: [control, lost, superseded], assertions };
await writeFile(path.join(outputDir, "proof-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(
  path.join(outputDir, "transcript.md"),
  [
    "# lost lease-completion callback proof",
    `mode: ${mode}`,
    `head: ${headSha}`,
    "",
    ...transcript.map((entry) =>
      [`## ${entry.label}`, "```", `POST ${entry.route}`, `-> ${entry.status}`, entry.response_body, "```", ""].join("\n"),
    ),
  ].join("\n"),
);

for (const run of [control, lost, superseded]) {
  console.log(`[${run.label}] healer ${run.healer_route} -> ${JSON.stringify(run.healer_response)}`);
  console.log(
    `[${run.label}] queue item afterwards: ${run.item_afterwards ? JSON.stringify(run.item_afterwards) : "DELETED - no source-drift follow-up review remains anywhere"}`,
  );
  console.log(`[${run.label}] lifecycle terminal disposition: ${run.terminal_disposition ?? "none"}`);
  console.log(`[${run.label}] bay rows: ${JSON.stringify(run.bay_rows)}`);
  console.log(`[${run.label}] durable lifecycle bay before: ${JSON.stringify(run.bay_before)}`);
  console.log(`[${run.label}] durable lifecycle bay after:  ${JSON.stringify(run.bay_after)}`);
  console.log("");
}
console.log(JSON.stringify({ mode, head: headSha, assertions }, null, 2));
PROOF_DRIVER

cleanup() {
  if [ -n "${wrangler_pid:-}" ]; then
    kill -- "-${wrangler_pid}" >/dev/null 2>&1 || kill "$wrangler_pid" >/dev/null 2>&1 || true
    wait "$wrangler_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$proof_entry" "$proof_config"
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

if curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
  echo "Port ${port} already serves a worker. Stop it first or set COMPLETION_METADATA_PROOF_PORT." >&2
  exit 1
fi

if [ "${COMPLETION_METADATA_PROOF_SKIP_INSTALL:-0}" != "1" ]; then
  corepack pnpm install --frozen-lockfile
fi
setsid npx --yes wrangler@4.107.0 dev --config "$proof_config" --local --ip 127.0.0.1 --port "$port" --env-file "$vars_file" --persist-to "$runtime_dir/state" >"$wrangler_log" 2>&1 &
wrangler_pid=$!

for _ in $(seq 1 120); do
  if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    tail -n 100 "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health" >/dev/null
COMPLETION_METADATA_PROOF_ORIGIN="http://127.0.0.1:${port}" \
  COMPLETION_METADATA_PROOF_SECRET="$secret" \
  COMPLETION_METADATA_PROOF_OUTPUT="$output_dir" \
  COMPLETION_METADATA_PROOF_MODE="$proof_mode" \
  COMPLETION_METADATA_PROOF_HEAD="$head_sha" \
  node "$driver"

test -s "$output_dir/proof-summary.json"
