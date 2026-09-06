import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  REVIEW_PROOF_PRODUCER_ENDPOINT,
  verifyReviewProofProducerToken,
} from "../dashboard/review-proof-producer-auth.ts";

test("producer OIDC verifies GitHub signature and exact workflow/run identity", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.now();
  const expected = {
    repositoryId: "123",
    workflowPath: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    workflowSha: "a".repeat(40),
    runId: "456",
    runAttempt: 1,
  };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: REVIEW_PROOF_PRODUCER_ENDPOINT,
    repository: "openclaw/openclaw",
    repository_id: "123",
    event_name: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: expected.workflowSha,
    workflow_sha: expected.workflowSha,
    workflow_ref: "openclaw/openclaw/" + expected.workflowPath + "@refs/heads/main",
    run_id: "456",
    run_attempt: "1",
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 300,
  };
  const token = (overrides = {}, algorithm = "RS256") => {
    const encoded = [
      { alg: algorithm, kid: "test" },
      { ...claims, ...overrides },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return (
      encoded + "." + sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")
    );
  };
  const fetcher = (async (url: string) => {
    assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
    return Response.json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" }],
    });
  }) as typeof fetch;
  assert.equal(
    await verifyReviewProofProducerToken(token(), expected, { now, fetch: fetcher }),
    true,
  );
  for (const mismatch of [
    { aud: "wrong" },
    { repository_id: "999" },
    { run_id: "999" },
    { run_attempt: "2" },
    { workflow_sha: "b".repeat(40) },
    { ref: "refs/heads/candidate" },
    { event_name: "pull_request" },
    { job_workflow_ref: "openclaw/openclaw/.github/workflows/other.yml@refs/heads/main" },
    { job_workflow_sha: "b".repeat(40) },
    { iat: Math.floor(now / 1000) - 601 },
    { nbf: Math.floor(now / 1000) + 31 },
    { exp: Math.floor(now / 1000) + 601 },
    { exp: Math.floor(now / 1000) - 1 },
  ]) {
    assert.equal(
      await verifyReviewProofProducerToken(token(mismatch), expected, { now, fetch: fetcher }),
      false,
    );
  }
  assert.equal(
    await verifyReviewProofProducerToken(token({}, "none"), expected, { now, fetch: fetcher }),
    false,
  );
  const forged = token().slice(0, -6) + "abcdef";
  assert.equal(
    await verifyReviewProofProducerToken(forged, expected, { now, fetch: fetcher }),
    false,
  );
});
