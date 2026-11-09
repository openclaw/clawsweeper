import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type ReviewedAttribution,
  type ScanSourceReference,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";

// Assemble the existing synthetic fixture; the reviewed OpenClaw source is unchanged.
const raw = ["https", "://", "user", ":", "pass", "@", "relay.example.com"].join("");
const rawV2 = ["https", "://", "user", ":", "pass", "@", "relay.example.com/path"].join("");
const line = '      ["' + rawV2 + '", "userinfo is not allowed"],';
const bytes = Buffer.from("// fixture\n" + line + "\n");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const source = "src/infra/push-apns.test.ts";
const file = "/scanner/77724187431100ec599905e760c04c03ae8d1c51";
const parsed = new URL(rawV2);
const finding = {
  SourceType: 15,
  DetectorType: 17,
  DetectorName: "URI",
  DecoderName: "PLAIN",
  Verified: false,
  VerificationError: "synthetic native verification error",
  Raw: raw,
  RawV2: rawV2,
  ExtraData: null,
  StructuredData: null,
  SecretParts: { host: parsed.host, username: parsed.username, password: parsed.password },
  SourceMetadata: { Data: { Filesystem: { file, line: 2 } } },
};
const reference: ScanSourceReference = {
  source,
  mode: "100644",
  revision: "154d60ec2bc612db80a39c13b61466a64acfc527",
  role: "base",
};

function scan(
  decoder: string,
  changes: {
    content?: Buffer;
    reference?: Partial<ScanSourceReference>;
    finding?: Record<string, unknown>;
    duplicate?: boolean;
    mixed?: boolean;
    complete?: boolean;
    policy?: readonly ReviewedAttribution[];
  } = {},
) {
  const observed = { ...finding, DecoderName: decoder, ...changes.finding };
  const findings = changes.duplicate
    ? [observed, observed]
    : changes.mixed
      ? [observed, { ...observed, RawV2: rawV2 + "x" }]
      : [observed];
  const inputs = new Map<string, StagedScanInput>([
    [
      file,
      {
        kind: "blob",
        id: file.split("/").at(-1)!,
        bytes: changes.content ?? bytes,
        references: [{ ...reference, ...changes.reference }],
      },
    ],
  ]);
  const stdout = Buffer.from(findings.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const stderr = Buffer.from(
    changes.complete === false
      ? ""
      : JSON.stringify({
          level: "info-0",
          logger: "trufflehog",
          msg: "finished scanning",
          trufflehog_version: "3.99.4",
          chunks: 1,
          bytes: bytes.length,
          verified_secrets: findings.filter((value) => value.Verified === true).length,
          unverified_secrets: findings.filter((value) => value.Verified !== true).length,
        }) + "\n",
  );
  return classifyReviewedFixtureScan(183, stdout, stderr, inputs, changes.policy);
}

test("push relay rejection fixture matches the observed native and complete-line identities", () => {
  assert.equal(sha256(raw), "e86d617b3e5670ce0a6c4f92f89148535c8a379bdb84a9fc144f2004ac4743a4");
  assert.equal(sha256(rawV2), "26450b6aba4123d2f67a8d940c50bf9b6c492993c657100d6a02c4345b67ea3a");
  assert.equal(sha256(line), "708fc8405f2610f3ccfea55cee78e6eceb2912c1ffa847609040442f554f7847");
});

for (const decoder of ["PLAIN", "HTML", "ESCAPED_UNICODE"]) {
  test(`push relay fixture admits the observed ${decoder} identity on immutable base and head`, () => {
    for (const role of ["base", "head"] as const) {
      const result = scan(decoder, { reference: { role } });
      assert.equal(result.kind, "classified", JSON.stringify(result));
      if (result.kind === "classified") {
        assert.equal(result.notices.length, 1);
        assert.equal(result.notices[0]?.source, source);
        assert.equal(result.notices[0]?.findings[0]?.literalLine, 2);
      }
    }
  });
}

test("push relay qualification refuses mutations and incomplete native evidence", async (t) => {
  const cases: [string, Parameters<typeof scan>[1]][] = [
    [
      "credential byte",
      {
        content: Buffer.from(bytes.toString().replaceAll(parsed.password, "different")),
        finding: { Raw: raw + "x", RawV2: rawV2 + "x" },
      },
    ],
    ["complete source line", { content: Buffer.from("// fixture\n " + line + "\n") }],
    ["duplicate literal", { content: Buffer.from(bytes.toString() + line + "\n") }],
    ["source path", { reference: { source: "src/infra/other.test.ts" } }],
    ["production path", { reference: { source: "src/infra/push-apns.ts" } }],
    ["executable mode", { reference: { mode: "100755" } }],
    ["worktree role", { reference: { role: "worktree" } }],
    ["index role", { reference: { role: "index" } }],
    ["verified finding", { finding: { Verified: true } }],
    ["native detector", { finding: { DetectorType: 895, DetectorName: "MongoDB" } }],
    ["native Raw", { finding: { Raw: raw + "x" } }],
    ["native RawV2", { finding: { RawV2: rawV2 + "x" } }],
    [
      "native metadata",
      { finding: { SecretParts: { ...finding.SecretParts, host: "other.example.test" } } },
    ],
    ["duplicate finding", { duplicate: true }],
    ["mixed unqualified finding", { mixed: true }],
    ["incomplete scan", { complete: false }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, () => {
      for (const decoder of ["PLAIN", "HTML", "ESCAPED_UNICODE"]) {
        assert.equal(scan(decoder, changes).kind, "refused", `${name}: ${decoder}`);
      }
    });
  }
  await t.test("unobserved decoder", () => assert.equal(scan("BASE64").kind, "refused"));
});

test("push relay policy validation refuses broader attribution rows", () => {
  const row = (changes: {
    raw?: string;
    rawV2?: string;
    line?: string;
    path?: string;
    decoder?: ReviewedAttribution[2];
  }): ReviewedAttribution => [
    17,
    "URI",
    changes.decoder ?? "PLAIN",
    changes.raw ?? sha256(raw),
    changes.rawV2 ?? sha256(rawV2),
    changes.line ?? sha256(line),
    changes.path ?? source,
    "100644",
  ];
  for (const changes of [
    { raw: "0".repeat(64) },
    { rawV2: "0".repeat(64) },
    { line: "0".repeat(64) },
    { path: "src/infra/other.test.ts" },
    { decoder: "BASE64" as const },
  ]) {
    assert.throws(
      () => scan("PLAIN", { policy: [row(changes)] }),
      /invalid reviewed attribution policy/,
    );
  }
});
