import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydrateState } from "../../scripts/hydrate-state.ts";
import { materializeWorkerRecord } from "../../scripts/worker-records.ts";

const repoSlug = "openclaw-openclaw";
const itemNumber = 111745;
const webhookSecret = "single-record-test-secret";

test("single-issue hydration fetches one authenticated Worker record without snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-state-"));
  const stateRoot = join(root, "state");
  const worktreeRoot = join(root, "worktree");
  mkdirSync(join(stateRoot, "jobs"), { recursive: true });
  writeFileSync(join(stateRoot, "jobs", "pending.md"), "durable operational state\n");
  mkdirSync(join(worktreeRoot, "records", repoSlug, "items"), { recursive: true });
  writeFileSync(join(worktreeRoot, "records", repoSlug, "items", "999.md"), "stale\n");

  const content = "---\nnumber: 111745\n---\nsmall proven bug\n";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json({
      content,
      digest: createHash("sha256").update(content).digest("hex"),
      revision: 42,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
  };

  const result = await hydrateState(
    [
      "--state-dir",
      stateRoot,
      "--worktree",
      worktreeRoot,
      "--skip-state-blobs",
      "--records-item-number",
      String(itemNumber),
    ],
    {
      CLAWSWEEPER_RECORDS_SECRET: webhookSecret,
      CLAWSWEEPER_RECORDS_REPO_SLUGS: repoSlug,
      CLAWSWEEPER_RECORDS_URL: "https://worker.example.test",
    },
    fetchImpl as typeof fetch,
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    `https://worker.example.test/internal/state/records/${repoSlug}/items/${itemNumber}`,
  );
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(requests[0]?.init?.body, undefined);
  const expectedSignature = `sha256=${createHmac("sha256", webhookSecret).update("").digest("hex")}`;
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("x-clawsweeper-exact-review-signature"),
    expectedSignature,
  );
  assert.equal(
    readFileSync(join(worktreeRoot, "records", repoSlug, "items", `${itemNumber}.md`), "utf8"),
    content,
  );
  assert.throws(() => readFileSync(join(worktreeRoot, "records", repoSlug, "items", "999.md")));
  assert.equal(
    readFileSync(join(worktreeRoot, "jobs", "pending.md"), "utf8"),
    "durable operational state\n",
  );
  assert.deepEqual(result.worker[repoSlug]?.coverageTrackedItemIds, [itemNumber]);
  assert.equal(result.worker[repoSlug]?.recordCount, 1);
  assert.equal(result.worker[repoSlug]?.snapshotCache, "direct");
});

test("single-issue hydration rejects invalid identifiers before remote reads", async () => {
  let reads = 0;
  const fetchImpl = async () => {
    reads += 1;
    return Response.json({});
  };
  for (const value of ["0", "-1", "1.5", "9007199254740992", "1oops"]) {
    await assert.rejects(
      hydrateState(
        ["--skip-git-state", "--skip-state-blobs", "--records-item-number", value],
        { CLAWSWEEPER_RECORDS_SECRET: webhookSecret, CLAWSWEEPER_RECORDS_REPO_SLUGS: repoSlug },
        fetchImpl as typeof fetch,
      ),
      /positive safe integer/,
    );
  }
  for (const slugs of [undefined, "openclaw-openclaw,openclaw-other"]) {
    await assert.rejects(
      hydrateState(
        ["--skip-git-state", "--skip-state-blobs", "--records-item-number", String(itemNumber)],
        { CLAWSWEEPER_RECORDS_SECRET: webhookSecret, CLAWSWEEPER_RECORDS_REPO_SLUGS: slugs },
        fetchImpl as typeof fetch,
      ),
      /exactly one explicit repository slug/,
    );
  }
  assert.equal(reads, 0);
});

test("single-issue hydration refuses corrupt Worker content without replacing local records", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-corrupt-"));
  const preservedPath = join(root, "records", repoSlug, "items", "100.md");
  mkdirSync(join(root, "records", repoSlug, "items"), { recursive: true });
  writeFileSync(preservedPath, "keep\n");
  const fetchImpl = async () =>
    Response.json({ content: "corrupted", digest: "0".repeat(64), revision: 7 });

  await assert.rejects(
    hydrateState(
      [
        "--worktree",
        root,
        "--skip-git-state",
        "--skip-state-blobs",
        "--records-item-number",
        String(itemNumber),
      ],
      {
        CLAWSWEEPER_RECORDS_SECRET: webhookSecret,
        CLAWSWEEPER_RECORDS_REPO_SLUGS: repoSlug,
      },
      fetchImpl as typeof fetch,
    ),
    /digest does not match/,
  );
  assert.equal(readFileSync(preservedPath, "utf8"), "keep\n");
});

test("single-issue hydration retries malformed successful edge responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-edge-"));
  const content = "current canonical report\n";
  let reads = 0;
  const fetchImpl = async () => {
    reads += 1;
    return reads === 1
      ? new Response("", { status: 200 })
      : Response.json({
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          revision: 11,
        });
  };

  await materializeWorkerRecord({
    worktreeRoot: root,
    baseUrl: "https://worker.example.test",
    webhookSecret,
    repoSlug,
    itemNumber,
    fetch: fetchImpl as typeof fetch,
  });
  assert.equal(reads, 2);
  assert.equal(
    readFileSync(join(root, "records", repoSlug, "items", `${itemNumber}.md`), "utf8"),
    content,
  );
});

test("single-issue hydration retries malformed Worker record envelopes", async () => {
  const content = "current canonical report\n";
  const digest = createHash("sha256").update(content).digest("hex");
  for (const malformed of [
    {},
    [],
    { content },
    { content, digest },
    { content, digest, revision: 0 },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-envelope-"));
    let reads = 0;
    await materializeWorkerRecord({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumber,
      fetch: (async () => {
        reads += 1;
        return Response.json(reads === 1 ? malformed : { content, digest, revision: 11 });
      }) as typeof fetch,
    });
    assert.equal(reads, 2, JSON.stringify(malformed));
    assert.equal(
      readFileSync(join(root, "records", repoSlug, "items", `${itemNumber}.md`), "utf8"),
      content,
    );
  }
});

test("single-issue hydration bounds repeated malformed Worker record envelopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-envelope-failure-"));
  let reads = 0;
  await assert.rejects(
    materializeWorkerRecord({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumber,
      fetch: (async () => {
        reads += 1;
        return Response.json({});
      }) as typeof fetch,
    }),
    /invalid_json_body/,
  );
  assert.equal(reads, 3);
});

test("failed staged record installation restores the existing canonical record tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-rename-"));
  const preservedPath = join(root, "records", repoSlug, "items", "100.md");
  mkdirSync(join(root, "records", repoSlug, "items"), { recursive: true });
  writeFileSync(preservedPath, "keep\n");
  const content = "replacement\n";
  const originalRename = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    if (
      String(oldPath).includes(".worker-records-stage-") &&
      String(oldPath).endsWith("/records")
    ) {
      throw new Error("simulated staged replacement failure");
    }
    return originalRename(oldPath, newPath);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      materializeWorkerRecord({
        worktreeRoot: root,
        baseUrl: "https://worker.example.test",
        webhookSecret,
        repoSlug,
        itemNumber,
        fetch: (async () =>
          Response.json({
            content,
            digest: createHash("sha256").update(content).digest("hex"),
            revision: 12,
          })) as typeof fetch,
      }),
      /simulated staged replacement failure/,
    );
    assert.equal(readFileSync(preservedPath, "utf8"), "keep\n");
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});
