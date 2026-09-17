import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";
import {
  qualifyReviewedMaterial,
  REVIEWED_SOURCE_MATERIAL,
  type ReviewedMaterialPin,
  type ReviewedMaterialPolicy,
} from "../dist/agent-input-scan-reviewed-material.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";
import { resolvePatchWitnesses } from "../dist/agent-input-scan-patch.js";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const oid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const source = "test/scripts/crabbox-wrapper.test.ts";
const from = "1".repeat(40);
const to = "2".repeat(40);

function pin(input: StagedScanInput): ReviewedMaterialPin {
  assert.ok(input.bytes);
  assert.ok(input.kind === "blob" || input.kind === "patch" || input.kind === "raw_diff");
  return {
    kind: input.kind,
    ...(input.kind === "blob"
      ? { blob: input.id, references: input.references }
      : { from: input.from, to: input.to }),
    size: input.bytes.length,
    sha256: sha(input.bytes),
  };
}

function fixture(baseHasLiteral = false) {
  // Independent synthetic input; never copy the rejected review's matched values.
  const uri = new URL("https://unit.example/value");
  uri.username = "fixture-user";
  uri.password = "fixture-password";
  const rawV2 = uri.href;
  uri.pathname = "/";
  const raw = uri.href.slice(0, -1);
  const line = `const value = ${JSON.stringify(rawV2)};`;
  const before = Buffer.from(baseHasLiteral ? `${line}\n` : "keep\n");
  const after = Buffer.from(before.toString() + line + "\n");
  const beforeId = oid(before);
  const afterId = oid(after);
  const patch = Buffer.from(
    [
      `diff --git a/${source} b/${source}`,
      `index ${beforeId}..${afterId} 100644`,
      `--- a/${source}`,
      `+++ b/${source}`,
      "@@ -1 +1,2 @@",
      " " + before.toString().trimEnd(),
      "+" + line,
      "",
    ].join("\n"),
  );
  const inputs = new Map<string, StagedScanInput>([
    [
      "raw",
      {
        kind: "raw_diff",
        id: "0",
        from,
        to,
        bytes: Buffer.from(`:100644 100644 ${beforeId} ${afterId} M\0${source}\0`),
      },
    ],
    ["patch", { kind: "patch", id: "1", from, to, bytes: patch }],
    [
      beforeId,
      {
        kind: "blob",
        id: beforeId,
        bytes: before,
        references: [{ source, mode: "100644", role: "base", revision: from }],
      },
    ],
    [
      afterId,
      {
        kind: "blob",
        id: afterId,
        bytes: after,
        references: [{ source, mode: "100644", role: "head", revision: to }],
      },
    ],
  ]);
  const policy: ReviewedMaterialPolicy = {
    attributions: [
      [17, "URI", "PLAIN", sha(raw), sha(rawV2), sha(line), source, "100644"],
      [17, "URI", "ESCAPED_UNICODE", sha(raw), sha(rawV2), sha(line), source, "100644"],
    ],
    materials: [...inputs.values()].map(pin),
  };
  const finding = (
    file: string,
    scannerLine = 2,
    decoder: "PLAIN" | "ESCAPED_UNICODE" = "ESCAPED_UNICODE",
  ): Record<string, unknown> => ({
    DetectorType: 17,
    DetectorName: "URI",
    DecoderName: decoder,
    SourceType: 15,
    Verified: false,
    VerificationError: "controlled fixture",
    Raw: raw,
    RawV2: rawV2,
    ExtraData: null,
    StructuredData: null,
    SecretParts: { host: uri.host, username: uri.username, password: uri.password },
    SourceMetadata: { Data: { Filesystem: { file, line: scannerLine } } },
  });
  const classify = (
    selectedInputs = inputs,
    findings = [finding(afterId), finding("patch", 7)],
    selectedPolicy = policy,
  ) =>
    classifyReviewedFixtureScan(
      183,
      Buffer.from(findings.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      Buffer.from(
        JSON.stringify({
          level: "info-0",
          logger: "trufflehog",
          msg: "finished scanning",
          trufflehog_version: TRUFFLEHOG_VERSION,
          chunks: 1,
          bytes: 100,
          verified_secrets: findings.filter((row) => row.Verified === true).length,
          unverified_secrets: findings.filter((row) => row.Verified !== true).length,
        }) + "\n",
      ),
      selectedInputs,
      [],
      selectedPolicy,
    );
  return { inputs, policy, beforeId, afterId, finding, classify, rawV2 };
}

function change(
  inputs: Map<string, StagedScanInput>,
  key: string,
  edit: (input: StagedScanInput) => StagedScanInput,
) {
  const input = inputs.get(key);
  assert.ok(input);
  inputs.set(key, edit(input));
}

test("finite reviewed material requires the complete closed set for blob and added patch", () => {
  const f = fixture();
  for (const rows of [
    [f.finding(f.afterId)],
    [f.finding("patch", 7)],
    [f.finding("patch", 159), f.finding(f.afterId, 4748)],
  ]) {
    const result = f.classify(f.inputs, rows);
    assert.equal(result.kind, "classified");
    if (result.kind !== "classified") return;
    assert.ok(result.notices.every((notice) => notice.source === source));
    assert.ok(
      result.notices.flatMap((notice) => notice.findings).every((row) => row.role === "head"),
    );
  }
  assert.equal(qualifyReviewedMaterial(f.inputs, REVIEWED_SOURCE_MATERIAL), undefined);
});

test("finite material admits the two observed decoder tuples on either native surface", () => {
  const f = fixture();
  for (const decoder of ["PLAIN", "ESCAPED_UNICODE"] as const) {
    for (const file of [f.afterId, "patch"]) {
      assert.equal(f.classify(f.inputs, [f.finding(file, 2, decoder)]).kind, "classified");
    }
  }
  for (const rows of [
    [f.finding(f.afterId, 2, "PLAIN"), f.finding("patch", 7, "ESCAPED_UNICODE")],
    [f.finding(f.afterId, 2, "ESCAPED_UNICODE"), f.finding("patch", 7, "PLAIN")],
  ]) {
    assert.equal(f.classify(f.inputs, rows).kind, "classified");
    assert.equal(f.classify(f.inputs, [...rows].reverse()).kind, "classified");
  }
});

test("finite material permits reordered inputs and unrelated scanned prompt bytes", () => {
  const f = fixture();
  const inputs = new Map([...f.inputs].reverse());
  for (const kind of ["prompt", "schema", "additional"] as const)
    inputs.set(kind, { kind, id: kind, bytes: Buffer.from("unrelated input") });
  assert.equal(f.classify(inputs).kind, "classified");
  for (const kind of ["prompt", "schema", "additional"])
    assert.equal(f.classify(inputs, [f.finding(kind)]).kind, "refused");
});

const materialMutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    "missing raw diff",
    (f) => {
      f.inputs.delete("raw");
    },
  ],
  [
    "missing patch",
    (f) => {
      f.inputs.delete("patch");
    },
  ],
  [
    "missing base blob",
    (f) => {
      f.inputs.delete(f.beforeId);
    },
  ],
  [
    "missing head blob",
    (f) => {
      f.inputs.delete(f.afterId);
    },
  ],
  [
    "extra blob",
    (f) => {
      f.inputs.set("extra", f.inputs.get(f.beforeId)!);
    },
  ],
  [
    "extra raw diff",
    (f) => {
      f.inputs.set("extra", f.inputs.get("raw")!);
    },
  ],
  [
    "same-id patch copy",
    (f) => {
      f.inputs.set("extra", f.inputs.get("patch")!);
    },
  ],
  [
    "same-id masked supplemental patch",
    (f) => {
      f.inputs.set("metadata-proof/1", { ...f.inputs.get("patch")!, bytes: Buffer.from("masked") });
    },
  ],
  [
    "worktree bytes",
    (f) => {
      f.inputs.set("worktree", {
        kind: "worktree",
        id: "x",
        references: [],
        bytes: Buffer.from("x"),
      });
    },
  ],
  [
    "missing retained bytes",
    (f) => {
      change(f.inputs, f.afterId, (input) => {
        const { bytes: _bytes, ...rest } = input;
        return rest;
      });
    },
  ],
  [
    "blob id",
    (f) => {
      change(f.inputs, f.afterId, (input) => ({ ...input, id: "f".repeat(40) }));
    },
  ],
  [
    "byte hash",
    (f) => {
      change(f.inputs, f.afterId, (input) => ({
        ...input,
        bytes: Buffer.concat([input.bytes!, Buffer.from("x")]),
      }));
    },
  ],
  ...["source", "mode", "role", "revision"].map(
    (field): [string, (f: ReturnType<typeof fixture>) => void] => [
      `reference ${field}`,
      (f) => {
        change(f.inputs, f.afterId, (input) => {
          assert.equal(input.kind, "blob");
          if (input.kind !== "blob") return input;
          return {
            ...input,
            references: input.references.map((reference) => ({ ...reference, [field]: "changed" })),
          };
        });
      },
    ],
  ),
  [
    "extra shared reference",
    (f) => {
      change(f.inputs, f.afterId, (input) =>
        input.kind === "blob"
          ? { ...input, references: [...input.references, input.references[0]!] }
          : input,
      );
    },
  ],
  [
    "other committed source pair",
    (f) => {
      for (const [key, input] of f.inputs)
        f.inputs.set(
          key,
          "from" in input
            ? { ...input, from: "3".repeat(40) }
            : "references" in input
              ? {
                  ...input,
                  references: input.references.map((reference) => ({
                    ...reference,
                    revision: "3".repeat(40),
                  })),
                }
              : input,
        );
    },
  ],
  [
    "decoder neighbor",
    (f) => {
      change(f.inputs, f.afterId, (input) => ({
        ...input,
        bytes: Buffer.concat([Buffer.from("\\u000a\n"), input.bytes!]),
      }));
    },
  ],
  [
    "encoded same-value neighbor",
    (f) => {
      const encoded = [...f.rawV2]
        .map((character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");
      change(f.inputs, f.afterId, (input) => ({
        ...input,
        bytes: Buffer.concat([input.bytes!, Buffer.from(encoded)]),
      }));
    },
  ],
];
for (const [name, mutate] of materialMutations)
  test(`finite material refuses ${name} for either emitted surface`, () => {
    const f = fixture();
    mutate(f);
    for (const decoder of ["PLAIN", "ESCAPED_UNICODE"] as const) {
      for (const file of [f.afterId, "patch"]) {
        assert.equal(f.classify(f.inputs, [f.finding(file, 2, decoder)]).kind, "refused");
      }
    }
  });

test("finite material still requires an added head witness even with only a blob record", () => {
  const f = fixture();
  change(f.inputs, "patch", (input) => ({
    ...input,
    bytes: Buffer.from(input.bytes!.toString().replace("@@ -1 +1,2 @@", "@@ -2 +1,2 @@")),
  }));
  f.policy.materials = [...f.inputs.values()].map(pin);
  assert.equal(f.classify(f.inputs, [f.finding(f.afterId)]).kind, "refused");
  const withBaseLiteral = fixture(true);
  assert.equal(withBaseLiteral.classify().kind, "refused");
});

test("finite material retains strict native metadata and all-record refusal", () => {
  const f = fixture();
  const edits: Record<string, unknown>[] = [
    { Verified: true },
    { DetectorType: 895 },
    { DetectorName: "Postgres" },
    { DecoderName: "HTML" },
    { DecoderName: "BASE64" },
    { DecoderName: "UTF16" },
    { SourceType: 1 },
    { VerificationError: "" },
    { ExtraData: {} },
    { StructuredData: {} },
    { Raw: "different" },
    { RawV2: f.rawV2 + "?changed" },
    { SecretParts: {} },
  ];
  for (const edit of edits) {
    const changed = { ...f.finding(f.afterId), ...edit };
    assert.equal(f.classify(f.inputs, [f.finding("patch", 7), changed]).kind, "refused");
  }
  assert.equal(f.classify(f.inputs, [f.finding(f.afterId), f.finding(f.afterId)]).kind, "refused");
  assert.equal(
    f.classify(f.inputs, [f.finding("patch", 7), f.finding("patch", 7)]).kind,
    "refused",
  );
  for (const index of [3, 4, 5]) {
    const policy = structuredClone(f.policy);
    policy.attributions = policy.attributions.map((attribution) => {
      const row = [...attribution];
      row[index] = "0".repeat(64);
      return row as unknown as ReviewedMaterialPolicy["attributions"][number];
    });
    assert.equal(f.classify(f.inputs, undefined, policy).kind, "refused");
  }
});

test("finite material rejects a base literal outside a zero-context added hunk", () => {
  const f = fixture(true);
  const patch = f.inputs.get("patch")!;
  assert.ok(patch.kind === "patch");
  const lines = patch.bytes!.toString().split("\n");
  const zeroContext = {
    ...patch,
    bytes: Buffer.from([...lines.slice(0, 4), "@@ -1,0 +2 @@", lines[6]!, ""].join("\n")),
  };
  f.inputs.set("patch", zeroContext);
  f.policy.materials = [...f.inputs.values()].map(pin);
  const witnesses = resolvePatchWitnesses(zeroContext, f.rawV2, f.inputs);
  assert.equal(witnesses?.length, 1);
  assert.equal(witnesses?.[0]?.kind, "add");
  const result = f.classify(f.inputs, [f.finding(f.afterId)]);
  if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding")
    assert.equal(result.diagnostic.reason, "material_not_reviewed");
  else assert.fail("expected the base-literal admission guard");
});
