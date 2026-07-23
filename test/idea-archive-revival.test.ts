import assert from "node:assert/strict";
import test from "node:test";

import {
  ideaArchiveLabelSettled,
  hasBotIdeaArchiveRevivalComment,
  ideaArchiveRevivalReason,
  ideaArchiveRevivalCapReached,
  ideaArchiveScanDirection,
  maintainerSponsorshipAfterClose,
  positiveReactionCount,
  runIdeaArchiveRevival,
} from "../dist/idea-archive-revival.js";

const closedAt = "2026-07-01T00:00:00Z";

test("idea archive reaction threshold includes the exact boundary", () => {
  assert.equal(positiveReactionCount({ "+1": 2, heart: 1, hooray: 1, laugh: 20 }), 4);
  assert.equal(
    ideaArchiveRevivalReason({ closed_at: closedAt, reactions: { "+1": 3, heart: 1 } }, [], 5),
    null,
  );
  assert.deepEqual(
    ideaArchiveRevivalReason(
      { closed_at: closedAt, reactions: { "+1": 3, heart: 1, hooray: 1 } },
      [],
      5,
    ),
    { kind: "community_traction", reactionCount: 5 },
  );
});

test("idea archive requires a sponsorship command and accepts the close-second boundary", () => {
  const comments = [
    {
      author_association: "OWNER",
      created_at: "2026-06-30T23:59:59Z",
      user: { login: "before-close", type: "User" },
      body: "@clawsweeper sponsor",
    },
    {
      author_association: "COLLABORATOR",
      created_at: "2026-07-01T00:00:00Z",
      user: { login: "sponsor", type: "User" },
      body: "Good idea after all.\n@ClawSweeper REVIVE!",
    },
  ];
  assert.equal(maintainerSponsorshipAfterClose(comments, closedAt), "sponsor");
  assert.deepEqual(ideaArchiveRevivalReason({ closed_at: closedAt, reactions: {} }, comments, 5), {
    kind: "maintainer_sponsorship",
    author: "sponsor",
  });
});

test("idea archive ignores maintainer comments without an explicit sponsorship command", () => {
  assert.equal(
    maintainerSponsorshipAfterClose(
      [
        {
          author_association: "OWNER",
          created_at: "2026-07-01T00:00:01Z",
          user: { login: "maintainer", type: "User" },
          body: "Still not planned.",
        },
        {
          author_association: "OWNER",
          created_at: "2026-07-01T00:00:02Z",
          user: { login: "maintainer", type: "User" },
          body: "do not reopen this",
        },
        {
          author_association: "OWNER",
          created_at: "2026-07-01T00:00:03Z",
          user: { login: "maintainer", type: "User" },
          body: "I can't sponsor this.",
        },
        {
          author_association: "OWNER",
          created_at: "2026-07-01T00:00:04Z",
          user: { login: "maintainer", type: "User" },
          body: "@clawsweeper reopen",
        },
      ],
      closedAt,
    ),
    null,
  );
});

test("idea archive honors the maintainer login allowlist for contributor-associated sponsors", () => {
  const comments = [
    {
      author_association: "CONTRIBUTOR",
      created_at: "2026-07-01T00:00:01Z",
      user: { login: "Steipete", type: "User" },
      body: "@clawsweeper sponsor.",
    },
  ];
  assert.equal(maintainerSponsorshipAfterClose(comments, closedAt, new Set()), null);
  assert.equal(
    maintainerSponsorshipAfterClose(comments, closedAt, new Set(["steipete"])),
    "Steipete",
  );
});

test("idea archive ignores bot maintainer comments", () => {
  assert.equal(
    maintainerSponsorshipAfterClose(
      [
        {
          author_association: "MEMBER",
          created_at: "2026-07-01T00:00:01Z",
          user: { login: "clawsweeper[bot]", type: "Bot" },
          body: "@clawsweeper revive",
        },
      ],
      closedAt,
    ),
    null,
  );
});

test("idea archive recognizes existing bot revival comments", () => {
  assert.equal(
    hasBotIdeaArchiveRevivalComment([
      {
        user: { login: "clawsweeper[bot]", type: "Bot" },
        body: "reviving from the idea archive: community traction (5 positive reactions).",
      },
    ]),
    true,
  );
  assert.equal(
    hasBotIdeaArchiveRevivalComment([
      {
        user: { login: "maintainer", type: "User" },
        body: "reviving from the idea archive: manually.",
      },
    ]),
    false,
  );
});

test("idea archive revival cap bounds one run", () => {
  assert.equal(ideaArchiveRevivalCapReached(9, 10), false);
  assert.equal(ideaArchiveRevivalCapReached(10, 10), true);
  assert.equal(ideaArchiveRevivalCapReached(11, 10), true);
});

test("idea archive scan alternates newest and oldest ends by six-hour UTC slot", () => {
  assert.equal(ideaArchiveScanDirection(new Date("2026-07-01T00:00:00Z")), "desc");
  assert.equal(ideaArchiveScanDirection(new Date("2026-07-01T06:00:00Z")), "asc");
  assert.equal(ideaArchiveScanDirection(new Date("2026-07-01T12:00:00Z")), "desc");
  assert.equal(ideaArchiveScanDirection(new Date("2026-07-01T18:00:00Z")), "asc");
});

test("idea archive uses since pagination and reconciles partial reopen mutations", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  let deleteCalls = 0;
  let patchCalls = 0;
  let postCalls = 0;
  const issue = {
    number: 7,
    closed_at: closedAt,
    reactions: { total_count: 5, "+1": 3, heart: 1, hooray: 1 },
  };
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, path: `${url.pathname}${url.search}` });
    if (method === "GET" && url.pathname.endsWith("/issues")) {
      if (url.searchParams.get("state") === "closed") {
        if (url.searchParams.get("sort") === "updated") {
          assert.equal(url.searchParams.get("direction"), "desc");
          if (url.searchParams.get("page") === "1") {
            return Response.json(
              Array.from({ length: 100 }, (_, index) => ({
                number: 1_000 + index,
                pull_request: {},
              })),
            );
          }
        } else {
          assert.equal(url.searchParams.get("sort"), "created");
          assert.equal(url.searchParams.get("direction"), "asc");
        }
        return Response.json([issue]);
      }
      if (url.searchParams.get("state") === "open") {
        return Response.json([{ ...issue, closed_at: null }]);
      }
    }
    if (method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
      assert.equal(url.searchParams.get("since"), "2026-06-30T23:59:59.000Z");
      assert.equal(url.searchParams.get("sort"), "created");
      assert.equal(url.searchParams.get("direction"), "desc");
      return Response.json([]);
    }
    if (method === "PATCH" && url.pathname.endsWith("/issues/7")) {
      patchCalls += 1;
      return Response.json({ state: "open" });
    }
    if (method === "DELETE" && url.pathname.endsWith("/labels/clawsweeper%3Aidea-archive")) {
      deleteCalls += 1;
      return deleteCalls === 1
        ? new Response("failed", { status: 500 })
        : new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
      postCalls += 1;
      return postCalls === 1
        ? new Response("failed", { status: 500 })
        : Response.json({ id: 99 }, { status: 201 });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}${url.search}`);
  };

  const summary = await runIdeaArchiveRevival({
    env: {
      GH_TOKEN: "test-token-placeholder",
      GITHUB_API_URL: "https://api.github.test",
      TARGET_REPO: "openclaw/openclaw",
    },
    fetchImpl: mockFetch as typeof fetch,
    now: new Date("2026-07-01T06:00:00Z"),
  });

  assert.equal(summary.revived, 1);
  assert.equal(summary.errors, 2);
  assert.equal(patchCalls, 1);
  assert.equal(deleteCalls, 2);
  assert.equal(postCalls, 2);
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "GET" &&
        call.path.includes("state=closed") &&
        call.path.includes("sort=updated"),
    ).length,
    2,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "GET" &&
        call.path.includes("state=closed") &&
        call.path.includes("sort=updated") &&
        call.path.includes("direction=desc"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "GET" &&
        call.path.includes("state=closed") &&
        call.path.includes("sort=created") &&
        call.path.includes("direction=asc"),
    ),
  );
  assert.ok(
    calls
      .filter((call) => call.method === "GET" && call.path.includes("/comments?"))
      .every((call) => call.path.includes("since=2026-06-30T23%3A59%3A59.000Z")),
  );
});

test("idea archive sponsorship command must be a standalone line", () => {
  const base = {
    author_association: "OWNER",
    created_at: "2026-07-01T00:00:01Z",
    user: { login: "maintainer", type: "User" },
  };
  assert.equal(
    maintainerSponsorshipAfterClose(
      [{ ...base, body: "Do not use @clawsweeper revive for this issue." }],
      closedAt,
    ),
    null,
  );
  assert.equal(
    maintainerSponsorshipAfterClose(
      [{ ...base, body: "> @clawsweeper revive\nquoting the syntax, not sponsoring" }],
      closedAt,
    ),
    null,
  );
  assert.equal(
    maintainerSponsorshipAfterClose(
      [{ ...base, body: "```\n@clawsweeper revive\n```\nexample only" }],
      closedAt,
    ),
    null,
  );
  assert.equal(
    maintainerSponsorshipAfterClose(
      [{ ...base, body: "Good idea after all.\n\n@clawsweeper revive" }],
      closedAt,
    ),
    "maintainer",
  );
});

test("idea archive reconciliation skips freshly labeled open issues", () => {
  const now = Date.parse("2026-07-01T12:00:00Z");
  assert.equal(ideaArchiveLabelSettled({ updated_at: "2026-07-01T11:45:00Z" }, now), false);
  assert.equal(ideaArchiveLabelSettled({ updated_at: "2026-07-01T11:29:59Z" }, now), true);
  assert.equal(ideaArchiveLabelSettled({}, now), false);
});
