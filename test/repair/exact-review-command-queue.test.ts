import assert from "node:assert/strict";
import test from "node:test";
import {
  postExactReviewCommandIntake,
  postExactReviewCommandIntakeSync,
} from "../../dist/repair/exact-review-command-queue.js";
import { startIntakeFixture } from "../helpers/command-intake-fixture.mjs";

for (const [mode, invoke] of [
  ["sync", postExactReviewCommandIntakeSync],
  ["async", postExactReviewCommandIntake],
] as const) {
  test(`${mode} intake preserves signed admission and closed HTTP diagnostics`, async (t) => {
    const fixture = await startIntakeFixture();
    t.after(() => fixture.close());
    const commandVersionId = fixture.options.intake.commandVersionId;
    for (const [status, code, suffix] of [
      [503, "target_visibility_unverified", ": target_visibility_unverified"],
      [422, "private_target_unsupported", ": private_target_unsupported"],
      [503, "synthetic_private_token", ""],
    ] as const) {
      await t.test(`HTTP ${status} ${code}`, async () => {
        await fixture.setResponse(status, {
          error: code,
          retryable: true,
          message: "synthetic-private-sentinel",
        });
        await assert.rejects(async () => invoke(fixture.options), {
          message: `exact-review command intake failed (HTTP ${status})${suffix}`,
        });
        await assertSignedOnce(fixture);
      });
    }
    for (const deduped of [false, true]) {
      await fixture.setResponse(202, {
        ok: true,
        accepted: true,
        deduped,
        command_version_id: commandVersionId,
      });
      assert.deepEqual(await invoke(fixture.options), {
        kind: "accepted",
        deduped,
        commandVersionId,
      });
      await assertSignedOnce(fixture);
    }
    await fixture.setResponse(202, {
      ok: true,
      accepted: false,
      reason: "superseded",
      command_version_id: commandVersionId,
    });
    assert.deepEqual(await invoke(fixture.options), {
      kind: "stale",
      reason: "superseded",
      commandVersionId,
    });
    await assertSignedOnce(fixture);
    await fixture.setResponse(202, null);
    await assert.rejects(async () => invoke(fixture.options), {
      message: "exact-review command intake returned an invalid result",
    });
    await assertSignedOnce(fixture);
    for (const close of [true, "partial"]) {
      await fixture.setResponse(
        202,
        {
          ok: true,
          accepted: true,
          deduped: false,
          command_version_id: commandVersionId,
        },
        close,
      );
      await assert.rejects(async () => invoke(fixture.options));
      await assertSignedOnce(fixture);
    }
  });
}

test("intake omits malformed and over-bound diagnostics", async (t) => {
  const fixture = await startIntakeFixture();
  t.after(() => fixture.close());
  for (const body of [
    "{",
    null,
    [],
    123,
    { error: 123 },
    { error: "https://private.example.test/token" },
    "synthetic-private-sentinel",
  ]) {
    await fixture.setResponse(503, body);
    await assert.rejects(postExactReviewCommandIntake(fixture.options), {
      message: "exact-review command intake failed (HTTP 503)",
    });
    await assertSignedOnce(fixture);
  }
  // UTF-8 reaches the byte cap while the JSON is still fewer than 512 characters.
  const body = JSON.stringify({
    padding: "\u00e9".repeat(230),
    error: "target_visibility_unverified",
  });
  assert.ok(body.length < 512 && Buffer.byteLength(body) > 512);
  for (const invoke of [postExactReviewCommandIntakeSync, postExactReviewCommandIntake]) {
    await fixture.setResponse(503, body);
    await assert.rejects(async () => invoke(fixture.options), {
      message: "exact-review command intake failed (HTTP 503)",
    });
    await assertSignedOnce(fixture);
    const code = JSON.stringify({ error: "target_visibility_unverified" });
    await fixture.setResponse(503, code.padStart(512));
    await assert.rejects(async () => invoke(fixture.options), {
      message: "exact-review command intake failed (HTTP 503): target_visibility_unverified",
    });
    await assertSignedOnce(fixture);
  }
});

async function assertSignedOnce(fixture) {
  const requests = await fixture.requests();
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/exact-review/command-intake",
      signed: true,
      body: JSON.stringify(fixture.options.intake),
    },
  ]);
}
