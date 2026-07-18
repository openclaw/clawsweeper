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
