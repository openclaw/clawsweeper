#!/usr/bin/env node
// Native admission proof. Run after building with pinned TruffleHog on PATH:
// node docs/proof/input-scan-approved-values/run-proof.mjs --out <receipt.json>
// Optional --module-root points at a different built revision for comparison.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { resolve, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !out) throw new Error("--out <receipt.json> is required");
const moduleRoot = args.includes("--module-root")
  ? resolve(args[args.indexOf("--module-root") + 1])
  : process.cwd();
const { scanAgentInput } = await import(
  pathToFileURL(join(moduleRoot, "dist/agent-input-scan.js")).href
);
const { TRUFFLEHOG_VERSION } = await import(
  pathToFileURL(join(moduleRoot, "dist/review-tool-bootstrap.js")).href
);
const root = realpathSync(mkdtempSync(join(tmpdir(), "approved-values-proof-")));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.invalid",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.invalid",
};
const git = (cwd, ...options) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...options], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  }).trim();
const sourceGitObservation = () => {
  let markerMissing = false;
  try {
    lstatSync(join(moduleRoot, ".git"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot inspect source Git marker");
    markerMissing = true;
  }
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: moduleRoot,
    env: { ...gitEnv, LC_ALL: "C" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 65_536,
  });
  if (
    markerMissing &&
    probe.status === 128 &&
    /^fatal: not a git repository(?: \(|:)/.test(probe.stderr)
  ) {
    return { head: null, sourceDirty: null, gitMetadata: "absent" };
  }
  if (probe.status !== 0 || realpathSync(probe.stdout.trim()) !== realpathSync(moduleRoot)) {
    throw new Error("Cannot identify proof source Git repository");
  }
  return {
    head: git(moduleRoot, "rev-parse", "HEAD"),
    sourceDirty: git(moduleRoot, "status", "--porcelain").length > 0,
    gitMetadata: "present",
  };
};
const approved = ["https://", "fixture-user:fixture-password@example.invalid"].join("");
const unreviewed = ["https://", "review_user:CSW_SYNTHETIC_NOT_A_SECRET_2201@"].join("");
const cases = [
  ["approved-value", approved, true],
  ["approved-value-surrounding-edit", "// unrelated edit\n" + approved, true],
  ["approved-password-only", ["https://:", "example-password@status.example"].join(""), true],
  ["changed-approved-password", approved.replace("fixture-password", "different-password"), false],
  ["unreviewed-reserved-host", unreviewed + "db.example.invalid/path", false],
  ["unreviewed-test-host", unreviewed + "db.example.test/path", false],
  ["unreviewed-loopback", unreviewed + "127.0.0.1:1/path", false],
  [
    "normalized-postgres-fixture",
    ["postgres", "://secret:secret@db.example.test/openclaw"].join(""),
    false,
  ],
  [
    "normalized-postgres-query-password",
    [
      "postgres",
      "://secret:secret@db.example.test/openclaw?hostaddr=192.0.2.20&",
      "password=CSW_SYNTHETIC_NOT_A_SECRET_NEW_2201&connect_timeout=1",
    ].join(""),
    false,
  ],
  [
    "normalized-postgres-target-override",
    [
      "postgres",
      "://secret:secret@db.example.test/openclaw?hostaddr=192.0.2.20&connect_timeout=1",
    ].join(""),
    false,
  ],
  [
    "jdbc-password-at",
    [
      "jdbc:sqlserver",
      "://db.company.internal:1433;databaseName=app;user=review_user;password=",
      "CSW_SYNTHETIC_NOT_A_SECRET_2201@example.test",
    ].join(""),
    false,
  ],
  [
    "postgres-hostaddr",
    [
      "postgresql",
      "://review_user:CSW_SYNTHETIC_NOT_A_SECRET_2201@db.example.invalid/app?",
      "hostaddr=192.0.2.20&connect_timeout=1",
    ].join(""),
    false,
  ],
  [
    "jdbc-cloudsql",
    [
      "jdbc:postgresql",
      "://db.example.invalid/app?user=review_user&password=CSW_SYNTHETIC_NOT_A_SECRET_2201&",
      "socketFactory=com.google.cloud.sql.postgres.SocketFactory&cloudSqlInstance=sample-project:us-central1:production",
    ].join(""),
    false,
  ],
  ["nonreserved-host", unreviewed + "db.company.internal/path", false],
];
let trajectoryFixtureBlob;
if (args.includes("--trajectory-source")) {
  const fixturePath = args[args.indexOf("--trajectory-source") + 1];
  assert.ok(fixturePath && !fixturePath.startsWith("--"), "Missing trajectory fixture path");
  const bytes = readFileSync(resolve(fixturePath));
  const blob = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
  assert.equal(blob, "121ac30b9bfae120aac724ec972a25f42c0a45c8", "Unexpected fixture blob");
  trajectoryFixtureBlob = blob;
  const source = bytes.toString("utf8");
  const literals = [...source.matchAll(/"(?:[^"\\\r\n]|\\.)*"/g)].flatMap((match) => {
    try {
      const value = JSON.parse(match[0]);
      return createHash("sha256").update(value).digest("hex") ===
        "62947f2f84906400f7b0c6ad013ce889e95256a5c7dcbc82d982450ab6f4d1b1"
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  assert.equal(literals.length, 1, "Missing unique reviewed fixture literal");
  const literal = literals[0];
  const replaceUri = (update) => {
    const uri = new URL(literal);
    update(uri);
    const changed = source.replace(JSON.stringify(literal), JSON.stringify(uri.href));
    assert.ok(changed !== source, "Fixture mutation did not change source");
    return changed;
  };
  const unknown = new URL(literal);
  unknown.username += "-unreviewed";
  unknown.password += "-unreviewed";
  cases.unshift(
    ["trajectory-source", source, true],
    ["trajectory-surrounding-edit", source + "\n// Unrelated surrounding edit.\n", true],
    ["trajectory-changed-user", replaceUri((uri) => (uri.username += "-unreviewed")), false],
    ["trajectory-changed-password", replaceUri((uri) => (uri.password += "-unreviewed")), false],
    ["trajectory-changed-host", replaceUri((uri) => (uri.hostname = "unreviewed.example.test")), false],
    [
      "trajectory-changed-path",
      replaceUri((uri) => {
        const pathname = uri.pathname;
        uri.pathname = pathname.replace(/[A-Za-z]/, (letter) => (letter === "z" ? "y" : "z"));
        assert.ok(uri.pathname !== pathname, "Fixture pathname did not change");
      }),
      false,
    ],
    [
      "trajectory-mixed-unknown",
      source + `\nconst unreviewedFixture = ${JSON.stringify(unknown.href)};\n`,
      false,
    ],
  );
}
const approvedNotice = (message) => {
  if (typeof message !== "string") return null;
  let notice;
  try {
    notice = JSON.parse(message);
  } catch {
    return null;
  }
  if (
    notice?.event !== "agent_input_scan_classified" ||
    notice.classification !== "approved_value" ||
    notice.detector !== "URI" ||
    !Array.isArray(notice.findings) ||
    !notice.findings.every(
      (finding) =>
        typeof finding?.blob === "string" &&
        /^(?:prompt|[a-f0-9]{40}|[0-9]+)$/.test(finding.blob) &&
        Number.isSafeInteger(finding.scannerLine) &&
        finding.scannerLine > 0 &&
        ["PLAIN", "HTML", "BASE64", "ESCAPED_UNICODE"].includes(finding.decoder) &&
        Number.isSafeInteger(finding.occurrences) &&
        finding.occurrences > 0,
    )
  ) {
    return null;
  }
  return {
    event: notice.event,
    classification: notice.classification,
    detector: notice.detector,
    findings: notice.findings.map(({ blob, scannerLine, decoder, occurrences }) => ({
      blob,
      scannerLine,
      decoder,
      occurrences,
    })),
  };
};
const results = [];
try {
  const scanner = execFileSync("trufflehog", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(scanner, `trufflehog ${TRUFFLEHOG_VERSION}`);
  scenarios: for (const [name, value, expected] of cases) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "fixture.txt"), "// before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "base");
    const baseSha = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "fixture.txt"), name === "trajectory-source" ? value : value + "\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const headSha = git(cwd, "rev-parse", "HEAD");
    if (name === "trajectory-source") {
      assert.ok(
        git(cwd, "rev-parse", `${headSha}:fixture.txt`) === trajectoryFixtureBlob,
        "Committed fixture blob changed",
      );
    }
    for (const surface of ["prompt", "committed"]) {
      let admitted = true,
        reason,
        diagnostic;
      const notices = [];
      const originalConsoleError = console.error;
      console.error = (...values) => {
        originalConsoleError(...values);
        const notice = values.length === 1 ? approvedNotice(values[0]) : null;
        if (notice) notices.push(notice);
      };
      try {
        scanAgentInput({
          cwd,
          prompt: surface === "prompt" ? value : "Review the fixture change.",
          source:
            surface === "prompt" ? { kind: "prompt" } : { kind: "committed", baseSha, headSha },
          timeoutMs: 60_000,
        });
      } catch (error) {
        admitted = false;
        reason = error.reason;
        if (error.scanDiagnostic?.kind === "unclassified_finding") {
          const { kind, reason, detectorType, decoder, verified } = error.scanDiagnostic;
          diagnostic = { kind, reason, detectorType, decoder, verified };
        }
        // Infrastructure failures do not establish that the credential was detected.
        if (reason !== "findings") throw error;
      } finally {
        console.error = originalConsoleError;
      }
      const requiredApprovedNotice =
        name === "trajectory-source"
          ? surface === "committed"
            ? { blob: trajectoryFixtureBlob }
            : { blob: "prompt" }
          : undefined;
      const requiredNoticeMatched =
        !requiredApprovedNotice ||
        notices.some((notice) =>
          notice.findings.some(
            (finding) =>
              finding.blob === requiredApprovedNotice.blob &&
              (!requiredApprovedNotice.decoder ||
                finding.decoder === requiredApprovedNotice.decoder),
          ),
        );
      results.push({
        name,
        surface,
        expected,
        admitted,
        ...(reason ? { reason } : {}),
        ...(diagnostic ? { diagnostic } : {}),
        ...(notices.length ? { approvedNotices: notices } : {}),
        ...(requiredApprovedNotice ? { requiredApprovedNotice, requiredNoticeMatched } : {}),
      });
      if (expected !== admitted || !requiredNoticeMatched) break scenarios;
    }
  }
  const scannerFile = process.env.PATH.split(delimiter)
    .map((dir) => join(dir, "trufflehog"))
    .find((file) => {
      try {
        return readFileSync(file).length > 0;
      } catch {
        return false;
      }
    });
  const receipt = {
    ...sourceGitObservation(),
    platform: `${platform()}-${arch()}`,
    node: process.version,
    scanner,
    scannerSha256: createHash("sha256").update(readFileSync(scannerFile)).digest("hex"),
    ...(trajectoryFixtureBlob ? { trajectoryFixtureBlob } : {}),
    results,
    passed: results.every((r) => r.expected === r.admitted && r.requiredNoticeMatched !== false),
    limits:
      "Synthetic inputs and native admission only; no model call or live database authentication. Verification/error contracts additionally covered by focused tests.",
  };
  writeFileSync(resolve(out), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({ passed: receipt.passed, scenarios: results.length, head: receipt.head }),
  );
  assert.equal(receipt.passed, true, "admission differs from expected; inspect receipt");
} finally {
  rmSync(root, { recursive: true, force: true });
}
