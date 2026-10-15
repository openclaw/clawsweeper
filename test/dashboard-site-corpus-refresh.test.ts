import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CORPUS_REFRESH_INTERVAL_MS,
  corpusNeedsRefresh,
  selectCorpusRefresh,
} from "../dashboard-site/scripts/corpus-refresh.ts";

test("corpus refresh requires an initial, expired, invalid, future, or requested snapshot", () => {
  const now = Date.parse("2026-10-15T06:00:00Z");
  const cache = (generatedAt: unknown, version = 2) => ({ version, generatedAt });
  assert.equal(corpusNeedsRefresh(cache(new Date(now).toISOString()), false, now), false);
  assert.equal(
    corpusNeedsRefresh(
      cache(new Date(now - CORPUS_REFRESH_INTERVAL_MS + 1).toISOString()),
      false,
      now,
    ),
    false,
  );
  for (const corpus of [
    undefined,
    null,
    [],
    cache(new Date(now).toISOString(), 1),
    cache(undefined),
    cache("invalid"),
    cache(now),
    cache(new Date(now + 1).toISOString()),
    cache(new Date(now - CORPUS_REFRESH_INTERVAL_MS).toISOString()),
  ]) {
    assert.equal(corpusNeedsRefresh(corpus, false, now), true);
  }
  assert.equal(corpusNeedsRefresh(cache(new Date(now).toISOString()), true, now), true);
});

test("workflow refresh selector emits real GitHub outputs and refuses filesystem failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-corpus-refresh-"));
  const corpusPath = path.join(root, "corpus.json");
  const run = (force = false) =>
    execFileSync(
      process.execPath,
      ["dashboard-site/scripts/corpus-refresh.ts", corpusPath, String(force)],
      {
        encoding: "utf8",
      },
    );
  try {
    assert.equal(run(), "refresh=true\n");
    await writeFile(corpusPath, "{bad JSON");
    assert.equal(run(), "refresh=true\n");
    await writeFile(
      corpusPath,
      JSON.stringify({ version: 2, generatedAt: new Date().toISOString() }),
    );
    assert.equal(run(), "refresh=false\n");
    assert.equal(run(true), "refresh=true\n");
    await writeFile(
      corpusPath,
      JSON.stringify({
        version: 2,
        generatedAt: new Date(Date.now() - CORPUS_REFRESH_INTERVAL_MS).toISOString(),
      }),
    );
    assert.equal(run(), "refresh=true\n");
    await assert.rejects(selectCorpusRefresh(root), { code: "EISDIR" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
