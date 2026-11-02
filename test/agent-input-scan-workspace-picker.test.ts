import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type ScanSourceReference,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";

const source = "src/gateway/server-methods/projects-identity.test.ts";
const file = "/scanner/e5c6bfd8c9785047f6ee0123257dbd1cf23b7bdd";
// Follow the existing policy-test fixture builder; the published source stays unchanged.
const uri = new URL("https://ghe.example.test/acme/private.git");
uri.username = "user";
const fixturePassword = "placeholder";
uri.password = fixturePassword;
uri.searchParams.set("secret", "placeholder");
const raw = [uri.protocol, "//", uri.username, ":", fixturePassword, "@", uri.host].join("");
// Native 3.99.4 stops before the suffix; the full-line and file pins retain it.
const rawV2 = raw + "/acme/private";
const content = `import { expect, test, vi } from "vitest";
import * as registry from "../../projects/project-registry.js";
import { projectsHandlers } from "./projects.js";
import { invokeProjectMethod } from "./projects.test-support.js";

test("projects.list projects raw Enterprise origins into read-safe identity without credentials or placement", async () => {
  const cfg = { gateway: { github: { host: "ghe.example.test" } } };
  using _ = vi.spyOn(registry, "listProjectRegistry").mockResolvedValue([
    {
      id: "console",
      displayName: "Console",
      source: "registered",
      repoRoot: "/private/console",
      originUrl: "git@ghe.example.test:Acme/Console.git",
    },
    {
      id: "credentials",
      displayName: "Credentials",
      source: "registered",
      repoRoot: "/private/credentials",
      originUrl: "${uri.href}",
    },
  ]);
  const invoke = (scopes: string[]) =>
    invokeProjectMethod("projects.list", {}, cfg, scopes, undefined, projectsHandlers);
  const read = await invoke(["operator.sessions.read"]);
  expect(read).toEqual({
    ok: true,
    error: undefined,
    payload: {
      projects: [
        {
          id: "console",
          displayName: "Console",
          source: "registered",
          repositoryIdentity: "acme/console",
        },
        { id: "credentials", displayName: "Credentials", source: "registered" },
      ],
    },
  });
  const write = await invoke(["operator.write"]);
  expect(write).toMatchObject({
    ok: true,
    payload: {
      projects: [
        {
          id: "console",
          repoRoot: "/private/console",
          originUrl: "ghe.example.test:Acme/Console.git",
          repositoryIdentity: "acme/console",
        },
        {
          id: "credentials",
          repoRoot: "/private/credentials",
          originUrl: "https://ghe.example.test/acme/private.git",
        },
      ],
    },
  });
});
`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference: ScanSourceReference = {
  source,
  mode: "100644",
  revision: "d96b69052ac265fc2a1a980a81a68eab30ecf1ce",
  role: "head",
};
const finding = {
  SourceType: 15,
  DetectorType: 17,
  DetectorName: "URI",
  DecoderName: "PLAIN",
  Verified: false,
  VerificationError: "synthetic verification error",
  Raw: raw,
  RawV2: rawV2,
  ExtraData: null,
  StructuredData: null,
  SecretParts: { host: uri.host, username: uri.username, password: uri.password },
  SourceMetadata: { Data: { Filesystem: { file, line: 21 } } },
};

function scan(
  changes: {
    content?: string;
    finding?: Record<string, unknown>;
    reference?: Partial<ScanSourceReference>;
    duplicate?: boolean;
    incomplete?: boolean;
  } = {},
) {
  const bytes = Buffer.from(changes.content ?? content);
  const observed = { ...finding, ...changes.finding };
  const findings = changes.duplicate ? [observed, observed] : [observed];
  const inputs = new Map<string, StagedScanInput>([
    [
      file,
      {
        kind: "blob",
        id: file.split("/").at(-1)!,
        bytes,
        references: [{ ...reference, ...changes.reference }],
      },
    ],
  ]);
  const newline = String.fromCharCode(10);
  const stdout = Buffer.from(
    findings.map((value) => JSON.stringify(value)).join(newline) + newline,
  );
  const stderr = Buffer.from(
    changes.incomplete
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
        }) + newline,
  );
  return classifyReviewedFixtureScan(183, stdout, stderr, inputs);
}

test("workspace repository identity fixture binds exact native, line, and complete source identities", () => {
  assert.equal(hash(raw), "e26a1ab8bea9e595632020487f494a373085d4ece58f72dcb9c9d72aae3c1353");
  assert.equal(hash(rawV2), "91f8a02c4831296a6adc1d02eaf52ebaa563e1593b759677c284a23c4874e948");
  assert.equal(
    hash(content.split(String.fromCharCode(10))[20]!),
    "d70f1b47aeda919b3c0c195b6e5df95fa6af2329760734508ab87bbbcbf456ef",
  );
  assert.equal(hash(content), "1441fca2a24daa08e02e82f032601729277b1334d3b996c2346d55ac6adabe90");
  const result = scan();
  assert.equal(result.kind, "classified", JSON.stringify(result));
  if (result.kind === "classified") {
    assert.equal(result.notices.length, 1);
    assert.equal(result.notices[0]?.source, source);
    assert.equal(result.notices[0]?.fixtureSha256, hash(rawV2));
    assert.equal(result.notices[0]?.findings[0]?.literalLine, 21);
  }
});

test("workspace repository identity qualification refuses altered inputs", async (t) => {
  const cases: [string, Parameters<typeof scan>[0]][] = [
    [
      "credential byte",
      {
        content: content.replaceAll("placeholder", "different"),
        finding: {
          Raw: raw.replace("placeholder", "different"),
          RawV2: rawV2.replace("placeholder", "different"),
          SecretParts: { ...finding.SecretParts, password: "different" },
        },
      },
    ],
    [
      "query beyond native prefix",
      { content: content.replace("secret=placeholder", "secret=different") },
    ],
    ["unrelated source byte", { content: content + String.fromCharCode(10) }],
    [
      "full line whitespace",
      {
        content: content.replace(
          `      originUrl: "${uri.href}"`,
          `       originUrl: "${uri.href}"`,
        ),
      },
    ],
    ["path", { reference: { source: "src/gateway/server-methods/other.test.ts" } }],
    ["mode", { reference: { mode: "100755" } }],
    ["worktree role", { reference: { role: "worktree" } }],
    ["index role", { reference: { role: "index" } }],
    ["verified finding", { finding: { Verified: true } }],
    ["HTML decoder", { finding: { DecoderName: "HTML" } }],
    ["BASE64 decoder", { finding: { DecoderName: "BASE64" } }],
    [
      "native metadata",
      { finding: { SecretParts: { ...finding.SecretParts, host: "other.example.test" } } },
    ],
    ["native Raw", { finding: { Raw: raw + "x" } }],
    ["native RawV2", { finding: { RawV2: rawV2 + "x" } }],
    ["duplicate record", { duplicate: true }],
    ["incomplete native scan", { incomplete: true }],
  ];
  for (const [label, changes] of cases)
    await t.test(label, () => assert.equal(scan(changes).kind, "refused", label));
});
