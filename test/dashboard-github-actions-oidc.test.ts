import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  verifiedGithubActionsOidcClaims,
} from "../dashboard/github-actions-oidc.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };
const now = Date.now();
const seconds = Math.floor(now / 1000);
const audience = "https://example.invalid/dispatch";
const claims = {
  iss: GITHUB_ACTIONS_OIDC_ISSUER,
  aud: audience,
  iat: seconds,
  nbf: seconds,
  exp: seconds + 300,
};

function token(claimOverrides = {}, headerOverrides = {}) {
  const encoded = [
    { alg: "RS256", kid: "test", ...headerOverrides },
    { ...claims, ...claimOverrides },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return encoded + "." + sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url");
}

const validFetch = (async () => Response.json({ keys: [jwk] })) as typeof fetch;

test("OIDC verifier returns verified claims", async () => {
  assert.deepEqual(
    await verifiedGithubActionsOidcClaims(token(), audience, () => true, {
      now,
      fetch: validFetch,
    }),
    { ok: true, claims },
  );
});

test("OIDC verifier reports JWKS infrastructure failures as unavailable", async (t) => {
  const cases: Array<[string, () => Promise<Response> | Response]> = [
    [
      "fetch throws",
      () => {
        throw new TypeError("network failure");
      },
    ],
    ["HTTP 500", () => new Response("unavailable", { status: 500 })],
    ["HTTP redirect", () => new Response(null, { status: 302 })],
    ["HTTP 404", () => new Response(null, { status: 404 })],
    ["malformed JSON", () => new Response("{broken")],
    ["missing kid", () => Response.json({ keys: [{ ...jwk, kid: "rotated" }] })],
    ["missing key set", () => Response.json({})],
    ["invalid key set", () => Response.json({ keys: [null] })],
    ["invalid matching key", () => Response.json({ keys: [{ kid: "test", kty: "RSA" }] })],
    ["duplicate matching keys", () => Response.json({ keys: [jwk, jwk] })],
    ["too many keys", () => Response.json({ keys: Array.from({ length: 21 }, () => jwk) })],
    ["oversized body", () => new Response(" ".repeat(65_537))],
    [
      "oversized content length",
      () => new Response("{}", { headers: { "content-length": "65537" } }),
    ],
    ["missing body", () => new Response(null)],
    [
      "body read fails",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
        ),
    ],
  ];
  for (const [name, fetchResponse] of cases) {
    await t.test(name, async () => {
      assert.deepEqual(
        await verifiedGithubActionsOidcClaims(token(), audience, () => true, {
          now,
          fetch: fetchResponse as typeof fetch,
        }),
        { ok: false, reason: "unavailable" },
      );
    });
  }
});

test("OIDC verifier reports its actual fetch deadline as unavailable", async () => {
  // Keep the process alive: AbortSignal.timeout itself uses an unref'ed timer.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const fetchUntilAbort = (async (_input, init) => {
      assert.ok(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    assert.deepEqual(
      await verifiedGithubActionsOidcClaims(token(), audience, () => true, {
        now,
        fetch: fetchUntilAbort,
      }),
      { ok: false, reason: "unavailable" },
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("OIDC verifier rejects token defects before fetching keys", async () => {
  const noFetch = (() => {
    assert.fail("invalid token must not fetch keys");
  }) as typeof fetch;
  const valid = token();
  const defects = [
    "",
    "x".repeat(16_385),
    "one.two",
    "one.two.three.four",
    "invalid!.payload.signature",
    `e30.${valid.split(".")[1]}.YQ`,
    `${valid.split(".").slice(0, 2).join(".")}.A`,
    token({}, { alg: "HS256" }),
    token({}, { kid: 1 }),
    token({}, { kid: "x".repeat(201) }),
    token({}, { crit: ["extension"] }),
    token({ iss: "https://example.invalid" }),
    token({ aud: "other" }),
    token({ exp: seconds }),
    token({ exp: "later" }),
    token({ iat: "now" }),
    token({ nbf: "now" }),
    token({ nbf: seconds + 60 }),
    token({ iat: seconds + 60 }),
    token({ exp: seconds + 601 }),
    token({ iat: seconds - 601 }),
  ];
  for (const value of defects) {
    assert.deepEqual(
      await verifiedGithubActionsOidcClaims(value, audience, () => true, { now, fetch: noFetch }),
      { ok: false, reason: "rejected" },
    );
  }
  assert.deepEqual(
    await verifiedGithubActionsOidcClaims(valid, audience, () => false, { now, fetch: noFetch }),
    { ok: false, reason: "rejected" },
  );
});

test("OIDC verifier rejects signature mismatch with a found key", async () => {
  const parts = token().split(".");
  parts[2] = Buffer.alloc(256).toString("base64url");
  assert.deepEqual(
    await verifiedGithubActionsOidcClaims(parts.join("."), audience, () => true, {
      now,
      fetch: validFetch,
    }),
    { ok: false, reason: "rejected" },
  );
});
