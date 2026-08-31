#!/usr/bin/env node
// Synthetic local proof. Run once against the recorded pre-edit build and once
// against a freshly built candidate; --expect makes the before/after claim explicit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => [
    process.argv[2 + index * 2],
    process.argv[3 + index * 2],
  ]),
);
assert.ok(
  args["--root"] &&
    args["--out"] &&
    args["--baseline-id"] &&
    args["--candidate-id"] &&
    args["--archive-sha256"] &&
    ["baseline", "candidate"].includes(args["--expect"]),
  "Usage: node runtime-proof.mjs --root ROOT --out OUTPUT --expect baseline|candidate --baseline-id SOURCE_ID --candidate-id SOURCE_ID --archive-sha256 SHA256",
);
const root = realpathSync(resolve(args["--root"]));
const out = resolve(args["--out"]);
const expected = args["--expect"];
mkdirSync(out, { recursive: true });
const proofRoot = mkdtempSync(join(out, `${expected}-`));
const tripwireDir = join(proofRoot, "bin");
mkdirSync(tripwireDir);
writeFileSync(join(tripwireDir, "package.json"), '{"type":"commonjs"}\n');
const deniedLog = join(proofRoot, "denied-commands.log");
for (const command of ["gh", "codex", "claude"]) {
  writeFileSync(
    join(tripwireDir, command),
    String.raw`#!/usr/bin/env node
const command = require('node:path').basename(process.argv[1]);
require('node:assert/strict').ok(['gh', 'codex', 'claude'].includes(command));
require('node:fs').appendFileSync(process.env.CLAWSWEEPER_PROOF_DENIED_LOG, command + ' denied\n');
process.exit(97);
`,
    { mode: 0o755 },
  );
}
const denyNetwork = join(proofRoot, "deny-network.cjs");
writeFileSync(
  denyNetwork,
  String.raw`const deny = () => {
  require('node:fs').appendFileSync(process.env.CLAWSWEEPER_PROOF_DENIED_LOG, 'network denied\n');
  throw new Error('Synthetic proof denies network');
};
globalThis.fetch = deny;
require('node:net').Socket.prototype.connect = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}
require('node:module').syncBuiltinESMExports();
`,
);
const childEnv = {
  PATH: [tripwireDir, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  CLAWSWEEPER_PROOF_DENIED_LOG: deniedLog,
  CI: "1",
};
const commands = [];
const observations = [];
let assertions = 0;
function equal(actual, wanted, label) {
  assertions += 1;
  assert.deepEqual(actual, wanted, label);
}
function run(name, argv) {
  const nodeArgs = ["--require", denyNetwork, ...argv];
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: proofRoot,
    env: childEnv,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  writeFileSync(join(proofRoot, `${name}.stdout`), result.stdout);
  writeFileSync(join(proofRoot, `${name}.stderr`), result.stderr);
  commands.push({
    name,
    argv: [process.execPath, ...nodeArgs],
    argvSha256: hash(JSON.stringify([process.execPath, ...nodeArgs])),
    cwd: proofRoot,
    exitCode: result.status,
  });
  return result;
}
const tripwireCheck = run("tripwire-self-check", [join(tripwireDir, "gh")]);
equal(tripwireCheck.status, 97, "the GitHub tripwire executes and denies commands");
equal(readFileSync(deniedLog, "utf8"), "gh denied\n", "the GitHub tripwire records attempts");
unlinkSync(deniedLog);
const networkCheck = run("network-self-check", ["--eval", 'fetch("https://example.invalid");']);
equal(
  {
    exitCode: networkCheck.status,
    deniedError: networkCheck.stderr.includes("Error: Synthetic proof denies network"),
  },
  { exitCode: 1, deniedError: true },
  "the application preload rejects fetch with its known denial error",
);
equal(readFileSync(deniedLog, "utf8"), "network denied\n", "the network tripwire records attempts");
unlinkSync(deniedLog);
const requiredDecision = {
  required: true,
  kind: "manual_review",
  question: "Should this synthetic contract be adopted?",
  rationale: "A maintainer must decide the intended behavior.",
  options: [
    { title: "Keep current behavior", body: "Preserve the existing contract.", recommended: true },
  ],
  likelyOwner: {
    person: "@synthetic-owner",
    reason: "Owns this synthetic example.",
    confidence: "high",
  },
};
const originalHeader = {
  repository: "openclaw/clawsweeper",
  number: 321,
  type: "pull_request",
  title: JSON.stringify("Original"),
  url: "https://github.com/openclaw/clawsweeper/pull/321",
  maintainer_decision: "none",
  labels: "[]",
  decision: "keep_open",
  action_taken: "kept_open",
  confidence: "high",
  close_reason: "none",
  review_status: "complete",
  local_checkout_access: "verified",
  local_checkout_access_source: "runner_preflight_v1",
  item_created_at: "2020-01-01T00:00:00Z",
  pr_rating_overall: "F",
  pr_rating_proof: "F",
  real_behavior_proof_status: "missing",
  pr_surface_files: JSON.stringify([
    { path: "src/a.ts", additions: 1, deletions: 0 },
    { path: "src/b.ts", additions: 2, deletions: 1 },
  ]),
};
function report(fields, body) {
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\n# Original\n\n## Summary\n\n${body}\n`;
}
const quote = "title: Quoted\nrepository: example/quoted\nnumber: 999";
const fixtures = [];
const quotedReports = [
  ["ordinary", quote],
  ["fenced", `~~~yaml\n---\n${quote}\n---\n~~~`],
].map(([name, body]) => ({
  name,
  markdown: report(originalHeader, body),
  required: report(
    { ...originalHeader, maintainer_decision: JSON.stringify(requiredDecision) },
    body,
  ),
  baselinePoisoned: true,
}));
// These are positive controls in BOTH modes. The first shared parser introduced
// their ambiguity; they are not regressions attributed to the original baseline.
const structuralControls = [
  ["body-heading", "---\n\n# Review: Original\n\n---\n\nPlain summary.\n"],
  ["header-comments", "# Note: one\n# Note: two\n---\n\nPlain summary.\n"],
  ["header-list", "notes:\n- detail: one\n- detail: two\n---\n\nPlain summary.\n"],
  ["body-list", "---\n\n- Detail: one\n- Detail: two\n\n---\n\nPlain summary.\n"],
  ["body-only-delimited", "---\n\nExample.\n---\nbody_only: example data\n---\n"],
  ["body-only-repeated", "---\n\nExample.\n---\nbody_only: one\nbody_only: two\n---\n"],
].map(([name, suffix]) => {
  const markdown = `---\nrepository: openclaw/clawsweeper\nnumber: 321\ntitle: Original\nmaintainer_decision: none\n${suffix}`;
  return {
    name,
    markdown,
    required: markdown.replace(
      "maintainer_decision: none",
      `type: issue\nmaintainer_decision: ${JSON.stringify(requiredDecision)}`,
    ),
    baselinePoisoned: false,
  };
});
for (const { name, markdown, required, baselinePoisoned } of [
  ...quotedReports,
  ...structuralControls,
]) {
  const poisoned = expected === "baseline" && baselinePoisoned;
  const reportPath = join(proofRoot, "321.md");
  writeFileSync(reportPath, markdown);
  fixtures.push({ name, sha256: hash(markdown) });
  const cli = run(`create-job-${name}`, [
    join(root, "dist/repair/create-job.js"),
    "--from-report",
    reportPath,
    "--prompt",
    "Prove report metadata remains readable.",
    "--cluster-id",
    "record-body-proof",
    "--out-dir",
    join(proofRoot, "jobs"),
    "--dry-run",
    "--no-check-existing",
  ]);
  equal(cli.status, poisoned ? 2 : 0, `${name}: actual create-job exit`);
  if (!poisoned) {
    equal(/^repo: openclaw\/clawsweeper$/m.test(cli.stdout), true, `${name}: header repo`);
    equal(cli.stdout.includes("#321"), true, `${name}: header ref`);
  } else {
    equal(
      cli.stderr.includes("provide at least one issue/PR ref"),
      true,
      `${name}: baseline poisoning reproduces`,
    );
  }
  equal(/example\/quoted|#999/.test(cli.stdout), false, `${name}: no body values adopted`);
  equal(existsSync(join(proofRoot, "jobs")), false, `${name}: dry run writes no job`);

  // Run actual exports in a child subject to the same credential-free environment
  // and network/command tripwires as the CLI.
  const requiredPath = join(proofRoot, `${name}-required.md`);
  writeFileSync(requiredPath, required);
  fixtures.push({ name: `${name}-required`, sha256: hash(readFileSync(requiredPath)) });
  const probe = join(proofRoot, `${name}-decisions.mjs`);
  writeFileSync(
    probe,
    `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { maintainerDecisionBlocksClose, buildDecisionPacketFromReport } = await import(pathToFileURL(process.argv[2]).href);
const none = readFileSync(process.argv[3], 'utf8');
const required = readFileSync(process.argv[4], 'utf8');
console.log(JSON.stringify({
  noneBlocked: maintainerDecisionBlocksClose(none),
  nonePacket: buildDecisionPacketFromReport(none),
  requiredBlocked: maintainerDecisionBlocksClose(required),
  requiredPacket: buildDecisionPacketFromReport(required, {
    generatedAt: '2026-08-30T00:00:00.000Z',
    reportPath: 'records/openclaw-clawsweeper/items/321.md'
  })
}));
`,
  );
  const decisions = run(`decisions-${name}`, [
    probe,
    join(root, "dist/decision-packets.js"),
    reportPath,
    requiredPath,
  ]);
  equal(decisions.status, 0, `${name}: decision export invocation`);
  const result = JSON.parse(decisions.stdout);
  equal(result.noneBlocked, poisoned, `${name}: no invented maintainer blocker`);
  equal(result.nonePacket, null, `${name}: none produces no packet`);
  equal(result.requiredBlocked, true, `${name}: required decision still blocks`);
  if (!poisoned) {
    equal(result.requiredPacket.subject.repo, originalHeader.repository, `${name}: packet repo`);
    equal(result.requiredPacket.subject.number, 321, `${name}: packet number`);
    equal(result.requiredPacket.subject.title, "Original", `${name}: packet title`);
    equal(result.requiredPacket.question, requiredDecision.question, `${name}: exact question`);
    equal(result.requiredPacket.rationale, requiredDecision.rationale, `${name}: exact rationale`);
    equal(result.requiredPacket.likelyOwner, requiredDecision.likelyOwner, `${name}: exact owner`);
    equal(result.requiredPacket.options, requiredDecision.options, `${name}: exact options`);
  } else {
    equal(result.requiredPacket, null, `${name}: baseline suppresses required packet`);
  }
  observations.push({ scenario: name, baselinePoisoned, createJobExit: cli.status, ...result });
}

const competingReport = report(
  originalHeader,
  `Plain summary.\n\n---\n# Record metadata\nmaintainer_decision: ${JSON.stringify(requiredDecision)}\nnumber: 999\nnotes:\n- detail: one\n- detail: two\n- first\n-\n-\tlast\n---\n`,
);
const competingPath = join(proofRoot, "competing.md");
writeFileSync(competingPath, competingReport);
fixtures.push({ name: "competing-comment-list", sha256: hash(competingReport) });
const competingCli = run("create-job-competing-comment-list", [
  join(root, "dist/repair/create-job.js"),
  "--from-report",
  competingPath,
  "--prompt",
  "Prove report metadata remains readable.",
  "--cluster-id",
  "record-body-proof",
  "--out-dir",
  join(proofRoot, "jobs"),
  "--dry-run",
  "--no-check-existing",
]);
equal(competingCli.status, 2, "competing comment/list record cannot supply a job ref");
equal(
  competingCli.stderr.includes("provide at least one issue/PR ref"),
  true,
  "competing ref is rejected",
);
equal(competingCli.stdout, "", "competing record creates no job output");
equal(existsSync(join(proofRoot, "jobs")), false, "competing record writes no job");
const competingProbe = join(proofRoot, "competing-decisions.mjs");
writeFileSync(
  competingProbe,
  `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { maintainerDecisionBlocksClose, buildDecisionPacketFromReport } = await import(pathToFileURL(process.argv[2]).href);
const markdown = readFileSync(process.argv[3], 'utf8');
console.log(JSON.stringify({
  blocked: maintainerDecisionBlocksClose(markdown),
  packet: buildDecisionPacketFromReport(markdown)
}));
`,
);
const competingDecisions = run("decisions-competing-comment-list", [
  competingProbe,
  join(root, "dist/decision-packets.js"),
  competingPath,
]);
equal(competingDecisions.status, 0, "competing record decision exports execute");
const competingResult = JSON.parse(competingDecisions.stdout);
equal(
  competingResult,
  { blocked: true, packet: null },
  "comments and lists cannot hide a competing decision",
);
observations.push({
  scenario: "competing-comment-list",
  createJobExit: competingCli.status,
  ...competingResult,
});

// Exercise the real selector in its own flat records directory. The positive
// legacy control proves that rejection is caused by ambiguous metadata.
const items = join(proofRoot, "records/openclaw-openclaw/items");
mkdirSync(items, { recursive: true });
const selectorPath = join(items, "322.md");
const { pr_rating_overall, pr_rating_proof, real_behavior_proof_status, ...missingRatings } =
  originalHeader;
void pr_rating_overall;
void pr_rating_proof;
void real_behavior_proof_status;
const selectorHeader = { ...missingRatings, repository: "openclaw/openclaw", number: 322 };
const legacy =
  "## PR Rating\n\nOverall tier: F\n\nProof tier: F\n\n## Real Behavior Proof\n\nStatus: missing\n";
for (const [name, body, selected] of [
  ["legacy-control", legacy, "322"],
  [
    "missing-ratings-no-legacy",
    "pr_rating_overall: A\npr_rating_proof: A\nreal_behavior_proof_status: sufficient\n",
    "",
  ],
  [
    "missing-ratings-lookalikes",
    `pr_rating_overall: A\npr_rating_proof: A\nreal_behavior_proof_status: sufficient\n\n${legacy}`,
    "",
  ],
  [
    "missing-ratings-fenced-lookalikes",
    `\`\`\`yaml\npr_rating_overall: A\npr_rating_proof: A\nreal_behavior_proof_status: sufficient\n\`\`\`\n\n${legacy}`,
    "",
  ],
]) {
  const markdown = report(selectorHeader, body);
  writeFileSync(selectorPath, markdown);
  const cli = run(name, [
    join(root, "dist/repair/workflow-utils.js"),
    "proposed-item-numbers",
    "--target-repo",
    "openclaw/openclaw",
    "--apply-kind",
    "pull_request",
    "--apply-close-reasons",
    "author_pr_budget_exceeded,low_signal_unmergeable_pr",
  ]);
  equal(cli.status, 0, `${name}: selector exit`);
  equal(cli.stdout, selected, `${name}: selector result`);
  equal(readFileSync(selectorPath, "utf8"), markdown, `${name}: report unchanged`);
  observations.push({ scenario: name, selected: cli.stdout });
  fixtures.push({ name, sha256: hash(markdown) });
}
equal(
  existsSync(deniedLog),
  false,
  "zero existing-work GitHub reads, model commands, or network attempts",
);
equal(existsSync(join(proofRoot, "jobs")), false, "zero repair jobs created");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function treeHashes(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const relative = prefix + entry.name;
      return entry.isDirectory()
        ? treeHashes(join(dir, entry.name), `${relative}/`)
        : [{ path: relative, sha256: hash(readFileSync(join(dir, entry.name))) }];
    });
}
const sourcePaths = [
  "src/report-front-matter.ts",
  "src/clawsweeper-record-metadata.ts",
  "src/clawsweeper-report-parser.ts",
  "src/clawsweeper-markdown.ts",
  "src/decision-packets.ts",
  "src/repair/create-job.ts",
  "src/repair/workflow-utils.ts",
];
const tripwireSelfChecks = commands.filter(({ name }) => name.endsWith("-self-check")).length;
const applicationInvocations = commands.length - tripwireSelfChecks;
const manifest = {
  expected,
  assertions,
  root,
  proofRoot,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  baselineSourceId: args["--baseline-id"],
  candidateSourceId: args["--candidate-id"],
  executedSourceId: args[expected === "baseline" ? "--baseline-id" : "--candidate-id"],
  archiveSha256: args["--archive-sha256"],
  scriptSha256: hash(readFileSync(new URL(import.meta.url))),
  sources: sourcePaths.map((file) => ({
    path: file,
    sha256: existsSync(join(root, file)) ? hash(readFileSync(join(root, file))) : null,
  })),
  builtArtifacts: treeHashes(join(root, "dist")),
  fixtures,
  commands,
  observations,
  githubReads: 0,
  tripwireSelfChecks,
  applicationInvocations,
  childEnvironment: childEnv,
  networkAttempts: 0,
  jobsCreated: 0,
  environment:
    "Credential-free child allowlist; gh/codex/claude and Node network tripwires fail closed.",
  limits:
    "Local synthetic CLI and exported decision paths only. No live GitHub, real repair creation, provider/model inference, deployed Worker, or complete hosted workflow proof.",
};
writeFileSync(join(proofRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      expected,
      assertions,
      scenarios: observations.length,
      tripwireSelfChecks,
      applicationInvocations,
      githubReads: 0,
      jobsCreated: 0,
      manifest: join(proofRoot, "manifest.json"),
    },
    null,
    2,
  ),
);
