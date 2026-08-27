// Prepare production planner inputs, then replay an actual Codex decision through tmux.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDecision,
  reviewPromptForTest,
  reviewDecisionSchemaText,
} from "../../dist/clawsweeper.js";
import { createDecisionParser } from "../../dist/clawsweeper-decision-parser.js";
import { driveTerminal } from "../../dist/live-proof/drivers.js";
import { buildLiveVerificationResult } from "../../dist/live-proof/verification.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [mode, directory, variant = "fast"] = process.argv.slice(2);
assert.ok(
  ["prepare", "run"].includes(mode) && directory,
  "usage: SCRIPT prepare|run DIR [fast|delayed]",
);
assert.ok(["fast", "delayed"].includes(variant));
const bundle = resolve(directory);
const base = "f211e21fb89d00777ac07cc13c358f9f7b02a939";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const sources = [
  "prompts/review-item.md",
  "schema/clawsweeper-decision.schema.json",
  "src/clawsweeper-decision-parser.ts",
  "src/clawsweeper-review-runtime.ts",
  "src/live-proof/drivers.ts",
  "src/live-proof/verification.ts",
  "scripts/e2e/terminal-proof-once.mjs",
  "scripts/e2e/terminal-proof-planning.mjs",
];
const sourceHashes = () =>
  Object.fromEntries(sources.map((file) => [file, hash(readFileSync(join(root, file)))]));
const stripDescriptions = (value) =>
  Array.isArray(value)
    ? value.map(stripDescriptions)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "description")
            .map(([key, child]) => [key, stripDescriptions(child)]),
        )
      : value;
const schema = JSON.parse(reviewDecisionSchemaText());
assert.deepEqual(
  stripDescriptions(schema),
  stripDescriptions(JSON.parse(git("show", `${base}:schema/clawsweeper-decision.schema.json`))),
);
const proofCommand = `node once.mjs output${variant === "delayed" ? " 34" : ""}`;
const setupCommand = "printf 'SETUP_READY\\n'";
const markers = [
  "PASS exclusive directory",
  "PASS original bytes retained",
  "PASS local fixture",
  "PASS stable assertions",
  "PASS proof complete",
];

if (mode === "prepare") {
  mkdirSync(bundle); // Refuse to overwrite an earlier generation or proof.
  const fixture = readFileSync(join(root, "scripts/e2e/terminal-proof-once.mjs"), "utf8");
  const item = {
    repo: "openclaw/clawsweeper",
    number: 1,
    kind: "pull_request",
    title: "Controlled local terminal proof fixture (synthetic, no GitHub item)",
    url: "https://example.invalid/fixture/1",
    author: "fixture",
    authorAssociation: "NONE",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    labels: [],
  };
  const context = {
    issue: {
      ...item,
      body: `A local CLI now creates an exclusive output directory and emits five stable success assertions. Demonstrate it with ${proofCommand}. The output directory initially does not exist. A second invocation against it fails with exit 17 without overwriting the original result. It emits PROOF_STARTED immediately, then finishes after ${variant === "delayed" ? "34 seconds" : "a short burst"}. A harmless setup command is available: ${setupCommand}. Verify all five PASS lines. No dependencies, accounts, secrets, or network. The full changed source follows:\n\n${fixture}`,
    },
    comments: [],
    timeline: [],
    counts: { comments: 0, timeline: 0 },
    pullDiff: `diff --git a/once.mjs b/once.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/once.mjs\n${fixture
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}`,
  };
  const prompt = reviewPromptForTest(
    item,
    context,
    { mainSha: base, latestRelease: null },
    "This is a controlled offline planner evaluation, not a real GitHub review. Use only the complete supplied fixture context. Do not use tools, execute the fixture, access the network, or modify files. Return the full decision JSON under the supplied production schema. Only the liveProofPlan will be executed afterward. Use the exact supplied commands and stable assertions; do not invent alternate commands. Do not claim proof has already run.",
  );
  writeFileSync(join(bundle, "prompt.md"), prompt, { flag: "wx" });
  json(join(bundle, "schema.json"), schema);
  json(join(bundle, "inputs.json"), {
    base,
    head: git("rev-parse", "HEAD"),
    variant,
    sourceHashes: sourceHashes(),
    baseSourceHashes: Object.fromEntries(
      sources
        .filter((file) => !file.startsWith("scripts/e2e/terminal-proof-"))
        .map((file) => [
          file,
          hash(execFileSync("git", ["show", `${base}:${file}`], { cwd: root })),
        ]),
    ),
    promptSha256: hash(prompt),
    schemaSha256: hash(readFileSync(join(bundle, "schema.json"))),
  });
  console.log(
    `Prepared production prompt and schema in ${bundle}; generate decision.json with Codex, then run this script with run.`,
  );
} else {
  const inputs = JSON.parse(readFileSync(join(bundle, "inputs.json"), "utf8"));
  assert.deepEqual(
    inputs.sourceHashes,
    sourceHashes(),
    "source changed since generation; prepare fresh inputs",
  );
  assert.equal(inputs.variant, variant);
  assert.equal(inputs.promptSha256, hash(readFileSync(join(bundle, "prompt.md"))));
  assert.equal(inputs.schemaSha256, hash(readFileSync(join(bundle, "schema.json"))));
  const rawDecision = JSON.parse(readFileSync(join(bundle, "decision.json"), "utf8"));
  const plan = parseDecision(rawDecision).liveProofPlan;
  assert.deepEqual(
    plan,
    rawDecision.liveProofPlan,
    "generated plan must survive production parsing unchanged",
  );
  assert.equal(plan.status, "recommended");
  assert.equal(plan.surface, "terminal");
  const commands = [
    plan.entry,
    ...plan.steps.filter((step) => step.action === "run").map((step) => step.command),
  ];
  assert.equal(commands.filter((command) => command === proofCommand).length, 1);
  assert.ok(
    commands.every((command) => [proofCommand, setupCommand].includes(command)),
    "review unexpected generated commands before execution",
  );
  assert.ok(plan.steps.every((step) => ["run", "wait", "expect_output"].includes(step.action)));
  for (const marker of markers)
    assert.ok(plan.steps.some((step) => step.action === "expect_output" && step.text === marker));

  const parsePlan = createDecisionParser({
    isMaintainerAuthorAssociation: () => false,
    neutralizeOwnedSectionSpoofing: (value) => value,
    sanitizeArchitectureDiagram: (value) => value,
  }).parseLiveProofPlan;
  const receipts = [];
  const drive = (name, candidate) => {
    const checkout = join(bundle, name);
    mkdirSync(checkout);
    copyFileSync(join(root, "scripts/e2e/terminal-proof-once.mjs"), join(checkout, "once.mjs"));
    const parsed = parsePlan(candidate, "liveProofPlan");
    assert.deepEqual(parsed, candidate);
    // Dedicated tmux server: do not touch user sessions or inherit their environment.
    const socket = `terminal-planning-${process.pid}-${name}`;
    const runner = (command, args, options = {}) =>
      spawnSync(command, command === "tmux" ? ["-L", socket, "-f", "/dev/null", ...args] : args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: checkout, TMPDIR: checkout, LANG: "en_US.UTF-8" },
      });
    let driven;
    try {
      driven = driveTerminal({
        plan: parsed,
        checkout,
        rawVideoPath: join(checkout, "unused.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner,
      });
    } finally {
      runner("tmux", ["kill-server"]);
    }
    const result = buildLiveVerificationResult({
      repo: "example/fixture",
      item: 1,
      headSha: inputs.head,
      plan: parsed,
      driveStatus: driven.status,
      stepLog: driven.steps,
      output: driven.output,
      verifiedAt: new Date().toISOString(),
    });
    json(join(checkout, "live-verification.json"), result);
    receipts.push({
      scenario: name,
      generated: name === "generated",
      plan: parsed,
      drive_status: result.drive_status,
      overall_pass: result.overall_pass,
      failure: result.failure ?? null,
      steps: result.steps,
      output: result.output,
    });
    return { checkout, result };
  };
  const good = drive("generated", plan);
  assert.equal(good.result.overall_pass, true);
  for (const step of good.result.steps.filter((step) => step.action === "expect_output")) {
    assert.equal(step.satisfied, true);
    assert.equal(step.detail, "ok");
  }
  const resultBytes = readFileSync(join(good.checkout, "output/result.txt"));
  assert.equal(readFileSync(join(good.checkout, "output.invocations"), "utf8"), "invoked\n");
  const replay = spawnSync(process.execPath, ["once.mjs", "output"], {
    cwd: good.checkout,
    encoding: "utf8",
  });
  assert.equal(replay.status, 17);
  assert.deepEqual(readFileSync(join(good.checkout, "output/result.txt")), resultBytes);

  const control = (entry, steps) => ({ ...plan, entry, steps });
  const duplicate = drive(
    "duplicate",
    control("node once.mjs output", [
      { action: "run", command: "node once.mjs output" },
      { action: "expect_output", text: markers[4] },
    ]),
  );
  assert.equal(duplicate.result.overall_pass, false);
  assert.match(duplicate.result.output, /REFUSED_EXISTING_OUTPUT/);
  assert.equal(
    readFileSync(join(duplicate.checkout, "output.invocations"), "utf8"),
    "invoked\ninvoked\n",
  );
  assert.deepEqual(readFileSync(join(duplicate.checkout, "output/result.txt")), resultBytes);
  const repeat = "cat state.txt >> reads.txt && cat state.txt";
  const later = drive(
    "intentional-repeat",
    control("printf before > state.txt", [
      { action: "run", command: repeat },
      { action: "run", command: "printf after > state.txt" },
      { action: "run", command: repeat },
      { action: "expect_output", text: "after" },
    ]),
  );
  assert.equal(later.result.overall_pass, true);
  assert.equal(readFileSync(join(later.checkout, "reads.txt"), "utf8"), "beforeafter");
  const negative = drive(
    "nonzero",
    control("printf 'CONTROL_FAILED\\n'; exit 7", [
      { action: "expect_output", text: "CONTROL_FAILED" },
    ]),
  );
  assert.equal(negative.result.overall_pass, false);
  assert.match(negative.result.failure.reason, /exit status 7/);
  const timeout = drive(
    "timeout",
    control("sleep 40", [{ action: "expect_output", text: "NEVER_EMITTED" }]),
  );
  assert.equal(timeout.result.overall_pass, false);
  assert.match(timeout.result.failure.reason, /within 30 seconds/);
  json(join(bundle, "receipt.json"), {
    ...inputs,
    provider: "local macOS tmux",
    node: process.version,
    tmux: execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim(),
    decisionSha256: hash(readFileSync(join(bundle, "decision.json"))),
    schemaShapeUnchanged: true,
    oneShotInvocationsBeforeReplay: 1,
    replayExit: replay.status,
    originalBytesPreserved: true,
    resultSha256: hash(resultBytes),
    recordingTested: false,
    scenarios: receipts,
  });
  console.log(
    `PASS generated plan, non-overwrite replay, duplicate execution, intentional rerun, nonzero and real timeout; receipt: ${join(bundle, "receipt.json")}`,
  );
}
