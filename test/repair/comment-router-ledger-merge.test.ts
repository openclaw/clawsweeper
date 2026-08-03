import assert from "node:assert/strict";
import test from "node:test";

import { mergeCommentRouterLedgers } from "../../dist/repair/comment-router-ledger-merge.js";

test("comment router ledger merge preserves disjoint concurrent commands", () => {
  const local = ledger([
    command("base", "2026-07-18T22:00:00Z"),
    command("local", "2026-07-18T22:10:31Z"),
  ]);
  const remote = ledger([
    command("base", "2026-07-18T22:00:00Z"),
    command("remote", "2026-07-18T22:10:32Z"),
  ]);

  const merged = JSON.parse(mergeCommentRouterLedgers(local, remote));

  assert.deepEqual(
    merged.commands.map((entry: { comment_version_key: string }) => entry.comment_version_key),
    ["base", "local", "remote"],
  );
});

test("comment router ledger merge keeps terminal progress for the same command", () => {
  const claimed = { ...command("same", "2026-07-18T22:10:31Z"), status: "claimed" };
  const executed = { ...claimed, status: "executed", processed_at: "2026-07-18T22:10:32Z" };

  const merged = JSON.parse(mergeCommentRouterLedgers(ledger([claimed]), ledger([executed])));

  assert.equal(merged.commands[0].status, "executed");
});

test("concurrent ledger merges retain the verified delivery for the exact comment body", () => {
  const identified = {
    ...command("same", "2026-07-18T22:10:31Z"),
    repo: "openclaw/openclaw",
    comment_body_sha256: "a".repeat(64),
    source_delivery_id: "github-original-delivery",
    status: "claimed",
  };
  const { source_delivery_id: _sourceDeliveryId, ...scheduledIdentity } = identified;
  const scheduled = {
    ...scheduledIdentity,
    status: "waiting",
    processed_at: "2026-07-18T22:10:32Z",
  };

  for (const [first, second] of [
    [ledger([identified]), ledger([scheduled])],
    [ledger([scheduled]), ledger([identified])],
  ]) {
    const merged = JSON.parse(mergeCommentRouterLedgers(first, second));
    assert.equal(merged.commands[0].status, "waiting");
    assert.equal(merged.commands[0].source_delivery_id, "github-original-delivery");
  }

  const changedBody = { ...scheduled, comment_body_sha256: "b".repeat(64) };
  assert.equal(
    JSON.parse(mergeCommentRouterLedgers(ledger([identified]), ledger([changedBody]))).commands[0]
      .source_delivery_id,
    undefined,
  );
});

test("concurrent comment delivery merges converge regardless of grouping", () => {
  const base = {
    ...command("same", "2026-07-18T22:10:31Z"),
    repo: "openclaw/openclaw",
    comment_body_sha256: "a".repeat(64),
  };
  const variants = ["claimed", "waiting", "skipped", "executed"].flatMap((status) =>
    [undefined, "a".repeat(64), "b".repeat(64)].flatMap((bodySha256) =>
      [undefined, "delivery-a", "delivery-b"].map((sourceDeliveryId) => ({
        ...base,
        status,
        ...(bodySha256 === undefined
          ? { comment_body_sha256: undefined }
          : { comment_body_sha256: bodySha256 }),
        ...(sourceDeliveryId ? { source_delivery_id: sourceDeliveryId } : {}),
      })),
    ),
  );

  for (const first of variants) {
    for (const second of variants) {
      assert.equal(
        mergeCommentRouterLedgers(ledger([first]), ledger([second])),
        mergeCommentRouterLedgers(ledger([second]), ledger([first])),
      );
      for (const third of variants) {
        assert.equal(
          mergeCommentRouterLedgers(
            mergeCommentRouterLedgers(ledger([first]), ledger([second])),
            ledger([third]),
          ),
          mergeCommentRouterLedgers(
            ledger([first]),
            mergeCommentRouterLedgers(ledger([second]), ledger([third])),
          ),
        );
      }
    }
  }
});

test("conflicting comment bodies permanently discard delivery provenance", () => {
  const first = {
    ...command("same", "2026-07-18T22:10:31Z"),
    repo: "openclaw/openclaw",
    comment_body_sha256: "a".repeat(64),
    source_delivery_id: "delivery-a",
    status: "claimed",
  };
  const incompatible = {
    ...first,
    comment_body_sha256: "b".repeat(64),
    status: "waiting",
  };
  const later = {
    ...first,
    status: "executed",
  };

  for (const merged of [
    mergeCommentRouterLedgers(
      mergeCommentRouterLedgers(ledger([first]), ledger([incompatible])),
      ledger([later]),
    ),
    mergeCommentRouterLedgers(
      ledger([first]),
      mergeCommentRouterLedgers(ledger([incompatible]), ledger([later])),
    ),
  ]) {
    const entry = JSON.parse(merged).commands[0];
    assert.equal(entry.status, "executed");
    assert.equal(entry.source_delivery_id, undefined);
    assert.equal(entry.source_delivery_conflict, true);
  }
});

test("comment router ledger merge never regresses executed evidence to a later skip", () => {
  const executed = { ...command("same", "2026-07-18T22:10:31Z"), status: "executed" };
  const skipped = { ...executed, status: "skipped", processed_at: "2026-07-18T22:10:32Z" };

  const merged = JSON.parse(mergeCommentRouterLedgers(ledger([executed]), ledger([skipped])));

  assert.equal(merged.commands[0].status, "executed");
});

test("comment router ledger merge compacts by durable processing time", () => {
  const old = Array.from({ length: 1000 }, (_, index) =>
    command(
      `old-${index}`,
      `2026-07-18T21:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    ),
  );
  const recent = command("resume", "2026-07-18T22:10:31Z");

  const merged = JSON.parse(mergeCommentRouterLedgers(ledger([...old, recent]), ledger(old)));

  assert.equal(merged.commands.length, 1000);
  assert.equal(
    merged.commands.some(
      (entry: { comment_version_key: string }) => entry.comment_version_key === "resume",
    ),
    true,
  );
});

function ledger(commands: Record<string, unknown>[]): string {
  return JSON.stringify({ updated_at: "2026-07-18T22:10:32Z", commands });
}

function command(key: string, processedAt: string): Record<string, unknown> {
  return {
    comment_version_key: key,
    comment_id: key,
    comment_updated_at: processedAt,
    status: "executed",
    processed_at: processedAt,
  };
}
