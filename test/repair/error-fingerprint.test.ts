import assert from "node:assert/strict";
import test from "node:test";

import {
  errorFingerprint,
  errorFingerprintDigest,
  failureFingerprint,
} from "../../dist/repair/error-fingerprint.js";

test("error fingerprint wrappers preserve their distinct wire formats", () => {
  const digest = "dd3599487ed91066c703b33178b719dcc9b548de8576047b95b06482bab7eaf6";
  const error = new Error("boom");

  assert.equal(errorFingerprintDigest(error), digest);
  assert.equal(failureFingerprint(error), digest);
  assert.equal(errorFingerprint(error), `sha256:${digest}`);
});
