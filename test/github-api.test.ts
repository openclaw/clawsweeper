import assert from "node:assert/strict";
import {
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import test from "node:test";

import { pemToPkcs8, signGithubAppJwt } from "../dashboard/github-api.ts";
import worker from "../dashboard/worker.ts";

test("canonical GitHub App signer emits a verifiable RS256 JWT", async () => {
  const originalNow = Date.now;
  const now = 1_800_000_000_000;
  Date.now = () => now;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  try {
    const jwt = await signGithubAppJwt("Iv23canonical", privateKey);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
    assert.deepEqual(decodeJwtPart(encodedHeader), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(decodeJwtPart(encodedPayload), {
      iat: now / 1_000 - 60,
      exp: now / 1_000 + 540,
      iss: "Iv23canonical",
    });
    assert.equal(
      verifySignature(
        "RSA-SHA256",
        `${encodedHeader}.${encodedPayload}`,
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
      ),
      true,
    );
  } finally {
    Date.now = originalNow;
  }
});

test("canonical GitHub App signer converts PKCS1 private keys to PKCS8", async () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1Pem = keyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const expectedPkcs8 = keyPair.privateKey.export({ type: "pkcs8", format: "der" });

  assert.deepEqual(Buffer.from(pemToPkcs8(pkcs1Pem)), expectedPkcs8);
  const jwt = await signGithubAppJwt("Iv23pkcs1", pkcs1Pem);
  const [header, payload, signature] = jwt.split(".");
  assert.equal(
    verifySignature(
      "RSA-SHA256",
      `${header}.${payload}`,
      keyPair.publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );

  const imported = createPrivateKey({
    key: Buffer.from(pemToPkcs8(pkcs1Pem)),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(imported.asymmetricKeyType, "rsa");
});

test("worker GitHub App call sites preserve plain error messages", async () => {
  const originalFetch = globalThis.fetch;
  const originalAbortSignalTimeout = AbortSignal.timeout;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const fetchFailure = new TypeError("fetch failed");
  const abortFailure = new DOMException("request aborted", "AbortError");
  const failures = [
    {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException("request timed out", "AbortError");
      },
      abortSignalTimeout: (() => AbortSignal.abort("timeout")) as typeof AbortSignal.timeout,
      message: "GitHub App installation timed out",
      constructor: Error,
    },
    {
      fetch: async () => {
        throw fetchFailure;
      },
      message: "fetch failed",
      constructor: TypeError,
      original: fetchFailure,
    },
    {
      fetch: async () => {
        throw abortFailure;
      },
      message: "request aborted",
      constructor: DOMException,
      original: abortFailure,
    },
    {
      fetch: async () =>
        new Response(JSON.stringify({ message: "upstream unavailable" }), { status: 503 }),
      message: "GitHub App installation 503",
      constructor: Error,
    },
    {
      fetch: async () => new Response("not-json", { status: 200 }),
      message: `Unexpected token 'o', "not-json" is not valid JSON`,
      constructor: SyntaxError,
    },
  ];

  try {
    for (const failure of failures) {
      globalThis.fetch = failure.fetch;
      AbortSignal.timeout = failure.abortSignalTimeout || originalAbortSignalTimeout;
      await assert.rejects(
        worker.fetch(workerGithubWebhookRequest(), {
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23worker-errors",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
          CLAWSWEEPER_WEBHOOK_SECRET: "worker-error-test",
        }),
        (error: Error) => {
          assert.equal(error.constructor, failure.constructor);
          assert.equal(error.message, failure.message);
          if (failure.original) assert.equal(error, failure.original);
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalAbortSignalTimeout;
  }
});

function decodeJwtPart(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function workerGithubWebhookRequest() {
  const payload = {
    action: "created",
    repository: {
      full_name: "openclaw/gogcli",
      default_branch: "trunk",
      private: false,
      archived: false,
      fork: false,
      has_issues: true,
    },
    issue: { number: 597, user: { login: "steipete" } },
    installation: { id: 123 },
    comment: {
      id: 456,
      body: "@clawsweeper review",
      author_association: "OWNER",
      user: { login: "steipete" },
    },
  };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", "worker-error-test").update(body).digest("hex");
  return new Request("https://clawsweeper.openclaw.ai/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": "worker-error-shape",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}
