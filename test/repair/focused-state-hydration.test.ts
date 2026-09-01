import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { hydrateState } from "../../scripts/hydrate-state.ts";
import { materializeWorkerItems } from "../../scripts/worker-records.ts";

const repoSlug = "openclaw-openclaw";
const itemNumber = 111745;
const webhookSecret = "single-record-test-secret";

function captureRetryDelays(t: TestContext) {
  const delays: number[] = [];
  const immediateSetTimeout = (
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    delays.push(Number(delay));
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  t.mock.method(globalThis, "setTimeout", immediateSetTimeout as typeof setTimeout);
  return delays;
}

test("focused batch hydration ignores unavailable snapshots and preserves complete item tuples", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = new Map([
    ["items/101", "open review\n"],
    ["plans/101", "open review plan\n"],
    ["decision-packets/101", '{"decision":"keep_open"}\n'],
    ["closed/102", "closed review\n"],
  ]);
  const requests: string[] = [];
  const result = await hydrateState(
    [
      "--worktree",
      root,
      "--skip-git-state",
      "--skip-state-blobs",
      "--records-item-number",
      "102,101,102",
    ],
    { CLAWSWEEPER_RECORDS_SECRET: webhookSecret, CLAWSWEEPER_RECORDS_REPO_SLUGS: repoSlug },
    (async (url: RequestInfo | URL) => {
      const pathname = new URL(String(url)).pathname;
      requests.push(pathname);
      if (!pathname.startsWith(`/internal/state/records/${repoSlug}/`)) {
        return Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 });
      }
      const key = pathname.split("/").slice(-2).join("/");
      const content = contents.get(key);
      return content === undefined
        ? Response.json({ error: "record_not_found" }, { status: 404 })
        : Response.json({
            content,
            digest: createHash("sha256").update(content).digest("hex"),
            revision: 42,
          });
    }) as typeof fetch,
  );
  assert.equal(requests.length, 8);
  assert.equal(result.worker[repoSlug]?.recordCount, 4);
  assert.deepEqual(result.worker[repoSlug]?.coverageTrackedItemIds, [101]);
  for (const [key, content] of contents) {
    const extension = key.startsWith("decision-packets/") ? "json" : "md";
    assert.equal(
      readFileSync(join(root, "records", repoSlug, `${key}.${extension}`), "utf8"),
      content,
    );
  }
});

test("focused batch hydration leaves existing records intact when a later item fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-batch-failed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preservedPath = join(root, "records", repoSlug, "items", "101.md");
  mkdirSync(join(root, "records", repoSlug, "items"), { recursive: true });
  writeFileSync(preservedPath, "prior review\n");
  await assert.rejects(
    materializeWorkerItems({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumbers: [101, 102],
      fetch: (async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/102"))
          return Response.json({ error: "unauthorized" }, { status: 403 });
        const content = "replacement review\n";
        return Response.json({
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          revision: 42,
        });
      }) as typeof fetch,
    }),
    /unauthorized/,
  );
  assert.equal(readFileSync(preservedPath, "utf8"), "prior review\n");
});

test("focused hydration fetches authenticated item tuples without snapshots", async () => {
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
    if (!String(url).includes("/items/"))
      return Response.json({ error: "record_not_found" }, { status: 404 });
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

  assert.equal(requests.length, 4);
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

test("single-issue hydration preserves valid issue jobs with no open canonical record", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-missing-"));
  const stalePath = join(root, "records", repoSlug, "items", "999.md");
  mkdirSync(join(root, "records", repoSlug, "items"), { recursive: true });
  writeFileSync(stalePath, "stale\n");
  let reads = 0;

  const result = await hydrateState(
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
      CLAWSWEEPER_RECORDS_URL: "https://worker.example.test",
    },
    (async () => {
      reads += 1;
      return Response.json({ error: "record_not_found" }, { status: 404 });
    }) as typeof fetch,
  );

  assert.equal(reads, 4);
  assert.throws(() => readFileSync(stalePath));
  assert.deepEqual(result.worker[repoSlug]?.coverageTrackedItemIds, []);
  assert.equal(result.worker[repoSlug]?.recordCount, 0);
});

test("single-issue hydration refuses unrelated Worker authorization failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-denied-"));
  await assert.rejects(
    materializeWorkerItems({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumbers: [itemNumber],
      fetch: (async () =>
        Response.json({ error: "unauthorized" }, { status: 404 })) as typeof fetch,
    }),
    /unauthorized/,
  );
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

test("single-issue hydration retries malformed successful edge responses", async (t) => {
  const delays = captureRetryDelays(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-edge-"));
  const content = "current canonical report\n";
  let reads = 0;
  const fetchImpl = async (url: RequestInfo | URL) => {
    if (!String(url).includes("/items/"))
      return Response.json({ error: "record_not_found" }, { status: 404 });
    reads += 1;
    return reads === 1
      ? new Response("", { status: 200 })
      : Response.json({
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          revision: 11,
        });
  };

  await materializeWorkerItems({
    worktreeRoot: root,
    baseUrl: "https://worker.example.test",
    webhookSecret,
    repoSlug,
    itemNumbers: [itemNumber],
    fetch: fetchImpl as typeof fetch,
  });
  assert.equal(reads, 2);
  assert.deepEqual(delays, [30_000]);
  assert.equal(
    readFileSync(join(root, "records", repoSlug, "items", `${itemNumber}.md`), "utf8"),
    content,
  );
});

test("single-issue hydration retries malformed Worker record envelopes", async (t) => {
  const delays = captureRetryDelays(t);
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
    await materializeWorkerItems({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumbers: [itemNumber],
      fetch: (async (url: RequestInfo | URL) => {
        if (!String(url).includes("/items/"))
          return Response.json({ error: "record_not_found" }, { status: 404 });
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
  assert.deepEqual(delays, [30_000, 30_000, 30_000, 30_000, 30_000]);
});

test("single-issue hydration bounds repeated malformed Worker record envelopes", async (t) => {
  const delays = captureRetryDelays(t);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-focused-envelope-failure-"));
  let reads = 0;
  await assert.rejects(
    materializeWorkerItems({
      worktreeRoot: root,
      baseUrl: "https://worker.example.test",
      webhookSecret,
      repoSlug,
      itemNumbers: [itemNumber],
      fetch: (async () => {
        reads += 1;
        return Response.json({});
      }) as typeof fetch,
    }),
    /invalid_json_body/,
  );
  assert.equal(reads, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
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
      materializeWorkerItems({
        worktreeRoot: root,
        baseUrl: "https://worker.example.test",
        webhookSecret,
        repoSlug,
        itemNumbers: [itemNumber],
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
