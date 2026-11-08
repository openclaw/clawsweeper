import assert from "node:assert/strict";
import test from "node:test";
import { createApplyGuardActivity } from "../dist/clawsweeper-apply-guard-activity.js";

const pull = { created_at: "2026-01-01T00:00:00Z", head: { sha: "head-sha", ref: "feature" } };

function guardWithForcePushPages(pages: Array<{ nodes: unknown[]; startCursor: string | null }>) {
  const graphqlReads: string[][] = [];
  const activity = createApplyGuardActivity({
    targetRepo: () => "openclaw/openclaw",
    ghPaged: () => {
      throw new Error("head activity must not read the REST timeline");
    },
    ghJson: (args: string[]) => {
      if (args[1]?.startsWith("repos/openclaw/openclaw/actions/runs?"))
        return { workflow_runs: [] };
      if (args[1] !== "graphql") throw new Error(`unexpected read ${args.join(" ")}`);
      graphqlReads.push(args);
      const page = pages[graphqlReads.length - 1]!;
      return {
        data: {
          repository: {
            pullRequest: {
              timelineItems: {
                nodes: page.nodes,
                pageInfo: {
                  hasPreviousPage: page.startCursor !== null,
                  startCursor: page.startCursor,
                },
              },
            },
          },
        },
      };
    },
  } as never);
  return { activity, graphqlReads };
}

test("head activity pages back through force pushes to find the head's push", () => {
  // Newest page: later pushes to other commits; the head's push is one page older.
  const { activity, graphqlReads } = guardWithForcePushPages([
    {
      nodes: [{ createdAt: "2026-03-01T00:00:00Z", afterCommit: { oid: "other" } }],
      startCursor: "cursor-1",
    },
    {
      nodes: [
        { createdAt: "2026-02-03T00:00:00Z", afterCommit: { oid: "head-sha" } },
        // Commits GitHub no longer has resolve to null and never match the head.
        { createdAt: "2026-02-04T00:00:00Z", afterCommit: null },
      ],
      startCursor: null,
    },
  ]);
  assert.deepEqual(activity.pullRequestHeadActivity(7, pull), {
    headSha: "head-sha",
    headActivityAtMs: Date.parse("2026-02-03T00:00:00Z"),
  });
  assert.equal(graphqlReads.length, 2);
  assert.ok(graphqlReads[1]!.includes("before=cursor-1"));
  assert.ok(graphqlReads[0]!.includes("number=7"));
});

test("head activity fails closed when force-push history exceeds its read bound", () => {
  const { activity } = guardWithForcePushPages(
    Array.from({ length: 11 }, (_, index) => ({ nodes: [], startCursor: `cursor-${index}` })),
  );
  assert.throws(() => activity.pullRequestHeadActivity(7, pull), /exceeds the read bound/);
});
