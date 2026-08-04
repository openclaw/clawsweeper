import assert from "node:assert/strict";
import test from "node:test";

import { createLinearTransport, mintLinearAppToken } from "../dist/linear/client.js";
import { LinearItemSource, parseLinearIdentifier } from "../dist/linear/source.js";
// Barrel-wiring checks: the new write-path symbols must be re-exported from the barrel.
import {
  createLinearTransport as createLinearTransportFromIndex,
  mintLinearAppToken as mintLinearAppTokenFromIndex,
  parseLinearIdentifier as parseLinearIdentifierFromIndex,
} from "../dist/linear/index.js";
import {
  applyPlan,
  buildItemPlan,
  assertReadBackConfirmed,
  readBackComment,
  revalidateCommentWrite,
  renderReviewContent,
  resolveApproval,
  resolveAppCredentials,
  resolveReadToken,
  summarize,
  resolveWriteDecision,
  resolveWriteMode,
} from "../scripts/linear-comment-apply.mjs";

// ---------------------------------------------------------------------------
// Bearer-mode header construction (the seam in client.ts) — fake fetch, no network
// ---------------------------------------------------------------------------

// Captures the Authorization header sent on the first request, then returns ok data.
function captureAuthFetch(captured: { header?: string }) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.header = headers["Authorization"];
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
}

test("createLinearTransport defaults to the RAW token header (read path unchanged)", async () => {
  const captured: { header?: string } = {};
  const transport = createLinearTransport({
    token: "personal-key",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: captureAuthFetch(captured) as typeof fetch,
  });
  await transport("query { ok }", {});
  assert.equal(captured.header, "personal-key");
});

test("createLinearTransport auth:'raw' explicitly sends the raw token", async () => {
  const captured: { header?: string } = {};
  const transport = createLinearTransport({
    token: "personal-key",
    auth: "raw",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: captureAuthFetch(captured) as typeof fetch,
  });
  await transport("query { ok }", {});
  assert.equal(captured.header, "personal-key");
});

test("createLinearTransport auth:'bearer' sends 'Bearer <token>'", async () => {
  const captured: { header?: string } = {};
  const transport = createLinearTransport({
    token: "oauth-access-token",
    auth: "bearer",
    endpoint: "https://fake.linear.app/graphql",
    fetchImpl: captureAuthFetch(captured) as typeof fetch,
  });
  await transport("mutation { commentCreate { success } }", {});
  assert.equal(captured.header, "Bearer oauth-access-token");
});

// ---------------------------------------------------------------------------
// mintLinearAppToken — urlencoded client_credentials POST, never leaks secrets
// ---------------------------------------------------------------------------

test("mintLinearAppToken POSTs urlencoded client_credentials and returns the access token", async () => {
  let captured: { url?: string; contentType?: string; body?: string } = {};
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    captured = {
      url,
      contentType: ((init?.headers ?? {}) as Record<string, string>)["Content-Type"],
      body: init?.body as string,
    };
    return new Response(
      JSON.stringify({ access_token: "minted-abc", expires_in: 2591999, token_type: "Bearer" }),
      { status: 200 },
    );
  };

  const result = await mintLinearAppToken({
    clientId: "cid",
    clientSecret: "csecret",
    endpoint: "https://fake.linear.app/oauth/token",
    fetchImpl: fakeFetch as typeof fetch,
  });

  assert.equal(result.accessToken, "minted-abc");
  assert.equal(result.expiresInSec, 2591999);
  assert.equal(result.tokenType, "Bearer");
  assert.equal(captured.url, "https://fake.linear.app/oauth/token");
  assert.equal(captured.contentType, "application/x-www-form-urlencoded");
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get("grant_type"), "client_credentials");
  assert.equal(params.get("client_id"), "cid");
  assert.equal(params.get("client_secret"), "csecret");
  assert.equal(params.get("scope"), "read,write");
  // Linear client-credentials tokens already represent the app actor. `actor=app` is an
  // authorization-URL parameter for the interactive code flow, not a token-mint parameter.
  assert.equal(params.has("actor"), false);
});

test("mintLinearAppToken throws a token-free error on HTTP failure", async () => {
  const fakeFetch = async (): Promise<Response> =>
    new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
  await assert.rejects(
    () =>
      mintLinearAppToken({
        clientId: "cid",
        clientSecret: "supersecret",
        fetchImpl: fakeFetch as typeof fetch,
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /HTTP 401/);
      assert.match(message, /invalid_client/);
      // The secret must never appear in the error.
      assert.ok(!message.includes("supersecret"));
      return true;
    },
  );
});

test("mintLinearAppToken requires both clientId and clientSecret", async () => {
  await assert.rejects(
    () => mintLinearAppToken({ clientId: "", clientSecret: "x" }),
    /requires both clientId and clientSecret/,
  );
});

// ---------------------------------------------------------------------------
// parseLinearIdentifier
// ---------------------------------------------------------------------------

test("parseLinearIdentifier splits TEAM-number", () => {
  assert.deepEqual(parseLinearIdentifier("PAR-244"), { teamKey: "PAR", number: 244 });
  assert.deepEqual(parseLinearIdentifier(" par-7 "), { teamKey: "PAR", number: 7 });
});

test("parseLinearIdentifier rejects malformed identifiers", () => {
  assert.throws(() => parseLinearIdentifier("PAR"), /invalid Linear identifier/);
  assert.throws(() => parseLinearIdentifier("244"), /invalid Linear identifier/);
  assert.throws(() => parseLinearIdentifier(""), /invalid Linear identifier/);
});

// ---------------------------------------------------------------------------
// LinearItemSource.fetchIssueByIdentifier — single-item fetch via fake transport
// ---------------------------------------------------------------------------

function hydratedIssueNode() {
  return {
    id: "issue-uuid-244",
    identifier: "PAR-244",
    title: "Example issue",
    description: "Example description",
    url: "https://linear.app/partnerai/issue/PAR-244",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    priority: 2,
    creator: { id: "user-1", name: "Reporter", admin: false, owner: false },
    team: { id: "team-1", key: "PAR", name: "PartnerAI" },
    project: { id: "proj-1", name: "ClawSweeper", state: "started" },
    state: { id: "state-1", name: "Backlog", type: "backlog" },
    labels: { nodes: [{ id: "lbl-1", name: "bug" }] },
    attachments: {
      nodes: [] as Array<{ id: string; url: string; title: string }>,
      pageInfo: { hasNextPage: false, endCursor: null as string | null },
    },
    comments: {
      nodes: [] as Array<{ id: string; body: string }>,
      pageInfo: { hasNextPage: false, endCursor: null as string | null },
    },
  };
}

function fakeTransport(node: ReturnType<typeof hydratedIssueNode> | null) {
  const calls: Array<{ query: string; vars: Record<string, unknown> }> = [];
  const transport = async (query: string, vars: Record<string, unknown>): Promise<unknown> => {
    calls.push({ query, vars });
    return {
      issues: { nodes: node ? [node] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  };
  return { transport, calls };
}

test("fetchIssueByIdentifier returns a hydrated workspace item with comments", async () => {
  const { transport, calls } = fakeTransport(hydratedIssueNode());
  const source = new LinearItemSource(transport);
  const item = await source.fetchIssueByIdentifier("PAR-244");
  assert.ok(item);
  assert.equal(item.issue.identifier, "PAR-244");
  assert.equal(item.team.key, "PAR");
  assert.equal(item.project?.name, "ClawSweeper");
  assert.deepEqual(item.comments, []);
  assert.equal(item.description, "Example description");
  assert.equal(item.creator?.name, "Reporter");
  // The query is scoped by team key + number.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vars["teamKey"], "PAR");
  assert.equal(calls[0].vars["number"], 244);
  assert.equal(calls[0].vars["commentFirst"], 100);
});

test("fetchIssueByIdentifier paginates issue comments so marker comments beyond page one are visible", async () => {
  const first = hydratedIssueNode();
  first.comments = {
    nodes: [{ id: "c-old", body: "ordinary comment" }],
    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
  };
  const second = hydratedIssueNode();
  second.comments = {
    nodes: [{ id: "c-marker", body: "<!-- clawsweeper-review:issue-uuid-244 -->\n\nold" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const calls: Array<{ vars: Record<string, unknown> }> = [];
  const pages = [first, second];
  const transport = async (_query: string, vars: Record<string, unknown>): Promise<unknown> => {
    calls.push({ vars });
    const node = pages.shift();
    return {
      issues: { nodes: node ? [node] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  };

  const item = await new LinearItemSource(transport).fetchIssueByIdentifier("PAR-244");

  assert.ok(item);
  assert.deepEqual(
    item.comments.map((c) => c.id),
    ["c-old", "c-marker"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].vars["commentAfter"], "cursor-1");
});

test("fetchIssueByIdentifier fails closed when issue fields drift between comment pages", async () => {
  const first = hydratedIssueNode();
  first.comments = {
    nodes: [{ id: "c-old", body: "ordinary comment" }],
    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
  };
  const second = hydratedIssueNode();
  second.title = "Changed while comments were paginating";
  second.comments = {
    nodes: [{ id: "c-marker", body: "<!-- clawsweeper-review:issue-uuid-244 -->\n\nold" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const pages = [first, second];
  const transport = async (): Promise<unknown> => ({
    issues: {
      nodes: pages.length > 0 ? [pages.shift()] : [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });

  await assert.rejects(
    () => new LinearItemSource(transport).fetchIssueByIdentifier("PAR-244"),
    /changed while paginating comments/,
  );
});

test("fetchIssueByIdentifier returns null when no issue matches", async () => {
  const { transport } = fakeTransport(null);
  const source = new LinearItemSource(transport);
  assert.equal(await source.fetchIssueByIdentifier("PAR-999"), null);
});

// ---------------------------------------------------------------------------
// resolveWriteMode — dry-run by default; live needs --apply AND OPENCLAW_NOTIFY_LINEAR
// ---------------------------------------------------------------------------

test("resolveWriteMode is dry-run without --apply", () => {
  assert.equal(resolveWriteMode({ apply: false }, {}).live, false);
});

test("resolveWriteMode stays dry-run with --apply but no OPENCLAW_NOTIFY_LINEAR", () => {
  const mode = resolveWriteMode({ apply: true }, {});
  assert.equal(mode.live, false);
  assert.match(mode.reason, /OPENCLAW_NOTIFY_LINEAR/);
});

test("resolveWriteMode goes live only with both --apply and OPENCLAW_NOTIFY_LINEAR=1", () => {
  assert.equal(resolveWriteMode({ apply: true }, { OPENCLAW_NOTIFY_LINEAR: "1" }).live, true);
  assert.equal(resolveWriteMode({ apply: true }, { OPENCLAW_NOTIFY_LINEAR: "true" }).live, true);
  assert.equal(resolveWriteMode({ apply: true }, { OPENCLAW_NOTIFY_LINEAR: "0" }).live, false);
});

// ---------------------------------------------------------------------------
// buildItemPlan — end-to-end single-item plan (real pipeline, fake transport)
// ---------------------------------------------------------------------------

test("buildItemPlan does not authorize a create plan without an independently supplied approval", async () => {
  const { transport } = fakeTransport(hydratedIssueNode());
  const source = new LinearItemSource(transport);
  const result = await buildItemPlan(source, {
    identifier: "PAR-244",
    nowIso: "2026-06-22T00:00:00Z",
    staleDays: 60,
  });
  assert.equal(result.plan.action, "create");
  assert.equal(result.plan.targetCommentId, null);
  // body carries the durable marker keyed on the issue UUID.
  assert.ok(result.plan.body.includes("<!-- clawsweeper-review:issue-uuid-244 -->"));
  // Not authorized: a live apply needs an independently reviewed dry-run receipt/hash pair.
  assert.equal(result.authorization.allowed, false);
  assert.match(result.authorization.reasons.join("\n"), /plan hash mismatch/);
});

test("buildItemPlan authorizes only when approved plan and snapshot hashes match the current dry-run", async () => {
  const probe = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-06-22T00:00:00Z",
      staleDays: 60,
    },
  );
  const result = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-06-22T00:00:00Z",
      staleDays: 60,
      approval: {
        approvedPlanHash: probe.plan.planHash,
        approvedSnapshotHash: probe.record.snapshotHash,
        source: "direct-hashes",
      },
    },
  );

  assert.equal(result.authorization.allowed, true);
  assert.equal(result.receipt.driftDetected, false);
  assert.equal(result.receipt.approvedPlanHash, probe.plan.planHash);
});

test("buildItemPlan rejects an approval when the approved snapshot hash is stale", async () => {
  const probe = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-06-22T00:00:00Z",
    },
  );
  const result = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-06-22T00:00:00Z",
      approval: {
        approvedPlanHash: probe.plan.planHash,
        approvedSnapshotHash: "0".repeat(64),
        source: "direct-hashes",
      },
    },
  );

  assert.equal(result.authorization.allowed, false);
  assert.match(result.authorization.reasons.join("\n"), /snapshot drift/);
});

test("revalidateCommentWrite blocks a live write when the issue drifts after planning", async () => {
  const node = hydratedIssueNode();
  const source = new LinearItemSource(fakeTransport(node).transport);
  const nowIso = "2026-06-22T00:00:00Z";
  const probe = await buildItemPlan(source, { identifier: "PAR-244", nowIso });
  const approval = {
    approvedPlanHash: probe.plan.planHash,
    approvedSnapshotHash: probe.record.snapshotHash,
    source: "dry-run-receipt",
  };

  node.title = "changed after the reviewed dry-run";

  await assert.rejects(
    revalidateCommentWrite(
      source,
      { identifier: "PAR-244", nowIso, approval },
      { live: true, reason: "live" },
    ),
    /live comment revalidation blocked.*snapshot drift/s,
  );
});

test("buildItemPlan approval stays stable for stale candidates when the dry-run nowIso is reused", async () => {
  const probe = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-08-22T00:00:00Z",
    },
  );
  assert.equal(probe.classification.disposition, "stale-candidate");

  const withSameClock = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: probe.nowIso,
      approval: {
        approvedPlanHash: probe.plan.planHash,
        approvedSnapshotHash: probe.record.snapshotHash,
        source: "dry-run-receipt",
      },
    },
  );
  assert.equal(withSameClock.authorization.allowed, true);

  const withDifferentClock = await buildItemPlan(
    new LinearItemSource(fakeTransport(hydratedIssueNode()).transport),
    {
      identifier: "PAR-244",
      nowIso: "2026-08-23T00:00:00Z",
      approval: {
        approvedPlanHash: probe.plan.planHash,
        approvedSnapshotHash: probe.record.snapshotHash,
        source: "dry-run-receipt",
      },
    },
  );
  assert.equal(withDifferentClock.authorization.allowed, false);
  assert.match(withDifferentClock.authorization.reasons.join("\n"), /plan hash mismatch/);
});

test("buildItemPlan yields a noop when an up-to-date marker comment already exists", async () => {
  // First render the body the planner would produce, then seed it as an existing comment.
  const node = hydratedIssueNode();
  const probe = fakeTransport(node);
  const probeResult = await buildItemPlan(new LinearItemSource(probe.transport), {
    identifier: "PAR-244",
    nowIso: "2026-06-22T00:00:00Z",
  });
  node.comments.nodes = [
    {
      id: "existing-comment-1",
      body: probeResult.plan.body,
      botActor: { id: "clawsweeper-app", name: "ClawSweeper" },
    },
  ];

  const { transport } = fakeTransport(node);
  const result = await buildItemPlan(new LinearItemSource(transport), {
    identifier: "PAR-244",
    nowIso: "2026-06-22T00:00:00Z",
    expectedAuthorId: "clawsweeper-app",
  });
  assert.equal(result.plan.action, "noop");
  assert.equal(result.plan.targetCommentId, "existing-comment-1");
});

test("renderReviewContent is deterministic for the same record + classification", () => {
  const record = {
    identifier: "PAR-244",
    triagePriority: "P2",
    itemCategory: "bug",
    state: "open",
    labels: [],
  };
  const classification = {
    disposition: "review",
    eligible: true,
    staleCandidate: false,
    reasons: ["eligible for review"],
  };
  const a = renderReviewContent(record, classification);
  const b = renderReviewContent(record, classification);
  assert.equal(a, b);
  assert.ok(a.includes("PAR-244"));
  assert.ok(a.includes("Suggested next step:")); // policy-driven next step is rendered
});

// ---------------------------------------------------------------------------
// applyPlan — mints a Bearer token and runs the create/update mutation (fakes)
// ---------------------------------------------------------------------------

test("applyPlan mints a Bearer token and runs commentCreate with the planned body", async () => {
  const seen: { authHeader?: string; mutation?: string; vars?: Record<string, unknown> } = {};
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "minted-xyz", expires_in: 100, token_type: "Bearer" }),
        { status: 200 },
      );
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.authHeader = headers["Authorization"];
    const parsed = JSON.parse(init?.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    seen.mutation = parsed.query;
    seen.vars = parsed.variables;
    return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
      status: 200,
    });
  };

  const plan = { action: "create", issueId: "issue-uuid-244", targetCommentId: null, body: "BODY" };
  const out = await applyPlan(
    plan,
    { clientId: "cid", clientSecret: "csec" },
    {
      fetchImpl: fakeFetch as typeof fetch,
      mintEndpoint: "https://fake.linear.app/oauth/token",
      graphqlEndpoint: "https://fake.linear.app/graphql",
    },
  );

  assert.equal(seen.authHeader, "Bearer minted-xyz");
  assert.match(seen.mutation ?? "", /commentCreate/);
  assert.deepEqual(seen.vars, { issueId: "issue-uuid-244", body: "BODY" });
  assert.deepEqual(out, { commentCreate: { success: true } });
});

test("applyPlan does nothing (and mints no token) for a noop plan", async () => {
  let touched = false;
  const fakeFetch = async (): Promise<Response> => {
    touched = true;
    return new Response("{}", { status: 200 });
  };
  const out = await applyPlan(
    { action: "noop", issueId: "x", targetCommentId: "c1", body: "B" },
    { clientId: "cid", clientSecret: "csec" },
    { fetchImpl: fakeFetch as typeof fetch, mintEndpoint: "https://fake/oauth/token" },
  );
  assert.deepEqual(out, { noop: true });
  // A noop must NOT mint a write token or hit the network at all.
  assert.equal(touched, false);
});

// ---------------------------------------------------------------------------
// Keychain resolvers — env precedence / injected lookup (no real `security` call)
// ---------------------------------------------------------------------------

test("resolveReadToken prefers env and never calls the keychain when env is set", () => {
  const token = resolveReadToken({
    env: { LINEAR_API_KEY: "env-key" },
    runKeychain: () => {
      throw new Error("keychain must not be consulted when env token is present");
    },
  });
  assert.equal(token, "env-key");
});

test("resolveAppCredentials reads client id + secret from the injected keychain", () => {
  const creds = resolveAppCredentials({
    runKeychain: (service: string) => (service.includes("client-id") ? "the-id" : "the-secret"),
  });
  assert.deepEqual(creds, { clientId: "the-id", clientSecret: "the-secret" });
});

test("resolveApproval loads approved plan and snapshot hashes from a saved dry-run receipt", () => {
  const planHash = "a".repeat(64);
  const snapshotHash = "b".repeat(64);
  const nowIso = "2026-06-22T00:00:00Z";
  const approval = resolveApproval(
    { identifier: "PAR-244", dryRunReceipt: "/fake/receipt.json" },
    {
      readFileSync: () =>
        JSON.stringify({
          identifier: "PAR-244",
          planHash,
          snapshotHash,
          nowIso,
          authorized: false,
        }),
    },
  );
  assert.deepEqual(approval, {
    approvedPlanHash: planHash,
    approvedSnapshotHash: snapshotHash,
    nowIso,
    source: "dry-run-receipt",
  });
});

test("resolveApproval compares dry-run receipt identifiers after Linear-style normalization", () => {
  const planHash = "a".repeat(64);
  const snapshotHash = "b".repeat(64);
  const approval = resolveApproval(
    { identifier: "par-244", dryRunReceipt: "/fake/receipt.json" },
    {
      readFileSync: () => JSON.stringify({ identifier: "PAR-244", planHash, snapshotHash }),
    },
  );
  assert.equal(approval?.approvedPlanHash, planHash);
});

test("resolveApproval requires direct approval to include both plan and snapshot hashes", () => {
  assert.throws(
    () => resolveApproval({ approvedPlanHash: "a".repeat(64), approvedSnapshotHash: "" }),
    /requires both --approved-plan-hash and --approved-snapshot-hash/,
  );
});

// ---------------------------------------------------------------------------
// resolveWriteDecision — eligibility-aware live-write gate. ClawSweeper never
// comments on closed/protected/excluded; noop / denied / dry-run all skip.
// ---------------------------------------------------------------------------

function decisionResultStub(over: Record<string, unknown> = {}) {
  return {
    record: { identifier: (over.identifier as string) ?? "PAR-244" },
    classification: {
      eligible: (over.eligible as boolean) ?? true,
      disposition: (over.disposition as string) ?? "review",
    },
    policy: { ruleId: (over.ruleId as string) ?? "needs-maintainer-review" },
    authorization: { allowed: (over.allowed as boolean) ?? true, reasons: [] },
    plan: { action: (over.action as string) ?? "create" },
    expectedAuthorId: (over.expectedAuthorId as string) ?? "actor-1",
  };
}

test("resolveWriteDecision: dry-run never writes", () => {
  const d = resolveWriteDecision(decisionResultStub(), {
    live: false,
    reason: "dry-run (default)",
  });
  assert.equal(d.write, false);
  assert.match(d.reason, /dry-run/);
});

test("resolveWriteDecision: live + ineligible (closed) is skipped, not written", () => {
  const d = resolveWriteDecision(decisionResultStub({ eligible: false, disposition: "closed" }), {
    live: true,
    reason: "live",
  });
  assert.equal(d.write, false);
  assert.match(d.reason, /not eligible/);
  assert.match(d.reason, /closed/);
});

test("resolveWriteDecision: live + eligible + authorized + create writes", () => {
  const d = resolveWriteDecision(decisionResultStub(), { live: true, reason: "live" });
  assert.equal(d.write, true);
});

test("resolveWriteDecision: live write requires an expected app actor id", () => {
  const d = resolveWriteDecision(decisionResultStub({ expectedAuthorId: "" }), {
    live: true,
    reason: "live",
  });
  assert.equal(d.write, false);
  assert.match(d.reason, /LINEAR_APP_ACTOR_ID is required/);
});

test("summarize never reports a live write without an expected app actor id", () => {
  const result = decisionResultStub({ expectedAuthorId: "" });
  const summary = summarize(result, { live: false, reason: "dry-run" });
  assert.equal(summary.wouldWrite, false);
});

test("summarize never advertises a comment write for human-review protection", () => {
  const summary = summarize(decisionResultStub({ ruleId: "protected-human-review" }), {
    live: false,
    reason: "dry-run",
  });
  assert.equal(summary.wouldWrite, false);
});

test("resolveWriteDecision: live + eligible but noop does not write", () => {
  const d = resolveWriteDecision(decisionResultStub({ action: "noop" }), {
    live: true,
    reason: "live",
  });
  assert.equal(d.write, false);
  assert.match(d.reason, /noop/);
});

test("resolveWriteDecision: live + eligible but unauthorized does not write", () => {
  const d = resolveWriteDecision(decisionResultStub({ allowed: false }), {
    live: true,
    reason: "live",
  });
  assert.equal(d.write, false);
  assert.match(d.reason, /denied/);
});

test("buildItemPlan marks a completed issue ineligible -> the write decision refuses even when live", async () => {
  const node = hydratedIssueNode();
  node.state = { id: "s", name: "Done", type: "completed" };
  const { transport } = fakeTransport(node);
  const result = await buildItemPlan(new LinearItemSource(transport), {
    identifier: "PAR-244",
    nowIso: "2026-06-22T00:00:00Z",
  });
  assert.equal(result.classification.eligible, false);
  assert.equal(result.classification.disposition, "closed");
  const d = resolveWriteDecision(result, { live: true, reason: "live" });
  assert.equal(d.write, false);
  assert.match(d.reason, /not eligible/);
});

test("buildItemPlan treats clawsweeper:human-review as a no-comment protection", async () => {
  const node = hydratedIssueNode();
  node.labels = { nodes: [{ id: "human", name: "clawsweeper:human-review" }] };
  const { transport } = fakeTransport(node);
  const result = await buildItemPlan(new LinearItemSource(transport), {
    identifier: "PAR-244",
    nowIso: "2026-06-22T00:00:00Z",
    expectedAuthorId: "actor-1",
  });
  const decision = resolveWriteDecision(result, { live: true, reason: "live" });
  assert.equal(decision.write, false);
  assert.match(decision.reason, /human-review/);
});

// ---------------------------------------------------------------------------
// readBackComment — PAR-215 read-back: confirm the durable marker comment landed
// ---------------------------------------------------------------------------

test("readBackComment confirms a single marker comment whose body matches the plan", async () => {
  const plan = { marker: "<!-- m -->", body: "<!-- m -->\n\nhello" };
  const source = {
    fetchIssueByIdentifier: async () => ({
      comments: [{ id: "c1", body: plan.body, authorId: "actor-1" }],
    }),
  };
  const rb = await readBackComment(source, "PAR-244", plan, "actor-1");
  assert.equal(rb.confirmed, true);
  assert.equal(rb.commentId, "c1");
  assert.equal(rb.markerCommentCount, 1);
});

test("readBackComment is not confirmed when the comment is missing or the body mismatches", async () => {
  const plan = { marker: "<!-- m -->", body: "<!-- m -->\n\nhello" };
  const missing = { fetchIssueByIdentifier: async () => ({ comments: [] }) };
  assert.equal((await readBackComment(missing, "PAR-244", plan, "actor-1")).confirmed, false);
  const mismatch = {
    fetchIssueByIdentifier: async () => ({
      comments: [{ id: "c1", body: "<!-- m -->\n\nOLD", authorId: "actor-1" }],
    }),
  };
  const rb = await readBackComment(mismatch, "PAR-244", plan, "actor-1");
  assert.equal(rb.confirmed, false);
  assert.equal(rb.bodyMatches, false);
});

test("readBackComment rejects a matching body written by a different actor", async () => {
  const plan = { marker: "<!-- m -->", body: "<!-- m -->\n\nhello", targetCommentId: null };
  const source = {
    fetchIssueByIdentifier: async () => ({
      comments: [{ id: "foreign", body: plan.body, authorId: "actor-other" }],
    }),
  };
  const rb = await readBackComment(source, "PAR-244", plan, "actor-1");
  assert.equal(rb.confirmed, false);
  assert.equal(rb.authorMatches, false);
});

test("assertReadBackConfirmed fails live apply on missing, mismatched, or fetch-error read-back", () => {
  assert.doesNotThrow(() => assertReadBackConfirmed({ confirmed: true }));
  assert.throws(() => assertReadBackConfirmed({ confirmed: false }), /read-back failed/);
  assert.throws(
    () => assertReadBackConfirmed({ confirmed: false, error: "Linear fetch failed" }),
    /Linear fetch failed/,
  );
});

test("readBackComment confirms an UPDATE by target id even with stale duplicate marker comments", async () => {
  // The planner tolerates stale duplicates; a successful update must still read back confirmed.
  const plan = { marker: "<!-- m -->", body: "<!-- m -->\n\nnew", targetCommentId: "keep" };
  const source = {
    fetchIssueByIdentifier: async () => ({
      comments: [
        { id: "stale", body: "<!-- m -->\n\nOLD-DUPLICATE", authorId: "actor-1" },
        { id: "keep", body: plan.body, authorId: "actor-1" },
      ],
    }),
  };
  const rb = await readBackComment(source, "PAR-244", plan, "actor-1");
  assert.equal(rb.confirmed, true);
  assert.equal(rb.commentId, "keep");
  assert.equal(rb.markerCommentCount, 2);
  assert.equal(rb.staleDuplicates, 1);
});

test("readBackComment confirms a CREATE by matching body even if a stale duplicate exists", async () => {
  const plan = { marker: "<!-- m -->", body: "<!-- m -->\n\nfresh", targetCommentId: null };
  const source = {
    fetchIssueByIdentifier: async () => ({
      comments: [
        { id: "stale", body: "<!-- m -->\n\nOLD", authorId: "actor-1" },
        { id: "new", body: plan.body, authorId: "actor-1" },
      ],
    }),
  };
  const rb = await readBackComment(source, "PAR-244", plan, "actor-1");
  assert.equal(rb.confirmed, true);
  assert.equal(rb.commentId, "new");
});

// ---------------------------------------------------------------------------
// Barrel wiring
// ---------------------------------------------------------------------------

test("write-path symbols are re-exported from the barrel", () => {
  assert.equal(typeof createLinearTransportFromIndex, "function");
  assert.equal(typeof mintLinearAppTokenFromIndex, "function");
  assert.equal(typeof parseLinearIdentifierFromIndex, "function");
});
