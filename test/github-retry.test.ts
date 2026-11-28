import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRateLimitError, ghCommandError, ghRetryKind } from "../dist/github-retry.js";

test("request text cannot turn a child-process failure into a retry or supply retry hints", () => {
  const message =
    "Command failed: gh api repos/acme/example/issues/comments/42 --method PATCH -f body=Review of rate limit handling.\nRetry-After: 9999\nHTTP 503: Service unavailable";
  const makeFailure = (stderr: Buffer | string, stdout = "") =>
    Object.assign(new Error(message), { status: 1, stderr, stdout });

  assert.equal(ghRetryKind(makeFailure(Buffer.from("gh: Forbidden (HTTP 403)"))), "none");
  assert.equal(ghRetryKind(makeFailure("")), "none");
  assert.equal(ghRetryKind(new Error(message)), "none");
  assert.equal(ghRetryKind(makeFailure("gh: Bad Gateway (HTTP 502)")), "transient");
  assert.equal(ghRetryKind(Object.assign(makeFailure(""), { code: "ETIMEDOUT" })), "transient");

  const now = Date.parse("2026-08-05T10:00:00Z");
  const throttled = makeFailure("gh: secondary rate limit (HTTP 403)", "Retry-After: 120");
  assert.equal(ghRetryKind(throttled), "throttle");
  const limit = new GitHubRateLimitError(throttled, now);
  assert.equal(limit.retryAt, "2026-08-05T10:02:00.000Z");
  assert.doesNotMatch(limit.message, /Review of rate limit handling|9999/);
});

test("spawned gh commands retain their response when only stdout carries a diagnostic", () => {
  const error = ghCommandError({
    status: 1,
    stdout: '{"message":"API rate limit exceeded"}',
    stderr: "",
  });
  assert.equal(ghRetryKind(error), "throttle");
});
