import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (!databasePath) throw new Error("usage: seed-publication-fences.mjs <database-path>");

const publications = [
  {
    key: "steipete/CodexBar#2516",
    path: "records/steipete-codexbar/items/2516.md",
  },
  {
    key: "openclaw/openclaw#806",
    path: "records/openclaw-openclaw/items/806.md",
  },
];
const digest = createHash("sha256").update("x").digest("hex");
const database = new DatabaseSync(databasePath);
try {
  const insert = database.prepare(`
    INSERT INTO exact_review_direct_publication_plans
      (item_key, canonical_target_key, fence_key, revision, identity_item_key,
       identity_revision, claim_generation, operations_json, lifecycle_json,
       total_bytes, file_count, state, attempts, created_at, updated_at,
       next_attempt_at, commit_sha, failure_reason)
    VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?, 1, 1, 'pending', 0, 1, 1, 1, NULL, NULL)
  `);
  for (const publication of publications) {
    insert.run(
      publication.key,
      publication.key,
      publication.key,
      publication.key,
      JSON.stringify([{ path: publication.path, bytes: 1, digest, deleted: false }]),
      JSON.stringify({ kind: "policy_noop" }),
    );
  }
} finally {
  database.close();
}
