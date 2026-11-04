import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  classifyReviewedFixtureScan,
  validateReviewedAttributionPolicy,
  type StagedScanInput,
  type ScanSourceRole,
} from "../dist/agent-input-scan-fixtures.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";

test("MCP sandbox origin tuples satisfy the host-owned policy schema", () => {
  assert.doesNotThrow(validateReviewedAttributionPolicy);
});

// Captured from pinned native TruffleHog 3.99.4, with local source paths normalized.
// The synthetic literal and complete source-line witnesses stay directly inspectable.
const nativeFinding = {
  SourceMetadata: {
    Data: {
      Filesystem: {
        file: "/private/scanner/31c6eb5e1aef768f44b8fa778d24cc8b5bffe8c1",
        line: 1,
      },
    },
  },
  SourceType: 15,
  SourceName: "filesystem",
  DetectorType: 17,
  DetectorName: "URI",
  DetectorDescription:
    "This detector identifies URLs with embedded credentials, which can be used to access web resources without explicit user interaction.",
  DecoderName: "HTML",
  Verified: false,
  VerificationError: "synthetic fixture verification failed",
  VerificationFromCache: false,
  Raw: "https://user:pass@mcp-apps.example.com",
  RawV2: "https://user:pass@mcp-apps.example.com",
  Redacted: "https://user:********@mcp-apps.example.com",
  ExtraData: null,
  StructuredData: null,
  SecretParts: {
    host: "mcp-apps.example.com",
    password: "pass",
    username: "user",
  },
};
const sourceLine = '    "https://user:pass@mcp-apps.example.com",';
const legacyLine = '      "https://user:pass@mcp-apps.example.com",';
const source = "src/config/config-misc.test.ts";
const file = nativeFinding.SourceMetadata.Data.Filesystem.file;
const revision = "fb2c420c4e75ea43884869786f5b0e9b7af36c06";

function fixture(decoder = "HTML", line = sourceLine, roles: ScanSourceRole[] = ["base"]) {
  const finding = structuredClone(nativeFinding);
  finding.DecoderName = decoder;
  const input: StagedScanInput = {
    kind: "blob",
    id: "31c6eb5e1aef768f44b8fa778d24cc8b5bffe8c1",
    bytes: Buffer.from(line + "\n"),
    references: roles.map((role) => ({ source, mode: "100644", revision, role })),
  };
  return { finding, input, inputs: new Map([[file, input]]) };
}

function classify(
  findings: unknown[],
  inputs: ReadonlyMap<string, StagedScanInput>,
  completion: Record<string, unknown> = {},
) {
  return classifyReviewedFixtureScan(
    183,
    Buffer.from(findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n"),
    Buffer.from(
      JSON.stringify({
        level: "info-0",
        logger: "trufflehog",
        msg: "finished scanning",
        trufflehog_version: TRUFFLEHOG_VERSION,
        chunks: 1,
        bytes: 1,
        verified_secrets: 0,
        unverified_secrets: findings.length,
        ...completion,
      }) + "\n",
    ),
    inputs,
  );
}

for (const decoder of ["PLAIN", "HTML", "ESCAPED_UNICODE"]) {
  for (const roles of [["base"], ["head"], ["base", "head"]] as ScanSourceRole[][]) {
    test(
      "MCP sandbox origin enforces decoder policy for " + decoder + " committed " + roles.join("/"),
      () => {
        const { finding, inputs } = fixture(decoder, sourceLine, roles);
        assert.equal(
          classify([finding], inputs).kind,
          decoder === "ESCAPED_UNICODE" ? "refused" : "classified",
        );
      },
    );
  }
}

test("MCP sandbox origin preserves the existing PLAIN legacy witness", () => {
  const { finding, inputs } = fixture("PLAIN", legacyLine);
  assert.equal(classify([finding], inputs).kind, "classified");
});

for (const scenario of [
  "raw",
  "raw-v2",
  "line",
  "extra-occurrence",
  "path",
  "mode",
  "index",
  "tree",
  "worktree",
  "mixed-reference",
  "no-reference",
  "decoder",
  "legacy-html",
  "detector",
  "verified",
  "mixed-finding",
  "completion-count",
  "completion-version",
  "invalid-scanner-line",
  "verification-missing",
]) {
  test("MCP sandbox origin refuses unapproved " + scenario, () => {
    const { finding, input, inputs } = fixture();
    assert.equal(input.kind, "blob");
    if (input.kind !== "blob") throw new Error("Expected blob fixture");
    const findings = [finding];
    const completion: Record<string, unknown> = {};
    switch (scenario) {
      case "raw":
        finding.Raw += "x";
        break;
      case "raw-v2":
        finding.RawV2 += "x";
        break;
      case "line":
        input.bytes = Buffer.from(" " + sourceLine + "\n");
        break;
      case "extra-occurrence":
        input.bytes = Buffer.from([sourceLine, sourceLine, ""].join("\n"));
        break;
      case "path":
        input.references[0]!.source = "src/config/other.test.ts";
        break;
      case "mode":
        input.references[0]!.mode = "100755";
        break;
      case "index":
      case "tree":
      case "worktree":
        input.references[0]!.role = scenario;
        break;
      case "mixed-reference":
        input.references = [
          ...input.references,
          { ...input.references[0]!, source: "other.test.ts" },
        ];
        break;
      case "no-reference":
        input.references = [];
        break;
      case "decoder":
        finding.DecoderName = "BASE64";
        break;
      case "legacy-html":
        input.bytes = Buffer.from(legacyLine + "\n");
        break;
      case "detector":
        finding.DetectorType = 895;
        break;
      case "verified":
        finding.Verified = true;
        completion.verified_secrets = 1;
        completion.unverified_secrets = 0;
        break;
      case "mixed-finding":
        findings.push({ ...structuredClone(finding), Raw: finding.Raw + "x" });
        break;
      case "completion-count":
        completion.unverified_secrets = 0;
        break;
      case "completion-version":
        completion.trufflehog_version = "0.0.0";
        break;
      case "invalid-scanner-line":
        finding.SourceMetadata.Data.Filesystem.line = 0;
        break;
      case "verification-missing":
        finding.VerificationError = "";
        break;
      default:
        throw new Error("Unknown negative scenario");
    }
    const result = classify(findings, inputs, completion);
    assert.equal(result.kind, "refused");
    if (scenario === "verified") {
      // Constructed classifier control, not a native verified finding.
      // The exact approved fixture and consistent completion counts stay fixed.
      assert.equal(result.kind === "refused" && result.diagnostic.kind, "unclassified_finding");
      if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding") {
        assert.equal(result.diagnostic.reason, "finding_not_reviewed");
        assert.equal(result.diagnostic.verified, true);
      }
    }
  });
}

function gitBlob(bytes: Buffer) {
  return createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
}

for (const change of ["add", "context", "remove"]) {
  for (const decoder of ["PLAIN", "HTML", "ESCAPED_UNICODE"]) {
    test("MCP sandbox origin enforces complete " + change + " patch policy with " + decoder, () => {
      const oldMarker = "export const marker = 0;";
      const newMarker = "export const marker = 1;";
      const before = Buffer.from(
        (change === "add" ? [oldMarker, ""] : [sourceLine, oldMarker, ""]).join("\n"),
      );
      const after = Buffer.from(
        (change === "remove" ? [newMarker, ""] : [sourceLine, newMarker, ""]).join("\n"),
      );
      const oldId = gitBlob(before);
      const newId = gitBlob(after);
      const from = "a".repeat(40);
      const to = "b".repeat(40);
      const patchFile = "/private/scanner/patch";
      const hunk =
        change === "add"
          ? "@@ -1 +1,2 @@"
          : change === "remove"
            ? "@@ -1,2 +1 @@"
            : "@@ -1,2 +1,2 @@";
      const prefix = change === "add" ? "+" : change === "remove" ? "-" : " ";
      const bytes = Buffer.from(
        [
          "diff --git a/" + source + " b/" + source,
          "index " + oldId + ".." + newId + " 100644",
          "--- a/" + source,
          "+++ b/" + source,
          hunk,
          prefix + sourceLine,
          "-" + oldMarker,
          "+" + newMarker,
          "",
        ].join("\n"),
      );
      const oldFile = "/private/scanner/" + oldId;
      const newFile = "/private/scanner/" + newId;
      const inputs = new Map<string, StagedScanInput>([
        [
          oldFile,
          {
            kind: "blob",
            id: oldId,
            bytes: before,
            references: [{ source, mode: "100644", revision: from, role: "base" }],
          },
        ],
        [
          newFile,
          {
            kind: "blob",
            id: newId,
            bytes: after,
            references: [{ source, mode: "100644", revision: to, role: "head" }],
          },
        ],
        [patchFile, { kind: "patch", id: "patch", bytes, from, to }],
      ]);
      const finding = structuredClone(nativeFinding);
      finding.DecoderName = decoder;
      finding.SourceMetadata.Data.Filesystem = { file: patchFile, line: 6 };
      assert.equal(
        classify([finding], inputs).kind,
        decoder === "ESCAPED_UNICODE" ? "refused" : "classified",
      );

      // Full before/after source binding is mandatory, even for a removed value.
      inputs.delete(change === "add" ? newFile : oldFile);
      assert.equal(classify([finding], inputs).kind, "refused");
    });
  }
}
