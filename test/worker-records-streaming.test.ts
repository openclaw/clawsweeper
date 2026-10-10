import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeWorkerRecords, type WorkerRecord } from "../scripts/worker-records.ts";

const repoSlug = "streaming-fixture";

function record(id: string, storeRevision: number, content: string | null): WorkerRecord {
  return {
    section: "items",
    id,
    storeRevision,
    revision: storeRevision,
    content,
    digest: content === null ? null : createHash("sha256").update(content).digest("hex"),
    deleted: content === null,
  };
}

for (const fail of [false, true]) {
  test(`hydration writes pages before fetching more and ${fail ? "discards failed staging" : "keeps newest revisions"}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "streaming-records-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const original = path.join(root, "records", repoSlug, "items", "99.md");
    mkdirSync(path.dirname(original), { recursive: true });
    writeFileSync(original, "original");
    let page = 0;
    const result = materializeWorkerRecords({
      worktreeRoot: root,
      baseUrl: "https://worker.invalid",
      webhookSecret: "fixture",
      repoSlugs: [repoSlug],
      log: () => {},
      fetch: async (input) => {
        const endpoint = new URL(String(input)).pathname;
        if (endpoint.endsWith("/latest"))
          return Response.json({ error: "snapshot_not_found" }, { status: 404 });
        if (endpoint.endsWith("/list"))
          return Response.json({ repoSlug, section: "items", records: [], nextCursor: null });
        assert.ok(endpoint.endsWith("/export"));
        page++;
        if (page === 1)
          return Response.json({
            repoSlug,
            revision: 10,
            records: [record("1", 4, "newest"), record("2", 3, "delete me")],
            nextCursor: 1,
          });
        const stage = readdirSync(root).find((entry) => entry.startsWith(".worker-records-stage-"));
        assert.ok(stage);
        const items = path.join(root, stage, "records", repoSlug, "items");
        assert.equal(readFileSync(path.join(items, "1.md"), "utf8"), "newest");
        assert.equal(readFileSync(original, "utf8"), "original");
        if (fail) return Response.json({ error: "denied" }, { status: 403 });
        return Response.json({
          repoSlug,
          revision: 12,
          records: [
            record("1", 2, "older"),
            record("1", 4, "equal"),
            record("2", 7, null),
            record("2", 5, "stale resurrection"),
            record("3", 9, "third"),
          ],
          nextCursor: null,
        });
      },
    });
    if (fail) {
      await assert.rejects(result, /403/);
      assert.equal(readFileSync(original, "utf8"), "original");
    } else {
      const hydrated = await result;
      assert.equal(hydrated.repositories[repoSlug].deltaRecords, 3);
      assert.equal(hydrated.repositories[repoSlug].recordCount, 2);
      assert.equal(hydrated.repositories[repoSlug].exportStartRevision, 10);
      assert.equal(hydrated.repositories[repoSlug].revision, 12);
      const items = path.join(root, "records", repoSlug, "items");
      assert.equal(readFileSync(path.join(items, "1.md"), "utf8"), "newest");
      assert.equal(readFileSync(path.join(items, "3.md"), "utf8"), "third");
      assert.equal(existsSync(path.join(items, "2.md")), false);
      assert.equal(existsSync(original), false);
    }
    assert.equal(
      readdirSync(root).some((entry) => entry.startsWith(".worker-records-stage-")),
      false,
    );
  });
}
