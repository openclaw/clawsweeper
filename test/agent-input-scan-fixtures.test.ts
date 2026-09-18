import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
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

function autoreviewPatch(
  t: test.TestContext,
  source: string,
  entries: ReturnType<typeof autoreviewFixtures>,
  change: "add" | "remove" = "add",
) {
  const cwd = mkdtempSync(join(tmpdir(), "clawsweeper-autoreview-fixtures-"));
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
  const versions = change === "add" ? ["# fixture\n", content] : [content, "# fixture\n"];
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
  const role = change === "add" ? "head" : "base";
  const revision = change === "add" ? to : from;
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
  const classify = (decoder: "PLAIN" | "HTML") => {
    const findings = entries
      .filter((entry) => entry.decoders.includes(decoder))
      .flatMap(({ raw }) => {
        const url = new URL(raw);
        return [patchFile, `/scanner/${blobId}`].map((file) => ({
          SourceType: 15,
          DetectorType: 17,
          DetectorName: "URI",
          DecoderName: decoder,
          Verified: false,
          VerificationError: "synthetic verification error",
          Raw: raw,
          RawV2: raw,
          SourceMetadata: {
            Data: {
              Filesystem: {
                file,
                line:
                  inputs
                    .get(file)!
                    .bytes!.toString()
                    .split("\n")
                    .findIndex((line) => line.includes(raw)) + 1,
              },
            },
          },
          SecretParts: { host: url.host, username: url.username, password: url.password },
          ExtraData: null,
          StructuredData: null,
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
          verified_secrets: 0,
          unverified_secrets: findings.length,
        }) + "\n",
      ),
      inputs,
    );
  };
  return { classify, role };
}

for (const source of [
  "skills/autoreview/tests/test_autoreview_hardening.py",
  ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
]) {
  for (const change of ["add", "remove"] as const) {
    test(`autoreview fixtures admit exact Git-generated ${change} lines at ${source}`, (t) => {
      const patch = autoreviewPatch(t, source, autoreviewFixtures(), change);
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
      const patch = autoreviewPatch(t, source, entries);
      for (const decoder of entry.decoders) {
        assert.equal(patch.classify(decoder).kind, "refused", `${index}/${decoder}`);
      }
    }
  });

  test(`autoreview exact lines supersede legacy value-only admission at ${source}`, (t) => {
    const entries = autoreviewFixtures();
    entries[0]!.line += " ";
    const patch = autoreviewPatch(t, source, entries);
    for (const decoder of ["PLAIN", "HTML"] as const) {
      const result = patch.classify(decoder);
      assert.equal(result.kind, "refused");
      if (result.kind === "refused") assert.equal(result.diagnostic.reason, "literal_mismatch");
    }
  });
}
