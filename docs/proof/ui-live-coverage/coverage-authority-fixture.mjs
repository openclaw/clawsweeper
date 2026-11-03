// Explicit synthetic authority service + real producer/Worker/DO/build owners.
// No live GitHub, model or production credentials; metadata can revoke independently
// while the persisted census/body bytes stay EXACTLY the same.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import worker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import { CANONICAL_BODY_PREFIX } from "../../../dashboard/canonical-bodies.ts";
import {
  REVIEW_COVERAGE_INVENTORY_KEY,
  ExactReviewDirectPublicationStore,
} from "../../../dashboard/exact-review-direct-publication.ts";
import { TestStorage } from "../../../test/exact-review-test-storage.ts";
import { publishReviewCoverageInventory } from "../../../dist/repair/target-fanout.js";
import {
  readCoverageForBuild,
  publicDashboardInputs,
} from "../../../dashboard-site/scripts/coverage.ts";

export async function authorityFixture() {
  const secret = "synthetic-authority-chain-secret",
    now = Date.now(),
    at = new Date(now).toISOString();
  const storage = new TestStorage(),
    bodies = new Map(),
    calls = [],
    metadataCalls = [];
  const bucket = {
    async get(key) {
      const value = bodies.get(key);
      return value
        ? {
            size: value.length,
            body: new ReadableStream({
              start(c) {
                c.enqueue(value);
                c.close();
              },
            }),
          }
        : null;
    },
    async put() {
      throw new Error("No proof body writes");
    },
  };
  const store = new ExactReviewDirectPublicationStore(storage, bucket);
  store.ensureSchemaSync();
  for (const [slug, number, status] of [
    ["privacy-revocable", 101, "complete"],
    ["privacy-steady", 201, "failed"],
  ]) {
    const repo = slug.replace("privacy-", "privacy/"),
      content =
        "---\nrepository: " +
        repo +
        "\ntype: issue\nreview_status: " +
        status +
        "\nreviewed_at: " +
        at +
        "\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n---\nExisting synthetic canonical body.",
      value = Buffer.from(content),
      digest = createHash("sha256").update(value).digest("hex");
    bodies.set(CANONICAL_BODY_PREFIX + digest, value);
    storage.sql.exec(
      "INSERT INTO exact_review_canonical_records_v2 (repo_slug,section,item_id,digest,byte_length,deleted,revision,item_key,claim_generation,updated_at,coverage_repo,coverage_status,coverage_reviewed_at,coverage_excluded) VALUES (?,'items',?,?,?,0,7,?,3,?,?,'complete',?,0)",
      slug,
      number,
      digest,
      value.length,
      repo + "#" + number,
      now,
      repo,
      now,
    );
  }
  const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          calls.push({ method: request.method, path: new URL(request.url).pathname });
          return queue.fetch(request);
        },
      }),
    },
  };
  const fetchImpl = (url, init) => worker.fetch(new Request(String(url), init), env);
  const snapshot = {
    generated_at: at,
    repositories: [
      ["privacy/revocable", 7, 101],
      ["privacy/steady", 2, 201],
      ["privacy/coverage-only", 3, 301],
    ].map(([repo, count, start]) => ({
      repo,
      repo_slug: repo.replace("/", "-"),
      visibility: "public",
      observation_scope: "eligible",
      counts_observed_at: at,
      open_issues: count,
      open_pull_requests: 0,
      complete: true,
      items: Array.from({ length: count }, (_, i) => ({
        number: start + i,
        kind: "issue",
        updated_at: at,
        reopened_at: null,
        labels: [],
      })),
    })),
  };
  await publishReviewCoverageInventory({
    baseUrl: "https://local.invalid",
    webhookSecret: secret,
    snapshot,
    fetchImpl,
    attempts: 1,
  });
  let mode = "public";
  const names = [
    "privacy/revocable",
    "privacy/steady",
    "privacy/coverage-only",
    "privacy/history-only",
  ];
  const meta = (name) => ({ full_name: name, visibility: "public" });
  const github = async (path) => {
    metadataCalls.push({ mode, path });
    if (path.startsWith("users/")) {
      if (mode === "partial")
        return path.endsWith("page=1")
          ? Response.json(Array.from({ length: 100 }, (_, i) => meta("privacy/unrelated-" + i)))
          : new Response(null, { status: 429 });
      return Response.json(
        names.filter((name) => name !== "privacy/revocable" || mode === "public").map(meta),
      );
    }
    if (path !== "repos/privacy/revocable") return new Response(null, { status: 404 });
    if (mode === "private")
      return Response.json({ full_name: "privacy/revocable", visibility: "private" });
    if (mode === "404") return new Response(null, { status: 404 });
    if (mode === "renamed") return Response.json(meta("privacy/renamed"));
    if (mode === "403" || mode === "429") return new Response(null, { status: Number(mode) });
    if (mode === "network")
      throw new Error("synthetic upstream private diagnostic must not escape");
    if (mode === "invalid") return Response.json({ visibility: "public" });
    return Response.json(meta("privacy/revocable"));
  };
  const example = JSON.parse(
    readFileSync(new URL("../../../dashboard-site/fixtures/dashboard.json", import.meta.url)),
  ).corpus.repos[0];
  const itemNumber = (repo) =>
    repo === "privacy/revocable" ? 102 : repo === "privacy/steady" ? 202 : 401;
  const part = (repo, n) => ({
    stats: {
      ...example,
      repo,
      slug: repo.replace("/", "-"),
      records: n,
      open: n,
      staleOpen: n,
      reviewed7d: n,
      reviewed30d: n,
    },
    totals: { records: n, typed: n, missingTyped: 0, open: n, archived: 0 },
    distributions: {},
    days: {},
    closes: { total: 0, byReason: {}, days: {}, recent: [] },
    closedElsewhere: {},
    lists: {
      maintainer: [],
      security: [],
      stale: [
        {
          repo,
          number: itemNumber(repo),
          kind: "issue",
          url: "https://github.com/" + repo + "/issues/" + itemNumber(repo),
          title: repo === "privacy/revocable" ? "revoked-title-needle" : "public fixture",
          reviewedAt: at,
          createdAt: null,
          archived: false,
          decision: null,
          closeReason: null,
          proof: null,
          security: null,
          maintainerKind: null,
        },
      ],
    },
    codexMs: [],
    createdToReviewHours: [],
  });
  const cache = {
    version: 2,
    generatedAt: at,
    excludedRepositories: 0,
    repositories: [
      part("privacy/revocable", 7),
      part("privacy/steady", 2),
      part("privacy/history-only", 4),
    ],
  };
  const candidates = () => readCoverageForBuild(secret, fetchImpl, "https://local.invalid");
  const build = async () => publicDashboardInputs(cache, await candidates(), github);
  const anonymous = () =>
    fetchImpl("https://local.invalid/api/review-coverage?repo=privacy/revocable");
  const signed = (
    body,
    method = "POST",
    path = "/internal/review-coverage/build",
    signature = true,
    configured = true,
  ) =>
    worker.fetch(
      new Request("https://local.invalid" + path, {
        method,
        ...(method === "GET" ? {} : { body }),
        headers: signature
          ? {
              "x-clawsweeper-exact-review-signature":
                "sha256=" +
                createHmac("sha256", secret)
                  .update("coverage-build-read-v1\nPOST\n/internal/review-coverage/build\n" + body)
                  .digest("hex"),
            }
          : {},
      }),
      configured ? env : { ...env, CLAWSWEEPER_WEBHOOK_SECRET: "" },
    );
  const canonicalState = () =>
    Array.from(
      storage.sql.exec(
        "SELECT repo_slug,item_id,digest,revision,updated_at FROM exact_review_canonical_records_v2 ORDER BY repo_slug,item_id",
      ),
    );
  return {
    secret,
    env,
    storage,
    queue,
    calls,
    metadataCalls,
    cache,
    snapshot,
    candidates,
    build,
    anonymous,
    signed,
    canonicalState,
    setMode(value) {
      mode = value;
    },
    persisted: () => storage.kv.get(REVIEW_COVERAGE_INVENTORY_KEY),
  };
}
