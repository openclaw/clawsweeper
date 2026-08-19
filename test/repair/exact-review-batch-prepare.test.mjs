import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBoundedPool } from "../../scripts/prepare-exact-review-batch.mjs";
import {
  packExactReviewBundle,
  unpackExactReviewBundle,
} from "../../scripts/exact-review-artifact-cache.mjs";

test("bounded preparation pool respects the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
  assert.deepEqual(result.results, [2, 4, 6, 8, 10]);
});

test("batch preparation copies canonical records without cloning git state", () => {
  const source = readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8");
  assert.match(source, /cpSync\(recordsSource, join\(root, "records"\)/);
  assert.doesNotMatch(source, /CLAWSWEEPER_STATE_DIR|stateClone|git["'], \["clone"/);
  assert.doesNotMatch(source, /pack-objects|unpack-objects|targetOid|expectedOid/);
});

test("artifact cache archive round-trips exact file bytes deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-artifact-archive-"));
  const source = join(root, "source");
  const restored = join(root, "restored");
  try {
    mkdirSync(join(source, "review"), { recursive: true });
    mkdirSync(join(source, "metadata"), { recursive: true });
    writeFileSync(join(source, "review", "42.md"), Buffer.from([0, 1, 2, 10, 255]));
    writeFileSync(join(source, "metadata", "bundle.json"), '{"version":2}\n');
    const first = packExactReviewBundle(source);
    const second = packExactReviewBundle(source);
    assert.deepEqual(first, second);
    unpackExactReviewBundle(first, restored);
    assert.deepEqual(
      readFileSync(join(restored, "review", "42.md")),
      Buffer.from([0, 1, 2, 10, 255]),
    );
    assert.equal(
      readFileSync(join(restored, "metadata", "bundle.json"), "utf8"),
      '{"version":2}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact cache archive rejects corrupted bytes before writing a bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-artifact-corrupt-"));
  const source = join(root, "source");
  const restored = join(root, "restored");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "bundle.txt"), "authoritative bytes\n");
    const archive = packExactReviewBundle(source);
    archive[archive.length - 1] ^= 0xff;
    assert.throws(() => unpackExactReviewBundle(archive, restored), /file digest mismatch/);
    assert.equal(readFileSync(source + "/bundle.txt", "utf8"), "authoritative bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
