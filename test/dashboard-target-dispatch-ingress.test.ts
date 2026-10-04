import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  assert,
  test,
  worker,
  MemoryDurableNamespace,
  createExactReviewAdmissionHarness,
  withExactReviewAdmissionHarness,
  jsonResponse,
} from "./dashboard-worker-harness.ts";
import {
  authenticateTargetDispatchToken,
  TARGET_DISPATCH_ENDPOINT,
  targetDispatchQueueIntake,
  type TargetDispatchIdentity,
} from "../dashboard/target-dispatch-ingress.ts";

const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "target", alg: "RS256" }] };
const nowMs = Date.now();
const nowSeconds = Math.floor(nowMs / 1000);
const baseClaims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: TARGET_DISPATCH_ENDPOINT,
  repository: "openclaw/openclaw",
  repository_id: "4242",
  event_name: "pull_request_target",
  ref: "refs/heads/main",
  workflow_ref: "openclaw/openclaw/.github/workflows/clawsweeper-dispatch.yml@refs/heads/main",
  job_workflow_ref: "openclaw/openclaw/.github/workflows/clawsweeper-dispatch.yml@refs/heads/main",
  run_id: "777",
  run_attempt: "1",
  iat: nowSeconds,
  nbf: nowSeconds,
  exp: nowSeconds + 300,
};

function oidcToken(overrides: Record<string, unknown> = {}) {
  const encoded = [
    { alg: "RS256", kid: "target" },
    { ...baseClaims, ...overrides },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return encoded + "." + sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url");
}

const jwksFetch = (async (url: string, init?: RequestInit) => {
  assert.equal(url, JWKS_URL);
  // Cloudflare Workers throw on `redirect: "error"`, which failed every token.
  assert.equal(init?.redirect, "manual");
  return Response.json(jwks);
}) as typeof fetch;

const pullRequestPayload = {
  target_repo: "openclaw/openclaw",
  target_branch: "main",
  item_number: 162098,
  item_kind: "pull_request",
  source_event: "pull_request_target",
  source_action: "edited",
  supersedes_in_progress: true,
  queue_claim: {
    review_acknowledgement_comment_id: 5918736444,
    source_updated_at: "2026-10-01T03:10:50Z",
    source_content_revision: "c".repeat(64),
    source_head_sha: "a".repeat(40),
    source_base_sha: "b".repeat(40),
    source_is_draft: false,
  },
  ingress_route: "target_dispatcher",
  ingress_fingerprint: "f".repeat(64),
};
const issuePayload = {
  target_repo: "openclaw/openclaw",
  target_branch: "main",
  item_number: 162099,
  item_kind: "issue",
  source_event: "issues",
  source_action: "opened",
  supersedes_in_progress: false,
  queue_claim: {
    source_updated_at: "2026-10-01T03:10:51Z",
    source_content_revision: "d".repeat(64),
  },
};
const pullIdentity: TargetDispatchIdentity = {
  repository: "openclaw/openclaw",
  repositoryId: "4242",
  eventName: "pull_request_target",
  ref: "refs/heads/main",
  runId: "777",
  runAttempt: "1",
};

test("target dispatch OIDC binds repository, event, branch, workflow, and run", async () => {
  assert.deepEqual(
    await authenticateTargetDispatchToken(oidcToken(), { now: nowMs, fetch: jwksFetch }),
    pullIdentity,
  );
  assert.equal(
    (
      await authenticateTargetDispatchToken(oidcToken({ event_name: "issues" }), {
        now: nowMs,
        fetch: jwksFetch,
      })
    )?.eventName,
    "issues",
  );
  for (const mismatch of [
    { aud: "https://clawsweeper.openclaw.ai/internal/exact-review/proof/producer" },
    { iss: "https://example.invalid" },
    // PR-head code, manual dispatches, and pushes never get queue authority.
    { event_name: "pull_request" },
    { event_name: "workflow_dispatch" },
    { ref: "refs/pull/1/merge" },
    { workflow_ref: "other/repo/.github/workflows/clawsweeper-dispatch.yml@refs/heads/main" },
    { workflow_ref: "openclaw/openclaw/.github/workflows/clawsweeper-dispatch.yml@refs/heads/x" },
    // Any other workflow in the target repository, even on main, is refused.
    {
      workflow_ref: "openclaw/openclaw/.github/workflows/labeler.yml@refs/heads/main",
      job_workflow_ref: "openclaw/openclaw/.github/workflows/labeler.yml@refs/heads/main",
    },
    { job_workflow_ref: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main" },
    { repository: "openclaw/openclaw;rm" },
    { repository_id: "0" },
    { run_id: "abc" },
    { run_attempt: "0" },
    { exp: nowSeconds - 1 },
    { iat: nowSeconds - 601 },
  ]) {
    assert.equal(
      await authenticateTargetDispatchToken(oidcToken(mismatch), { now: nowMs, fetch: jwksFetch }),
      null,
      JSON.stringify(mismatch),
    );
  }
  const forged = oidcToken().slice(0, -6) + "abcdef";
  assert.equal(
    await authenticateTargetDispatchToken(forged, { now: nowMs, fetch: jwksFetch }),
    null,
  );
  const redirected = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://example.invalid/jwks" },
    })) as typeof fetch;
  assert.equal(
    await authenticateTargetDispatchToken(oidcToken(), { now: nowMs, fetch: redirected }),
    null,
  );
});

test("target dispatch intake matches the legacy relay decision for dispatcher payloads", () => {
  const workflow = parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
  const intake = workflow.jobs["legacy-event-queue-intake"].steps.find(
    (step: { name?: string }) =>
      step.name === "Enqueue legacy event through the durable control plane",
  ).run as string;
  const relayScript = [...intake.matchAll(/node <<'NODE'\n([\s\S]*?)\nNODE\n/g)].map(
    (match) => match[1],
  )[1];
  assert.ok(relayScript);
  const legacyOpenclawPayload = {
    target_repo: "openclaw/openclaw",
    target_branch: "main",
    item_number: 162098,
    item_kind: "pull_request",
    source_event: "pull_request_target",
    source_action: "edited",
    supersedes_in_progress: true,
    ingress_route: "target_dispatcher",
    ingress_fingerprint: "5d6b8ba9351a8fd6b28f5c54c22a1da3abf6581d8de710a24944e4829a0ec8f0",
  };
  for (const [payload, identity] of [
    [pullRequestPayload, pullIdentity],
    [legacyOpenclawPayload, pullIdentity],
    [issuePayload, { ...pullIdentity, eventName: "issues" as const }],
  ] as const) {
    const relay = JSON.parse(
      execFileSync(process.execPath, ["-"], {
        input: relayScript,
        encoding: "utf8",
        env: {
          ...process.env,
          CLIENT_PAYLOAD: JSON.stringify(payload),
          TARGET_REPO: payload.target_repo,
          TARGET_BRANCH: payload.target_branch,
          USE_SOURCE_AUTHORITY: "0",
          GITHUB_RUN_ID: "36809311832",
          GITHUB_RUN_ATTEMPT: "1",
        },
      }),
    );
    const direct = targetDispatchQueueIntake(payload, identity);
    assert.ok(direct.ok);
    assert.equal(relay.delivery_id, "legacy:36809311832:1");
    assert.equal(direct.body.delivery_id, "target-dispatch:4242:777:1");
    assert.deepEqual(direct.body.decision, relay.decision);
    assert.deepEqual(direct.body.ingress, relay.ingress);
  }
});

test("target dispatch intake leaves relay-only fields and foreign identities to the relay", () => {
  for (const field of [
    "additional_prompt",
    "installation_id",
    "dispatch_key",
    "status_comment_id",
    "command_status_marker",
    "queue_lease_id",
  ]) {
    assert.deepEqual(
      targetDispatchQueueIntake({ ...pullRequestPayload, [field]: 1 }, pullIdentity),
      { ok: false, status: 400, error: "unsupported_target_dispatch_field" },
      field,
    );
  }
  assert.deepEqual(
    targetDispatchQueueIntake(
      { ...pullRequestPayload, queue_claim: { installation_id: 1 } },
      pullIdentity,
    ),
    { ok: false, status: 400, error: "unsupported_target_dispatch_field" },
  );
  for (const payload of [
    { ...pullRequestPayload, target_repo: "openclaw/clawsweeper" },
    { ...pullRequestPayload, source_event: "issues", item_kind: "issue" },
    { ...pullRequestPayload, item_kind: "issue" },
    // A pull request to another base branch is minted for that branch's ref.
    { ...pullRequestPayload, target_branch: "release" },
  ]) {
    assert.deepEqual(targetDispatchQueueIntake(payload, pullIdentity), {
      ok: false,
      status: 403,
      error: "target_dispatch_identity_mismatch",
    });
  }
  for (const payload of [
    { ...pullRequestPayload, target_branch: undefined },
    { ...pullRequestPayload, item_number: "162098" },
    { ...pullRequestPayload, source_action: "Edited; rm" },
    { ...pullRequestPayload, supersedes_in_progress: "true" },
  ]) {
    assert.equal(targetDispatchQueueIntake(payload, pullIdentity).ok, false);
  }
});

test("direct target dispatch enqueues once into the real queue and dedupes the replayed run", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));
  const harnessFetch = globalThis.fetch;
  let jwksFetches = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === JWKS_URL) {
      jwksFetches += 1;
      return Response.json(jwks);
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
  await withExactReviewAdmissionHarness(harness, async () => {
    const env = {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(harness.queue),
    };
    const post = (token: string, payload: unknown) =>
      worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/github/target-dispatch", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        env,
      );

    const first = await post(oidcToken(), pullRequestPayload);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), {
      ok: true,
      queued: true,
      item_key: "openclaw/openclaw#162098",
      superseded_publications: 0,
    });
    const replay = await post(oidcToken(), pullRequestPayload);
    assert.equal(replay.status, 202);
    assert.equal(((await replay.json()) as { deduped?: boolean }).deduped, true);

    const issue = await post(oidcToken({ event_name: "issues", run_id: "778" }), issuePayload);
    assert.equal(issue.status, 202);
    assert.equal(((await issue.json()) as { queued?: boolean }).queued, true);

    const deliveries = Array.from(
      harness.storage.sql.exec(
        "SELECT delivery_id FROM exact_review_queue_deliveries ORDER BY delivery_id",
      ),
    ).map((row) => (row as { delivery_id: string }).delivery_id);
    assert.deepEqual(deliveries, ["target-dispatch:4242:777:1", "target-dispatch:4242:778:1"]);
    assert.equal(jwksFetches, 3);
    // Executor dispatch belongs to the queue alarm; intake itself never relays.
    assert.deepEqual(harness.dispatched, []);
  });
});

test("direct target dispatch fails closed before the queue", async () => {
  const originalFetch = globalThis.fetch;
  let queueCalls = 0;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), JWKS_URL);
    return Response.json(jwks);
  }) as typeof fetch;
  try {
    const env = {
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
        fetch() {
          queueCalls += 1;
          return Response.json({ ok: true, queued: true });
        },
      }),
    };
    const post = (headers: Record<string, string>, body: string, extraEnv = {}) =>
      worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/github/target-dispatch", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
        { ...env, ...extraEnv },
      );
    const payload = JSON.stringify(pullRequestPayload);
    assert.equal((await post({}, payload)).status, 401);
    assert.equal(
      (await post({ authorization: `Bearer ${oidcToken({ aud: "wrong" })}` }, payload)).status,
      401,
    );
    assert.equal(
      (await post({ authorization: `Bearer ${oidcToken()}` }, "x".repeat(17 * 1024))).status,
      413,
    );
    assert.equal(
      (
        await post(
          { authorization: `Bearer ${oidcToken({ repository: "openclaw/clawsweeper" })}` },
          payload,
        )
      ).status,
      401,
    );
    const mismatch = await post(
      {
        authorization: `Bearer ${oidcToken({
          repository: "openclaw/clawsweeper",
          workflow_ref:
            "openclaw/clawsweeper/.github/workflows/clawsweeper-dispatch.yml@refs/heads/main",
          job_workflow_ref:
            "openclaw/clawsweeper/.github/workflows/clawsweeper-dispatch.yml@refs/heads/main",
        })}`,
      },
      payload,
    );
    assert.equal(mismatch.status, 403);
    const ineligible = await post({ authorization: `Bearer ${oidcToken()}` }, payload, {
      hostedTargetPredicate: () => false,
    });
    assert.equal(ineligible.status, 422);
    assert.equal(queueCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
