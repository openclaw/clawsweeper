#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const recipe = dirname(fileURLToPath(import.meta.url));
const root = resolve(recipe, "../../..");
const output = process.argv[2];
assert.ok(
  output,
  "usage: node docs/proof/historical-proof-classification/run-proof.mjs <new-output-dir>",
);
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node >=24 required");
const out = resolve(output);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out); // Refuse to overwrite a previous proof.
const home = join(out, "home");
mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: home, LANG: "C" };
const load = (name) => import(pathToFileURL(join(root, "dist", name)).href);
const { renderReviewCommentFromReport, reviewAutomationMarkersFromReport, reportLiveProofPlan } =
  await load("clawsweeper.js");
const { liveProofPlanSha256 } = await load("live-proof/verification.js");
const base = readFileSync(join(recipe, "help-only-report.md"), "utf8");
const receiptBytes = readFileSync(join(recipe, "help-only-receipt.json"));
const passed = JSON.parse(receiptBytes);
assert.equal(liveProofPlanSha256(reportLiveProofPlan(base)), passed.plan_sha256);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root });
const results = [];
const failures = [];

function section(report, heading, body) {
  return report.replace(new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |$)`), `$1\n${body}\n`);
}

function assessment(report, evidenceKind, summary) {
  return section(
    report,
    "Real Behavior Proof",
    `Status: sufficient\n\nEvidence kind: ${evidenceKind}\n\nNeeds contributor action: false\n\nSummary: ${summary}`,
  );
}

function projection(report, previousLabels) {
  const comment = renderReviewCommentFromReport(report, "none", { previousLabels });
  const markers = reviewAutomationMarkersFromReport(report);
  const row = (name) => comment.match(new RegExp(`\\| \\*\\*${name}\\*\\* \\|[^\\n]+`))?.[0];
  return {
    comment,
    markers,
    realBehaviorVerified: /\| \*\*Real behavior\*\* \| Verified/.test(comment),
    addsSufficient: /add `proof: sufficient`/.test(comment),
    addsVideo: /add `proof: 🎥 video`/.test(comment),
    contributorProofRequested: /add `status: 📣 needs proof`/.test(comment),
    maintainerProofDecision: /add `status: needs maintainer proof decision`/.test(comment),
    justifiedStatuses: [...comment.matchAll(/^- `(status: [^`]+)`: /gm)].map((match) => match[1]),
    mergePass: /clawsweeper-verdict:pass/.test(markers),
    proofRating: row("Proof confidence"),
    patchRating: row("Patch quality"),
    overallRating: row("Overall readiness"),
  };
}

function run(name, report, receipt, check, previousLabels) {
  const artifact = join(out, name);
  mkdirSync(artifact);
  const record = join(artifact, "42.md");
  writeFileSync(record, report);
  if (receipt) {
    const bundle = join(artifact, "live-proof", "42");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "live-verification.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  // This retained CLI folds local artifacts; it rejects live-head lookup. No media
  // manifest exists, so there is no upload, and this command never syncs comments.
  const publish = () =>
    spawnSync(
      process.execPath,
      [
        join(root, "dist/clawsweeper.js"),
        "live-proof-publish-artifacts",
        "--artifact-dir",
        artifact,
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 128 * 1024,
      },
    );
  const cli = publish();
  assert.ifError(cli.error);
  assert.equal(cli.signal, null);
  const publication = JSON.parse(cli.stdout);
  writeFileSync(join(artifact, "publication.json"), cli.stdout);
  const folded = readFileSync(record, "utf8");
  const observed = projection(folded, previousLabels);
  writeFileSync(join(artifact, "comment.md"), observed.comment);
  writeFileSync(join(artifact, "markers.txt"), observed.markers + "\n");
  const { comment: _comment, markers: _markers, ...compact } = observed;
  try {
    check({ observed, publication, folded, exitCode: cli.status });
    if (publication.results?.some((result) => result.outcome === "attached")) {
      assert.equal(
        section(folded, "Live Proof", "<attachment>"),
        section(report, "Live Proof", "<attachment>"),
        "publication preserves frontmatter, semantic proof, and unrelated sections exactly",
      );
      assert.equal(
        observed.comment.includes("PASS covers only the declared scenario and assertions"),
        receipt.overall_pass,
      );
      const repeated = publish();
      assert.ifError(repeated.error);
      assert.equal(repeated.status, 0);
      assert.deepEqual(JSON.parse(repeated.stdout), publication);
      assert.equal(readFileSync(record, "utf8"), folded, "repeat publication is idempotent");
      writeFileSync(join(artifact, "publication-repeat.json"), repeated.stdout);
    }
    results.push({ name, publication: publication.status, ...compact, passed: true });
  } catch (error) {
    failures.push(name);
    results.push({
      name,
      publication: publication.status,
      ...compact,
      passed: false,
      failure: error.message.split("\n")[0],
    });
  }
}

function attached({ publication, exitCode }) {
  assert.equal(exitCode, 0);
  assert.deepEqual(publication, {
    status: "published",
    results: [{ item: 42, outcome: "attached" }],
  });
}

run("missing-help-pass", base, passed, (result) => {
  attached(result);
  assert.equal(
    result.observed.realBehaviorVerified,
    false,
    "help receipt cannot prove authorization",
  );
  assert.equal(result.observed.addsSufficient, false);
  assert.equal(result.observed.mergePass, false);
  assert.equal(result.observed.contributorProofRequested, true);
});

// Constructed negative controls, not fresh target executions.
const failed = {
  ...passed,
  drive_status: "failed",
  overall_pass: false,
  output: "Synthetic negative control: expected help output was absent.",
  steps: passed.steps.map((step) => ({ ...step, status: "failed", satisfied: false })),
  failure: {
    phase: "step",
    reason: "Synthetic failed expectation",
    step: 1,
    action: "expect_output",
  },
};
const executionFailed = {
  ...failed,
  steps: failed.steps.map((step) => ({ ...step, status: "not_run" })),
  failure: { phase: "execution", reason: "Synthetic unavailable execution environment" },
};
for (const kind of ["recording", "linked_artifact", "terminal"]) {
  const summary = `Reviewer-assessed ${kind} exercises the changed owner and its denied-principal control.`;
  let independent = assessment(base, kind, summary);
  independent = section(
    independent,
    "PR Rating",
    `Overall tier: C\n\nProof tier: ${kind === "terminal" ? "A" : "S"}\n\nPatch tier: C\n\nSummary: Explicit reviewer patch cap.\n\nNext rank-up steps:\n\n- Simplify rollback ownership.`,
  );
  const direct = projection(independent);
  for (const [state, receipt] of [
    ["passed", passed],
    ["failed", failed],
    ["execution-failed", executionFailed],
  ]) {
    run(`${kind}-${state}`, independent, receipt, (result) => {
      attached(result);
      const observed = result.observed;
      assert.equal(observed.addsSufficient, true);
      assert.ok(observed.comment.includes(summary));
      assert.equal(observed.addsVideo, kind === "recording");
      assert.equal(observed.contributorProofRequested, false);
      assert.equal(observed.maintainerProofDecision, state !== "passed");
      assert.equal(observed.mergePass, state === "passed");
      for (const axis of ["proofRating", "patchRating", "overallRating"]) {
        assert.ok(direct[axis]);
        assert.equal(observed[axis], direct[axis]);
      }
      assert.ok(observed.comment.includes("Simplify rollback ownership"));
    });
  }
}
for (const association of ["CONTRIBUTOR", "MEMBER"]) {
  const report = base
    .replace("author_association: CONTRIBUTOR", `author_association: ${association}`)
    .replace(
      "Summary: No authorization scenario",
      "Summary: Authority-chain proof required: No authorization scenario",
    );
  run(`authority-${association.toLowerCase()}`, report, passed, (result) => {
    attached(result);
    assert.equal(result.observed.mergePass, false);
    assert.equal(result.observed.addsSufficient, false);
  });
}
for (const [name, report] of [
  ["author-exempt", base.replace("author_association: CONTRIBUTOR", "author_association: MEMBER")],
  ["docs-exempt", base.replace(/^pull_files:.*$/m, 'pull_files: ["docs/example.md"]')],
  [
    "override",
    base.replace(
      'labels: ["clawsweeper:automerge"]',
      'labels: ["clawsweeper:automerge", "proof: override"]',
    ),
  ],
]) {
  run(name, report, passed, (result) => {
    attached(result);
    assert.equal(result.observed.mergePass, true);
    assert.equal(result.observed.addsSufficient, false);
  });
}
const independent = section(
  assessment(base, "recording", "Independent reviewer-assessed recording remains valid."),
  "PR Rating",
  "Overall tier: A\n\nProof tier: S\n\nPatch tier: A\n\nSummary: Independent evidence with an explicit patch grade.\n\nNext rank-up steps:\n\n- none",
);
for (const [name, stale] of [
  ["contributor", "status: 📣 needs proof"],
  ["maintainer", "status: needs maintainer proof decision"],
]) {
  const report = independent.replace(
    'labels: ["clawsweeper:automerge"]',
    `labels: ${JSON.stringify(["clawsweeper:automerge", stale])}`,
  );
  for (const [mode, receipt] of [
    ["attached", passed],
    ["direct", null],
  ]) {
    run(
      `stale-${name}-${mode}`,
      report,
      receipt,
      (result) => {
        if (receipt) attached(result);
        else {
          assert.equal(result.exitCode, 0);
          assert.deepEqual(result.publication, { status: "published", results: [] });
        }
        assert.equal(result.observed.realBehaviorVerified, true);
        assert.deepEqual(result.observed.justifiedStatuses, ["status: 🚀 automerge armed"]);
        assert.ok(result.observed.comment.includes(`remove \`${stale}\``));
        assert.equal(result.observed.mergePass, true);
      },
      [stale],
    );
  }
}
run("invalid-identity", independent, { ...passed, head_sha: "b".repeat(40) }, (result) => {
  assert.equal(result.exitCode, 1);
  assert.equal(result.publication.status, "invalid_artifact");
  assert.equal(result.folded, independent);
});
const malformed = section(
  independent,
  "Live Proof",
  base.split("## Live Proof\n")[1].split("\n## Review Findings")[0] +
    "\n\n<!-- clawsweeper-live-verification -->\nResult: invalid!",
);
run("malformed-existing-report", malformed, null, (result) => {
  assert.equal(result.exitCode, 0);
  assert.equal(result.folded, malformed);
  assert.equal(result.observed.mergePass, false);
  assert.equal(result.observed.addsSufficient, true);
  assert.equal(result.observed.contributorProofRequested, false);
  assert.equal(result.observed.maintainerProofDecision, true);
});
run("direct-no-attachment", independent, null, (result) => {
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.publication, { status: "published", results: [] });
  assert.equal(result.folded, independent);
  assert.deepEqual(result.observed, projection(independent));
});

// Synthetic semantic assessments and native observations, never target execution.
const nativeOwner = "apps/macos/Sources/OpenClaw/ExecHostExecutor.swift";
const nativeBehavior =
  "Normal write-half-close succeeds; explicit caller abort cancels the command tree.";
const nativeObservation =
  "The macOS production socket trace shows normal write-half-close success separately from explicit caller-abort cancellation, parent and child PID disappearance, and delayed-sentinel absence after the deadline; before the fix, the child survived caller abort.";
const nativePlan = {
  ...reportLiveProofPlan(base),
  reason: nativeBehavior,
  payoff: { kind: "progressive_output", justification: "Synthetic cancellation trace." },
  entry: "./exec-host-cancellation-probe --socket ./fixture.sock",
  steps: [
    { action: "expect_output", text: "normal write-half-close: command succeeded" },
    { action: "expect_output", text: "caller abort: cancellation acknowledged" },
    { action: "expect_output", text: "parent PID absent; child PID absent" },
    { action: "expect_output", text: "delayed sentinel absent after deadline" },
  ],
};
const nativeReceipt = {
  ...passed,
  entry: nativePlan.entry,
  plan_sha256: liveProofPlanSha256(nativePlan),
  steps: nativePlan.steps.map((step) => ({
    ...passed.steps[0],
    detail: "Synthetic native observation, not executed by this recipe.",
    subject: step.text,
    assertion: step.text,
  })),
  output: nativePlan.steps.map((step) => step.text).join("\n"),
};
for (const scenario of [
  {
    name: "native-gap-help-pass",
    owner: nativeOwner,
    behavior: nativeBehavior,
    kind: "terminal",
    sufficient: false,
    summary: `Synthetic assessment: ${nativeOwner} changes socket cancellation and process lifetime, but help output does not exercise normal write-half-close success, explicit caller abort, child teardown, or the delayed sentinel on macOS.`,
  },
  {
    name: "changed-help-pass",
    owner: "src/cli/help.ts",
    behavior: "CLI help output changes.",
    kind: "terminal",
    sufficient: true,
    summary:
      "Synthetic assessment: src/cli/help.ts changes CLI help; pnpm openclaw --help on the reviewed local build shows the corrected Usage: openclaw [options] [command] output.",
  },
  ...["terminal", "linked_artifact", "recording"].map((kind) => ({
    name: `native-${kind}-pass`,
    owner: nativeOwner,
    behavior: nativeBehavior,
    kind,
    sufficient: true,
    summary: `Synthetic assessment: ${nativeOwner} changes socket cancellation. ${nativeObservation}${kind === "terminal" ? "" : " Independent Developer-ID-signed before/after evidence establishes coverage through those observations; signing establishes provenance only, and the unrelated help smoke adds no coverage."}`,
  })),
]) {
  let report = base.replace(/^pull_files:.*$/m, `pull_files: ${JSON.stringify([scenario.owner])}`);
  report = section(
    report,
    "Summary",
    "Synthetic classification fixture; no target code exists here.",
  );
  report = section(report, "What This Changes", scenario.behavior);
  report = assessment(report, scenario.kind, scenario.summary);
  report = section(
    report,
    "PR Rating",
    "Overall tier: A\n\nProof tier: A\n\nPatch tier: A\n\nSummary: Synthetic reviewer assessment.\n\nNext rank-up steps:\n\n- none",
  );
  if (!scenario.sufficient) {
    report = report
      .replace("Status: sufficient", "Status: insufficient")
      .replace("Needs contributor action: false", "Needs contributor action: true");
  }
  const nativeTerminal = scenario.name === "native-terminal-pass";
  if (nativeTerminal) {
    report = section(
      report,
      "Live Proof",
      `Status: recommended\n\nSurface: terminal\n\nTerminal completion: exit_zero\n\nReason: ${nativePlan.reason}\n\nPayoff: ${nativePlan.payoff.kind}\n\nPayoff justification: ${nativePlan.payoff.justification}\n\nEntry: ${nativePlan.entry}\n\nSteps:\n\n${nativePlan.steps.map((step) => `- ${JSON.stringify(step)}`).join("\n")}`,
    );
  }
  run(scenario.name, report, nativeTerminal ? nativeReceipt : passed, (result) => {
    attached(result);
    assert.ok(result.observed.comment.includes(scenario.summary), "source-aware summary retained");
    assert.ok(
      result.observed.comment.includes(
        scenario.sufficient
          ? `Sufficient (${scenario.kind}):`
          : "Needs stronger real behavior proof before merge:",
      ),
      "semantic classification and evidence attribution retained",
    );
    assert.equal(result.observed.realBehaviorVerified, scenario.sufficient);
    assert.equal(result.observed.addsSufficient, scenario.sufficient);
    assert.equal(result.observed.addsVideo, scenario.kind === "recording");
    assert.equal(result.observed.contributorProofRequested, !scenario.sufficient);
    assert.equal(result.observed.mergePass, scenario.sufficient);
  });
}

const summary = {
  claim: "Historical execution receipts do not replace reviewer-assessed behavioral proof.",
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    provider: "local-process",
    image: null,
    lease: null,
  },
  source: {
    head: git("rev-parse", "HEAD").toString().trim(),
    productionDiffSha256: hash(git("diff", "--binary", "HEAD", "--", "src")),
    builtOwners: Object.fromEntries(
      [
        "clawsweeper-report-parser.js",
        "clawsweeper-orchestration-foundation.js",
        "clawsweeper-rating.js",
        "clawsweeper-label-policy.js",
        "clawsweeper-review-presentation.js",
        "live-proof/verification.js",
        "live-proof/attach.js",
        "live-proof/publication-artifacts.js",
      ].map((file) => [file, hash(readFileSync(join(root, "dist", file)))]),
    ),
    recipeSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    receiptSha256: hash(receiptBytes),
    reportSha256: hash(base),
  },
  results,
  limits:
    "Synthetic historical input and native assessments; actual local CLI folding and report projections only. No Gateway or native execution, fresh terminal run, model assessment, media upload, GitHub call, deployment, or queue mutation.",
};
writeFileSync(join(out, "result.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
assert.deepEqual(
  failures,
  [],
  "historical proof classification checks failed; inspect result.json",
);
