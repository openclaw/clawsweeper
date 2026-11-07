import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  SCAN_FINDING_INVENTORY_MAX_BYTES,
  SCAN_FINDING_INVENTORY_MAX_ENTRIES,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";

const file = "/staged/diagnostic-input";
const input: StagedScanInput = {
  kind: "blob",
  id: "a".repeat(40),
  bytes: Buffer.from("DIAGNOSTIC_CANARY_A\n"),
  references: [{ revision: "b".repeat(40), source: "fixture.txt", mode: "100644", role: "head" }],
};
const finding = (updates: Record<string, unknown> = {}) => ({
  DetectorType: 0,
  DecoderName: "PLAIN",
  Verified: false,
  Raw: "DIAGNOSTIC_CANARY_A",
  RawV2: "DIAGNOSTIC_CANARY_B",
  DetectorName: "UNTRUSTED_METADATA_CANARY",
  SecretParts: { value: "OMITTED_CANARY" },
  SourceMetadata: { Data: { Filesystem: { file, line: 7 } } },
  ...updates,
});
function scan(findings: Record<string, unknown>[], staged = input) {
  const verified = findings.filter((f) => f.Verified === true).length;
  const result = classifyReviewedFixtureScan(
    183,
    Buffer.from(findings.map((f) => JSON.stringify(f) + "\n").join("")),
    Buffer.from(
      JSON.stringify({
        level: "info-0",
        logger: "trufflehog",
        msg: "finished scanning",
        trufflehog_version: "3.99.4",
        chunks: 1,
        bytes: 1,
        verified_secrets: verified,
        unverified_secrets: findings.length - verified,
      }) + "\n",
    ),
    new Map([[file, staged]]),
  );
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused" || result.diagnostic.kind !== "unclassified_finding")
    throw new Error("Expected unclassified refusal");
  assert.equal(result.reason, "findings");
  return result.diagnostic;
}

test("inventory keeps original indices and safe metadata without reclassifying findings", () => {
  const diagnostic = scan([
    finding(),
    finding({ DetectorType: 17, Verified: true, DecoderName: "HTML" }),
  ]);
  assert.equal(diagnostic.findingIndex, 0);
  assert.equal(diagnostic.reason, "finding_not_reviewed");
  const inventory = diagnostic.inventory;
  assert.deepEqual(
    [
      inventory.totalCount,
      inventory.retainedCount,
      inventory.omittedCount,
      inventory.unattributedCount,
    ],
    [2, 2, 0, 0],
  );
  assert.deepEqual(
    inventory.entries.map((e) => e.findingIndex),
    [0, 1],
  );
  assert.equal(inventory.entries[1]!.detectorType, 17);
  assert.equal(inventory.entries[1]!.verified, true);
  assert.equal(inventory.entries[1]!.attributionReason, "decoded");
  for (const entry of inventory.entries) {
    assert.equal(entry.sourceAttribution, "unavailable");
    assert.equal(entry.scannerLine, 7);
    assert.equal("sourceLine" in entry, false);
  }
  const serialized = JSON.stringify(diagnostic);
  for (const value of [
    file,
    "fixture.txt",
    "DIAGNOSTIC_CANARY",
    "UNTRUSTED_METADATA",
    "OMITTED_CANARY",
  ])
    assert.equal(serialized.includes(value), false);
});

test("entry and byte bounds retain the authoritative refusal and exact omitted counts", () => {
  const diagnostic = scan(Array.from({ length: 100 }, () => finding()));
  const inventory = diagnostic.inventory;
  assert.ok(inventory.retainedCount <= SCAN_FINDING_INVENTORY_MAX_ENTRIES);
  assert.ok(inventory.omittedCount > 0);
  assert.equal(inventory.retainedCount + inventory.omittedCount, 100);
  assert.equal(inventory.entries[0]!.findingIndex, diagnostic.findingIndex);
  assert.deepEqual(inventory.entries[0]!.material, diagnostic.material);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ failure: { scan: { inventory } } }, null, 2)) <=
      SCAN_FINDING_INVENTORY_MAX_BYTES,
  );
  const unknown = scan(
    Array.from({ length: 100 }, () => finding({ SourceMetadata: null })),
  ).inventory;
  assert.ok(unknown.retainedCount <= SCAN_FINDING_INVENTORY_MAX_ENTRIES);
  assert.equal(unknown.omittedCount, 100 - unknown.retainedCount);
  assert.equal(unknown.unattributedCount, 100);
});

test("unknown, plain, decoded, ambiguous and patch material never invent source coordinates", () => {
  const unknown = scan([
    finding({
      SourceMetadata: { Data: { Filesystem: { file: "UNTRUSTED_PATH_CANARY", line: 1 } } },
    }),
  ]).inventory;
  assert.equal(unknown.unattributedCount, 1);
  assert.equal(unknown.entries[0]!.attributionReason, "unknown_material");
  assert.equal(unknown.entries[0]!.material, undefined);
  assert.equal(scan([finding()]).inventory.entries[0]!.attributionReason, "not_proven");
  for (const decoder of ["HTML", "ESCAPED_UNICODE", "BASE64", "UNKNOWN_CANARY"])
    assert.equal(
      scan([finding({ DecoderName: decoder })]).inventory.entries[0]!.attributionReason,
      "decoded",
    );
  if (input.kind !== "blob") throw new Error("Expected blob");
  const ambiguous = scan([finding()], {
    ...input,
    references: [...input.references, { ...input.references[0]!, role: "base" }],
  });
  assert.equal(ambiguous.inventory.entries[0]!.attributionReason, "ambiguous");
  const patch = scan([finding()], {
    kind: "patch",
    id: "0",
    from: "c".repeat(40),
    to: "d".repeat(40),
  });
  assert.equal(patch.inventory.entries[0]!.material?.kind, "patch");
  assert.equal(patch.inventory.entries[0]!.sourceAttribution, "unavailable");
  assert.equal(patch.inventory.entries[0]!.scannerLine, 7);
});

test("malformed and oversized metadata is omitted or closed, never echoed", () => {
  const diagnostic = scan([
    finding({
      DetectorType: Infinity,
      DecoderName: "UNTRUSTED_CANARY".repeat(10000),
      Verified: "UNTRUSTED_CANARY",
      SourceMetadata: { Data: { Filesystem: { file, line: -1 } } },
    }),
  ]);
  const entry = diagnostic.inventory.entries[0]!;
  assert.equal(entry.detectorType, null);
  assert.equal(entry.decoder, "OTHER");
  assert.equal(entry.verified, null);
  assert.equal(entry.scannerLine, null);
  for (const staged of [
    { ...input, id: "UNTRUSTED_PATH_CANARY" },
    { kind: "prompt", id: "prompt", from: "UNTRUSTED_PATH_CANARY", to: "a".repeat(40) },
    { ...input, id: "a".repeat(40) + "\n" },
    {
      ...input,
      references: [
        { revision: "UNTRUSTED_REVISION", source: "fixture.txt", mode: "100644", role: "head" },
      ],
    },
    {
      ...input,
      references: [
        {
          revision: "a".repeat(40),
          source: "OVERSIZED_CANARY".repeat(10000),
          mode: "100644",
          role: "head",
        },
      ],
    },
    { kind: "patch", id: "0", from: "UNTRUSTED_REVISION", to: "a".repeat(40) },
  ] as StagedScanInput[]) {
    const refused = scan([finding()], staged);
    assert.equal(refused.material, undefined);
    assert.equal(refused.inventory.unattributedCount, 1);
    assert.equal(JSON.stringify(refused).includes("CANARY"), false);
  }
  const invalid = classifyReviewedFixtureScan(
    183,
    Buffer.from("not-json\n"),
    Buffer.from(""),
    new Map(),
  );
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused")
    assert.deepEqual(invalid.diagnostic, { kind: "native_contract", reason: "invalid_stdout" });
});

test(
  "controlled runtime emits inventory in the real failure manifest with no provider or replay effects",
  { skip: process.platform === "win32" },
  () => {
    for (const format of ["sha1", "sha256"]) {
      const result = JSON.parse(
        execFileSync(process.execPath, ["scripts/proof-input-scan-inventory.ts"], {
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, GIT_DEFAULT_HASH: format },
        }),
      );
      assert.equal(result.refusal, "findings");
      assert.equal(result.providerCalls, 0);
      assert.equal(result.canaryOrPrivatePathInManifest, false);
      assert.equal(result.inventory.totalCount, 2);
      assert.equal(result.inventory.retainedCount, 2);
      assert.equal(result.inventory.omittedCount, 0);
      assert.equal(result.inventory.entries[0].material.id.length, format === "sha1" ? 40 : 64);
    }
  },
);
