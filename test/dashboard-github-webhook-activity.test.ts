import assert from "node:assert/strict";
import test from "node:test";
import { forwardGithubWebhookActivity } from "../dashboard/github-activity.ts";
import {
  normalizeGithubActivity,
  renderGithubActivityMessage,
} from "../src/repair/github-activity.ts";
import {
  WEBHOOK_ACTIVITY_DELIVERY,
  WEBHOOK_ACTIVITY_ENV,
  WEBHOOK_ACTIVITY_NOW,
  webhookActivityPayload,
} from "./github-webhook-activity-fixtures.ts";

const delivered = { ok: true, runId: "proof-run", completion: { status: "ok", delivered: true } };
function harness(
  replies: { status: number; body: unknown }[] = [{ status: 200, body: delivered }],
  admitRetry: () => Promise<boolean> = async () => true,
) {
  const requests: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    signal?: AbortSignal | null;
  }[] = [];
  const logs: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    return Response.json(reply.body, { status: reply.status });
  };
  const run = (
    event = "issue_comment",
    payload = webhookActivityPayload(event),
    env: Record<string, string | undefined> = WEBHOOK_ACTIVITY_ENV,
    deliveryId: string | null = WEBHOOK_ACTIVITY_DELIVERY,
  ) =>
    forwardGithubWebhookActivity(
      { event, payload, deliveryId, env, admitRetry },
      {
        fetch: fetcher,
        now: () => new Date(WEBHOOK_ACTIVITY_NOW),
        log: (value) => logs.push(value),
      },
    );
  return { requests, logs, run };
}

test("webhook activity is opt-in and ignores unsubscribed events without any hook fetch", async () => {
  const h = harness();
  for (const gate of ["", "0", "true"])
    await h.run("issue_comment", webhookActivityPayload(), {
      ...WEBHOOK_ACTIVITY_ENV,
      CLAWSWEEPER_GITHUB_ACTIVITY_FROM_WEBHOOK: gate,
    });
  for (const event of [
    "push",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
    "ping",
  ])
    await h.run(event);
  assert.equal(h.requests.length, 0);
});

test("subscribed webhook activity preserves normalized message and wire contract with delivery UUID", async () => {
  for (const event of ["issues", "issue_comment", "pull_request"]) {
    const h = harness();
    const payload = webhookActivityPayload(event);
    await h.run(event, payload);
    assert.equal(h.requests.length, 1, event);
    const normalized = normalizeGithubActivity({
      eventName: event,
      payload,
      env: {},
      deliveryId: WEBHOOK_ACTIVITY_DELIVERY,
    });
    assert.ok(normalized);
    assert.ok(normalized.idempotencyKey.endsWith(`:${WEBHOOK_ACTIVITY_DELIVERY}`));
    const request = h.requests[0];
    assert.equal(request.url, "https://hook.invalid/hooks/agent");
    assert.equal(request.headers.get("authorization"), "Bearer local-proof-token-not-a-secret");
    assert.equal(request.headers.get("idempotency-key"), normalized.idempotencyKey);
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.deepEqual(request.body, {
      name: `GitHub ${event} openclaw/openclaw`,
      agentId: "clawsweeper",
      deliver: false,
      channel: "discord",
      to: "channel:123",
      idempotencyKey: normalized.idempotencyKey,
      thinking: "low",
      timeoutSeconds: 60,
      waitForCompletion: true,
      message: renderGithubActivityMessage(normalized, {
        discordTarget: "channel:123",
        observedAt: new Date(WEBHOOK_ACTIVITY_NOW).toISOString(),
      }),
    });
    assert.ok(request.signal, "hook fetch is bounded");
    assert.deepEqual(h.logs, [
      {
        event: "github_activity_hook",
        source_event: event,
        delivery_id: WEBHOOK_ACTIVITY_DELIVERY,
        repository: "openclaw/openclaw",
        item_number: 42,
        hook_status: 200,
        attempts: 1,
        duration_ms: 0,
        outcome: "delivered",
      },
    ]);
    const log = JSON.stringify(h.logs);
    assert.ok(!log.includes(WEBHOOK_ACTIVITY_ENV.CLAWSWEEPER_OPENCLAW_HOOK_TOKEN));
    assert.ok(!log.includes(payload.comment.body));
    assert.ok(!log.includes(payload.issue.body));
  }
});

test("routine webhook comments and PR synchronization are filtered before the hook", async () => {
  const h = harness();
  await h.run("issue_comment", { ...webhookActivityPayload(), action: "edited" });
  await h.run("issue_comment", { ...webhookActivityPayload(), sender: { login: "renovate[bot]" } });
  await h.run("pull_request", { ...webhookActivityPayload("pull_request"), action: "synchronize" });
  assert.equal(h.requests.length, 0);
  const command = webhookActivityPayload();
  command.action = "edited";
  command.comment.body = "@clawsweeper please review";
  await h.run("issue_comment", command);
  assert.equal(h.requests.length, 1, "command edits retain existing filter semantics");
});

test("missing delivery identity or hook configuration never posts an untracked activity", async () => {
  const h = harness();
  await h.run("issue_comment", webhookActivityPayload(), WEBHOOK_ACTIVITY_ENV, null);
  await h.run("issue_comment", webhookActivityPayload(), WEBHOOK_ACTIVITY_ENV, "");
  for (const missing of [
    "CLAWSWEEPER_OPENCLAW_HOOK_URL",
    "CLAWSWEEPER_OPENCLAW_HOOK_TOKEN",
    "CLAWSWEEPER_DISCORD_TARGET",
  ] as const) {
    await h.run("issue_comment", webhookActivityPayload(), {
      ...WEBHOOK_ACTIVITY_ENV,
      [missing]: "",
    });
  }
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.logs, [
    {
      event: "github_activity_hook",
      source_event: "issue_comment",
      delivery_id: null,
      repository: "openclaw/openclaw",
      item_number: 42,
      hook_status: null,
      attempts: 0,
      duration_ms: 0,
      outcome: "failed",
      reason: "missing_delivery_id",
    },
    {
      event: "github_activity_hook",
      source_event: "issue_comment",
      delivery_id: "",
      repository: "openclaw/openclaw",
      item_number: 42,
      hook_status: null,
      attempts: 0,
      duration_ms: 0,
      outcome: "failed",
      reason: "missing_delivery_id",
    },
    ...Array.from({ length: 3 }, () => ({
      event: "github_activity_hook",
      source_event: "issue_comment",
      delivery_id: WEBHOOK_ACTIVITY_DELIVERY,
      repository: "openclaw/openclaw",
      item_number: 42,
      hook_status: null,
      attempts: 0,
      duration_ms: 0,
      outcome: "failed",
      reason: "hook_not_configured",
    })),
  ]);
});

test("transient hook failure retries once with identical idempotency and ignores larger configured retry counts", async () => {
  const h = harness([
    { status: 503, body: { error: "temporary failure" } },
    { status: 200, body: delivered },
  ]);
  await h.run("issue_comment", webhookActivityPayload(), {
    ...WEBHOOK_ACTIVITY_ENV,
    CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "99",
  });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].body, h.requests[1].body);
  assert.equal(
    h.requests[0].headers.get("idempotency-key"),
    h.requests[1].headers.get("idempotency-key"),
  );
});
test("hook failures and inconclusive completion remain non-throwing best-effort outcomes", async () => {
  for (const reply of [
    { status: 401, body: { error: "denied" } },
    { status: 503, body: { error: "unavailable" } },
    {
      status: 200,
      body: { ok: true, runId: "run", completion: { status: "error", deliveryError: "failed" } },
    },
    { status: 200, body: { ok: true, runId: "run", completion: { status: "ok" } } },
  ]) {
    const h = harness([reply]);
    await assert.doesNotReject(h.run());
    assert.equal(h.requests.length, reply.status === 503 ? 2 : 1);
    assert.ok(
      h.logs.some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "outcome" in value &&
          value.outcome === "failed",
      ),
    );
  }
});

test("repeated App deliveries preserve a Gateway dedupe key; distinct UUIDs are distinct notifications", async () => {
  const h = harness();
  await h.run();
  await h.run();
  await h.run(
    "issue_comment",
    webhookActivityPayload(),
    WEBHOOK_ACTIVITY_ENV,
    "b92adfcb-93ad-47f9-89ad-45e7d826ea94",
  );
  assert.equal(
    h.requests[0].headers.get("idempotency-key"),
    h.requests[1].headers.get("idempotency-key"),
  );
  assert.notEqual(
    h.requests[0].headers.get("idempotency-key"),
    h.requests[2].headers.get("idempotency-key"),
  );
});

test("webhook delivery UUID overrides event IDs without changing legacy numeric delivery semantics", () => {
  const legacy = (delivery_id: number | string) =>
    normalizeGithubActivity({
      eventName: "repository_dispatch",
      env: {},
      payload: {
        action: "github_activity",
        client_payload: {
          activity: {
            type: "issue_comment",
            repo: "openclaw/openclaw",
            action: "created",
            subject: { kind: "pull_request", number: 42 },
            delivery_id,
          },
        },
      },
    });
  assert.equal(
    legacy(123)?.idempotencyKey,
    "github-activity:openclaw/openclaw:issue_comment:created:pull_request-42:unknown",
  );
  assert.equal(legacy(456)?.idempotencyKey, legacy(123)?.idempotencyKey);
  assert.equal(
    legacy("123")?.idempotencyKey,
    "github-activity:openclaw/openclaw:issue_comment:created:pull_request-42:123",
  );
  const payload = webhookActivityPayload();
  for (const commentId of [123, 456]) {
    payload.comment.id = commentId;
    const normalized = normalizeGithubActivity({
      eventName: "issue_comment",
      payload,
      env: {},
      deliveryId: WEBHOOK_ACTIVITY_DELIVERY,
    });
    assert.equal(
      normalized?.idempotencyKey,
      `github-activity:openclaw/openclaw:issue_comment:created:pull_request-42:${WEBHOOK_ACTIVITY_DELIVERY}`,
    );
  }
});

test("transport failure remains a bounded logged best-effort failure", async () => {
  const logs: unknown[] = [];
  let attempts = 0;
  await assert.doesNotReject(
    forwardGithubWebhookActivity(
      {
        event: "issue_comment",
        payload: webhookActivityPayload(),
        deliveryId: WEBHOOK_ACTIVITY_DELIVERY,
        env: WEBHOOK_ACTIVITY_ENV,
        admitRetry: async () => true,
      },
      {
        fetch: async () => {
          attempts++;
          throw new Error("fetch failed");
        },
        now: () => new Date(WEBHOOK_ACTIVITY_NOW),
        log: (value) => logs.push(value),
      },
    ),
  );
  assert.equal(attempts, 2);
  assert.deepEqual(logs, [
    {
      event: "github_activity_hook",
      source_event: "issue_comment",
      delivery_id: WEBHOOK_ACTIVITY_DELIVERY,
      repository: "openclaw/openclaw",
      item_number: 42,
      hook_status: null,
      attempts: 2,
      duration_ms: 0,
      outcome: "failed",
      reason: "hook_request_failed",
    },
  ]);
});

test("revoked or unverifiable admission prevents another credential-bearing hook request", async () => {
  for (const admitRetry of [
    async () => false,
    async () => {
      throw new Error("admission unavailable");
    },
  ]) {
    const h = harness([{ status: 503, body: { error: "temporary" } }], admitRetry);
    await h.run();
    assert.equal(h.requests.length, 1);
    assert.ok(
      h.logs.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "outcome" in value &&
          value.outcome === "failed",
      ),
    );
  }
});
