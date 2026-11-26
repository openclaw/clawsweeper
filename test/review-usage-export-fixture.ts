import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewActionLedger } from "../dist/clawsweeper-review-ledger.js";
import { flushWorkflowActionEvents } from "../dist/action-ledger-runtime.js";
import {
  actionEventShardImportBindings,
  readImportedActionEventShards,
} from "../dist/action-ledger-import.js";
import { prepareSafeReadRoot } from "../dist/action-ledger-files.js";
import { sha256 } from "../dist/content-hash.js";
import { item } from "./helpers.ts";
import type { Item } from "../dist/clawsweeper-types.js";

/** Canonical native writer output served by both unit and real-CLI transport fixtures. */
export async function reviewUsageExportFixture(
  options: { withItem?: boolean; secondProducer?: boolean } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-usage-export-")));
  const source = {
    runId: "12345",
    runAttempt: 2,
    sourceSha: "a".repeat(40),
    partitionDate: "2026-11-26",
    webhookSecret: "fixture-webhook-secret",
    output: join(root, "export"),
  };
  const previous = process.env;
  process.env = {
    ...previous,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: source.partitionDate,
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: source.runId,
    GITHUB_RUN_ATTEMPT: String(source.runAttempt),
    GITHUB_SHA: source.sourceSha,
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
    GITHUB_JOB: "event-review-apply",
    GITHUB_ACTION: "fixture",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "default",
  };
  let paths: string[];
  try {
    const owner = createReviewActionLedger({
      root,
      targetRepo: () => "openclaw/clawsweeper",
      repoRelativePath: (p) => p,
      isRuntimeBudgetError: () => false,
    });
    for (let index = 0; index < (options.secondProducer ? 2 : 1); index += 1) {
      process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = index === 0 ? "default" : "secondary";
      const candidate = item({ repo: "openclaw/clawsweeper", number: 42 + index }) as Item;
      const ledger = owner.startReviewActionLedger({
        candidates: [candidate],
        reviewPolicy: "fixture",
        shardIndex: 0,
        shardCount: 1,
        batchSize: 1,
      });
      if (options.withItem !== false) {
        owner.startReviewActionLedgerItem(ledger, candidate);
        owner.recordReviewActionLedgerUsage(
          ledger,
          candidate,
          { input_tokens: 100, output_tokens: 10 },
          "b".repeat(64),
        );
        owner.finishReviewActionLedgerItem({
          ledger,
          item: candidate,
          status: "completed",
          reasonCode: "completed",
          retryable: false,
          cached: false,
          startedAtMs: Date.now(),
        });
      }
      owner.finishReviewActionLedger({
        ledger,
        completedCount: options.withItem === false ? 0 : 1,
        cacheHits: 0,
      });
    }
    paths = await flushWorkflowActionEvents(root, { outputRoot: root });
  } finally {
    process.env = previous;
  }
  const objects = new Map(paths.map((path) => [path, readFileSync(join(root, path))]));
  const shards = readImportedActionEventShards(prepareSafeReadRoot(root, "fixture"), paths);
  const bindings = actionEventShardImportBindings(shards);
  for (const binding of bindings) objects.set(binding.relativePath, Buffer.from(binding.content));
  const calls: Array<{ operation: string; body: Record<string, unknown> }> = [];
  const descriptor = (path: string, bytes: Buffer) => ({
    path,
    bytes: bytes.length,
    digest: sha256(bytes),
    digestVerified: true,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://clawsweeper.openclaw.ai");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    const text = String(init.body);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(
      new Headers(init.headers).get("x-clawsweeper-exact-review-signature"),
      `sha256=${createHmac("sha256", source.webhookSecret).update(text).digest("hex")}`,
    );
    const operation = url.pathname.replace("/internal/state/blobs/", "");
    calls.push({ operation, body });
    if (operation === "list")
      return Response.json({
        ok: true,
        prefix: body.prefix,
        blobs: [...objects]
          .filter(([p]) => p.startsWith(String(body.prefix)))
          .map(([p, b]) => descriptor(p, b)),
        nextCursor: null,
      });
    const bytes = objects.get(String(body.path));
    if (!bytes) return Response.json({ error: "blob_not_found" }, { status: 404 });
    if (operation === "stat")
      return Response.json({ ok: true, blob: descriptor(String(body.path), bytes) });
    assert.equal(operation, "chunk");
    assert.equal(body.offset, 0);
    assert.equal(body.length, bytes.length);
    return new Response(new Uint8Array(bytes), {
      status: 206,
      headers: {
        "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "x-clawsweeper-blob-digest": sha256(bytes),
      },
    });
  };
  return {
    root,
    source,
    paths,
    bindings,
    objects,
    calls,
    fetchImpl,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
