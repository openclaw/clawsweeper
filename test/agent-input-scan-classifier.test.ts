import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyScan,
  isReservedHost,
  type StagedScanInput,
} from "../dist/agent-input-scan-classifier.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";

const file = "/private/scanner/blob";
const inputs = new Map<string, StagedScanInput>([
  [
    file,
    {
      kind: "blob",
      id: "a".repeat(40),
      bytes: Buffer.from("fixture\n"),
      references: [
        { source: "test/a.test.ts", mode: "100644", revision: "b".repeat(40), role: "head" },
      ],
    },
  ],
]);

function uriFinding(value: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function classify(findings: Record<string, unknown>[]) {
  const verified = findings.filter((finding) => finding.Verified === true).length;
  const log = {
    level: "info-0",
    logger: "trufflehog",
    msg: "finished scanning",
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
    inputs,
  );
}

test("reserved and loopback hosts are recognized; look-alikes are not", () => {
  for (const host of [
    "example.test",
    "db.example.test:5432",
    "proxy.example",
    "example.invalid",
    "app.localhost",
    "localhost",
    "localhost:3000",
    "example.com",
    "cdn.example.com",
    "matrix.example.org",
    "example.net.",
    "127.0.0.1",
    "127.10.20.30:9222",
    "[::1]:8080",
  ])
    assert.equal(isReservedHost(host), true, host);
  for (const host of [
    "github.com",
    "chrome.browserless.io",
    "example.com.attacker.net",
    "notexample.com",
    "test.com",
    "localhost.attacker.net",
    "128.0.0.1",
    "127.0.0.256",
    "10.0.0.1",
    "[::2]",
    "example.test\\@evil.com",
    "",
  ])
    assert.equal(isReservedHost(host), false, host);
});

test("unverifiable credentials for reserved hosts classify without any per-file policy", () => {
  const result = classify([
    uriFinding("https://user:pass@example.test/path"),
    uriFinding("http://admin:secret@127.0.0.1:9222", { DecoderName: "HTML" }),
    {
      ...uriFinding("postgres://u:p@db.example.test:5432"),
      DetectorType: 968,
      DetectorName: "Postgres",
      SecretParts: { connection_string: "postgres://u:p@db.example.test:5432" },
    },
    {
      ...uriFinding("mongodb+srv://u:p@cluster.example.test/app"),
      DetectorType: 895,
      DetectorName: "MongoDB",
      RawV2: "",
      SecretParts: { key: "mongodb+srv://u:p@cluster.example.test/app" },
    },
  ]);
  assert.equal(result.kind, "classified");
  if (result.kind !== "classified") return;
  assert.deepEqual(
    result.notices.map(({ classification, detector }) => [classification, detector]),
    [
      ["reserved_host", "MongoDB"],
      ["reserved_host", "Postgres"],
      ["reserved_host", "URI"],
    ],
  );
  assert.equal(JSON.stringify(result).includes("pass"), false, "values are never emitted");
});

test("anything that could unlock a reachable host still refuses", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["public host", uriFinding("https://user:pass@github.com")],
    ["verified", uriFinding("https://user:pass@example.test", { Verified: true })],
    [
      "no verification error",
      uriFinding("https://user:pass@example.test", { VerificationError: "" }),
    ],
    ["non-filesystem source", uriFinding("https://user:pass@example.test", { SourceType: 16 })],
    [
      "unrelated detector",
      uriFinding("https://user:pass@example.test", { DetectorType: 2, DetectorName: "AWS" }),
    ],
    [
      "public host in RawV2",
      uriFinding("https://user:pass@example.test", { RawV2: "https://user:pass@api.openclaw.ai" }),
    ],
    [
      "public SecretParts host",
      uriFinding("https://user:pass@example.test", {
        SecretParts: { host: "api.openclaw.ai", username: "user", password: "pass" },
      }),
    ],
    [
      "backslash authority",
      uriFinding("https://user:pass@example.test", { Raw: "https://evil.com\\@example.test" }),
    ],
    ["no authority", uriFinding("https://user:pass@example.test", { Raw: "user:pass", RawV2: "" })],
    [
      "public seed host",
      {
        ...uriFinding("mongodb://u:p@a.example.test,db.openclaw.ai/app"),
        DetectorType: 895,
        DetectorName: "MongoDB",
        SecretParts: { key: "mongodb://u:p@a.example.test,db.openclaw.ai/app" },
      },
    ],
    [
      "JDBC parameters in authority",
      {
        ...uriFinding("https://x@example.test"),
        DetectorType: 10,
        DetectorName: "JDBC",
        Raw: "jdbc:sqlserver://db.example.test;user=sa;password=secret",
        RawV2: "",
        SecretParts: {},
      },
    ],
  ];
  for (const [name, finding] of cases) {
    const result = classify([uriFinding("https://user:pass@example.test"), finding]);
    assert.equal(result.kind, "refused", name);
    if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding") {
      assert.equal(result.diagnostic.findingIndex, 1, name);
      assert.equal(result.diagnostic.reason, "finding_not_reviewed", name);
    }
  }
});
