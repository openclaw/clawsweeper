import assert from "node:assert/strict";
import test from "node:test";
import {
  githubReviewTreeBlobSizes,
  REVIEW_TREE_MAX_FILES,
} from "../dist/clawsweeper-review-blobs.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const prefix = "repos/openclaw/openclaw/git/trees/";
const complete = (tree: unknown[]) => ({ truncated: false, tree });
const partial = () => ({ truncated: true, tree: [{ type: "blob", sha: "discarded", size: -1 }] });
const blob = (n: number, size = n) => ({ type: "blob", sha: oid(n), size });
const subtree = (n: number) => ({ type: "tree", sha: oid(n) });

function run(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const sizes = githubReviewTreeBlobSizes({
    repository: "openclaw/openclaw",
    headSha: oid(1),
    request: (path) => {
      const suffix = path.slice(prefix.length);
      calls.push(suffix);
      assert.ok(Object.hasOwn(responses, suffix), path);
      return responses[suffix];
    },
  });
  return { sizes, calls };
}

test("complete recursive metadata keeps the single-request fast path", () => {
  const { sizes, calls } = run({ [oid(1) + "?recursive=1"]: complete([blob(9)]) });
  assert.deepEqual([...sizes], [[oid(9), 9]]);
  assert.equal(calls.length, 1);
});

test("truncated recursive metadata expands complete shallow and nested trees", () => {
  const { sizes, calls } = run({
    [oid(1) + "?recursive=1"]: partial(),
    [oid(1)]: complete([blob(9), subtree(2)]),
    [oid(2) + "?recursive=1"]: partial(),
    [oid(2)]: complete([blob(10), subtree(3)]),
    [oid(3) + "?recursive=1"]: complete([blob(11)]),
  });
  assert.deepEqual(
    [...sizes],
    [
      [oid(9), 9],
      [oid(10), 10],
      [oid(11), 11],
    ],
  );
  assert.equal(calls.length, 5);
  assert.equal(sizes.has("discarded"), false);
});

test("identical child trees share their fetched response", () => {
  const { sizes, calls } = run({
    [oid(1) + "?recursive=1"]: partial(),
    [oid(1)]: complete([subtree(2), subtree(2)]),
    [oid(2) + "?recursive=1"]: complete([blob(9)]),
  });
  assert.deepEqual([...sizes], [[oid(9), 9]]);
  assert.equal(calls.length, 3);
});

test("truncated shallow metadata still fails closed", () => {
  assert.throws(
    () =>
      run({
        [oid(1) + "?recursive=1"]: partial(),
        [oid(1)]: partial(),
      }),
    /incomplete bounded review tree metadata response/,
  );
});

test("fallback rejects malformed child references and blob metadata", () => {
  for (const entry of [null, { type: "tree", sha: "invalid" }, blob(9, -1)]) {
    assert.throws(
      () =>
        run({
          [oid(1) + "?recursive=1"]: partial(),
          [oid(1)]: complete([entry]),
        }),
      /invalid bounded review/,
    );
  }
});

test("fallback rejects inconsistent blob sizes across subtrees", () => {
  assert.throws(
    () =>
      run({
        [oid(1) + "?recursive=1"]: partial(),
        [oid(1)]: complete([blob(9), subtree(2)]),
        [oid(2) + "?recursive=1"]: complete([blob(9, 10)]),
      }),
    /inconsistent bounded review tree blob metadata/,
  );
});

test("aggregate entry budget counts cached subtree occurrences", () => {
  assert.throws(
    () =>
      run({
        [oid(1) + "?recursive=1"]: partial(),
        [oid(1)]: complete([subtree(2), subtree(2)]),
        [oid(2) + "?recursive=1"]: complete(Array(REVIEW_TREE_MAX_FILES / 2).fill(blob(9))),
      }),
    /exceeded its entry limit/,
  );
});

test("fallback refuses cycles", () => {
  assert.throws(
    () =>
      run({
        [oid(1) + "?recursive=1"]: partial(),
        [oid(1)]: complete([subtree(2)]),
        [oid(2) + "?recursive=1"]: partial(),
        [oid(2)]: complete([subtree(2)]),
      }),
    /cyclic bounded review tree metadata/,
  );
});

test("fallback bounds the number of metadata requests", () => {
  let calls = 0;
  assert.throws(
    () =>
      githubReviewTreeBlobSizes({
        repository: "openclaw/openclaw",
        headSha: oid(1),
        request: (path) => {
          calls += 1;
          const [sha, query] = path.slice(prefix.length).split("?");
          return query ? partial() : complete([subtree(Number.parseInt(sha!, 16) + 1)]);
        },
      }),
    /metadata request limit exceeded/,
  );
  assert.equal(calls, 64);
});

test("fallback propagates the caller's shared deadline failure", () => {
  const timeout = new Error("shared metadata deadline expired");
  let calls = 0;
  assert.throws(
    () =>
      githubReviewTreeBlobSizes({
        repository: "openclaw/openclaw",
        headSha: oid(1),
        request: () => {
          if (++calls === 1) return partial();
          throw timeout;
        },
      }),
    (error) => error === timeout,
  );
  assert.equal(calls, 2);
});

test("fallback passes only the remaining shared deadline to each request", (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const budgets: number[] = [];
  const result = githubReviewTreeBlobSizes({
    repository: "openclaw/openclaw",
    headSha: oid(1),
    timeoutMs: 20,
    request: (_path, remainingMs) => {
      budgets.push(remainingMs);
      now += 7;
      return budgets.length === 1 ? partial() : complete([blob(9)]);
    },
  });
  assert.deepEqual(budgets, [20, 13]);
  assert.equal(result.get(oid(9)), 9);
});

test("metadata returned after the shared deadline is not admitted", (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  assert.throws(
    () =>
      githubReviewTreeBlobSizes({
        repository: "openclaw/openclaw",
        headSha: oid(1),
        timeoutMs: 20,
        request: () => {
          now += 21;
          return complete([blob(9)]);
        },
      }),
    /deadline/,
  );
});

test("an exhausted metadata budget performs no request", () => {
  let calls = 0;
  assert.throws(
    () =>
      githubReviewTreeBlobSizes({
        repository: "openclaw/openclaw",
        headSha: oid(1),
        timeoutMs: 0,
        request: () => {
          calls += 1;
          return complete([]);
        },
      }),
    /deadline/,
  );
  assert.equal(calls, 0);
});
