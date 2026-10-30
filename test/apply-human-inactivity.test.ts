import assert from "node:assert/strict";
import test from "node:test";
import { githubHumanContentEditTimes } from "../dist/github-content-edits.js";
import {
  createApplyGuardActivity,
  recentHumanActivityBlockReason,
} from "../dist/clawsweeper-apply-guard-activity.js";

const now = Date.parse("2026-10-19T00:00:00Z");
const old = "2026-01-01T00:00:00Z";
const recent = "2026-10-18T00:00:00Z";

test("ordinary human creation prevents inactivity closure without attributing edits to authors", () => {
  for (const activity of [{ created_at: recent }, { submitted_at: recent }]) {
    assert.match(
      recentHumanActivityBlockReason(
        [{ ...activity, user: { login: "author", type: "User" } }],
        14,
        now,
      ) ?? "",
      /human.*activity/,
    );
  }
  assert.equal(
    recentHumanActivityBlockReason(
      [{ created_at: recent, user: { login: "automation", type: "Bot" } }],
      14,
      now,
    ),
    null,
  );
  assert.equal(
    recentHumanActivityBlockReason(
      [{ created_at: old, updated_at: recent, user: { login: "author", type: "User" } }],
      14,
      now,
    ),
    null,
  );
  assert.equal(
    recentHumanActivityBlockReason(
      [{ created_at: old, user: { login: "author", type: "User" } }],
      14,
      now,
    ),
    null,
  );
  assert.match(recentHumanActivityBlockReason([{ created_at: old }], 14, now) ?? "", /unavailable/);
});

function history(id: string, edits: unknown[], more = false, total = edits.length) {
  return {
    id,
    lastEditedAt: edits.length ? recent : null,
    userContentEdits: {
      totalCount: total,
      nodes: edits,
      pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
    },
  };
}
const edit = (id: string, type = "User", at = recent) => ({
  id,
  editedAt: at,
  editor: { __typename: type, id: 123 },
});

test("body, comment, review and inline human edits survive a later bot edit", () => {
  for (const surface of ["body", "comment", "review", "inline"]) {
    for (const editorType of ["User", "Bot"]) {
      const editedAt = new Date(Date.now() - 1000).toISOString();
      const content = {
        node_id: "content",
        created_at: old,
        updated_at: old,
        submitted_at: old,
        user: { login: "automation[bot]", type: "Bot" },
      };
      const activity = createApplyGuardActivity({
        targetRepo: () => "openclaw/openclaw",
        ghPaged: <T>(path: string): T[] =>
          ((surface === "comment" && path.includes("/issues/")) ||
          (surface === "review" && path.endsWith("/reviews")) ||
          (surface === "inline" && path.includes("/pulls/") && path.endsWith("/comments"))
            ? [content]
            : []) as T[],
        ghJson: <T>(args: string[]): T => {
          assert.equal(args[1], "graphql");
          if (args.some((arg) => arg.includes("nodes(ids:")))
            return {
              data: {
                nodes: [
                  {
                    ...history("content", [
                      edit("human", editorType, editedAt),
                      edit("bot", "Bot", editedAt),
                    ]),
                    lastEditedAt: editedAt,
                  },
                ],
              },
            } as T;
          return {
            data: {
              repository: {
                pullRequest: {
                  id: "content",
                  lastEditedAt: surface === "body" ? editedAt : null,
                },
              },
            },
          } as T;
        },
      });
      const block = activity.pullRequestHumanEngagementBlockReason(321, {}, 14);
      if (editorType === "User") assert.match(block ?? "", /human edit activity/);
      else assert.equal(block, null);
    }
  }
});

test("complete pagination finds a human edit behind 100 newer bot edits", () => {
  let reads = 0;
  const times = githubHumanContentEditTimes(
    <T>(args: string[]): T => {
      reads++;
      if (reads === 1)
        return {
          data: {
            nodes: [
              history(
                "content",
                Array.from({ length: 100 }, (_, index) => edit(`bot${index}`, "Bot")),
                true,
                101,
              ),
            ],
          },
        } as T;
      assert.ok(args.includes("after=next"));
      return { data: { node: history("content", [edit("human")], false, 101) } } as T;
    },
    ["content"],
  );
  assert.equal(reads, 2);
  assert.deepEqual(times, [Date.parse(recent)]);
});

test("missing, ambiguous or incomplete edit provenance cannot prove inactivity", () => {
  for (const mutate of [
    (node: any) => {
      delete node.lastEditedAt;
    },
    (node: any) => {
      node.id = "other";
    },
    (node: any) => {
      node.userContentEdits.nodes[0].editor.id = null;
    },
    (node: any) => {
      node.userContentEdits.nodes[0].editor = null;
    },
    (node: any) => {
      node.userContentEdits.nodes[0].editor.__typename = "Mannequin";
    },
    (node: any) => {
      node.userContentEdits.totalCount = 2;
    },
    (node: any) => {
      node.lastEditedAt = old;
    },
    (node: any) => {
      node.userContentEdits.nodes.push(edit("human"));
      node.userContentEdits.totalCount = 2;
    },
    (node: any) => {
      node.userContentEdits.pageInfo = { hasNextPage: true, endCursor: null };
    },
  ]) {
    const node = history("content", [edit("human")]);
    mutate(node);
    assert.throws(() =>
      githubHumanContentEditTimes(<T>(): T => ({ data: { nodes: [node] } }) as T, ["content"]),
    );
  }
  const activity = createApplyGuardActivity({
    targetRepo: () => "openclaw/openclaw",
    ghPaged: () => [],
    ghJson: <T>(): T =>
      ({ data: { repository: { pullRequest: { id: "content", lastEditedAt: recent } } } }) as T,
  });
  assert.match(
    activity.pullRequestHumanEngagementBlockReason(321, {}, 14) ?? "",
    /attributed edit activity is unavailable/,
  );
});

for (const failure of ["repeated cursor", "changed total", "changed last edit", "page bound"]) {
  test(`attributed edit collection rejects ${failure}`, () => {
    let reads = 0;
    assert.throws(
      () =>
        githubHumanContentEditTimes(<T>(): T => {
          reads++;
          const node = history("content", [edit(`bot${reads}`, "Bot")], true, 101);
          node.userContentEdits.pageInfo.endCursor =
            failure === "repeated cursor" ? "same" : `page${reads}`;
          if (reads > 1 && failure === "changed total") node.userContentEdits.totalCount = 102;
          if (reads > 1 && failure === "changed last edit") node.lastEditedAt = old;
          return { data: reads === 1 ? { nodes: [node] } : { node } } as T;
        }, ["content"]),
      /pagination|changed while reading/,
    );
    if (failure === "page bound") assert.equal(reads, 101);
  });
}
