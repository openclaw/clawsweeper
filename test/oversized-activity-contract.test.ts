import assert from "node:assert/strict";
import test from "node:test";
import {
  activityHash,
  captureOversizedActivity,
  oversizedActivityBlock,
  oversizedActivityNeeded,
  parseOversizedActivityEvidence,
} from "../src/oversized-activity-contract.ts";
import {
  ownedCommentWriteIntent,
  ownedCommentWriteResult,
} from "../src/oversized-activity-write.ts";
import { OversizedActivityStore } from "../dashboard/oversized-activity-store.ts";
import { exactReviewBaseDecisionFrom } from "../dashboard/exact-review-decision.ts";

const repo = "openclaw/openclaw",
  number = 42;
const reference = {
  version: 1 as const,
  repo,
  number,
  epoch: "10000000-0000-0000-0000-000000000000",
};
const old = "2026-01-01T00:00:00Z",
  now = "2026-01-01T00:00:10Z",
  writeTime = "2026-01-01T00:00:12Z";
function fixture() {
  const pull = {
    number,
    title: "Synthetic",
    body: "PR body",
    updated_at: old,
    comments: 1,
    review_comments: 0,
    labels: [],
    state: "open",
    additions: 50001,
    deletions: 0,
    changed_files: 1,
    head: { sha: "b".repeat(40) },
    base: { ref: "main" },
  };
  const comment = {
    id: 9,
    body: "<!-- clawsweeper-command-ack:8 -->",
    created_at: old,
    updated_at: old,
    user: { login: "clawsweeper[bot]" },
  };
  const review = { id: 7, body: "Review A", submitted_at: old, state: "COMMENTED" };
  const streams = [
    [comment],
    [
      { ...comment, event: "commented" },
      { ...review, event: "reviewed" },
    ],
    [],
    [review],
  ];
  const paths: string[] = [];
  const read = (path: string): unknown => {
    paths.push(path);
    if (path.endsWith("/pulls/42")) return structuredClone(pull);
    const index = path.includes("/issues/42/comments")
      ? 0
      : path.includes("/timeline")
        ? 1
        : path.includes("/pulls/42/comments")
          ? 2
          : 3;
    return structuredClone(streams[index]);
  };
  const capture = (initial = false) => {
    const g = captureOversizedActivity(repo, number, now, initial);
    let n = g.next();
    while (n.done !== true) n = g.next(read(n.value));
    return n.value;
  };
  return { pull, comment, review, streams, paths, read, capture };
}

test("queue baseline retains submitted review bodies; same-second human edit refuses", () => {
  const f = fixture(),
    baseline = f.capture(true);
  const request = {
    method: "PATCH",
    path: `repos/${repo}/issues/comments/9`,
    body: { body: "<!-- clawsweeper-command-ack:8 --> Complete" },
  };
  const before = structuredClone(f.comment),
    intent = ownedCommentWriteIntent(request, before);
  f.comment.body = request.body.body;
  f.comment.updated_at = writeTime;
  f.pull.updated_at = writeTime;
  Object.assign(f.streams[1]![0]!, f.comment);
  const receipt = ownedCommentWriteResult(intent, f.comment, f.pull);
  const evidence = { reference, baseline, receipts: [receipt], invalid: null };
  assert.equal(oversizedActivityBlock(evidence, f.capture()), null);
  f.review.body = "Review B";
  Object.assign(f.streams[1]![1]!, f.review);
  assert.match(oversizedActivityBlock(evidence, f.capture())!, /non-owned PR activity/);
});

test("duplicate acknowledgement POST then DELETE in the PATCH second has complete receipts", () => {
  const f = fixture(),
    baseline = f.capture(true),
    receipts = [];
  const duplicate = { ...f.comment, id: 10, created_at: writeTime, updated_at: writeTime };
  const post = ownedCommentWriteIntent(
    { method: "POST", path: "unused", body: { body: duplicate.body } },
    null,
  );
  f.pull.comments = 2;
  f.pull.updated_at = writeTime;
  receipts.push(ownedCommentWriteResult(post, duplicate, f.pull));
  const patch = ownedCommentWriteIntent(
    { method: "PATCH", path: "unused", body: { body: f.comment.body + " Complete" } },
    f.comment,
  );
  f.comment.body += " Complete";
  f.comment.updated_at = writeTime;
  Object.assign(f.streams[1]![0]!, f.comment);
  receipts.push(ownedCommentWriteResult(patch, f.comment, f.pull));
  const deletion = ownedCommentWriteIntent({ method: "DELETE", path: "unused" }, duplicate);
  f.pull.comments = 1;
  receipts.push(ownedCommentWriteResult(deletion, null, f.pull));
  assert.equal(
    oversizedActivityBlock({ reference, baseline, receipts, invalid: null }, f.capture()),
    null,
  );
  assert.match(
    oversizedActivityBlock(
      { reference, baseline, receipts: receipts.slice(0, 2), invalid: null },
      f.capture(),
    )!,
    /comment/,
  );
  f.review.body = "Human edit in same second";
  Object.assign(f.streams[1]![1]!, f.review);
  assert.match(
    oversizedActivityBlock({ reference, baseline, receipts, invalid: null }, f.capture())!,
    /non-owned PR activity/,
  );
});

test("baseline capture keeps bounded pagination, completeness, and admission ambiguity guards", () => {
  for (const mutation of ["missing", "undatable", "ambiguous", "duplicate", "overlarge"]) {
    const f = fixture();
    if (mutation === "missing") f.pull.comments = 2;
    if (mutation === "undatable") f.comment.updated_at = "";
    if (mutation === "ambiguous") f.comment.updated_at = now;
    if (mutation === "duplicate") {
      f.streams[0]!.push({ ...f.comment });
      f.pull.comments = 2;
    }
    if (mutation === "overlarge") {
      f.streams[0] = Array.from({ length: 100 }, (_, id) => ({ ...f.comment, id: id + 100 }));
      f.pull.comments = 300;
    }
    assert.throws(() => f.capture(true), undefined, mutation);
  }
  const f = fixture();
  f.capture(true);
  assert.equal(f.paths.length, 6);
  assert.ok(f.paths.every((p) => !/\/(files|commits|blobs)(\/|$)/.test(p)));
});

test("evidence and decision allowlist reject malformed or wrong-target references explicitly", () => {
  const f = fixture(),
    evidence = { reference, baseline: f.capture(true), receipts: [], invalid: null };
  assert.ok(parseOversizedActivityEvidence(evidence));
  for (const value of [
    null,
    {},
    { ...evidence, baseline: { ...evidence.baseline, streams: [[null], [], [], []] } },
    { ...evidence, receipts: [null] },
    {
      ...evidence,
      baseline: {
        ...evidence.baseline,
        comments: [evidence.baseline.comments[0], evidence.baseline.comments[0]],
      },
    },
  ])
    assert.equal(parseOversizedActivityEvidence(value), null);
  const decision = {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "opened",
    supersedesInProgress: false,
    oversizedActivityReference: reference,
  };
  assert.deepEqual(exactReviewBaseDecisionFrom(decision)?.oversizedActivityReference, reference);
  for (const ref of [
    { ...reference, number: 43 },
    { ...reference, repo: "elsewhere/repo" },
    { ...reference, epoch: "broken" },
    null,
  ])
    assert.equal(
      exactReviewBaseDecisionFrom({ ...decision, oversizedActivityReference: ref }),
      null,
    );
  assert.equal(
    oversizedActivityNeeded({ ...fixture().pull, additions: 50000, deletions: 0 }, undefined),
    false,
  );
  assert.equal(
    oversizedActivityNeeded({ ...fixture().pull, additions: 50001, deletions: 0 }, undefined),
    true,
  );
  assert.equal(
    oversizedActivityNeeded({ ...fixture().pull, additions: 2, deletions: 0 }, "1"),
    true,
  );
  assert.equal(activityHash("a").length, 64);
});

test("durable receipts survive reconstruction and fence prevents convergence until release or expiry", async () => {
  const memory = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => structuredClone(memory.get(key)) as T | undefined,
    put: (key: string, value: unknown) => {
      memory.set(key, structuredClone(value));
    },
  };
  const f = fixture();
  const store = new OversizedActivityStore(kv);
  const ref = await store.prepare(repo, number, { head: "b" }, async (path) => f.read(path));
  assert.ok(store.evidence(ref)?.baseline);
  const intent = ownedCommentWriteIntent(
    { method: "PATCH", path: "unused", body: { body: f.comment.body } },
    f.comment,
  );
  store.begin(ref, intent);
  assert.match(store.evidence(ref)?.invalid || "", /no complete receipt/);
  store.complete(ref, ownedCommentWriteResult(intent, f.comment, f.pull));
  assert.equal(new OversizedActivityStore(kv).evidence(ref)?.receipts.length, 1);
  const owner = {
    itemKey: `${repo}#${number}`,
    leaseId: "lease",
    claimGeneration: 1,
    runId: "123",
    runAttempt: 1,
  };
  assert.equal(store.fence(ref, owner, Date.now() + 60000), true);
  assert.throws(() => store.lockAcknowledgement(ref), /fenced/);
  store.release(ref, { ...owner, runId: "999" });
  assert.equal(store.blocked(repo, number), true);
  store.release(ref, owner);
  assert.equal(store.blocked(repo, number), false);
  assert.equal(store.fence(ref, owner, Date.now() - 1), true);
  assert.equal(store.blocked(repo, number), false);
  assert.ok([...memory.values()].every((v) => Buffer.byteLength(JSON.stringify(v)) < 128 * 1024));
});

test("late baseline capture cannot overwrite a successor fence or its pending receipts", async () => {
  const memory = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => structuredClone(memory.get(key)) as T | undefined,
    put: (key: string, value: unknown) => {
      memory.set(key, structuredClone(value));
    },
  };
  const store = new OversizedActivityStore(kv),
    f = fixture();
  let first = true;
  const owner = {
    itemKey: `${repo}#${number}`,
    leaseId: "successor",
    claimGeneration: 2,
    runId: "124",
    runAttempt: 1,
  };
  const ref = await store.prepare(repo, number, { head: "b" }, async (path) => {
    if (first) {
      first = false;
      const key = `oversized-activity:v1:item:${repo}#${number}`;
      const control: any = kv.get(key);
      kv.put(key, { ...control, busyUntil: Date.now() - 1 });
      const token = store.lockAcknowledgement(control.reference);
      store.unlockAcknowledgement(control.reference, token);
      assert.equal(store.fence(control.reference, owner, Date.now() + 60000), true);
      const intent = ownedCommentWriteIntent(
        { method: "PATCH", path: "unused", body: { body: f.comment.body } },
        f.comment,
      );
      store.begin(control.reference, intent);
    }
    return f.read(path);
  });
  assert.equal(store.owns(ref, owner), true);
  assert.match(store.evidence(ref)?.invalid || "", /capture ownership/);
  const meta: any = kv.get(`oversized-activity:v1:epoch:${ref.epoch}`);
  assert.equal(meta.receiptCount, 1);
  assert.ok(meta.pending);
});

test("unsealed or failed publishers cannot authorize a successor close", async () => {
  for (const seal of [undefined, false, true]) {
    const memory = new Map<string, unknown>();
    const kv = {
      get: <T>(key: string) => structuredClone(memory.get(key)) as T | undefined,
      put: (key: string, value: unknown) => {
        memory.set(key, structuredClone(value));
      },
    };
    const store = new OversizedActivityStore(kv),
      f = fixture();
    const ref = await store.prepare(repo, number, {}, async (path) => f.read(path));
    const owner = {
      itemKey: `${repo}#${number}`,
      leaseId: "producer",
      claimGeneration: 1,
      runId: "123",
      runAttempt: 1,
    };
    assert.equal(store.fence(ref, owner, Date.now() + 60000), true);
    if (seal !== undefined) store.seal(ref, owner, seal);
    store.release(ref, owner);
    assert.equal(
      store.fence(
        ref,
        {
          ...owner,
          itemKey: `${repo}#${number}@publish:123:1`,
          leaseId: "publisher",
          runId: "124",
        },
        Date.now() + 60000,
      ),
      true,
    );
    if (seal === false) assert.equal(store.evidence(ref)?.invalid, null);
    else assert.ok(store.evidence(ref)?.invalid);
  }
});

test("reviewer subprocesses cannot inherit publisher receipt capabilities", async () => {
  const { codexEnv } = await import("../dist/codex-env.js");
  const { codexSubprocessEnv } = await import("../dist/repair/process-env.js");
  const keys = [
    "CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT",
    "CLAWSWEEPER_WEBHOOK_SECRET",
    "EXACT_REVIEW_LEASE_ID",
    "EXACT_REVIEW_DECISION",
    "GITHUB_ENV",
    "GITHUB_EVENT_PATH",
  ];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "synthetic-publisher-capability";
    for (const env of [codexEnv({ ghToken: "synthetic-read-only" }), codexSubprocessEnv()])
      for (const key of keys) assert.equal(env[key], undefined, key);
    assert.equal(codexEnv({ ghToken: "synthetic-read-only" }).GH_TOKEN, "synthetic-read-only");
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("publisher losing ownership during pre-write metadata cannot mutate the comment", async () => {
  const { observeOversizedCommentWrite } = await import("../dist/oversized-activity-runtime.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(join(tmpdir(), "oversized-owner-"));
  const prior = process.env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT;
  let current = true,
    writes = 0;
  const owner = {
    itemKey: `${repo}#42`,
    leaseId: "synthetic",
    claimGeneration: 1,
    runId: "123",
    runAttempt: 1,
  };
  process.env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT = JSON.stringify({
    reference,
    owner,
    queueUrl: "http://127.0.0.1",
    failurePath: join(directory, "failed.json"),
  });
  const f = fixture();
  try {
    assert.throws(
      () =>
        observeOversizedCommentWrite(
          [
            "api",
            `repos/${repo}/issues/comments/9`,
            "--method",
            "PATCH",
            "-f",
            `body=${f.comment.body} Updated`,
          ],
          (args) => {
            if (args[1]!.endsWith("/pulls/42")) {
              current = false;
              return JSON.stringify(f.pull);
            }
            if (!args.includes("--method")) return JSON.stringify(f.comment);
            writes++;
            return JSON.stringify(f.comment);
          },
          undefined,
          () =>
            current
              ? { ok: true, recorded: true }
              : { ok: true, recorded: false, authority_current: false },
        ),
      /ownership is no longer current/,
    );
    assert.equal(writes, 0);
  } finally {
    if (prior === undefined) delete process.env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT;
    else process.env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});
