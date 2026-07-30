import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  coverageTrackedCountsFromManifest,
  coverageTrackedItemIdsFromManifest,
  WORKER_RECORDS_MANIFEST_SCHEMA_VERSION,
} from "../dist/review-coverage-manifest.js";

test("coverage manifest exposes exact canonical identities and fleet counts", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-coverage-manifest-"));
  const manifest = join(root, "worker-records-manifest.json");
  try {
    writeFileSync(
      manifest,
      `${JSON.stringify({
        schemaVersion: WORKER_RECORDS_MANIFEST_SCHEMA_VERSION,
        source: "worker",
        repositories: {
          "openclaw-openclaw": { coverageTrackedItemIds: [1, 5, 9] },
          "openclaw-clawsweeper": { coverageTrackedItemIds: [2] },
        },
      })}\n`,
    );

    assert.deepEqual(
      [...coverageTrackedItemIdsFromManifest(manifest, "openclaw-openclaw")],
      [1, 5, 9],
    );
    assert.deepEqual(
      coverageTrackedCountsFromManifest(manifest),
      new Map([
        ["openclaw-openclaw", 3],
        ["openclaw-clawsweeper", 1],
      ]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage manifest rejects duplicate canonical identities", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-coverage-manifest-"));
  const manifest = join(root, "worker-records-manifest.json");
  try {
    writeFileSync(
      manifest,
      `${JSON.stringify({
        schemaVersion: WORKER_RECORDS_MANIFEST_SCHEMA_VERSION,
        source: "worker",
        repositories: {
          "openclaw-openclaw": { coverageTrackedItemIds: [1, 1] },
        },
      })}\n`,
    );

    assert.throws(
      () => coverageTrackedItemIdsFromManifest(manifest, "openclaw-openclaw"),
      /invalid coverage identities/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
