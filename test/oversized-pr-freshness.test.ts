import assert from "node:assert/strict";
import test from "node:test";
import {
  createOversizedPrFreshnessGuard,
  oversizedPrSourceSnapshot,
} from "../dist/clawsweeper-oversized-pr-freshness.js";

const initial = {
  number: 1,
  title: "Synthetic PR",
  body: "Initial body",
  state: "open",
  locked: false,
  additions: 30001,
  deletions: 0,
  changed_files: 1,
  comments: 0,
  review_comments: 0,
  labels: [],
  updated_at: "2026-09-01T00:00:00Z",
  head: { sha: "b".repeat(40) },
  base: { ref: "main" },
};
const own = {
  id: 99,
  body: "Pending size policy",
  user: { login: "clawsweeper[bot]" },
  created_at: "2026-09-01T01:00:00Z",
  updated_at: "2026-09-01T01:00:00Z",
};

function fixture() {
  let pull = structuredClone(initial);
  let comments: object[] = [];
  let reviews: object[] = [];
  let timeline: object[] = [
    { event: "committed", sha: "c".repeat(40), message: "Commit without numeric timeline id" },
  ];
  const read = (args: string[]) => {
    const path = args[1]!;
    if (path.endsWith("/pulls/1")) return structuredClone(pull);
    if (path.includes("/issues/1/comments")) return structuredClone(comments);
    if (path.includes("/timeline")) return structuredClone(timeline);
    if (path.includes("/reviews")) return structuredClone(reviews);
    return [];
  };
  const guard = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot(initial),
    ghJson: read as any,
  });
  return {
    guard,
    read,
    get pull() {
      return pull;
    },
    set pull(value) {
      pull = value;
    },
    get comments() {
      return comments;
    },
    set comments(value) {
      comments = value;
    },
    get reviews() {
      return reviews;
    },
    set reviews(value) {
      reviews = value;
    },
    get timeline() {
      return timeline;
    },
    set timeline(value) {
      timeline = value;
    },
  };
}

test("metadata receipt tolerates only the exact owned comment and detects same-second human activity", () => {
  const f = fixture();
  assert.equal(f.guard.check(1, true), null);
  f.comments = [own];
  f.timeline.push({ ...own, event: "commented" });
  f.pull.comments = 1;
  f.pull.updated_at = own.updated_at;
  f.guard.recordOwnComment(own);
  assert.equal(f.guard.check(2, true), null);
  assert.ok(f.guard.receipt());
  f.comments.push({
    ...own,
    id: 100,
    user: { login: "human" },
    body: "same-second human activity",
  });
  f.pull.comments = 2;
  assert.match(f.guard.check(2, true) ?? "", /non-owned PR activity changed/);
});

test("metadata receipt detects body changes and changed owned comments", () => {
  const f = fixture();
  assert.equal(f.guard.check(1, true), null);
  f.pull.body = "Edited body";
  assert.match(f.guard.check(1, true) ?? "", /metadata changed/);
  f.pull.body = initial.body;
  f.comments = [{ ...own, body: "another generation" }];
  f.pull.comments = 1;
  f.guard.recordOwnComment(own);
  assert.match(f.guard.check(2, true) ?? "", /owned size-policy comment changed/);
});

test("persisted receipts survive an own-comment-only retry and reject subsequent activity", () => {
  const f = fixture();
  assert.equal(f.guard.check(1, true), null);
  f.comments = [own];
  f.pull.comments = 1;
  f.pull.updated_at = own.updated_at;
  f.guard.recordOwnComment(own);
  assert.equal(f.guard.check(2, true), null);
  const retry = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot(initial),
    priorReceipt: f.guard.receipt(),
    ownedComment: own,
    ghJson: f.read as any,
  });
  assert.equal(retry.check(1, true), null);
  f.timeline.push({
    id: 10,
    event: "reviewed",
    submitted_at: own.updated_at,
    body: "human review",
  });
  assert.match(retry.check(1, true) ?? "", /non-owned PR activity changed/);
});

test("activity probes fail closed at a bounded window and on invalid persisted evidence", () => {
  const full = Array.from({ length: 100 }, (_, id) => ({ id }));
  let reads = 0;
  const guard = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot(initial),
    ghJson: ((args: string[]) => {
      reads++;
      return args[1]!.endsWith("/pulls/1")
        ? initial
        : full.map((entry) => ({ ...entry, id: entry.id + reads * 100 }));
    }) as any,
  });
  assert.match(guard.check(1, true) ?? "", /bounded 300-entry window/);
  assert.equal(reads, 4);
  const f = fixture();
  const invalid = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot(initial),
    priorReceipt: "invalid",
    ghJson: f.read as any,
  });
  assert.match(invalid.check(1, true) ?? "", /persisted PR activity receipt/);
});

test("first baseline rejects same-second comment edits hidden by unchanged PR metadata", () => {
  const f = fixture();
  f.pull.comments = 1;
  f.comments = [
    {
      id: 5,
      body: "Edited after metadata admission",
      user: { login: "human" },
      created_at: "2026-08-01T00:00:00Z",
      updated_at: initial.updated_at,
    },
  ];
  const source = oversizedPrSourceSnapshot({ ...initial, comments: 1 }, initial.updated_at);
  const guard = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source,
    ghJson: f.read as any,
  });
  assert.match(guard.check(1, true) ?? "", /admission observation boundary/);
  const later = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot({ ...initial, comments: 1 }, "2026-09-01T00:00:03Z"),
    ghJson: f.read as any,
  });
  assert.equal(
    later.check(1, true),
    null,
    "a later fresh metadata observation can admit the now-stable activity",
  );
});

test("activity pagination rejects repeated identities instead of hiding a missing row", () => {
  const f = fixture();
  f.comments = [own, own];
  f.pull.comments = 2;
  assert.match(f.guard.check(1, true) ?? "", /repeated an identity/);
});

test("first receipt rejects undatable review edits at an ambiguous PR timestamp", () => {
  const f = fixture();
  f.reviews = [
    {
      id: 7,
      body: "Edited old review summary",
      submitted_at: "2026-08-01T00:00:00Z",
      state: "COMMENTED",
    },
  ];
  assert.match(f.guard.check(1, true) ?? "", /cannot exclude review-summary edits/);
  const later = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source: oversizedPrSourceSnapshot(initial, "2026-09-01T00:00:03Z"),
    ghJson: f.read as any,
  });
  assert.equal(later.check(1, true), null);
});

test("failed post-write checks preserve the baseline across a retry", () => {
  const f = fixture();
  f.reviews = [
    { id: 7, body: "Original review", submitted_at: "2026-08-01T00:00:00Z", state: "COMMENTED" },
  ];
  const source = oversizedPrSourceSnapshot(initial, "2026-09-01T00:00:03Z");
  const guard = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source,
    ghJson: f.read as any,
  });
  assert.equal(guard.check(1, true), null);
  f.comments = [own];
  f.pull.comments = 1;
  f.pull.updated_at = own.updated_at;
  guard.recordOwnComment(own);
  const persisted = guard.receipt();
  f.reviews = [
    {
      id: 7,
      body: "Edited without changing submitted_at",
      submitted_at: "2026-08-01T00:00:00Z",
      state: "COMMENTED",
    },
  ];
  assert.match(guard.check(2, true) ?? "", /non-owned PR activity changed/);
  const retry = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source,
    priorReceipt: persisted,
    ownedComment: own,
    ghJson: f.read as any,
  });
  assert.match(retry.check(1, true) ?? "", /persisted PR activity receipt/);
  const missing = createOversizedPrFreshnessGuard({
    repo: "example/project",
    number: 1,
    source,
    ownedComment: own,
    ghJson: f.read as any,
  });
  assert.match(missing.check(1, true) ?? "", /without a persisted activity receipt/);
});

test("documented cross-reference events have a stable identity without a numeric event id", () => {
  const f = fixture();
  const reference = {
    event: "cross-referenced",
    created_at: "2026-08-01T00:00:00Z",
    actor: { login: "human" },
    source: {
      type: "issue",
      issue: { id: 50, number: 2, html_url: "https://github.com/example/project/issues/2" },
    },
  };
  f.timeline.push(reference);
  assert.equal(f.guard.check(1, true), null);
  f.timeline.push(structuredClone(reference));
  assert.match(f.guard.check(2, true) ?? "", /repeated an identity/);
});
