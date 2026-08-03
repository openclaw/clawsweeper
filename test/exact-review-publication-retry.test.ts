import assert from "node:assert/strict";
import test from "node:test";
import {
  exactReviewPublicationRetryDelayMs,
  exactReviewPublicationRetryExhausted,
} from "../dashboard/exact-review-publication-retry.ts";

const itemKey = "openclaw/openclaw#112030@publish:30795752045:1";

test("ordinary publication failures retry within six minutes even after repeated failures", () => {
  for (const reasonCode of ["github_transient", "state_contention", "unknown_failure"]) {
    for (const kind of ["retryable_failure", "permanent_failure"]) {
      for (const attempt of [1, 2, 3, 4, 8, 12]) {
        const delay = exactReviewPublicationRetryDelayMs(itemKey, { kind, reasonCode }, attempt);
        assert.ok(delay >= 60_000, `${kind}/${reasonCode}/${attempt}: ${delay}`);
        assert.ok(delay <= 6 * 60_000, `${kind}/${reasonCode}/${attempt}: ${delay}`);
      }
    }
  }
});

test("GitHub rate limiting retains its longer protective retry ceiling", () => {
  const delay = exactReviewPublicationRetryDelayMs(
    itemKey,
    { kind: "retryable_failure", reasonCode: "github_rate_limit" },
    8,
  );
  assert.ok(delay >= 60 * 60_000);
  assert.ok(delay <= 72 * 60_000);
});

test("publication retry exhaustion preserves transient, permanent, and unknown budgets", () => {
  const now = 1_800_000_000_000;
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "retryable_failure", reasonCode: "github_transient" },
      47,
      now,
      now,
    ),
    false,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "retryable_failure", reasonCode: "github_transient" },
      48,
      now,
      now,
    ),
    true,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "permanent_failure", reasonCode: "invalid_artifact" },
      3,
      now,
      now,
    ),
    true,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "retryable_failure", reasonCode: "artifact_unavailable" },
      99,
      0,
      now,
    ),
    false,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "retryable_failure", reasonCode: "unknown_failure" },
      5,
      now,
      now,
    ),
    false,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "retryable_failure", reasonCode: "unknown_failure" },
      14,
      now,
      now,
    ),
    true,
  );
  assert.equal(
    exactReviewPublicationRetryExhausted(
      { kind: "permanent_failure", reasonCode: "unknown_failure" },
      1,
      now - 60 * 60_000,
      now,
    ),
    true,
  );
});

test("faster retries preserve the previous unknown and transient outage horizons", () => {
  const startedAt = 1_800_000_000_000;
  const elapsedUntilExhausted = (reasonCode: string): number => {
    const completion = { kind: "retryable_failure", reasonCode };
    let elapsed = 0;
    let attempt = 1;
    while (
      !exactReviewPublicationRetryExhausted(completion, attempt, startedAt, startedAt + elapsed)
    ) {
      elapsed += exactReviewPublicationRetryDelayMs(itemKey, completion, attempt);
      attempt += 1;
    }
    return elapsed;
  };

  assert.ok(elapsedUntilExhausted("unknown_failure") >= 50 * 60_000);
  assert.ok(elapsedUntilExhausted("github_transient") >= 210 * 60_000);
});
