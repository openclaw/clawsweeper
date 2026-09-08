import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  jsonResponse,
  signedGithubWebhookRequest,
  worker,
} from "../../../test/dashboard-worker-harness.ts";

export async function proveSourceAuthorityAcknowledgementRecovery() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const storage = new MemoryDurableStorage();
  const calls = [];
  const comments = [];
  let loseCreateResponse = true;
  const originalFetch = globalThis.fetch;
  const targetRepo = "openclaw/proof-ack-recovery";
  const itemNumber = 860;
  const deliveryId = "proof-source-authority-ack-recovery";
  const sourceHeadSha = "d".repeat(40);
  const commentId = 86_000;
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23proof",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      hostedPublicTargetProbe: async () => "public",
    },
  );

  const writePermissions = { issues: "write", pull_requests: "write" };
  const readPermissions = { pull_requests: "read" };
  const grants = new Map();
  let lastMintInit;
  function validateMint(init) {
    assert.equal(init?.method, "POST");
    const authorization = new Headers(init.headers).get("authorization") || "";
    assert.ok(authorization.startsWith("Bearer "), "expected app JWT authorization");
    const parts = authorization.slice(7).split(".");
    assert.equal(parts.length, 3);
    const [header, claims, signature] = parts;
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(header + "." + claims),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      "expected fixture app JWT signature",
    );
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    assert.equal(payload.iss, "Iv23proof");
    assert.ok(
      payload.iat <= now &&
        payload.iat >= now - 120 &&
        payload.exp > now &&
        payload.exp <= now + 600,
    );
    const body = JSON.parse(String(init.body));
    const expectedPermissions =
      body.permissions?.issues === "write" ? writePermissions : readPermissions;
    assert.deepEqual(body, {
      repositories: ["proof-ack-recovery"],
      permissions: expectedPermissions,
    });
    return expectedPermissions;
  }
  function requireGrant(init, permissions) {
    const authorization = new Headers(init?.headers).get("authorization") || "";
    const grant = grants.get(authorization);
    assert.ok(grant, "expected a token minted by the fixture");
    assert.deepEqual(grant, permissions);
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const method = init?.method || "GET";
    calls.push({ method, path: url.pathname, page: url.searchParams.get("page") });
    if (url.pathname === "/app/installations/123/access_tokens") {
      assert.equal(url.search, "");
      const permissions = validateMint(init);
      const token = "proof-scoped-token-" + (grants.size + 1);
      grants.set("Bearer " + token, permissions);
      lastMintInit = init;
      return jsonResponse({ token });
    }
    if (url.pathname === `/repos/${targetRepo}/pulls/${itemNumber}`) {
      assert.equal(method, "GET");
      assert.equal(url.search, "");
      assert.equal(init?.body, undefined);
      requireGrant(init, readPermissions);
      return jsonResponse({ head: { sha: sourceHeadSha } });
    }
    if (url.pathname === `/repos/${targetRepo}/issues/${itemNumber}/comments`) {
      requireGrant(init, writePermissions);
      if (method === "GET") {
        assert.equal(url.search, "?per_page=100&page=1");
        assert.equal(init?.body, undefined);
        return jsonResponse(comments);
      }
      assert.equal(method, "POST");
      assert.equal(url.search, "");
      const comment = {
        id: commentId,
        body: String(JSON.parse(String(init?.body || "{}")).body || ""),
        created_at: "2026-09-04T00:00:00Z",
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.push(comment);
      if (loseCreateResponse) {
        loseCreateResponse = false;
        return new Response(JSON.stringify({ message: "fixture response loss" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse(comment);
    }
    throw new Error(`unexpected proof request ${method} ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      signedGithubWebhookRequest({
        event: "pull_request",
        secret: "proof-secret",
        deliveryId,
        payload: {
          action: "opened",
          repository: {
            full_name: targetRepo,
            default_branch: "main",
            private: false,
            archived: false,
            fork: false,
            has_issues: true,
          },
          pull_request: {
            number: itemNumber,
            head: { sha: sourceHeadSha },
            updated_at: "2026-09-04T00:00:00Z",
            body: "Exercise source-authority acknowledgement recovery.",
          },
          installation: { id: 123 },
        },
      }),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23proof",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
        hostedPublicTargetProbe: async () => "public",
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      },
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      deferred: true,
      reason: "pull request acknowledgement deferred",
    });
    assert.equal(comments.length, 1);

    const reservationKey = `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
    const pending = storage.rawGet(reservationKey);
    assert.equal(pending.reviewAcknowledgementPending, true);
    const sourceAuthoritySeq = pending.sourceAuthoritySeq;
    storage.rawPut(reservationKey, { ...pending, nextAttemptAt: 0 });
    await queue.alarm();

    const state = await storage.get("exact-review-queue");
    assert.equal(
      state.items[`${targetRepo}#${itemNumber}`].decision.reviewAcknowledgementCommentId,
      commentId,
    );
    assert.equal(
      state.items[`${targetRepo}#${itemNumber}`].decision.sourceAuthoritySeq,
      sourceAuthoritySeq,
    );
    assert.equal(storage.rawHas(reservationKey), false);
    assert.equal(comments.length, 1);
    const commentPosts = calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/repos/${targetRepo}/issues/${itemNumber}/comments`,
    ).length;
    assert.equal(commentPosts, 1);
    assert.equal(grants.size, 3);
    assert.ok(lastMintInit);
    const mintBody = JSON.parse(String(lastMintInit.body));
    assert.throws(() => validateMint({ ...lastMintInit, method: "GET" }));
    assert.throws(() =>
      validateMint({
        ...lastMintInit,
        body: JSON.stringify({ ...mintBody, repositories: ["wrong-repository"] }),
      }),
    );
    assert.throws(() =>
      validateMint({
        ...lastMintInit,
        body: JSON.stringify({ ...mintBody, permissions: { contents: "write" } }),
      }),
    );
    assert.throws(() =>
      requireGrant(
        { headers: { authorization: "Bearer unminted-fixture-token" } },
        readPermissions,
      ),
    );

    return {
      credential_boundary_verified: true,
      scoped_token_mints: grants.size,
      rejected_credential_controls: 4,
      webhook_status: 202,
      initial_outcome: "acknowledgement_deferred",
      fallback: "production ExactReviewQueue alarm",
      receipt_comment_id: commentId,
      source_authority_seq: sourceAuthoritySeq,
      admitted_with_same_receipt: true,
      comment_create_attempts: commentPosts,
      duplicate_comments: comments.length - 1,
      reservation_completed: !storage.rawHas(reservationKey),
      external_boundary: "controlled GitHub Request/Response fixture",
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
