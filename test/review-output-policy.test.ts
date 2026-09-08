import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  createTransientReviewOutput,
  emitReviewFailureJson,
  emitReviewOutput,
  finalizeSummaryReviewOutput,
  prepareRetainedReviewOutput,
  reviewOutputSelection,
} from "../dist/review-output-policy.js";

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
  "transient review output is removed on a handled termination signal",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `import { createTransientReviewOutput } from ${JSON.stringify(new URL("../dist/review-output-policy.js", import.meta.url).href)};`,
          `const output = createTransientReviewOutput("clawsweeper-signal-test-");`,
          `console.log(output.path);`,
          `setInterval(() => {}, 1000);`,
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
    child.kill("SIGTERM");
    const [status, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    assert.equal(status, null);
    assert.equal(signal, "SIGTERM");
    assert.equal(existsSync(path), false);
  },
);

test("summary retention removes debug files and keeps private bounded reports", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-summary-test-"));
  rmSync(root, { recursive: true });
  try {
    prepareRetainedReviewOutput(root, "summary");
    const report = join(root, "42.md");
    const debug = join(root, "codex", "42.stdout.log");
    mkdirSync(join(root, "codex"));
    writeFileSync(report, "summary\n");
    writeFileSync(debug, "debug\n");
    chmodSync(report, 0o644);
    finalizeSummaryReviewOutput(root, [report]);
    assert.deepEqual(readdirSync(root), ["42.md"]);
    assert.equal(readFileSync(report, "utf8"), "summary\n");
    assert.equal(statSync(report).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
