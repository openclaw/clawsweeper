import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, delimiter } from "node:path";
import { writePreparedReviewReport } from "../dist/clawsweeper-review-item.js";
import { markdownFor } from "../dist/clawsweeper-report-document.js";
import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { reviewActionForDecision } from "../dist/clawsweeper-review-action.js";
import { validateReportClose } from "../dist/clawsweeper-apply-close-decision.js";
import { validateCloseDecision } from "../dist/clawsweeper-close-decision.js";
import { readReviewRecord } from "../dist/review-record.js";
import { credentialPublicationBlocked } from "../dist/publication-dlp.js";
import { runCodexForTest } from "../dist/clawsweeper.js";
import { writeFakeScanner } from "../test/agent-input-scan-helpers.ts";
import { closeDecision, item } from "../test/helpers.ts";

const root = resolve(process.argv[2] ?? ".artifacts/publication-dlp-proof");
const itemsDir = join(root, "items");
mkdirSync(itemsDir, { recursive: true });
const original = process.env;
const token = "synthetic-publication-proof-capability";
const originalError = console.error;
let redactions = 0;
console.error = (...args) => {
  if (
    typeof args[0] === "string" &&
    args[0].startsWith('{"event":"publication_credential_redaction"')
  ) {
    redactions += JSON.parse(args[0]).redactions;
  }
  originalError(...args);
};
try {
  process.env = { PATH: original.PATH, HOME: original.HOME, GH_TOKEN: token };
  const subject = item({ repo: "openclaw/clawsweeper" });
  const result = writePreparedReviewReport(
    {
      item: subject,
      context: { issue: {}, comments: [], timeline: [] },
      decision: {
        ...closeDecision({ summary: `Fixture evidence ${token} and ghs_${"x".repeat(36)}` }),
        localCheckoutAccess: "verified",
      },
      git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
      runtime: { model: "Codex", reasoningEffort: "high" },
      artifactDir: itemsDir,
      snapshotHash: "synthetic-snapshot",
      contentDigest: "synthetic-content",
      reviewPolicy: "synthetic-policy",
      structuralRecord: null,
      itemLocalReviewHistoryPath: null,
      previousLocalReviewCommentBody: "",
      localRange: false,
      metadataBytes: 1024 * 1024,
      writeOutputReport: (_item, path, markdown) => writeFileSync(path, markdown),
      writeOutputMetadata: (path, markdown) => writeFileSync(path, markdown),
    },
    {
      reviewActionForDecision,
      reportFileName: (_repo, number) => `${number}.md`,
      markdownFor,
      renderReviewCommentFromReport,
    },
  );
  const markdown = readFileSync(result.reportPath, "utf8");
  const comment = renderReviewCommentFromReport(markdown, "none");
  writeFileSync(join(root, "comment.md"), comment);
  for (const content of [markdown, comment]) {
    assert.ok(content.includes("[redacted credential]"));
    assert.ok(!content.includes(token));
    assert.ok(!content.includes(`ghs_${"x".repeat(36)}`));
  }
  assert.match(markdown, /^review_status: failed$/m);
  const record = readReviewRecord(markdown);
  assert.ok(credentialPublicationBlocked(record.decision));
  assert.ok(redactions >= 2);
  const guard = validateReportClose(
    { validateCloseDecision },
    subject,
    markdown,
    "implemented_on_main",
    { requireCloseComment: false },
  );
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /attempted to publish a credential/);
  const denyGh = join(root, "deny-github.mjs");
  writeFileSync(denyGh, 'throw new Error("Proof forbids every GitHub request");\n');
  const runApply = () =>
    spawnSync(
      process.execPath,
      [
        "dist/clawsweeper.js",
        "apply-decisions",
        "--target-repo",
        subject.repo,
        "--items-dir",
        itemsDir,
        "--closed-dir",
        join(root, "closed"),
        "--plans-dir",
        join(root, "plans"),
        "--report-path",
        join(root, "apply.json"),
        "--skip-dashboard",
        "--item-number",
        String(subject.number),
        "--dry-run",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, GH_BIN: process.execPath, GH_BIN_ARGS: JSON.stringify([denyGh]) },
      },
    );
  const apply = runApply();
  writeFileSync(join(root, "apply.log"), `${apply.stdout}\n${apply.stderr}`);
  assert.equal(apply.status, 0, `apply failed: ${apply.stderr}`);
  const applied = JSON.parse(readFileSync(join(root, "apply.json"), "utf8"));
  assert.ok(Array.isArray(applied));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].number, subject.number);
  assert.equal(applied[0].action, "kept_open");
  writeFileSync(join(root, "decision-time.md"), markdown);
  const checkout = join(root, "repair-checkout");
  const bin = join(root, "bin");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFakeScanner(bin);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(
    join(checkout, "tracked.txt"),
    "Synthetic tracked checkout for round five proof.\n",
  );
  git("add", "tracked.txt");
  git(
    "-c",
    "user.name=Proof",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  );
  const fakeCodex = join(bin, "codex");
  const homeTrace = join(root, "repair-home.jsonl");
  writeFileSync(homeTrace, "");
  const cleanClose = closeDecision({ summary: "Clean repaired close decision." });
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(homeTrace)}, JSON.stringify({ home: process.env.HOME, files: fs.readdirSync(process.env.HOME) }) + "\\n");
if (process.argv[2] === "sandbox") {
  process.stdout.write(require("node:child_process").execFileSync("git", process.argv.slice(process.argv.indexOf("--") + 2), { encoding: "utf8" }));
  process.exit(0);
}
fs.readFileSync(0, "utf8");
if (process.argv.includes("resume")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(cleanClose))} + "\\n");
} else {
  process.stderr.write("OpenAI Codex v0.0.0\\n--------\\nsession id: 019f0560-0000-7000-8000-0000000000a1\\n--------\\n" + process.env.GH_TOKEN + "\\n");
  process.stdout.write('{"decision":"keep_open"}\\n');
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${delimiter}${original.PATH}`;
  process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN = token;
  const repaired = runCodexForTest({
    item: subject,
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: git("rev-parse", "HEAD"), latestRelease: null },
    model: "Codex",
    openclawDir: checkout,
    reasoningEffort: "high",
    sandboxMode: "read-only",
    serviceTier: "",
    timeoutMs: 10000,
    workDir: join(root, "repair-work"),
    prompt: "Return the synthetic review decision.",
    resultFileBytes: 1024 * 1024,
  });
  assert.equal(repaired.decision, "keep_open");
  assert.ok(credentialPublicationBlocked(repaired));
  assert.match(repaired.summary, /Clean repaired close decision/);
  for (const stream of ["stdout", "stderr"]) {
    const captured = readFileSync(
      join(root, "repair-work", `${subject.number}.1.codex.${stream}.log`),
      "utf8",
    );
    assert.ok(!captured.includes(token));
    if (stream === "stderr") assert.match(captured, /redacted credential/);
  }
  const repairReport = markdownFor({
    item: subject,
    decision: repaired,
    context: { issue: {}, comments: [], timeline: [] },
    git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
    action: reviewActionForDecision(repaired),
    reviewMode: "propose",
    snapshotHash: "synthetic-snapshot",
    contentDigest: "synthetic-content",
    reviewPolicy: "synthetic-policy",
    runtime: { model: "Codex", reasoningEffort: "high" },
  });
  writeFileSync(result.reportPath, repairReport);
  writeFileSync(join(root, "repaired-turn.md"), repairReport);
  const repairedApply = runApply();
  assert.equal(repairedApply.status, 0, repairedApply.stderr);
  const repairedActions = JSON.parse(readFileSync(join(root, "apply.json"), "utf8"));
  assert.equal(repairedActions[0].action, "kept_open");
  writeFileSync(
    join(root, "repaired-apply.log"),
    `${repairedApply.stdout}\n${repairedApply.stderr}`,
  );
  const homes = readFileSync(homeTrace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(homes.length, 3);
  assert.equal(homes[1].home, homes[2].home);
  assert.notEqual(homes[1].home, original.HOME);
  for (const entry of homes) assert.deepEqual(entry.files.sort(), [".cache", ".config"]);
  const lateReport =
    markdownFor({
      item: subject,
      decision: {
        ...closeDecision({ summary: "Already implemented." }),
        localCheckoutAccess: "verified",
      },
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
      action: { actionTaken: "proposed_close" },
      reviewMode: "propose",
      snapshotHash: "synthetic-snapshot",
      contentDigest: "synthetic-content",
      reviewPolicy: "synthetic-policy",
      runtime: { model: "Codex", reasoningEffort: "high" },
    }) + `\n## Additional evidence\n${token}\n`;
  assert.equal(readReviewRecord(lateReport).decision.decision, "close");
  writeFileSync(result.reportPath, lateReport);
  const lateApply = runApply();
  writeFileSync(join(root, "late-apply.log"), `${lateApply.stdout}\n${lateApply.stderr}`);
  assert.equal(lateApply.status, 0, lateApply.stderr);
  const persistedLate = readFileSync(result.reportPath, "utf8");
  assert.ok(!persistedLate.includes(token));
  assert.match(persistedLate, /^review_status: failed$/m);
  assert.equal(readReviewRecord(persistedLate).decision.decision, "keep_open");
  const lateActions = JSON.parse(readFileSync(join(root, "apply.json"), "utf8"));
  assert.equal(lateActions[0].action, "kept_open");
  const renderPrefix = "synthetic-render-proof-capability-123456";
  const renderToken = `${renderPrefix}.`;
  const renderOnlyResults = [];
  for (const kind of ["issue", "pull_request"]) {
    const stored = markdownFor({
      item: { ...subject, kind },
      decision: { ...closeDecision({ summary: renderPrefix }), localCheckoutAccess: "verified" },
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "a".repeat(40), latestRelease: null, releaseStateComplete: true },
      action: { actionTaken: "proposed_close" },
      reviewMode: "propose",
      snapshotHash: "synthetic-snapshot",
      contentDigest: "synthetic-content",
      reviewPolicy: "synthetic-policy",
      runtime: { model: "Codex", reasoningEffort: "high" },
    }).replaceAll(renderToken, renderPrefix);
    assert.ok(!stored.includes(renderToken));
    assert.equal(readReviewRecord(stored).decision.decision, "close");
    writeFileSync(join(root, `render-only-${kind}-before.md`), stored);
    writeFileSync(result.reportPath, stored);
    process.env.GH_TOKEN = renderToken;
    const renderApply = runApply();
    writeFileSync(
      join(root, `render-only-${kind}-apply.log`),
      `${renderApply.stdout}\n${renderApply.stderr}`,
    );
    assert.equal(renderApply.status, 0, renderApply.stderr);
    const persisted = readFileSync(result.reportPath, "utf8");
    writeFileSync(join(root, `render-only-${kind}-after.md`), persisted);
    assert.match(persisted, /^review_status: failed$/m);
    assert.equal(readReviewRecord(persisted).decision.decision, "keep_open");
    const actions = JSON.parse(readFileSync(join(root, "apply.json"), "utf8"));
    assert.equal(actions[0].action, "kept_open");
    renderOnlyResults.push({
      kind,
      persistedFailed: true,
      decision: "keep_open",
      action: actions[0].action,
      githubRequests: 0,
    });
  }
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" });
  const proof = {
    sourceHead,
    sourceDiffSha256: createHash("sha256").update(diff).digest("hex"),
    provider: "local-macos",
    node: process.version,
    item: subject.number,
    reportRedacted: true,
    commentRedacted: true,
    redactions,
    reviewStatus: "failed",
    decision: record.decision.decision,
    applyGuard: guard,
    applyExit: apply.status,
    githubRequests: 0,
    repairedTurn: {
      decision: repaired.decision,
      applyAction: repairedActions[0].action,
      githubRequests: 0,
      isolatedHome: true,
      turnsShareHome: true,
    },
    lateBodyRedactionPersisted: true,
    lateBodyApplyAction: lateActions[0].action,
    renderOnlyResults,
    limits:
      "Synthetic decision through the production report writer/renderer and dry-run apply CLI; no inference or live GitHub writes.",
  };
  writeFileSync(join(root, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  process.env = original;
  console.error = originalError;
}
