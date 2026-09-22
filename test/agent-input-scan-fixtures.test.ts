import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  serializeReviewContext,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";

test("WebVNC fixture policy retains both exact native identities and source witnesses", () => {
  // Inspect only the static policy data, without copying credential-shaped fixture values.
  const source = readFileSync(
    new URL("../src/agent-input-scan-fixtures.ts", import.meta.url),
    "utf8",
  );
  const declaration = source.match(/const REVIEWED_FIXTURES:[^\n]* = \[([\s\S]*?)\n\];/);
  assert.ok(declaration);
  const flatObjects = (array: string) => {
    const data = array.replace(/\/\/[^\n]*/g, "");
    assert.equal(data.replace(/\{([^{}]*)\}/g, "").replace(/[\s,]/g, ""), "");
    return [...data.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
  };
  for (const unsupported of ["wrap({})", "{ nested: {} }", "...other, {}"])
    assert.throws(() => flatObjects(unsupported));
  const records = flatObjects(declaration[1]!)
    .filter((body) => body.includes('"internal/cli/webvnc_test.go"'))
    .map((body) => {
      const property = /([A-Za-z]\w*):\s*("(?:[^"\\]|\\.)*"|\[[^[\]]*\]),/g;
      const entries = [...body.matchAll(property)].map((match) => {
        const value: unknown = JSON.parse(match[2]!);
        assert.ok(
          typeof value === "string" ||
            (Array.isArray(value) && value.every((part) => typeof part === "string")),
        );
        return [match[1]!, value] as const;
      });
      assert.equal(body.replace(property, "").trim(), "");
      assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
      return Object.fromEntries(entries);
    });
  assert.deepEqual(records, [
    {
      fixtureSha256: "18cd62c666a4b48f9968cacc2acc34a27c1f15682219d4f45bfb903cfb3d60fc",
      rawSha256: "d72aa985328cd8b6b8d13182b028f5e5c06e574b9acfddc31dc5ab0655896050",
      lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
      decoders: ["PLAIN"],
      sources: ["internal/cli/webvnc_test.go"],
    },
    {
      fixtureSha256: "5f63e971f3b95e10c500e2c40cfaf423b47c60e1bbb3c1dad9633cef0aa1a10f",
      rawSha256: "6a160b5adb896b7ae8e5347258bce211ebcb35f422aa9fc0931d2406403e72ae",
      lineSha256s: ["83b93f401c1c6526ce80cca9860fdbf59825c92e70644a6f087e6a1b46b295e8"],
      decoders: ["PLAIN"],
      sources: ["internal/cli/webvnc_test.go"],
    },
  ]);
});

function autoreviewFixtures(): {
  raw: string;
  rawV2?: string;
  line: string;
  decoders: readonly ("PLAIN" | "HTML")[];
}[] {
  // Assemble synthetic values so this regression does not introduce new scan literals.
  const uri = (user: string, password: string, host: string) =>
    ["http://", user, ":", password, "@", host].join("");
  const quoted = (raw: string) => `            "${raw}",`;
  const review = uri("review-user", "review-password", "proxy.example.invalid:8080");
  const proxy = uri("user", "password", "proxy.example.invalid:8080");
  const transport = uri("fixture", "transport-password", "127.0.0.1:8080");
  const newline = uri("user", "p%0Ass", "host");
  const nul = uri("user", "p%00ss", "host");
  const malformedLine = `            ${[newline, nul, uri("user", "p%zz", "host")].map((value) => `"${value}"`).join(", ")},`;
  const emptyUser = uri("", "password", "proxy.example.invalid");
  const original = [
    { raw: review, line: quoted(review) },
    { raw: proxy, line: quoted(proxy) },
    {
      raw: newline,
      line: malformedLine,
    },
    { raw: transport, line: `            proxy = "${transport}"` },
  ];
  return [
    ...original.map((entry) => ({ ...entry, decoders: ["PLAIN", "HTML"] as const })),
    { raw: emptyUser, line: quoted(emptyUser), decoders: ["PLAIN"] },
    { raw: nul, line: malformedLine, decoders: ["PLAIN"] },
  ];
}

function fixturePatch(
  t: test.TestContext,
  source: string,
  entries: ReturnType<typeof autoreviewFixtures>,
  change: "add" | "remove" | "context" = "add",
) {
  const cwd = mkdtempSync(join(tmpdir(), "clawsweeper-reviewed-fixtures-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, timeout: 30_000 });
  git("init", "-q");
  git("config", "user.name", "Scanner fixture");
  git("config", "user.email", "scanner@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", devNull);
  const path = join(cwd, source);
  mkdirSync(dirname(path), { recursive: true });
  const content = `# fixture\n${[...new Set(entries.map(({ line }) => line))].join("\n")}\n`;
  const versions =
    change === "context"
      ? [`${content}# before\n`, `${content}# after\n`]
      : change === "add"
        ? ["# fixture\n", content]
        : [content, "# fixture\n"];
  const revisions = versions.map((bytes) => {
    writeFileSync(path, bytes, { mode: 0o644 });
    git("add", "--", source);
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD").toString().trim();
  });
  const [from, to] = revisions as [string, string];
  const patchFile = "/scanner/patch";
  const patch = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--binary",
    "--full-index",
    from,
    to,
  );
  const inputs = new Map<string, StagedScanInput>([
    [patchFile, { kind: "patch", id: "patch", bytes: patch, from, to }],
  ]);
  const role = change === "remove" ? "base" : "head";
  const revision = change === "remove" ? from : to;
  const blobId = git("rev-parse", `${revision}:${source}`).toString().trim();
  for (const [index, ref] of revisions.entries()) {
    const id = git("rev-parse", `${ref}:${source}`).toString().trim();
    inputs.set(`/scanner/${id}`, {
      kind: "blob",
      id,
      bytes: git("show", `${ref}:${source}`),
      references: [{ source, mode: "100644", revision: ref, role: index === 0 ? "base" : "head" }],
    });
  }
  const classify = (decoder: "PLAIN" | "HTML", overrides: Record<string, unknown> = {}) => {
    const findings = entries
      .filter((entry) => entry.decoders.includes(decoder))
      .flatMap(({ raw, rawV2 = raw }) => {
        const url = new URL(rawV2);
        return [patchFile, `/scanner/${blobId}`].map((file) => ({
          SourceType: 15,
          DetectorType: 17,
          DetectorName: "URI",
          DecoderName: decoder,
          Verified: false,
          VerificationError: "synthetic verification error",
          Raw: raw,
          RawV2: rawV2,
          SourceMetadata: {
            Data: {
              Filesystem: {
                file,
                line:
                  inputs
                    .get(file)!
                    .bytes!.toString()
                    .split("\n")
                    .findIndex((line) => line.includes(rawV2)) + 1,
              },
            },
          },
          SecretParts: { host: url.host, username: url.username, password: url.password },
          ExtraData: null,
          StructuredData: null,
          ...overrides,
        }));
      });
    return classifyReviewedFixtureScan(
      183,
      Buffer.from(findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n"),
      Buffer.from(
        JSON.stringify({
          level: "info-0",
          logger: "trufflehog",
          msg: "finished scanning",
          trufflehog_version: "3.97.4",
          chunks: 1,
          bytes: content.length,
          verified_secrets: findings.filter((finding) => finding.Verified === true).length,
          unverified_secrets: findings.filter((finding) => finding.Verified !== true).length,
        }) + "\n",
      ),
      inputs,
    );
  };
  return { classify, role, inputs };
}

for (const source of [
  "skills/autoreview/tests/test_autoreview_hardening.py",
  ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
]) {
  for (const change of ["add", "remove"] as const) {
    test(`autoreview fixtures admit exact Git-generated ${change} lines at ${source}`, (t) => {
      const patch = fixturePatch(t, source, autoreviewFixtures(), change);
      for (const decoder of ["PLAIN", "HTML"] as const) {
        const result = patch.classify(decoder);
        assert.equal(result.kind, "classified", JSON.stringify(result));
        if (result.kind !== "classified") continue;
        const count = autoreviewFixtures().filter((entry) =>
          entry.decoders.includes(decoder),
        ).length;
        assert.equal(result.notices.length, count * 2);
        assert.ok(result.notices.every((notice) => notice.source === source));
        const findings = result.notices.flatMap((notice) => notice.findings);
        assert.ok(
          findings.every((finding) => finding.decoder === decoder && finding.role === patch.role),
        );
        assert.equal(findings.filter((finding) => finding.patch).length, count);
      }
    });
  }

  test(`autoreview fixtures refuse each one-byte literal change at ${source}`, (t) => {
    for (const [index, entry] of autoreviewFixtures().entries()) {
      const password = new URL(entry.raw).password;
      const changed = entry.raw.replace(`:${password}@`, `:${password.slice(0, -1)}x@`);
      assert.equal(changed.length, entry.raw.length);
      const entries = autoreviewFixtures().map((value, candidate) => ({
        ...value,
        raw: candidate === index ? changed : value.raw,
        line: value.line.replace(entry.raw, changed),
      }));
      const patch = fixturePatch(t, source, entries);
      for (const decoder of entry.decoders) {
        assert.equal(patch.classify(decoder).kind, "refused", `${index}/${decoder}`);
      }
    }
  });

  test(`autoreview exact lines supersede legacy value-only admission at ${source}`, (t) => {
    const entries = autoreviewFixtures();
    entries[0]!.line += " ";
    const patch = fixturePatch(t, source, entries);
    for (const decoder of ["PLAIN", "HTML"] as const) {
      const result = patch.classify(decoder);
      assert.equal(result.kind, "refused");
      if (result.kind === "refused") assert.equal(result.diagnostic.reason, "literal_mismatch");
    }
  });
}

function questionPromptFixture(): ReturnType<typeof autoreviewFixtures>[number] {
  const raw = ["https://", "operator", ":", "password", "@", "example.test"].join("");
  const rawV2 = `${raw}/sign`;
  return { raw, rawV2, line: `    "${rawV2}-in",`, decoders: ["PLAIN", "HTML"] };
}

const questionPromptSource = "ui/src/app/question-prompt.test.ts";

for (const change of ["add", "remove", "context"] as const) {
  test(`question URL rejection fixture admits exact Git-generated ${change} attribution`, (t) => {
    const patch = fixturePatch(t, questionPromptSource, [questionPromptFixture()], change);
    for (const decoder of ["PLAIN", "HTML"] as const) {
      const result = patch.classify(decoder);
      assert.equal(result.kind, "classified", JSON.stringify(result));
      if (result.kind !== "classified") continue;
      assert.ok(result.notices.every((notice) => notice.source === questionPromptSource));
      const findings = result.notices.flatMap((notice) => notice.findings);
      assert.ok(findings.some((finding) => finding.patch));
      assert.ok(findings.every((finding) => finding.decoder === decoder));
      if (change === "context") {
        assert.ok(findings.some((finding) => finding.role === "base"));
        assert.ok(findings.some((finding) => finding.role === "head"));
      } else {
        assert.ok(findings.every((finding) => finding.role === patch.role));
      }
    }
  });
}

for (const variant of ["literal", "line", "path", "mode", "verified", "decoder"] as const) {
  test(`question URL rejection fixture still refuses changed ${variant}`, (t) => {
    const entry = questionPromptFixture();
    if (variant === "literal") {
      entry.raw = entry.raw.replace("password", "passwore");
      entry.rawV2 = entry.rawV2!.replace("password", "passwore");
      entry.line = entry.line.replace("password", "passwore");
    } else if (variant === "line") {
      entry.line += " ";
    }
    const patch = fixturePatch(
      t,
      variant === "path" ? "ui/src/app/another-question.test.ts" : questionPromptSource,
      [entry],
    );
    if (variant === "mode") {
      for (const [file, input] of patch.inputs) {
        if (input.kind === "blob") {
          patch.inputs.set(file, {
            ...input,
            references: input.references.map((reference) => ({ ...reference, mode: "100755" })),
          });
        }
      }
    }
    const result = patch.classify(
      "HTML",
      variant === "verified"
        ? { Verified: true }
        : variant === "decoder"
          ? { DecoderName: "BASE64" }
          : {},
    );
    assert.equal(result.kind, "refused", JSON.stringify(result));
  });
}

function readinessPrivacyFixture(): ReturnType<typeof autoreviewFixtures>[number] {
  const raw = ["http://", "fixture-user", ":", "fixture-secret", "@", "proxy.invalid"].join("");
  return {
    raw,
    rawV2: raw,
    line: "      const privateDetail = `" + raw + '/${"x".repeat(2_048)}`;',
    decoders: ["PLAIN", "HTML"],
  };
}

const readinessPrivacySource = "test/helpers/openclaw-test-instance.test.ts";
for (const change of ["add", "remove", "context"] as const) {
  test("readiness privacy fixture admits exact Git-generated " + change + " attribution", (t) => {
    const patch = fixturePatch(t, readinessPrivacySource, [readinessPrivacyFixture()], change);
    for (const decoder of ["PLAIN", "HTML"] as const) {
      const result = patch.classify(decoder);
      assert.equal(result.kind, "classified", JSON.stringify(result));
      if (result.kind !== "classified") continue;
      assert.ok(result.notices.every((notice) => notice.source === readinessPrivacySource));
      const findings = result.notices.flatMap((notice) => notice.findings);
      assert.ok(findings.some((finding) => finding.patch));
      assert.ok(findings.every((finding) => finding.decoder === decoder));
      if (change === "context") {
        assert.ok(findings.some((finding) => finding.role === "base"));
        assert.ok(findings.some((finding) => finding.role === "head"));
      } else {
        assert.ok(findings.every((finding) => finding.role === patch.role));
      }
    }
  });
}
for (const variant of [
  "literal",
  "line",
  "path",
  "mode",
  "role",
  "verified",
  "decoder",
  "surrounding-expression",
  "extra-occurrence",
] as const) {
  test("readiness privacy fixture refuses changed " + variant, (t) => {
    const entry = readinessPrivacyFixture();
    if (variant === "literal") {
      const original = entry.raw;
      entry.raw = original.replace("proxy.invalid", "proxz.invalid");
      entry.rawV2 = entry.raw;
      entry.line = entry.line.replace(original, entry.raw);
    } else if (variant === "line") {
      entry.line += " ";
    } else if (variant === "surrounding-expression") {
      entry.line = entry.line.replace("2_048", "2_049");
    }
    const entries =
      variant === "extra-occurrence"
        ? [entry, { ...entry, line: entry.line + " // additional occurrence" }]
        : [entry];
    const patch = fixturePatch(
      t,
      variant === "path" ? "test/helpers/another-instance.test.ts" : readinessPrivacySource,
      entries,
    );
    if (variant === "mode" || variant === "role") {
      for (const [file, input] of patch.inputs) {
        if (input.kind !== "blob") continue;
        patch.inputs.set(file, {
          ...input,
          references: input.references.map((reference) =>
            variant === "mode"
              ? { ...reference, mode: "100755" }
              : { ...reference, role: "worktree" as const },
          ),
        });
      }
    }
    for (const decoder of ["PLAIN", "HTML"] as const) {
      const result = patch.classify(
        decoder,
        variant === "verified"
          ? { Verified: true }
          : variant === "decoder"
            ? { DecoderName: "BASE64" }
            : {},
      );
      assert.equal(result.kind, "refused", JSON.stringify(result));
    }
  });
}

function githubCheckLinkFixture(): ReturnType<typeof autoreviewFixtures>[number] {
  // Match the approved external fixture without adding another scan literal here.
  const raw = ["https://", "user", ":", "password", "@", "ci.example.com"].join("");
  const rawV2 = raw + "/log";
  return { raw, rawV2, line: '    "' + rawV2 + '",', decoders: ["PLAIN", "HTML"] };
}

function browserSessionFixture(): ReturnType<typeof autoreviewFixtures>[number] {
  const raw = [
    "https://",
    "browser-user",
    ":",
    "browser-password",
    "@",
    "browserless.example",
  ].join("");
  const rawV2 = raw + "/cdp";
  return { raw, rawV2, line: '    const cdpUrl = "' + rawV2 + '";', decoders: ["PLAIN", "HTML"] };
}

function exactUriFixtureTests(
  name: string,
  source: string,
  makeFixture: () => ReturnType<typeof autoreviewFixtures>[number],
) {
  for (const change of ["add", "remove", "context"] as const) {
    test(name + " fixture admits exact Git-generated " + change + " attribution", (t) => {
      const patch = fixturePatch(t, source, [makeFixture()], change);
      for (const decoder of ["PLAIN", "HTML"] as const) {
        const result = patch.classify(decoder);
        assert.equal(result.kind, "classified", JSON.stringify(result));
        if (result.kind !== "classified") continue;
        assert.ok(result.notices.every((notice) => notice.source === source));
        const findings = result.notices.flatMap((notice) => notice.findings);
        assert.ok(findings.some((finding) => finding.patch));
        assert.ok(findings.every((finding) => finding.decoder === decoder));
        if (change === "context") {
          assert.ok(findings.some((finding) => finding.role === "base"));
          assert.ok(findings.some((finding) => finding.role === "head"));
        } else {
          assert.ok(findings.every((finding) => finding.role === patch.role));
        }
      }
    });
  }
  for (const variant of [
    "literal",
    "line",
    "path",
    "mode",
    "role",
    "verified",
    "decoder",
    "extra-occurrence",
  ] as const) {
    test(name + " fixture refuses changed " + variant, (t) => {
      const entry = makeFixture();
      if (variant === "literal") {
        const original = entry.raw;
        entry.raw = original.replace("://", "://x");
        entry.rawV2 = entry.rawV2!.replace(original, entry.raw);
        entry.line = entry.line.replace(original, entry.raw);
      } else if (variant === "line") {
        entry.line += " ";
      }
      const entries =
        variant === "extra-occurrence"
          ? [entry, { ...entry, line: entry.line + " // extra" }]
          : [entry];
      const patch = fixturePatch(t, variant === "path" ? source + ".other" : source, entries);
      if (variant === "mode" || variant === "role") {
        for (const [file, input] of patch.inputs) {
          if (input.kind !== "blob") continue;
          patch.inputs.set(file, {
            ...input,
            references: input.references.map((reference) => ({
              ...reference,
              ...(variant === "mode" ? { mode: "100755" } : { role: "worktree" as const }),
            })),
          });
        }
      }
      const result = patch.classify(
        "HTML",
        variant === "verified"
          ? { Verified: true }
          : variant === "decoder"
            ? { DecoderName: "BASE64" }
            : {},
      );
      assert.equal(result.kind, "refused", JSON.stringify(result));
    });
  }
}

exactUriFixtureTests(
  "GitHub check-link",
  "extensions/github/src/detail-checks.test.ts",
  githubCheckLinkFixture,
);
exactUriFixtureTests(
  "browser session",
  "extensions/browser/src/browser/pw-session.connections.test.ts",
  browserSessionFixture,
);

exactUriFixtureTests(
  "TypeSafe local transport",
  "extensions/typesafe/src/local.transport.test.ts",
  () => {
    const raw = ["http://", "user", ":", "password", "@", "localhost:8009"].join("");
    return { raw, rawV2: raw, line: '  "' + raw + '",', decoders: ["PLAIN", "HTML"] };
  },
);

exactUriFixtureTests("Gateway question", "src/gateway/server-methods/question.test.ts", () => {
  const raw = ["https://", "fixture-user", ":", "fixture-password", "@", "example.test"].join("");
  const rawV2 = raw + "/connect";
  return { raw, rawV2, line: '    ["credentials", "' + rawV2 + '"],', decoders: ["PLAIN", "HTML"] };
});

test("source projection removes only host-selected patch fields and preserves input records", () => {
  const current = {
    filename: "source.ts",
    patch: "CURRENT_SOURCE",
    patchComplete: true,
    changes: 1,
  };
  const cached = { filename: "source.ts", patch: "CACHED_SOURCE", status: "modified" };
  const context = {
    pullFiles: [current],
    snapshot: { files: { items: [cached] } },
    comment: { patch: "UNATTRIBUTED_TEXT", body: "COMMENT_BODY" },
  };
  const before = JSON.stringify(context);
  const projected = JSON.parse(serializeReviewContext(context, [current, cached]));
  assert.deepEqual(projected.pullFiles, [{ filename: "source.ts", changes: 1 }]);
  assert.deepEqual(projected.snapshot.files.items, [{ filename: "source.ts", status: "modified" }]);
  assert.deepEqual(projected.comment, context.comment);
  assert.equal(JSON.stringify(context), before);
  assert.deepEqual(JSON.parse(serializeReviewContext(context)), context);
});

// Reassemble qualified synthetic literals so this policy test adds no contiguous URI credentials.
const crabboxConfigFixtures = [
  {
    source: "internal/providers/azuredynamicsessions/client_test.go",
    raw: ["https", "user:pass@pool.env.eastus.azurecontainerapps.io"].join("://"),
    rawV2: ["https", "user:pass@pool.env.eastus.azurecontainerapps.io"].join("://"),
    lines: [['\t\t"https', 'user:pass@pool.env.eastus.azurecontainerapps.io",'].join("://")],
  },
  {
    source: "internal/cli/config_test.go",
    raw: ["https", "alice:secret@example.test"].join("://"),
    rawV2: ["https", "alice:secret@example.test/images/ubuntu"].join("://"),
    lines: [
      ['\t\t"https', 'alice:secret@example.test/images/ubuntu.img?token=private#fragment",'].join(
        "://",
      ),
    ],
  },
  {
    source: "internal/providers/all/command_routing_test.go",
    raw: ["https", "user:secret@api.example"].join("://"),
    rawV2: ["https", "user:secret@api.example/root"].join("://"),
    lines: [
      [
        '\t\tcfg.Proxmox.APIURL = "https',
        'user:secret@api.example/root?view=1&api%5Fkey=secret&signature=secret#secret"',
      ].join("://"),
    ],
  },
  {
    source: "internal/providers/all/command_routing_test.go",
    raw: ["https", "api-user:api-secret@provider.example.test"].join("://"),
    rawV2: ["https", "api-user:api-secret@provider.example.test/path"].join("://"),
    lines: [
      ['\tconst rawURL = "https', 'api-user:api-secret@provider.example.test/path?view=1"'].join(
        "://",
      ),
      [
        '\t\t{"morph", "https',
        'api-user:api-secret@provider.example.test/path?view=1", "--morph-api-url"},',
      ].join("://"),
    ],
  },
  {
    source: "internal/providers/all/command_routing_test.go",
    raw: ["https", "user:secret@api.example.test"].join("://"),
    rawV2: ["https", "user:secret@api.example.test/path"].join("://"),
    lines: [['\t\t\tEndpoint: "https', 'user:secret@api.example.test/path",'].join("://")],
  },
  {
    source: "internal/providers/all/command_routing_test.go",
    raw: ["https", "pool-user:pool-pass@xcp-ng.example.test"].join("://"),
    rawV2: ["https", "pool-user:pool-pass@xcp-ng.example.test/path"].join("://"),
    lines: [
      ['\t\t\tAPIURL:       "https', 'pool-user:pool-pass@xcp-ng.example.test/path?view=1",'].join(
        "://",
      ),
    ],
  },
  {
    source: "internal/providers/all/claim_scope_test.go",
    raw: ["https", "user:pass@API.EXAMPLE"].join("://"),
    rawV2: ["https", "user:pass@API.EXAMPLE/graphql"].join("://"),
    lines: [
      [
        '\t\t{"railway legacy case and query", "rail", core.Config{Railway: core.RailwayConfig{APIURL: " https',
        'user:pass@API.EXAMPLE/graphql/?view=1 ", ProjectID: " proj ", EnvironmentID: " env "}}, "endpoint:https',
        'API.EXAMPLE/graphql/?view=1|project:proj|environment:env"},',
      ].join("://"),
    ],
  },
];

for (const [index, entry] of crabboxConfigFixtures.entries()) {
  test(`Crabbox config fixture ${index + 1} binds exact committed source witnesses`, () => {
    const file = "/scanner/crabbox-fixture";
    const reference = {
      source: entry.source,
      mode: "100644",
      revision: "a".repeat(40),
      role: "base" as const,
    };
    const nativeURL = new URL(entry.rawV2);
    // WHATWG URL normalizes host case; the scanner retains the original authority.
    const host = entry.rawV2.split("@")[1]!.split("/")[0]!;
    const finding = {
      SourceType: 15,
      DetectorType: 17,
      DetectorName: "URI",
      DecoderName: "PLAIN",
      Verified: false,
      VerificationError: "synthetic verification error",
      Raw: entry.raw,
      RawV2: entry.rawV2,
      SourceMetadata: { Data: { Filesystem: { file, line: 1 } } },
      SecretParts: { host, username: nativeURL.username, password: nativeURL.password },
      ExtraData: null,
      StructuredData: null,
    };
    const classify = (
      lines = entry.lines,
      references: Extract<StagedScanInput, { kind: "blob" | "worktree" }>["references"] = [
        reference,
        { ...reference, revision: "b".repeat(40), role: "head" },
      ],
      overrides: Record<string, unknown> = {},
      duplicate = false,
      complete = true,
    ) => {
      const observed = { ...finding, ...overrides };
      const findings = duplicate ? [observed, observed] : [observed];
      const bytes = Buffer.from(lines.join("\n") + "\n");
      return classifyReviewedFixtureScan(
        183,
        Buffer.from(findings.map((value) => JSON.stringify(value)).join("\n") + "\n"),
        Buffer.from(
          complete
            ? JSON.stringify({
                level: "info-0",
                logger: "trufflehog",
                msg: "finished scanning",
                trufflehog_version: "3.97.4",
                chunks: 1,
                bytes: bytes.length,
                verified_secrets: findings.filter((value) => value.Verified).length,
                unverified_secrets: findings.filter((value) => !value.Verified).length,
              }) + "\n"
            : "",
        ),
        new Map([[file, { kind: "blob", id: "a".repeat(40), bytes, references }]]),
      );
    };
    assert.equal(classify().kind, "classified");
    const refused = (label: string, result: ReturnType<typeof classify>) => {
      assert.equal(result.kind, "refused", label);
    };
    refused("line bytes", classify(entry.lines.map((line) => line + " ")));
    refused(
      "literal bytes",
      classify(
        entry.lines.map((line) => line.replace(entry.rawV2, entry.rawV2 + "x")),
        undefined,
        { RawV2: entry.rawV2 + "x" },
      ),
    );
    refused(
      "source path",
      classify(undefined, [{ ...reference, source: "internal/cli/unreviewed_test.go" }]),
    );
    refused("mode", classify(undefined, [{ ...reference, mode: "100755" }]));
    refused("role", classify(undefined, [{ ...reference, role: "worktree" }]));
    refused("decoder", classify(undefined, undefined, { DecoderName: "HTML" }));
    refused("verified", classify(undefined, undefined, { Verified: true }));
    refused("extra occurrence", classify([...entry.lines, entry.lines[0]!]));
    refused(
      "mixed references",
      classify(undefined, [reference, { ...reference, source: "unreviewed.go" }]),
    );
    refused("duplicate native record", classify(undefined, undefined, {}, true));
    refused("incomplete scan", classify(undefined, undefined, {}, false, false));
    if (entry.lines.length > 1) {
      refused("ordered witnesses", classify([...entry.lines].reverse()));
      refused("missing witness", classify(entry.lines.slice(0, 1)));
    }
  });
}
