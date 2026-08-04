import assert from "node:assert/strict";
import test from "node:test";

import { LinearItemSource } from "../dist/linear/source.js";
import type { LinearTransport } from "../dist/linear/client.js";

// ---------------------------------------------------------------------------
// Fake transport helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  query: string;
  vars: Record<string, unknown>;
}

/** Returns a transport that plays back queued page responses keyed by query substring. */
function makeQueuedTransport(
  queues: Record<string, unknown[]>,
  calls: RecordedCall[],
): LinearTransport {
  const indices: Record<string, number> = {};
  return async (query: string, vars: Record<string, unknown>) => {
    calls.push({ query, vars });
    for (const key of Object.keys(queues)) {
      if (query.includes(key)) {
        const idx = indices[key] ?? 0;
        const pages = queues[key];
        if (idx >= pages.length) {
          throw new Error(`No more pages queued for ${key} (called ${idx + 1} times)`);
        }
        indices[key] = idx + 1;
        return pages[idx];
      }
    }
    throw new Error(`No queue registered for query: ${query.slice(0, 60)}`);
  };
}

// ---------------------------------------------------------------------------
// Teams pagination
// ---------------------------------------------------------------------------

test("iterateTeams / listTeams: multi-page pagination collects all nodes in order", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListTeams: [
        {
          teams: {
            nodes: [{ id: "t1", key: "T1", name: "Team One" }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
        {
          teams: {
            nodes: [{ id: "t2", key: "T2", name: "Team Two" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const teams = await source.listTeams(50);

  assert.equal(teams.length, 2);
  assert.equal(teams[0]?.id, "t1");
  assert.equal(teams[0]?.key, "T1");
  assert.equal(teams[0]?.name, "Team One");
  assert.equal(teams[1]?.id, "t2");
  assert.equal(teams[1]?.name, "Team Two");

  // First call: no `after`; second call: after = "c1"
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.vars["first"], 50);
  assert.equal("after" in (calls[0]?.vars ?? {}), false);
  assert.equal(calls[1]?.vars["after"], "c1");
  assert.equal(calls[1]?.vars["first"], 50);
});

// ---------------------------------------------------------------------------
// Projects pagination + mapping
// ---------------------------------------------------------------------------

test("listProjects: paginates under team.projects, sets teamId, maps state", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListProjects: [
        {
          team: {
            projects: {
              nodes: [
                { id: "p1", name: "Project Alpha", state: "started" },
                { id: "p2", name: "Project Beta", state: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const projects = await source.listProjects("team-abc", 100);

  assert.equal(projects.length, 2);

  const p1 = projects[0];
  assert.equal(p1?.id, "p1");
  assert.equal(p1?.name, "Project Alpha");
  assert.equal(p1?.teamId, "team-abc");
  assert.equal(p1?.state, "started");

  const p2 = projects[1];
  assert.equal(p2?.teamId, "team-abc");
  assert.equal(p2?.state, null);

  assert.equal(calls[0]?.vars["teamId"], "team-abc");
  assert.match(calls[0]?.query ?? "", /query ListProjects\(\$teamId: String!/);
});

// ---------------------------------------------------------------------------
// Issues WITHOUT updatedAfter
// ---------------------------------------------------------------------------

test("listIssues WITHOUT updatedAfter: vars have teamId but no updatedAfter key", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListIssues: [
        {
          issues: {
            nodes: [
              {
                id: "i1",
                identifier: "ENG-1",
                title: "Fix bug",
                url: "https://linear.app/issue/ENG-1",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                priority: 2,
                team: { id: "team-abc" },
                project: { id: "proj-1" },
                state: { id: "state-started", name: "In Progress", type: "started" },
                labels: { nodes: [{ id: "lbl-1", name: "bug" }] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const issues = await source.listIssues({ teamId: "team-abc" });

  assert.equal(issues.length, 1);

  const issue = issues[0];
  assert.ok(issue !== undefined);
  assert.equal(issue.id, "i1");
  assert.equal(issue.identifier, "ENG-1");
  assert.equal(issue.title, "Fix bug");
  assert.equal(issue.url, "https://linear.app/issue/ENG-1");
  assert.equal(issue.createdAt, "2024-01-01T00:00:00Z");
  assert.equal(issue.updatedAt, "2024-01-02T00:00:00Z");
  assert.equal(issue.priority, 2);
  assert.equal(issue.teamId, "team-abc");
  assert.equal(issue.projectId, "proj-1");
  assert.equal(issue.stateId, "state-started");
  assert.equal(issue.stateName, "In Progress");
  assert.equal(issue.stateType, "started");
  assert.deepEqual(issue.labels, [{ id: "lbl-1", name: "bug" }]);

  // updatedAfter must be absent from vars entirely
  const vars = calls[0]?.vars ?? {};
  assert.equal(vars["teamId"], "team-abc");
  assert.equal("updatedAfter" in vars, false);
  assert.match(
    calls[0]?.query ?? "",
    /query ListIssues\(\$teamId: ID!, \$updatedAfter: DateComparator/,
  );
});

// ---------------------------------------------------------------------------
// Issues WITH updatedAfter
// ---------------------------------------------------------------------------

test("listIssues WITH updatedAfter: transport receives updatedAfter: { gt: iso }", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListIssues: [
        {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  await source.listIssues({ teamId: "team-xyz", updatedAfter: "2024-06-01T00:00:00Z" });

  const vars = calls[0]?.vars ?? {};
  assert.equal(vars["teamId"], "team-xyz");
  assert.deepEqual(vars["updatedAfter"], { gt: "2024-06-01T00:00:00Z" });
});

// ---------------------------------------------------------------------------
// Issue field mapping edge cases: null project, null state, empty labels
// ---------------------------------------------------------------------------

test("listIssues: maps null project → projectId null, null state → nulls, empty labels", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListIssues: [
        {
          issues: {
            nodes: [
              {
                id: "i2",
                identifier: "ENG-2",
                title: "No project",
                url: "https://linear.app/issue/ENG-2",
                createdAt: "2024-02-01T00:00:00Z",
                updatedAt: "2024-02-02T00:00:00Z",
                priority: 0,
                team: { id: "team-abc" },
                project: null,
                state: null,
                labels: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const issues = await source.listIssues({ teamId: "team-abc" });

  const issue = issues[0];
  assert.ok(issue !== undefined);
  assert.equal(issue.projectId, null);
  assert.equal(issue.stateId, null);
  assert.equal(issue.stateName, null);
  assert.equal(issue.stateType, null);
  assert.deepEqual(issue.labels, []);
});

// ---------------------------------------------------------------------------
// iterateWorkspaceItems / listWorkspaceItems
// ---------------------------------------------------------------------------

test("listWorkspaceItems: joins team, projects, issues; resolves project by id", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListTeams: [
        {
          teams: {
            nodes: [{ id: "team-1", key: "T1", name: "Team One" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
      ListProjects: [
        {
          team: {
            projects: {
              nodes: [
                { id: "proj-a", name: "Alpha", state: "started" },
                { id: "proj-b", name: "Beta", state: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
      ListIssues: [
        {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "T1-1",
                title: "First",
                url: "https://linear.app/T1-1",
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-02T00:00:00Z",
                priority: 1,
                team: { id: "team-1" },
                project: { id: "proj-a" },
                state: { id: "state-todo", name: "Todo", type: "unstarted" },
                labels: { nodes: [] },
              },
              {
                id: "issue-2",
                identifier: "T1-2",
                title: "No project",
                url: "https://linear.app/T1-2",
                createdAt: "2024-01-03T00:00:00Z",
                updatedAt: "2024-01-04T00:00:00Z",
                priority: 3,
                team: { id: "team-1" },
                project: null,
                state: null,
                labels: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const items = await source.listWorkspaceItems();

  assert.equal(items.length, 2);

  const item1 = items[0];
  assert.ok(item1 !== undefined);
  assert.deepEqual(item1.team, { id: "team-1", key: "T1", name: "Team One" });
  assert.ok(item1.project !== null);
  assert.equal(item1.project.id, "proj-a");
  assert.equal(item1.project.teamId, "team-1");
  assert.equal(item1.issue.id, "issue-1");

  const item2 = items[1];
  assert.ok(item2 !== undefined);
  assert.deepEqual(item2.team, { id: "team-1", key: "T1", name: "Team One" });
  assert.equal(item2.project, null);
  assert.equal(item2.issue.id, "issue-2");
});

test("listWorkspaceItems: propagates updatedAfter and pageSize into issues query", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListTeams: [
        {
          teams: {
            nodes: [{ id: "team-1", key: "T1", name: "Team One" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
      ListProjects: [
        {
          team: {
            projects: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
      ListIssues: [
        {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  await source.listWorkspaceItems({ updatedAfter: "2024-05-01T00:00:00Z", pageSize: 25 });

  const issueCall = calls.find((c) => c.query.includes("ListIssues"));
  assert.ok(issueCall !== undefined);
  assert.equal(issueCall.vars["teamId"], "team-1");
  assert.deepEqual(issueCall.vars["updatedAfter"], { gt: "2024-05-01T00:00:00Z" });
  assert.equal(issueCall.vars["first"], 25);
});

// ---------------------------------------------------------------------------
// Null endCursor halts pagination even if hasNextPage were true
// ---------------------------------------------------------------------------

test("null endCursor halts pagination even when hasNextPage is true", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      ListTeams: [
        {
          teams: {
            nodes: [{ id: "t1", key: "T1", name: "Team One" }],
            // hasNextPage true but endCursor null — should not loop
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      ],
    },
    calls,
  );

  const source = new LinearItemSource(transport);
  const teams = await source.listTeams();

  // Only one page fetched, no infinite loop
  assert.equal(calls.length, 1);
  assert.equal(teams.length, 1);
});

// ---------------------------------------------------------------------------
// Malformed connection throws a clear error
// ---------------------------------------------------------------------------

test("malformed connection (transport returns {}) throws error mentioning query name", async () => {
  const transport: LinearTransport = async () => ({});
  const source = new LinearItemSource(transport);

  await assert.rejects(
    () => source.listTeams(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ListTeams/);
      assert.match(err.message, /connection/i);
      return true;
    },
  );
});

function hydratedIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PAR-1",
    title: "Hydrated issue",
    description: "See https://github.com/openclaw/openclaw/issues/1",
    url: "https://linear.app/issue/PAR-1",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    priority: 2,
    creator: { id: "user-1", name: "Maintainer", admin: true, owner: false },
    team: { id: "team-1", key: "PAR", name: "Partner" },
    project: null,
    state: { id: "todo", name: "Todo", type: "unstarted" },
    labels: { nodes: [{ id: "bug", name: "bug" }] },
    attachments: {
      nodes: [{ id: "att-1", url: "https://github.com/openclaw/openclaw/pull/2", title: "PR" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    comments: {
      nodes: [{ id: "comment-1", body: "context", createdAt: "2026-06-02T12:00:00Z" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  };
}

test("fetchIssueByIdentifier queries and maps analysis context", async () => {
  const calls: RecordedCall[] = [];
  const transport = makeQueuedTransport(
    {
      IssueByIdentifier: [
        {
          issues: {
            nodes: [hydratedIssueNode()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      ],
    },
    calls,
  );
  const source = new LinearItemSource(transport);
  const item = await source.fetchIssueByIdentifier("PAR-1");

  assert.ok(item !== null);
  assert.equal(item.description, "See https://github.com/openclaw/openclaw/issues/1");
  assert.deepEqual(item.creator, {
    id: "user-1",
    name: "Maintainer",
    admin: true,
    owner: false,
  });
  assert.deepEqual(item.attachments, [
    { id: "att-1", url: "https://github.com/openclaw/openclaw/pull/2", title: "PR" },
  ]);
  assert.deepEqual(item.comments, [
    {
      id: "comment-1",
      body: "context",
      createdAt: "2026-06-02T12:00:00Z",
      authorId: null,
      authorName: null,
    },
  ]);
  assert.match(calls[0]?.query ?? "", /description/);
  assert.match(calls[0]?.query ?? "", /creator\s*\{/);
  assert.match(calls[0]?.query ?? "", /attachments\(first: 250\)/);
  assert.match(
    calls[0]?.query ?? "",
    /comments\(first: \$commentFirst, after: \$commentAfter, orderBy: createdAt\)/,
  );
  assert.match(calls[0]?.query ?? "", /comments[\s\S]*createdAt/);
  assert.match(calls[0]?.query ?? "", /botActor\s*\{/);
  assert.match(calls[0]?.query ?? "", /user\s*\{/);
});

test("fetchIssueByIdentifier rejects analysis-context drift while paginating comments", async () => {
  const calls: RecordedCall[] = [];
  const first = hydratedIssueNode({
    comments: {
      nodes: [{ id: "comment-1", body: "first" }],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    },
  });
  const second = hydratedIssueNode({
    description: "changed while comments paginated",
    comments: {
      nodes: [{ id: "comment-2", body: "second" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const transport = makeQueuedTransport(
    {
      IssueByIdentifier: [
        { issues: { nodes: [first], pageInfo: { hasNextPage: false, endCursor: null } } },
        { issues: { nodes: [second], pageInfo: { hasNextPage: false, endCursor: null } } },
      ],
    },
    calls,
  );

  await assert.rejects(
    () => new LinearItemSource(transport).fetchIssueByIdentifier("PAR-1", 1),
    /changed while paginating comments/,
  );
});

test("fetchIssueByIdentifier rejects a truncated attachment page", async () => {
  const transport: LinearTransport = async () => ({
    issues: {
      nodes: [
        hydratedIssueNode({
          attachments: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "more" },
          },
        }),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  await assert.rejects(
    () => new LinearItemSource(transport).fetchIssueByIdentifier("PAR-1"),
    /more than 250 attachments/,
  );
});

test("fetchIssueByIdentifier rejects a truncated label page", async () => {
  const transport: LinearTransport = async () => ({
    issues: {
      nodes: [
        hydratedIssueNode({
          labels: {
            nodes: [{ id: "bug", name: "bug" }],
            pageInfo: { hasNextPage: true, endCursor: "more" },
          },
        }),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  await assert.rejects(
    () => new LinearItemSource(transport).fetchIssueByIdentifier("PAR-1"),
    /more than 250 labels/,
  );
});
