// Run from a checkout with its frozen dependencies installed. Each side of the
// upgrade uses committed source and a separate workerd process.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const bayQueue = "ff4b89dd6cdc4f905f714338004f2c30a7e7d194";
const release = "22265ff14ea73421cfaba18a17cca92a3c13d8e9"; // v0.3.5
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "exact-review-bundle-upgrade-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packagePaths = [join(repo, "node_modules")];

function checkout(ref) {
  const dir = join(scratch, ref);
  mkdirSync(dir);
  const archive = join(dir, "source.tar");
  execFileSync("git", ["archive", "-o", archive, ref, "src", "dashboard", "config", "schema"], {
    cwd: repo,
  });
  execFileSync("tar", ["xf", archive, "-C", dir]);
  return dir;
}

async function bundleCli(source) {
  const outfile = join(source, "bundle-cli.mjs");
  await build({
    entryPoints: [join(source, "src/repair/exact-review-bundle-cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    nodePaths: packagePaths,
  });
  return outfile;
}

async function queueScript(source) {
  const built = await build({
    stdin: {
      contents: `
        import { ExactReviewQueue } from "./dashboard/exact-review-queue.ts";
        export class Queue extends ExactReviewQueue {
          constructor(ctx, env) {
            super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" });
          }
          async alarm() {} // The proof drives the publication claim itself.
        }
        export default { fetch(request, env) {
          return env.QUEUE.get(env.QUEUE.idFromName("queue")).fetch(request);
        } };
      `,
      resolveDir: source,
      sourcefile: "upgrade-worker.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    nodePaths: packagePaths,
    write: false,
  });
  return built.outputFiles[0].text;
}

async function withQueue(script, store, exercise) {
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      name: "bundle-upgrade",
      modules: true,
      script,
      compatibilityDate: "2026-05-11",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      durableObjects: { QUEUE: { className: "Queue", useSQLite: true } },
      bindings: {
        EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
        EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
      },
      outboundService: () => {
        throw new Error("unexpected outbound request");
      },
    }),
    resourcePersistencePath: store,
  });
  try {
    await exercise(async (path, body) => {
      const response = await runtime.dispatchFetch(`http://queue${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.ok(response.ok && value.ok, JSON.stringify(value));
      return value;
    });
  } finally {
    await runtime.dispose();
  }
}

function bundleCommand(cli, command, publication, dir) {
  const decision = publication.producerDecision;
  return spawnSync(process.execPath, [cli, command], {
    encoding: "utf8",
    env: {
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_SHA: publication.sourceSha,
      EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
      EXACT_REVIEW_PRODUCER_RUN_ID: publication.producerRunId,
      EXACT_REVIEW_GENERATION_ATTEMPT: String(publication.producerRunAttempt),
      EXACT_REVIEW_ITEM_KEY: publication.itemKey,
      EXACT_REVIEW_PROTOCOL_VERSION: String(publication.protocolVersion),
      EXACT_REVIEW_LEASE_REVISION: String(publication.leaseRevision),
      EXACT_REVIEW_CLAIM_GENERATION: String(publication.claimGeneration),
      EXACT_REVIEW_LIVE_PROCEEDED: String(publication.liveProceeded),
      EXACT_REVIEW_LIVE_TERMINAL_NOOP: String(publication.liveTerminalNoop),
      EXACT_REVIEW_LIVE_TERMINAL_MISSING: String(publication.liveTerminalMissing),
      EXACT_REVIEW_LIVE_GUARDED_OPEN: String(publication.liveGuardedOpen),
      EXACT_REVIEW_TARGET_REPO: decision.targetRepo,
      EXACT_REVIEW_TARGET_BRANCH: decision.targetBranch,
      EXACT_REVIEW_ITEM_NUMBER: String(decision.itemNumber),
      EXACT_REVIEW_ITEM_KIND: decision.itemKind,
      EXACT_REVIEW_DECISION: JSON.stringify(decision),
      EXACT_REVIEW_BUNDLE_DIR: join(dir, "bundle"),
      ...(command === "create" ? { EXACT_REVIEW_REPORT_PATH: join(dir, "report.md") } : {}),
    },
  });
}

function accepted(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejected(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not match the trusted workflow context/);
}

function createHistoricalBundle(source, sourceSha, writer, dir, hasTelemetry) {
  mkdirSync(dir);
  const producer = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "artifact_retention_recovery",
    supersedesInProgress: false,
    commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:command-42 -->",
    ...(hasTelemetry ? { bayJourneyDeliveryId: "749a1c61-7a1a-4155-a24f-fd481bcaa51b" } : {}),
  };
  const request = JSON.parse(
    execFileSync(
      process.execPath,
      [join(source, "src/repair/exact-review-queue-request.ts"), "enqueue", "publication"],
      {
        encoding: "utf8",
        env: {
          CLAIM_DECISION: JSON.stringify(producer),
          GITHUB_SHA: sourceSha,
          GITHUB_RUN_ID: "29380556291",
          GITHUB_RUN_ATTEMPT: "2",
          ARTIFACT_NAME: "exact-review-29380556291-2",
          ITEM_KEY: "openclaw/openclaw#42",
          PROTOCOL_VERSION: "2",
          QUEUE_LEASE_REVISION: "7",
          CLAIM_GENERATION: "3",
          LIVE_PROCEEDED: "true",
          LIVE_TERMINAL_NOOP: "false",
          LIVE_TERMINAL_MISSING: "false",
          LIVE_GUARDED_OPEN: "false",
        },
      },
    ),
  );
  const original = request.decision.publication;
  const report =
    "---\nreview_lease_owner: github-run-29380556291-2\nreview_lease_comment_id: 101\n---\nStored review.\n";
  writeFileSync(join(dir, "report.md"), report);
  const manifest = accepted(bundleCommand(writer, "create", original, dir));
  assert.deepEqual(accepted(bundleCommand(writer, "validate", original, dir)), manifest);
  const manifestPath = join(dir, "bundle/manifest.json");
  const originalBytes = readFileSync(manifestPath);
  rmSync(join(dir, "report.md"));
  return { dir, request, manifest, manifestPath, originalBytes, report };
}

try {
  const beforeRetirement = checkout(bayQueue);
  const previous = checkout(release);
  const current = checkout(head);
  const bayScript = await queueScript(beforeRetirement);
  const releaseScript = await queueScript(previous);
  const currentScript = await queueScript(current);
  const historicalWriter = await bundleCli(beforeRetirement);
  const writer = await bundleCli(previous);
  const reader = await bundleCli(current);
  const historical = createHistoricalBundle(
    beforeRetirement,
    bayQueue,
    historicalWriter,
    join(scratch, "historical"),
    true,
  );
  const legacy = createHistoricalBundle(previous, release, writer, join(scratch, "legacy"), true);
  const ordinary = createHistoricalBundle(
    previous,
    release,
    writer,
    join(scratch, "ordinary"),
    false,
  );
  console.log(JSON.stringify({ head, release, bayQueue, node: process.version }));
  for (const { scenario, oldScript, artifact, retained, expectAccepted } of [
    {
      scenario: "pre-retirement-upgrade",
      oldScript: bayScript,
      artifact: historical,
      retained: true,
      expectAccepted: true,
    },
    {
      scenario: "retained-delivery",
      oldScript: bayScript,
      artifact: legacy,
      retained: true,
      expectAccepted: true,
    },
    {
      scenario: "ordinary-release",
      oldScript: releaseScript,
      artifact: ordinary,
      retained: false,
      expectAccepted: true,
    },
    {
      scenario: "discarded-delivery",
      oldScript: releaseScript,
      artifact: legacy,
      retained: false,
      expectAccepted: false,
    },
  ]) {
    const { dir, request, manifest, manifestPath, originalBytes, report } = artifact;
    const store = join(scratch, scenario, "sqlite");
    await withQueue(oldScript, store, async (post) => {
      assert.equal((await post("/enqueue", request)).queued, true);
    });
    await withQueue(currentScript, store, async (post) => {
      const leaseOwner = "upgrade-publisher";
      const claim = await post("/publication-batches/claim", {
        claim_id: "upgrade",
        lease_owner: leaseOwner,
        max_items: 1,
      });
      assert.equal(claim.claimed, true, JSON.stringify(claim));
      const fetched = await post("/publication-batches/fetch", {
        batch_id: claim.batch.batch_id,
        lease_owner: leaseOwner,
      });
      assert.equal(fetched.items.length, 1);
      const saved = fetched.items[0].decision.publication;
      const { bayJourneyDeliveryId, ...withoutId } = request.decision.publication.producerDecision;
      const expectedProducer = retained ? { ...withoutId, bayJourneyDeliveryId } : withoutId;
      assert.deepEqual(saved, {
        ...request.decision.publication,
        producerDecision: expectedProducer,
      });
      const validate = (p) => bundleCommand(reader, "validate", p, dir);
      const result = validate(saved);
      if (!expectAccepted) {
        rejected(bundleCommand(writer, "validate", saved, dir));
        rejected(result);
      } else {
        assert.deepEqual(accepted(result), manifest);
        rejected(
          validate({
            ...saved,
            producerDecision: {
              ...saved.producerDecision,
              commandStatusMarker: "<!-- clawsweeper-command-status:42:re_review:other-command -->",
            },
          }),
        );
        rejected(validate({ ...saved, claimGeneration: saved.claimGeneration + 1 }));
      }
      assert.deepEqual(readFileSync(manifestPath), originalBytes);
      assert.equal(readFileSync(join(dir, "bundle/review/42.md"), "utf8"), report);
      console.log(
        JSON.stringify({
          scenario,
          sourceSha: saved.sourceSha,
          writerDigest: manifest.review.decision_sha256,
          manifestSha256: sha256(originalBytes),
          trustedIdRetained: Object.hasOwn(saved.producerDecision, "bayJourneyDeliveryId"),
          accepted: result.status === 0,
          bytesUnchanged: true,
        }),
      );
    });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
