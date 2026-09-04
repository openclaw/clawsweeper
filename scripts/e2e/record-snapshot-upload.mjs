#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  materializeWorkerRecords,
  signedPost,
  uploadWorkerRecordSnapshot,
} from "../worker-records.ts";

const baseUrl = process.env.SNAPSHOT_PROOF_URL;
if (!baseUrl?.startsWith("http://127.0.0.1:"))
  throw new Error("SNAPSHOT_PROOF_URL must be an isolated loopback Worker");
const webhookSecret = "synthetic-snapshot-proof-secret";
const repoSlug = "fixture-record-snapshot";
const root = mkdtempSync(path.join(tmpdir(), "snapshot-runtime-proof-"));
const expected = new Map();
const post = (endpoint, body) => signedPost({ baseUrl, webhookSecret, path: endpoint, body });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function publish(id, entries, revision = 1) {
  const operations = ["items", "closed", "plans", "decision-packets"].map((section) => {
    const relativePath = `${section}/${id}${section === "decision-packets" ? ".json" : ".md"}`;
    const previous = expected.get(relativePath);
    const content = entries[section];
    const operation = {
      path: `records/${repoSlug}/${relativePath}`,
      expectedDigest: previous === undefined ? null : sha256(previous),
      ...(content === undefined ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
    };
    if (content === undefined) expected.delete(relativePath);
    else expected.set(relativePath, Buffer.from(content));
    return operation;
  });
  const result = await post("/internal/state/records/tuples", {
    deliveryId: `proof-${id}-${revision}`,
    key: `${repoSlug}/${id}`,
    operations,
  });
  assert.equal(result.ok, true);
}
async function verifyTree(name) {
  const restored = await materializeWorkerRecords({
    baseUrl,
    webhookSecret,
    repoSlugs: [repoSlug],
    worktreeRoot: path.join(root, name),
    log: () => {},
  });
  assert.equal(restored.repositories[repoSlug].recordCount, expected.size);
  for (const [relativePath, bytes] of expected)
    assert.deepEqual(
      readFileSync(path.join(restored.recordsRoot, repoSlug, relativePath)),
      bytes,
      relativePath,
    );
  return restored.repositories[repoSlug];
}
try {
  const packet = '{"result":"keep"}\n';
  await publish(1, {
    items: `---\ndecision_packet_sha256: ${sha256(packet)}\ndecision_packet_path: records/${repoSlug}/decision-packets/1.json\n---\n# Unicode 🦞\r\n`,
    plans: "",
    "decision-packets": packet,
  });
  await publish(2, { closed: "Closed\n" });
  const commit = "a".repeat(40);
  const commitContent = "Commit\n";
  await post("/internal/state/records/commits", {
    repo_slug: repoSlug,
    records: [{ sha: commit, content: commitContent, digest: sha256(commitContent) }],
  });
  expected.set(`commits/${commit}.md`, Buffer.from(commitContent));
  for (let id = 10; id < 58; id++)
    await publish(id, { items: randomBytes(192 * 1024).toString("base64") });
  const firstRevision = (await post("/internal/state/records/export", { repoSlug, limit: 1 }))
    .revision;
  const run = await promisify(execFile)(
    process.execPath,
    [
      "scripts/worker-records.ts",
      "snapshot-upload",
      "--repo-slug",
      repoSlug,
      "--records-url",
      baseUrl,
    ],
    {
      env: {
        ...process.env,
        CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
        CLAWSWEEPER_RECORDS_SECRET: webhookSecret,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const first = JSON.parse(run.stdout.trim());
  assert.ok(first.bytes > 6 * 1024 * 1024, "proof must exercise more than one R2 part");
  assert.equal(first.revisionWatermark, firstRevision);
  assert.equal(first.fileCount, expected.size);
  const firstRestore = await verifyTree("first");
  assert.equal(firstRestore.deltaRecords, 0);
  await publish(1, { items: "Updated after first snapshot\n", plans: "" }, 2);
  await publish(2, {}, 2);
  let lost = false;
  const partBodies = [];
  const second = await uploadWorkerRecordSnapshot({
    baseUrl,
    webhookSecret,
    repoSlug,
    log: () => {},
    fetch: async (input, init) => {
      if (String(input).endsWith("/upload/part")) partBodies.push(String(init.body));
      const response = await fetch(input, init);
      if (String(input).endsWith("/upload/part") && !lost) {
        assert.ok(response.ok);
        lost = true;
        throw new TypeError("synthetic lost part response");
      }
      return response;
    },
  });
  assert.equal(partBodies[0], partBodies[1]);
  assert.ok(second.revisionWatermark > first.revisionWatermark);
  const secondRestore = await verifyTree("second");
  assert.equal(secondRestore.deltaRecords, 0);
  const unsigned = await fetch(`${baseUrl}/internal/state/records/snapshots/upload/start`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(unsigned.status, 401);
  console.log(
    JSON.stringify(
      {
        result: "pass",
        runtime: "wrangler-local/workerd",
        repoSlug,
        first: { watermark: first.revisionWatermark, bytes: first.bytes, files: first.fileCount },
        second: {
          watermark: second.revisionWatermark,
          bytes: second.bytes,
          files: second.fileCount,
        },
        exactByteRestore: true,
        updateAndDeletion: true,
        multipartRetrySameBytes: true,
        unsigned: unsigned.status,
        limits: "Local R2/DO runtime, synthetic data; no production scale or network claim.",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
