#!/usr/bin/env node
// Offline contract: preserve evidence identity in both comment paths; diagnose storage honestly.
// Run after compilation: node docs/proof/review-evidence-identity/run-proof.mjs
// Same-input baseline: append --module /absolute/baseline/dist/clawsweeper.js (expected exit 1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--module" || !isAbsolute(args[1]))) {
  throw new Error("Usage: run-proof.mjs [--module /absolute/dist/clawsweeper.js]");
}
const modulePath = args[1] ?? join(root, "dist/clawsweeper.js");
const compiled = dirname(modulePath);
const { renderReviewCommentFromReport: render } = await import(pathToFileURL(modulePath).href);
const { dataModelChangeFromContext: classify } = await import(
  pathToFileURL(join(compiled, "clawsweeper-change-detection.js")).href
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixturePath = "test/fixtures/persistence-classifier-134934.json";
const fixtureBytes = readFileSync(join(root, fixturePath));
const fixture = JSON.parse(fixtureBytes);
const sha = "78c290807ce710180111df227df3b7a4fe845452";
const file = "codex-rs/core/config.schema.json";
const sourceUrl = `https://github.com/openai/codex/blob/${sha}/${file}#L5668`;
const commitUrl = `https://github.com/openai/codex/commit/${sha}`;
const syntheticHead = "c".repeat(40);
const failures = [];
const check = (name, condition) => {
  if (!condition) failures.push(name);
};
const urls = (text) => [
  ...new Set(text.match(/https:\/\/github\.com\/[^\s)]+\/(?:blob|commit)\/[^\s)]+/g) ?? []),
];

// Host completion/head/proof fields are synthetic inputs, never live review receipts.
function report(kind, evidence = "", detection = { change: false, surfaces: [] }) {
  const fields = {
    repository: "openclaw/openclaw",
    type: "pull_request",
    number: 999999,
    decision: kind,
    close_reason: kind === "close" ? "implemented_on_main" : "none",
    action_taken: kind === "close" ? "proposed_close" : "kept_open",
    confidence: "high",
    review_status: "complete",
    local_checkout_access: "verified",
    local_checkout_access_source: "runner_preflight_v1",
    pull_head_sha: syntheticHead,
    main_sha: "a".repeat(40),
    work_candidate: "none",
    labels: '["clawsweeper:automerge"]',
    real_behavior_proof_status: "sufficient",
    real_behavior_proof_needs_contributor_action: false,
    data_model_change: detection.change,
    data_model_surfaces: JSON.stringify(detection.surfaces),
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n
## Summary

Synthetic completed review for offline renderer proof only.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none

## Evidence

${evidence}\n`;
}

const evidenceResults = [];
for (const kind of ["close", "keep_open"]) {
  for (const [name, metadata, linked] of [
    [
      "historical",
      `  - file: [${file}:5668](${sourceUrl})\n  - sha: [78c290807ce7](${commitUrl})`,
      true,
    ],
    [
      "explicit-repo",
      `  - repo: openai/codex\n  - file: \`${file}:5668\`\n  - sha: \`${sha}\``,
      true,
    ],
    ["unknown", `  - repo: null\n  - file: \`${file}:5668\`\n  - sha: \`${sha}\``, false],
    ["sibling", `  - repo: null\n  - file: \`../codex/${file}:5668\`\n  - sha: \`${sha}\``, false],
  ]) {
    const input = report(kind, `- **${name}:** Pinned source identity only.\n${metadata}`);
    const comment = render(input, kind === "close" ? "implemented_on_main" : "none");
    const line = comment.split("\n").find((entry) => entry.startsWith(`- **${name}:`)) ?? "";
    const observedUrls = urls(line);
    const complete = !/did not complete|infrastructure failure/.test(comment);
    check(`${kind}/${name}: evidence retained and complete`, Boolean(line) && complete);
    check(
      `${kind}/${name}: identity`,
      linked
        ? observedUrls.includes(sourceUrl) &&
            observedUrls.includes(commitUrl) &&
            observedUrls.length === 2
        : observedUrls.length === 0 && line.includes(file),
    );
    check(
      `${kind}/${name}: verdict`,
      comment.includes(`clawsweeper-verdict:${kind === "close" ? "close" : "pass"}`),
    );
    evidenceResults.push({ kind, name, inputSha256: hash(input), observedUrls, complete });
  }
}

// Synthetic production-path controls change actual SQL/vector fields, not just diagnostic names.
const storageResults = [];
for (const [name, pullFiles, expected] of [
  ["captured-diagnostics", fixture.pullFiles, false],
  [
    "production-sql",
    [
      {
        filename: "src/runtime/database.ts",
        patch: "@@ -1,2 +1,3 @@\n CREATE TABLE sessions (\n+  revision INTEGER,\n );",
      },
    ],
    true,
  ],
  [
    "production-vector",
    [
      {
        filename: "src/memory/vector-store.ts",
        patch: "@@ -1 +1 @@\n-  embeddingDimension: 768,\n+  embeddingDimension: 1024,",
      },
    ],
    true,
  ],
]) {
  const detection = classify("openclaw/openclaw", {
    issue: {},
    comments: [],
    timeline: [],
    pullFiles,
  });
  const comment = render(report("keep_open", "", detection), "none");
  const warning = /Persistent data-model change detected|### Stored data model/.test(comment);
  const migrationGate = /Confirm migration or upgrade compatibility proof/.test(comment);
  const humanGate = comment.includes("clawsweeper-verdict:needs-human");
  const pass = comment.includes("clawsweeper-verdict:pass");
  check(
    `${name}: classification`,
    detection.change === expected && Boolean(detection.surfaces.length) === expected,
  );
  check(
    `${name}: warning/gates`,
    warning === expected &&
      migrationGate === expected &&
      humanGate === expected &&
      pass === !expected,
  );
  check(`${name}: complete`, !/did not complete|infrastructure failure/.test(comment));
  storageResults.push({ name, detection, warning, migrationGate, humanGate, pass });
}

console.log(
  JSON.stringify({
    passed: failures.length === 0,
    failures,
    environment: { node: process.version, platform: process.platform },
    candidateHead: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    expectedBaselineSourceHead: "48bd2b42f1dd0504c9afc8643c9781290604b3b2",
    modulePath,
    recipeSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    compiledSha256: Object.fromEntries(
      [
        "clawsweeper.js",
        "clawsweeper-runtime.js",
        "clawsweeper-change-detection.js",
        "clawsweeper-links.js",
        "clawsweeper-report-parser.js",
      ].map((name) => [name, hash(readFileSync(join(compiled, name)))]),
    ),
    fixture: {
      path: fixturePath,
      sha256: hash(fixtureBytes),
      pullRequest: fixture.pullRequest,
      headSha: fixture.headSha,
      mergeCommit: fixture.mergeCommit,
      provenance: fixture.provenance,
      sourceSha256: fixture.sourceSha256,
      sourceComment: "https://github.com/openclaw/openclaw/pull/134934#issuecomment-5490161955",
    },
    source: {
      repo: "openai/codex",
      sha,
      file,
      line: 5668,
      sourceUrl,
      commitUrl,
      inspectedBlobSha256: "ed663d6d4c6c8b36917596882414c93858f6cf9ca5449ea8c616fc76d1aac114",
      provenance:
        "Author inspected sibling checkout origin and git-show pinned blob; no runtime sibling dependency.",
    },
    evidenceResults,
    storageResults,
    limits:
      "Offline compiled renderer/classifier only; synthetic host/review/proof metadata and SQL/vector controls. No GitHub, providers, publication, translation execution, or stored-data upgrade exercised. Candidate HEAD is not build attestation; caller must record selected build provenance. No source/schema/decision roundtrip repetition. Bay observer contract unchanged.",
  }),
);
process.exitCode = failures.length ? 1 : 0;
