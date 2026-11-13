import assert from "node:assert/strict";
import test from "node:test";
import { classifyScan, type StagedScanInput } from "../dist/agent-input-scan-classifier.js";
import { APPROVED_SYNTHETIC_VALUES } from "../dist/agent-input-scan-approved-values.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";

const file = "/private/scanner/blob";
const approvedUri = ["https://", "fixture-user:fixture-password@example.invalid"].join("");

function uriFinding(value = approvedUri, overrides: Record<string, unknown> = {}) {
  const url = new URL(value);
  return {
    SourceType: 15,
    SourceMetadata: { Data: { Filesystem: { file, line: 1 } } },
    DetectorType: 17,
    DetectorName: "URI",
    DecoderName: "PLAIN",
    Verified: false,
    VerificationError: "lookup host: no such host",
    Raw: value,
    RawV2: value,
    SecretParts: { host: url.host, username: url.username, password: url.password },
    ExtraData: null,
    StructuredData: null,
    ...overrides,
  };
}

function classify(findings: Record<string, unknown>[], input?: StagedScanInput, complete = true) {
  const verified = findings.filter((finding) => finding.Verified === true).length;
  const log = {
    level: "info-0",
    logger: "trufflehog",
    msg: complete ? "finished scanning" : "started scanning",
    trufflehog_version: TRUFFLEHOG_VERSION,
    chunks: 1,
    bytes: 1,
    verified_secrets: verified,
    unverified_secrets: findings.length - verified,
  };
  return classifyScan(
    183,
    Buffer.from(findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n"),
    Buffer.from(JSON.stringify(log) + "\n"),
    new Map([[file, input ?? { kind: "prompt", id: "prompt", bytes: Buffer.from(approvedUri) }]]),
  );
}

test("reviewed synthetic values survive surrounding edits and material changes", () => {
  const materials: StagedScanInput[] = [
    ...(["prompt", "schema", "additional"] as const).map((kind) => ({ kind, id: kind })),
    { kind: "blob", id: "blob", references: [] },
    { kind: "worktree", id: "worktree", references: [] },
    ...(["patch", "raw_diff", "metadata_proof"] as const).map((kind) => ({
      kind,
      id: kind,
      from: "a".repeat(40),
      to: "b".repeat(40),
    })),
  ];
  for (const material of materials) {
    for (const prefix of ["", "// unrelated edit\n"]) {
      const result = classify([uriFinding()], {
        ...material,
        bytes: Buffer.from(prefix + approvedUri),
      });
      assert.equal(result.kind, "classified", material.kind);
      if (result.kind !== "classified") throw new Error("expected approved value");
      assert.equal(result.notices[0]?.classification, "approved_value");
      assert.equal(JSON.stringify(result).includes("fixture-password"), false);
    }
  }
});

test("reviewed password-only URI findings retain empty usernames", () => {
  for (const [raw, suffix] of [
    [["https://:", "example-password@status.example"].join(""), ""],
    [["https://:", "empty-username-password-1234567890@api.example.test"].join(""), "/v1"],
  ]) {
    const value = raw + suffix;
    const finding = uriFinding(value, { Raw: raw });
    assert.equal(classify([finding]).kind, "classified");
    assert.equal(classify([{ ...finding, Verified: true }]).kind, "refused");
    assert.equal(
      classify([{ ...finding, SecretParts: { ...finding.SecretParts, username: "changed" } }]).kind,
      "refused",
    );
  }
});

test("reviewed Privacy UUID retains its native absent verification error", () => {
  const uuid = ["870bbc5d", "0aaf", "4193", "8191", "61ef581c1bf1"].join("-");
  const finding = uriFinding(approvedUri, {
    DetectorType: 938,
    DetectorName: "Privacy",
    VerificationError: undefined,
    Raw: uuid,
    RawV2: "",
    SecretParts: { key: uuid },
  });
  assert.equal(classify([finding]).kind, "classified");
  for (const override of [
    { Verified: true },
    { VerificationError: null },
    { VerificationError: "" },
    { Raw: uuid.slice(0, -1) + "2" },
    { SecretParts: { key: uuid + "2" } },
    { ExtraData: {} },
  ])
    assert.equal(classify([{ ...finding, ...override }]).kind, "refused");
  assert.equal(
    classify([uriFinding(approvedUri, { VerificationError: undefined })]).kind,
    "refused",
  );
});

test("arbitrary credentials never qualify by reserved or loopback hostname", () => {
  for (const host of [
    "db.example.test",
    "proxy.example",
    "db.invalid",
    "app.localhost",
    "localhost",
    "example.com",
    "example.net",
    "example.org",
    "127.0.0.1",
    "127.10.20.30:9222",
    "[::1]:8080",
    "db.company.internal",
    "example.com.attacker.net",
  ]) {
    const value = ["https://", "review-user:unreviewed-password@", host].join("");
    assert.equal(classify([uriFinding(value)]).kind, "refused", host);
  }
});

test("JDBC authority tricks and connection target overrides refuse", () => {
  const values = [
    [
      "jdbc:sqlserver://db.company.internal:1433;user=review_user;password=",
      "synthetic@example.test",
    ].join(""),
    [
      "jdbc:postgresql://db.example.invalid/app?user=review_user&password=synthetic&",
      "host=db.company.internal",
    ].join(""),
    [
      "jdbc:postgresql://db.example.invalid/app?user=review_user&password=synthetic&",
      "socketFactory=com.google.cloud.sql.postgres.SocketFactory&cloudSqlInstance=project:region:production",
    ].join(""),
  ];
  for (const raw of values) {
    assert.equal(
      classify([
        uriFinding(approvedUri, {
          DetectorType: 10,
          DetectorName: "JDBC",
          Raw: raw,
          RawV2: "",
          SecretParts: { connection_string: raw },
          ExtraData: { host: "db.company.internal" },
        }),
      ]).kind,
      "refused",
    );
  }
  // Native Postgres findings normalize away hostaddr; even the normalized
  // reserved-host value must refuse without an exact synthetic-value approval.
  const raw = ["postgresql://", "review_user:synthetic@db.example.invalid:5432"].join("");
  assert.equal(
    classify([
      uriFinding(approvedUri, {
        DetectorType: 968,
        DetectorName: "Postgres",
        Raw: raw,
        RawV2: raw,
        SecretParts: { connection_string: raw },
        ExtraData: {
          database: "app",
          host: "db.example.invalid:5432",
          sslmode: "<unset>",
          username: "review_user",
        },
      }),
    ]).kind,
    "refused",
  );
});

test("approved values retain detector, decoder, verification and native-part bindings", () => {
  for (const override of [
    { Verified: true },
    { VerificationError: "" },
    { SourceType: 16 },
    { DetectorType: 2 },
    { DetectorName: "AWS" },
    { DecoderName: "OTHER" },
    { Raw: approvedUri + "/changed" },
    { RawV2: approvedUri + "/changed" },
    {
      SecretParts: {
        host: "elsewhere.invalid",
        username: "fixture-user",
        password: "fixture-password",
      },
    },
    {
      SecretParts: {
        host: "example.invalid",
        username: "fixture-user",
        password: "another-password",
      },
    },
    { ExtraData: { host: "db.company.internal" } },
    { StructuredData: {} },
    { SourceMetadata: { Data: { Filesystem: { file: "/unscanned/file", line: 1 } } } },
  ])
    assert.equal(
      classify([uriFinding(approvedUri, override)]).kind,
      "refused",
      JSON.stringify(override),
    );
  assert.equal(classify([uriFinding()], undefined, false).kind, "refused");
  assert.equal(classify([uriFinding(), uriFinding(approvedUri + "/changed")]).kind, "refused");
  assert.equal(classify([uriFinding(approvedUri, { DecoderName: "HTML" })]).kind, "classified");
});

test("migrated approvals have distinct, complete detector and native value identities", () => {
  const keys = new Set<string>();
  assert.equal(APPROVED_SYNTHETIC_VALUES.length, 98);
  for (const [type, name, decoders, raw, rawV2] of APPROVED_SYNTHETIC_VALUES) {
    assert.ok([10, 17, 895, 899, 938, 968].includes(type));
    assert.ok(["JDBC", "URI", "MongoDB", "FTP", "Privacy", "Postgres"].includes(name));
    assert.ok(decoders.length > 0);
    assert.equal(new Set(decoders).size, decoders.length);
    assert.ok(
      decoders.every((decoder) => ["PLAIN", "HTML", "BASE64", "ESCAPED_UNICODE"].includes(decoder)),
    );
    assert.match(raw, /^[a-f0-9]{64}$/);
    assert.match(rawV2, /^[a-f0-9]{64}$/);
    const key = `${type}:${name}:${raw}:${rawV2}`;
    assert.equal(keys.has(key), false);
    keys.add(key);
  }
});
