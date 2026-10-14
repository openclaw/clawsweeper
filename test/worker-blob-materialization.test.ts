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

import { WorkerBlobsUnavailableError, materializeStateBlobs } from "../scripts/worker-blobs.ts";

const firstPath = "assets/first.jsonl";
const secondPath = "assets/second.json";
const content = Buffer.from("synthetic ledger event\n");
const digest = createHash("sha256").update(content).digest("hex");

test("blob hydration stages each page before listing the next and reuses its digest cache", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-stream-"));
  let downloads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/list")) {
      if (request.prefix === "ledger/v1/") return Response.json({ blobs: [], nextCursor: null });
      if (request.cursor) {
        assert.equal(request.cursor, "second-page");
        assert.equal(readFileSync(stagedPath(root, firstPath), "utf8"), content.toString());
        return Response.json({ blobs: [descriptor(secondPath)], nextCursor: null });
      }
      return Response.json({ blobs: [descriptor(firstPath)], nextCursor: "second-page" });
    }
    assert.ok(String(input).endsWith("/chunk"));
    downloads += 1;
    return chunk();
  };
  try {
    const options = {
      baseUrl: "https://worker.example",
      webhookSecret: "fixture",
      fetch,
      worktreeRoot: root,
    };
    const first = await materializeStateBlobs(options);
    assert.equal(first.blobs, 2);
    assert.equal(first.bytes, content.byteLength * 2);
    assert.equal(first.downloads, 1);
    assert.equal(first.cacheHits, 1);
    assert.deepEqual(first.trees, { "ledger/v1": 0, assets: 2 });
    assert.equal(readFileSync(path.join(root, firstPath), "utf8"), content.toString());
    assert.equal(readFileSync(path.join(root, secondPath), "utf8"), content.toString());

    const cached = await materializeStateBlobs(options);
    assert.equal(cached.downloads, 0);
    assert.equal(cached.cacheHits, 2);
    assert.equal(downloads, 1);
    const manifest = JSON.parse(readFileSync(cached.manifestPath, "utf8"));
    assert.equal(manifest.blobs, 2);
    assert.equal(manifest.cacheHits, 2);
    assert.deepEqual(stagingDirectories(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later blob list failure preserves the previous trees and manifest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-failed-page-"));
  const existing = path.join(root, "ledger", "existing.json");
  const manifest = path.join(root, ".artifacts", "worker-blobs-manifest.json");
  mkdirSync(path.dirname(existing), { recursive: true });
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(existing, "previous ledger");
  writeFileSync(manifest, "previous manifest");
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(input).endsWith("/chunk")) return chunk();
    assert.ok(String(input).endsWith("/list"));
    if (request.cursor) {
      assert.equal(readFileSync(stagedPath(root, firstPath), "utf8"), content.toString());
      assert.equal(readFileSync(existing, "utf8"), "previous ledger");
      return Response.json({ error: "invalid_blob_cursor" }, { status: 400 });
    }
    return Response.json({ blobs: [descriptor(firstPath)], nextCursor: "second-page" });
  };
  try {
    await assert.rejects(
      materializeStateBlobs({
        baseUrl: "https://worker.example",
        webhookSecret: "fixture",
        fetch,
        worktreeRoot: root,
      }),
      /invalid_blob_cursor/,
    );
    assert.equal(readFileSync(existing, "utf8"), "previous ledger");
    assert.equal(readFileSync(manifest, "utf8"), "previous manifest");
    assert.equal(existsSync(path.join(root, firstPath)), false);
    assert.deepEqual(stagingDirectories(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty blob hydration refuses cutover and removes its staging directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "clawsweeper-blob-empty-"));
  const existing = path.join(root, "assets", "existing.svg");
  mkdirSync(path.dirname(existing), { recursive: true });
  writeFileSync(existing, "previous asset");
  try {
    await assert.rejects(
      materializeStateBlobs({
        baseUrl: "https://worker.example",
        webhookSecret: "fixture",
        worktreeRoot: root,
        fetch: async () => Response.json({ blobs: [], nextCursor: null }),
      }),
      (error: unknown) =>
        error instanceof WorkerBlobsUnavailableError && error.reason === "blobs_not_found",
    );
    assert.equal(readFileSync(existing, "utf8"), "previous asset");
    assert.deepEqual(stagingDirectories(root), []);
    assert.equal(existsSync(path.join(root, ".artifacts", "worker-blobs-manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function descriptor(blobPath: string) {
  return { path: blobPath, bytes: content.byteLength, digest, digestVerified: true };
}

function chunk() {
  return new Response(content, {
    status: 206,
    headers: { "content-range": `bytes 0-${content.byteLength - 1}/${content.byteLength}` },
  });
}

function stagingDirectories(root: string) {
  return readdirSync(root).filter((name) => name.startsWith(".worker-blobs-stage-"));
}

function stagedPath(root: string, blobPath: string) {
  const staging = stagingDirectories(root);
  assert.equal(staging.length, 1);
  return path.join(root, staging[0]!, blobPath);
}
