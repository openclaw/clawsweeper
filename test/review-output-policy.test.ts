import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  assertActiveReviewOutputBudget,
  assertTransientReviewOutputBudget,
  createReviewOutputMetadataBudget,
  createTransientReviewOutput,
  emitReviewFailureJson,
  emitReviewOutput,
  finalizeSummaryReviewOutput,
  prepareRetainedReviewOutput,
  pruneReviewOutputItem,
  readBoundedReviewResult,
  reviewOutputFilePeak,
  reviewOutputItemBudget,
  reviewOutputSelection,
  writeReviewOutputMetadata,
} from "../dist/review-output-policy.js";
import { localReviewOutputHasPayload } from "../dist/clawsweeper-review-command-workflow.js";

test("local review output defaults to none and preserves explicit-path compatibility", () => {
  assert.deepEqual(reviewOutputSelection(parseArgs([]), { destinationFlag: "artifact_dir" }), {
    retention: "none",
    resultFormat: "text",
    explicitDestination: false,
    compatibilityRetention: false,
  });
  assert.deepEqual(
    reviewOutputSelection(parseArgs(["--artifact-dir", "out"]), {
      destinationFlag: "artifact_dir",
    }),
    {
      retention: "debug",
      resultFormat: "text",
      explicitDestination: true,
      compatibilityRetention: true,
    },
  );
  assert.throws(
    () =>
      reviewOutputSelection(parseArgs(["--artifact-dir", "out", "--output-retention", "none"]), {
        destinationFlag: "artifact_dir",
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      reviewOutputSelection(parseArgs(["--output-retention", "debug"]), {
        destinationFlag: "artifact_dir",
      }),
    /requires an explicit --artifact-dir/,
  );
});

test("hosted review requires explicit debug retention and destination", () => {
  const options = { destinationFlag: "artifact_dir" as const, hostedEvidenceRequired: true };
  assert.throws(() => reviewOutputSelection(parseArgs([]), options), /requires.*debug/i);
  assert.equal(
    reviewOutputSelection(parseArgs(["--artifact-dir", "legacy-explicit"]), options)
      .compatibilityRetention,
    true,
  );
  assert.equal(
    reviewOutputSelection(
      parseArgs(["--artifact-dir", "artifacts", "--output-retention", "debug"]),
      options,
    ).retention,
    "debug",
  );
});

test("canonical hosted review launchers declare required debug retention", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  for (const artifactDir of [
    "--artifact-dir artifacts/event",
    "--artifact-dir ../review-artifacts/shard-${{ matrix.shard }}",
  ]) {
    const start = workflow.indexOf(artifactDir);
    assert.notEqual(start, -1);
    assert.match(workflow.slice(start, start + 220), /--output-retention debug/);
  }
});

test("transient review output is private and removed by its owner cleanup", () => {
  const first = createTransientReviewOutput("clawsweeper-output-test-");
  const second = createTransientReviewOutput("clawsweeper-output-test-");
  writeFileSync(join(first.path, "result.md"), "result\n");
  assert.notEqual(first.path, second.path);
  assert.equal(statSync(first.path).mode & 0o777, 0o700);
  first.cleanup();
  first.cleanup();
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(second.path), true);
  second.cleanup();
});

test(
  "transient review output does not swallow default termination during synchronous work",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `import { spawnSync } from "node:child_process";`,
          `import { createTransientReviewOutput } from ${JSON.stringify(new URL("../dist/review-output-policy.js", import.meta.url).href)};`,
          `const output = createTransientReviewOutput("clawsweeper-signal-test-");`,
          `console.log(output.path);`,
          `spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);`,
          `console.log("unexpected completion");`,
        ].join("\n"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    while (!stdout.includes("\n")) await once(child.stdout, "data");
    const path = stdout.trim();
    assert.equal(existsSync(path), true);
    const exited = once(child, "exit");
    const startedAt = Date.now();
    child.kill("SIGTERM");
    const [status, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    assert.equal(status, null);
    assert.equal(signal, "SIGTERM");
    assert.ok(
      Date.now() - startedAt < 750,
      "default termination must not wait for synchronous work",
    );
    assert.doesNotMatch(stdout, /unexpected completion/);
    rmSync(path, { recursive: true, force: true });
  },
);

test("summary retention removes debug files and keeps private bounded reports", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-summary-test-"));
  rmSync(root, { recursive: true });
  try {
    const output = prepareRetainedReviewOutput(root, "summary");
    const report = join(root, "42.md");
    const debug = join(root, "codex", "42.stdout.log");
    mkdirSync(join(root, "codex"));
    writeFileSync(report, "summary\n");
    writeFileSync(debug, "debug\n");
    chmodSync(report, 0o644);
    finalizeSummaryReviewOutput(output, [report]);
    assert.deepEqual(readdirSync(root), ["42.md"]);
    assert.equal(readFileSync(report, "utf8"), "summary\n");
    assert.equal(statSync(report).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty summary finalization removes only its exclusively owned empty directory", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-summary-empty-"));
  const destination = join(root, "summary");
  try {
    const output = prepareRetainedReviewOutput(destination, "summary");
    finalizeSummaryReviewOutput(output, []);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary output requires an exclusive destination and its original owner token", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-summary-owner-"));
  const existing = join(root, "existing");
  const owned = join(root, "owned");
  try {
    mkdirSync(existing);
    assert.throws(() => prepareRetainedReviewOutput(existing, "summary"), /must not already exist/);
    const output = prepareRetainedReviewOutput(owned, "summary");
    const marker = readdirSync(owned).find((name) => name.startsWith(".clawsweeper-output-owner"));
    assert.ok(marker);
    writeFileSync(join(owned, marker), "replaced-owner");
    const report = join(owned, "report.md");
    writeFileSync(report, "summary\n");
    assert.throws(() => finalizeSummaryReviewOutput(output, [report]), /ownership changed/);
    assert.equal(readFileSync(report, "utf8"), "summary\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient and debug output enforce aggregate file and byte budgets", () => {
  const transient = createTransientReviewOutput("clawsweeper-budget-test-");
  const debugRoot = join(tmpdir(), `clawsweeper-debug-budget-${process.pid}-${Date.now()}`);
  try {
    const tooLarge = join(transient.path, "too-large.log");
    writeFileSync(tooLarge, "");
    truncateSync(tooLarge, 96 * 1024 * 1024 + 1);
    assert.throws(() => assertTransientReviewOutputBudget(transient.path), /byte limit/);

    const debug = prepareRetainedReviewOutput(debugRoot, "debug");
    const debugLarge = join(debugRoot, "too-large.log");
    writeFileSync(debugLarge, "");
    truncateSync(debugLarge, 1024 * 1024 * 1024 + 1);
    assert.throws(() => assertActiveReviewOutputBudget(debug), /byte limit/);
  } finally {
    transient.cleanup();
    rmSync(debugRoot, { recursive: true, force: true });
  }
});

test("per-item budgets stay within their aggregate pools", () => {
  const debug = reviewOutputItemBudget("debug", 5);
  assert.ok(debug.streamFileBytes * 2 * 5 <= 480 * 1024 * 1024);
  assert.ok(debug.promptFileBytes * 5 <= 256 * 1024 * 1024);
  assert.ok(debug.resultFileBytes * 5 <= 64 * 1024 * 1024);
  for (const retention of ["none", "summary"] as const) {
    const transient = reviewOutputItemBudget(retention, 64);
    assert.deepEqual(transient, {
      promptFileBytes: 0,
      resultFileBytes: 4 * 1024 * 1024,
      streamFileBytes: 16 * 1024 * 1024,
      mediaDownloadBytes: 32 * 1024 * 1024,
      mediaDerivedBytes: 8 * 1024 * 1024,
      metadataBytes: 4 * 1024 * 1024,
      reportsBytes: 16 * 1024 * 1024,
    });
    assert.equal(
      transient.streamFileBytes * 2 +
        transient.resultFileBytes +
        transient.reportsBytes +
        transient.mediaDownloadBytes +
        transient.mediaDerivedBytes +
        transient.metadataBytes,
      96 * 1024 * 1024,
    );
  }
  assert.throws(() => reviewOutputItemBudget("debug", 129), /1-128 items/);
});

test("review metadata rejects an over-budget producer before creating its file", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-metadata-budget-"));
  try {
    const output = join(root, "metadata.json");
    const budget = createReviewOutputMetadataBudget(root, 4);
    assert.throws(
      () => writeReviewOutputMetadata(budget, output, "12345"),
      /exceeded its 4-byte limit/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("64-item none, summary, and debug runs respect live file peaks and preserve evidence hashes", () => {
  const parent = mkdtempSync(join(tmpdir(), "clawsweeper-output-peak-"));
  try {
    for (const retention of ["none", "summary", "debug"] as const) {
      const root = join(parent, retention);
      if (retention === "summary") prepareRetainedReviewOutput(root, "summary");
      else mkdirSync(root);
      for (let index = 0; index < 7; index += 1) {
        writeFileSync(join(root, `global-${index}.json`), "{}");
      }
      const evidence: string[] = [];
      let observedPeak = 0;
      for (let itemNumber = 1; itemNumber <= 64; itemNumber += 1) {
        const reportPath = join(root, `report-${itemNumber}.md`);
        const codexWorkDir = join(root, "codex");
        const proofScratchDir = join(codexWorkDir, "proof-scratch", String(itemNumber));
        mkdirSync(proofScratchDir, { recursive: true });
        writeFileSync(reportPath, `report ${itemNumber}\n`);
        for (const suffix of [
          "prompt.md",
          "json",
          "1.codex.stdout.log",
          "1.codex.stderr.log",
          "review-thread.json",
        ]) {
          writeFileSync(join(codexWorkDir, `${itemNumber}.${suffix}`), `${suffix}\n`);
        }
        for (let proof = 0; proof < 14; proof += 1) {
          writeFileSync(join(proofScratchDir, `proof-${proof}`), `${proof}\n`);
        }
        if (retention === "debug") {
          writeFileSync(join(root, `local-review-history-${itemNumber}.md`), "history\n");
        }
        for (const path of [
          reportPath,
          join(codexWorkDir, `${itemNumber}.1.codex.stdout.log`),
          join(codexWorkDir, `${itemNumber}.1.codex.stderr.log`),
        ]) {
          evidence.push(createHash("sha256").update(readFileSync(path)).digest("hex"));
        }
        observedPeak = Math.max(observedPeak, countFiles(root));
        pruneReviewOutputItem({
          artifactDir: root,
          codexWorkDir,
          proofScratchDir,
          reportPath,
          itemNumber,
          retention,
        });
      }
      assert.equal(observedPeak, reviewOutputFilePeak(retention, 64));
      assert.equal(evidence.length, 64 * 3);
      assert.ok(evidence.every((digest) => /^[0-9a-f]{64}$/.test(digest)));
      assert.equal(
        countFiles(root),
        retention === "none" ? 7 : retention === "summary" ? 7 + 1 + 64 : 7 + 64 * 21,
      );
      if (retention !== "debug") assert.equal(existsSync(join(root, "codex")), false);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("review result files are rejected before an oversized read", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-result-budget-"));
  try {
    const result = join(root, "result.json");
    writeFileSync(result, "");
    truncateSync(result, 4 * 1024 * 1024 + 1);
    assert.throws(
      () => readBoundedReviewResult(result, 4 * 1024 * 1024),
      /exceeded its .*byte limit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function countFiles(root: string): number {
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) pending.push(path);
      else files += 1;
    }
  }
  return files;
}

test("retained output rejects a symlink destination", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-output-link-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.throws(() => prepareRetainedReviewOutput(link, "debug"), /real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON result output keeps artifact paths nullable", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    emitReviewOutput(
      {
        retention: "none",
        resultFormat: "json",
        explicitDestination: false,
        compatibilityRetention: false,
      },
      "completed",
      [{ itemNumber: 42, path: null, markdown: "review" }],
    );
  } finally {
    console.log = original;
  }
  assert.deepEqual(JSON.parse(lines.join("")), {
    status: "completed",
    retention: "none",
    reports: [{ item_number: 42, artifact_path: null, report: "review" }],
  });
});

test("successful empty local selections emit JSON while empty failures defer to the CLI catch", () => {
  assert.equal(localReviewOutputHasPayload("completed", 0), true);
  assert.equal(localReviewOutputHasPayload("failed", 0), false);
  assert.equal(localReviewOutputHasPayload("failed", 1), true);
});

test("new retained modes print the review while legacy explicit paths still print the path", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    emitReviewOutput(
      {
        retention: "summary",
        resultFormat: "text",
        explicitDestination: false,
        compatibilityRetention: false,
      },
      "completed",
      [{ path: "/tmp/report.md", markdown: "review result\n" }],
    );
    emitReviewOutput(
      {
        retention: "debug",
        resultFormat: "text",
        explicitDestination: true,
        compatibilityRetention: true,
      },
      "completed",
      [{ path: "/tmp/report.md", markdown: "legacy result\n" }],
    );
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, ["review result", "/tmp/report.md"]);
});

test("early review failures remain valid JSON", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    assert.equal(
      emitReviewFailureJson(
        parseArgs(["--result-format", "json", "--output-retention", "summary"]),
        new Error("scan failed"),
      ),
      true,
    );
  } finally {
    console.log = original;
  }
  assert.deepEqual(JSON.parse(lines.join("")), {
    status: "failed",
    retention: "summary",
    reports: [],
    error: { message: "scan failed" },
  });
});

test("legacy explicit-path failures report compatibility retention in JSON", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => lines.push(String(value));
  try {
    assert.equal(
      emitReviewFailureJson(
        parseArgs(["--result-format", "json", "--artifact-dir", "artifacts"]),
        new Error("destination failed"),
      ),
      true,
    );
  } finally {
    console.log = original;
  }
  assert.equal(JSON.parse(lines.join("")).retention, "debug");
});
