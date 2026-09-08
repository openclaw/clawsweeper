#!/usr/bin/env node
// Offline detector -> synthetic report -> production comment rendering. See README.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const repoRoot = fileURLToPath(root);
const baselineRevision = "66af14ef3f725f5ecb1c0ab8f6b085cc40b3d642";
const detectorPath = "src/clawsweeper-change-detection.ts";
const fixturePath = "test/fixtures/persistence-classifier-138520.json";
const scriptPath = "docs/proof/persisted-model-diagnostics/run-proof.mjs";
const patchSha256 = "3a22d69f12982663c8dee1569c7c26ffdeba97777a7b0d6c8bd3516d357130de";
const negativeCases = [
  "exact-pr-138520",
  "normalized-pr-138520",
  "sqlite-diagnostics-missing-patch",
  "stdout-diagnostics",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFileSync(new URL(path, root));
const git = (...args) =>
  execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

// The renderer's readiness preconditions are deliberately fixture values, not
// attestations about a host, checkout, model review, or actual compatibility run.
function report(detection, sqlite, withProof) {
  return `---
repository: openclaw/openclaw
type: pull_request
number: 999999
decision: keep_open
close_reason: none
action_taken: kept_open
confidence: high
review_status: complete
review_lease_owner: synthetic-offline-fixture
review_lease_comment_id: 1059
reviewed_at: 2026-09-04T00:00:00Z
local_checkout_access: verified
local_checkout_access_source: runner_preflight_v1
pull_head_sha: ${"c".repeat(40)}
main_sha: ${"a".repeat(40)}
work_candidate: none
labels: ["clawsweeper:automerge"]
real_behavior_proof_status: sufficient
real_behavior_proof_needs_contributor_action: false
data_model_change: ${detection.change}
data_model_surfaces: ${JSON.stringify(detection.surfaces)}
sqlite_schema_change: ${sqlite.change}
sqlite_schema_files: ${JSON.stringify(sqlite.files)}
---

## Summary

Synthetic completed review for offline detector-to-render proof only.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none

## Solution Assessment

${
  withProof
    ? "The migration is tested against an existing database and preserves upgrade compatibility."
    : "No migration or upgrade compatibility proof supplied."
}
`;
}

function markers(comment) {
  return {
    sqliteTableWarning: comment.includes("**SQLite table change**"),
    persistedModelWarning: comment.includes("Persistent data-model change detected:"),
    compatibilityGate: comment.includes("Confirm migration or upgrade compatibility proof"),
    humanVerdict: comment.includes("clawsweeper-verdict:needs-human"),
    passVerdict: comment.includes("clawsweeper-verdict:pass"),
  };
}

async function main() {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node >=24 is required");
  assert.ok(
    process.argv.slice(2).every((arg) => arg === "--baseline") && process.argv.length <= 3,
    "Usage: node docs/proof/persisted-model-diagnostics/run-proof.mjs [--baseline]",
  );
  const baseline = process.argv.includes("--baseline");
  // Bounded owner inventory, not a claim to hash the complete transitive module graph.
  const owners = [
    "clawsweeper-change-detection",
    "openclaw-file-role",
    "clawsweeper-context-hydration",
    "clawsweeper-text",
    "clawsweeper-item-policy",
    "clawsweeper",
    "clawsweeper-runtime",
    "clawsweeper-report-orchestration",
    "clawsweeper-orchestration-foundation",
    "clawsweeper-report-comment-helpers",
    "clawsweeper-report-comment-presentation",
    "clawsweeper-report-parser",
  ];
  for (const owner of owners) {
    assert.ok(
      existsSync(new URL(`dist/${owner}.js`, root)),
      `Missing dist/${owner}.js; have the build owner run pnpm run build first`,
    );
  }

  const fixtureBytes = read(fixturePath);
  const fixture = JSON.parse(fixtureBytes);
  assert.equal(fixture.pullRequest, "https://github.com/openclaw/openclaw/pull/138520");
  assert.equal(fixture.headSha, "e87dc59f30bfb77dad91d8f9229839a350fad3f7");
  assert.equal(fixture.pullFiles.length, 1);
  const file = fixture.pullFiles[0];
  assert.equal(file.filename, "src/infra/sqlite-readonly-location.worker.ts");
  assert.equal(file.patch.length, 2090, "Use the exact API patch, without a final added LF");
  assert.equal(sha256(file.patch), patchSha256, "Pinned API patch bytes must not drift");

  const { createContextHydration } = await import(
    new URL("dist/clawsweeper-context-hydration.js", root)
  );
  const { asRecord } = await import(new URL("dist/clawsweeper-item-policy.js", root));
  const unavailable = () => {
    throw new Error(
      "Unused hydration dependency called: offline proof must not use external capabilities",
    );
  };
  const { compactPullFile } = createContextHydration(
    new Proxy(
      { asRecord },
      {
        get: (target, key) => (Object.hasOwn(target, key) ? target[key] : unavailable),
      },
    ),
  );
  const normalized = compactPullFile(file);
  assert.equal(normalized.filename, file.filename);
  assert.equal(
    normalized.patch,
    `${file.patch.slice(0, 2000)}\n\n[truncated 90 chars]`,
    "Production compactPullFile must retain the exact prefix and truncation marker",
  );

  let detectorUrl = new URL("dist/clawsweeper-change-detection.js", root).href;
  let detectorInput = read("dist/clawsweeper-change-detection.js");
  if (baseline) {
    // Only this pinned detector is historical. Resolve its sole runtime import
    // to the current production role classifier; do not rewrite detector logic.
    detectorInput = git("show", `${baselineRevision}:${detectorPath}`);
    const stripped = stripTypeScriptTypes(detectorInput);
    const roleImport = '"./openclaw-file-role.js"';
    assert.equal(stripped.split(roleImport).length, 2, "Expected one production role import");
    const code = stripped.replace(
      roleImport,
      JSON.stringify(new URL("dist/openclaw-file-role.js", root).href),
    );
    detectorUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  }
  const { dataModelChangeFromContext, sqliteSchemaChangeFromContext } = await import(detectorUrl);
  const { renderReviewCommentFromReport } = await import(new URL("dist/clawsweeper.js", root));

  const cases = [
    ...[
      "src/boards/sqlite-board-store.ts",
      "src/boards/sqlite-board-codec.ts",
      "src/infra/sqlite-audit-record-store.ts",
      "src/infra/sqlite-index-schema.ts",
      "src/infra/sqlite-user-version.ts",
    ].flatMap((filename) => [
      { name: `actual-owner-missing/${filename}`, filename, patch: null, expected: true },
      {
        name: `actual-owner-json/${filename}`,
        filename,
        expected: true,
        patch:
          "@@ -1 +1 @@\n-const raw = JSON.stringify(payload);\n+const raw = JSON.stringify(payload, null, 2);",
      },
      {
        name: `actual-owner-json-fields/${filename}`,
        filename,
        expected: true,
        patch: "@@\n const raw = JSON.stringify({\n+  payloadVersion: 2,\n });",
      },
    ]),
    { name: "exact-pr-138520", ...file, expected: false },
    { name: "normalized-pr-138520", ...normalized, expected: false },
    {
      name: "sql-table-column",
      filename: "src/runtime/database.ts",
      expected: true,
      patch: "@@ -1,2 +1,3 @@\n CREATE TABLE sessions (\n+  revision INTEGER,\n );",
    },
    {
      name: "persisted-json",
      filename: "src/runtime/state-store.ts",
      expected: true,
      patch:
        "@@ -1 +1 @@\n-fs.writeFileSync(statePath, JSON.stringify({ version: 1 }));\n+fs.writeFileSync(statePath, JSON.stringify({ version: 2 }));",
    },
    {
      name: "sqlite-store-missing-patch",
      filename: "src/cache/sqlite-store.ts",
      patch: null,
      expected: true,
    },
    {
      name: "sqlite-diagnostics-missing-patch",
      filename: file.filename,
      patch: null,
      expected: false,
    },
    {
      name: "same-hunk-storage",
      filename: "src/runtime/controller.ts",
      expected: true,
      patch:
        "@@ -1,4 +1,4 @@\n const record = {\n-  version: 1,\n+  version: 2,\n };\n fs.writeFileSync(statePath, JSON.stringify(record));",
    },
    {
      name: "stdout-diagnostics",
      filename: "src/runtime/diagnostics.ts",
      expected: false,
      patch:
        "@@ -1 +1 @@\n-process.stdout.write(JSON.stringify({ message: oldMessage }));\n+process.stdout.write(JSON.stringify({ message: newMessage }));",
    },
    {
      name: "mixed-stdout-and-sql",
      filename: file.filename,
      expected: true,
      patch: `${file.patch}\n@@ -80 +56 @@\n-db.exec("CREATE TABLE sessions (id TEXT)");\n+db.exec("CREATE TABLE sessions (id TEXT, revision INTEGER)");`,
    },
  ];
  assert.equal(cases.length, 24);
  assert.deepEqual(
    cases.filter((entry) => !entry.expected).map((entry) => entry.name),
    negativeCases,
  );

  const results = cases.map(({ name, filename, patch, expected }) => {
    const context = { issue: {}, comments: [], timeline: [], pullFiles: [{ filename, patch }] };
    const detection = dataModelChangeFromContext("openclaw/openclaw", context);
    const sqlite = sqliteSchemaChangeFromContext("openclaw/openclaw", context);
    const comment = renderReviewCommentFromReport(report(detection, sqlite, false), "none");
    const provedComment = renderReviewCommentFromReport(report(detection, sqlite, true), "none");
    const withoutProof = markers(comment);
    const withProof = markers(provedComment);
    const checks = {
      persistedClassification: detection.change === expected,
      persistedSurfaces: detection.surfaces.length > 0 === expected,
      persistedWarning: withoutProof.persistedModelWarning === expected,
      provedPersistedWarning: withProof.persistedModelWarning === expected,
      compatibilityGate: withoutProof.compatibilityGate === expected,
      humanVerdict: withoutProof.humanVerdict === expected,
      passVerdict: withoutProof.passVerdict === !expected,
      sqliteFilesMatchClassification: sqlite.files.length > 0 === sqlite.change,
      sqliteWarningMatchesClassification: withoutProof.sqliteTableWarning === sqlite.change,
      provedSqliteWarningMatchesClassification: withProof.sqliteTableWarning === sqlite.change,
      negativeHasNoSqliteClassification: expected || sqlite.change === false,
      negativeHasNoSqliteWarning: expected || withoutProof.sqliteTableWarning === false,
      compatibilityProofAccepted:
        withProof.passVerdict && !withProof.humanVerdict && !withProof.compatibilityGate,
    };
    return {
      name,
      expected,
      detection,
      sqlite,
      patchLength: patch?.length ?? null,
      withoutProof,
      withProof,
      renderedSha256: { withoutProof: sha256(comment), withProof: sha256(provedComment) },
      failedChecks: Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key),
    };
  });
  const failures = results
    .filter((result) => result.failedChecks.length > 0)
    .map((result) => result.name);
  const controlsPassed = results
    .filter((result) => result.expected)
    .every((result) => result.failedChecks.length === 0);
  const sourceHashes = Object.fromEntries(
    owners.map((owner) => [`src/${owner}.ts`, sha256(read(`src/${owner}.ts`))]),
  );
  const compiledHashes = Object.fromEntries(
    owners.map((owner) => [`dist/${owner}.js`, sha256(read(`dist/${owner}.js`))]),
  );
  console.log(
    JSON.stringify(
      {
        passed: failures.length === 0,
        mode: baseline ? "baseline" : "candidate",
        scenarioCount: results.length,
        failures,
        controlsPassed,
        expectedOutcomeObserved: baseline
          ? controlsPassed && JSON.stringify(failures) === JSON.stringify(negativeCases)
          : failures.length === 0,
        provenance: {
          sourceHead: git("rev-parse", "HEAD").trim(),
          sourceWorkingDiffSha256: sha256(
            git("diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "src"),
          ),
          baselineRevision,
          detector: {
            inputKind: baseline
              ? "pinned TypeScript stripped in memory"
              : "compiled candidate JavaScript",
            inputSha256: sha256(detectorInput),
          },
          script: { path: scriptPath, sha256: sha256(read(scriptPath)) },
          fixture: {
            path: fixturePath,
            sha256: sha256(fixtureBytes),
            pullRequest: fixture.pullRequest,
            headSha: fixture.headSha,
          },
          patch: {
            sha256: sha256(file.patch),
            length: file.patch.length,
            normalizedSha256: sha256(normalized.patch),
            normalizedLength: normalized.patch.length,
          },
          environment: {
            provider: "local-node",
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            image: null,
            lease: null,
          },
          sourceHashes,
          compiledHashes,
        },
        results,
        limits:
          "Offline detector-to-render replay with synthetic report readiness and compatibility text, not live review attestations. Baseline replaces only the two detector API inputs; current compiled role classifier, hydration, renderer and all emitter dependencies remain shared, including renderer-internal proof parsing. Owner hashes are bounded, not a complete dependency manifest or build-freshness attestation. No live model, GitHub publication, data migration, OpenClaw runtime, or Bay execution.",
      },
      null,
      2,
    ),
  );
  // Baseline deliberately fails the same desired-behavior assertions; never turn
  // its known regression into a successful exit or weaken the control checks.
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  // Keep even setup-error output portable; do not dump an import stack or host path.
  const message = error instanceof Error ? error.message : "Unknown proof error";
  console.error(message.replaceAll(root.href, "<repo>/").replaceAll(repoRoot, "<repo>/"));
  process.exitCode = 2;
});
