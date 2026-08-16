import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  codexFailureDecisionForTest,
  codexFailureLogKindForTest,
  redactInternalCodexModel,
  runCodexForTest,
} from "../dist/clawsweeper.js";
import { closeDecision, item, tmpPrefix } from "./helpers.ts";

const trackedCheckoutContent = "tracked checkout content\n";
const trackedCheckoutFingerprint = "8b9382c9009cdc46cb69d59eb0078522d45023b2";
const fakeCodexSandboxPass = `if (process.argv[2] === "sandbox") {
  process.stdout.write(${JSON.stringify(trackedCheckoutFingerprint)} + "\\n");
  process.exit(0);
}`;

function initTrackedRepo(dir: string, trackedPath = "tracked.txt"): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, trackedPath), trackedCheckoutContent);
  execFileSync("git", ["add", trackedPath], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    { cwd: dir, stdio: "ignore" },
  );
}

test("Codex decision schema avoids unsupported strict-output keywords recursively", () => {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), "schema", "clawsweeper-decision.schema.json"), "utf8"),
  ) as unknown;
  const forbidden = new Set(["oneOf", "allOf", "if", "then", "uniqueItems"]);
  const found: string[] = [];

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (forbidden.has(key)) found.push(childPath);
      visit(child, childPath);
    }
  };

  visit(schema, "$");
  assert.deepEqual(found, []);
});

test("Codex failure logs distinguish provider throttling from content output failures", () => {
  assert.equal(
    codexFailureLogKindForTest(
      "Codex review failed: retryable codex transport failure (capacity).",
    ),
    "provider_throttle",
  );
  assert.equal(
    codexFailureLogKindForTest("Codex review failed: invalid structured output."),
    "content_or_output",
  );
  assert.equal(
    codexFailureLogKindForTest("Codex review failed: codex execution failed."),
    "codex_execution",
  );
});

test("runCodex accepts valid structured output after non-zero Codex exit", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
process.stderr.write("wrote structured output before shutdown failure\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalDecision = process.env.CODEX_DECISION_JSON;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Keep open for maintainer follow-up.",
      bestSolution: "Review the routing invariant.",
      closeComment: "",
      workReason: "Maintainer review is required.",
    }),
  );
  try {
    const decision = runCodexForTest({
      item: item({ number: 83393 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(decision.decision, "keep_open");
    assert.equal(decision.summary, "Keep open for maintainer follow-up.");
    assert.equal(decision.localCheckoutAccess, "verified");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDecision === undefined) delete process.env.CODEX_DECISION_JSON;
    else process.env.CODEX_DECISION_JSON = originalDecision;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex stops before model review when the sandbox cannot prove the tracked file", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const invocationsPath = join(root, "codex-invocations");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CODEX_INVOCATIONS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "sandbox") {
  process.stdout.write("0000000000000000000000000000000000000000\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_INVOCATIONS_PATH: process.env.CODEX_INVOCATIONS_PATH,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_INVOCATIONS_PATH = invocationsPath;
  try {
    assert.throws(() =>
      runCodexForTest({
        item: item({ number: 83396 }),
        context: { issue: {}, comments: [], timeline: [] },
        git: { mainSha: "abc123", latestRelease: null },
        model: "model-test",
        openclawDir,
        reasoningEffort: "high",
        sandboxMode: "read-only",
        serviceTier: "",
        timeoutMs: 10_000,
        workDir,
        prompt: "Return a review decision.",
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(invocationsPath, "utf8")), [
      "sandbox",
      "--permission-profile",
      ":read-only",
      "-C",
      openclawDir,
      "--",
      "git",
      "hash-object",
      "--",
      "tracked.txt",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex supports whitespace and Unicode in regular tracked paths", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const argsPath = join(root, "codex-args");
  const trackedPath = "review proof ü.txt";
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir, trackedPath);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
${fakeCodexSandboxPass}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ARGS_PATH: process.env.CODEX_ARGS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ARGS_PATH = argsPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(closeDecision({ decision: "keep_open" }));
  try {
    const decision = runCodexForTest({
      item: item({ number: 83401 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });
    assert.equal(decision.localCheckoutAccess, "verified");
    const [inspectionArgs] = readFileSync(argsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(inspectionArgs?.at(-1), trackedPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex supports newlines in regular tracked paths", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const argsPath = join(root, "codex-args");
  const trackedPath = "review\nproof.txt";
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir, trackedPath);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
${fakeCodexSandboxPass}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ARGS_PATH: process.env.CODEX_ARGS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ARGS_PATH = argsPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(closeDecision({ decision: "keep_open" }));
  try {
    const decision = runCodexForTest({
      item: item({ number: 83402 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });
    assert.equal(decision.localCheckoutAccess, "verified");
    const [inspectionArgs] = readFileSync(argsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(inspectionArgs?.at(-1), trackedPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "runCodex rejects a tracked symlink that escapes the checkout",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(tmpPrefix);
    const openclawDir = join(root, "openclaw");
    const workDir = join(root, "codex-work");
    const binDir = join(root, "bin");
    const invocationsPath = join(root, "codex-invocations");
    const outsidePath = join(root, "outside.txt");
    mkdirSync(openclawDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
    writeFileSync(outsidePath, trackedCheckoutContent);
    symlinkSync(outsidePath, join(openclawDir, "escape-link"));
    execFileSync("git", ["add", "escape-link"], { cwd: openclawDir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      { cwd: openclawDir, stdio: "ignore" },
    );
    const codexPath = join(binDir, "codex");
    writeFileSync(
      codexPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CODEX_INVOCATIONS_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "sandbox") {
  process.stdout.write(${JSON.stringify(trackedCheckoutFingerprint)} + "\\n");
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(codexPath, 0o755);
    const previous = {
      PATH: process.env.PATH,
      CODEX_INVOCATIONS_PATH: process.env.CODEX_INVOCATIONS_PATH,
    };
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    process.env.CODEX_INVOCATIONS_PATH = invocationsPath;
    try {
      assert.throws(() =>
        runCodexForTest({
          item: item({ number: 83400 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "model-test",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      );
      assert.equal(existsSync(invocationsPath), false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("runCodex counts checkout inspection against the review timeout", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "sandbox") {
  setTimeout(() => {
    process.stdout.write(${JSON.stringify(trackedCheckoutFingerprint)} + "\\n");
    process.exit(0);
  }, 400);
} else {
  const outputIndex = process.argv.indexOf("--output-last-message");
  setTimeout(() => {
    fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
  }, 400);
}
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(closeDecision({ decision: "keep_open" }));
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "1";
  try {
    assert.throws(() =>
      runCodexForTest({
        item: item({ number: 83399 }),
        context: { issue: {}, comments: [], timeline: [] },
        git: { mainSha: "abc123", latestRelease: null },
        model: "model-test",
        openclawDir,
        reasoningEffort: "high",
        sandboxMode: "read-only",
        serviceTier: "",
        timeoutMs: 650,
        workDir,
        prompt: "Return a review decision.",
      }),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex rejects OpenClaw checkout text without structured read evidence", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "review-work");
  const openclawPath = join(root, "fake-openclaw");
  const invocationsPath = join(root, "openclaw-invocations");
  mkdirSync(openclawDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const expected = closeDecision({ decision: "keep_open", summary: "Reviewed with OpenClaw." });
  writeFileSync(
    openclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const count = fs.existsSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH)
  ? Number(fs.readFileSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH, "utf8"))
  : 0;
fs.writeFileSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH, String(count + 1));
const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8");
const relativePath = JSON.parse(prompt.match(/^Path: (.+)$/m)[1]);
const challenged = fs.readFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, relativePath), "utf8").trim();
const text = count === 0 ? challenged : ${JSON.stringify(JSON.stringify(expected))};
process.stdout.write(JSON.stringify({ payloads: [{ text }], meta: { stopReason: "stop" } }));
`,
  );
  chmodSync(openclawPath, 0o755);
  const previous = {
    CLAWSWEEPER_RUNNER: process.env.CLAWSWEEPER_RUNNER,
    CLAWSWEEPER_OPENCLAW_BIN: process.env.CLAWSWEEPER_OPENCLAW_BIN,
    CLAWSWEEPER_OPENCLAW_MODEL: process.env.CLAWSWEEPER_OPENCLAW_MODEL,
    CODEX_BIN: process.env.CODEX_BIN,
    OPENCLAW_TEST_INVOCATIONS_PATH: process.env.OPENCLAW_TEST_INVOCATIONS_PATH,
  };
  process.env.CLAWSWEEPER_RUNNER = "openclaw";
  process.env.CLAWSWEEPER_OPENCLAW_BIN = openclawPath;
  process.env.CLAWSWEEPER_OPENCLAW_MODEL = "openai/gpt-5";
  process.env.CODEX_BIN = join(root, "missing-codex");
  process.env.OPENCLAW_TEST_INVOCATIONS_PATH = invocationsPath;
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 83397 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "internal",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      /successful read tool call/,
    );
    assert.equal(readFileSync(invocationsPath, "utf8"), "1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex reviews after an attested OpenClaw checkout challenge", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "review-work");
  const openclawPath = join(root, "fake-openclaw");
  const invocationsPath = join(root, "openclaw-invocations");
  mkdirSync(openclawDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: openclawDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: openclawDir, stdio: "ignore" },
  );
  const expected = closeDecision({ decision: "keep_open", summary: "Reviewed with OpenClaw." });
  writeFileSync(
    openclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const count = fs.existsSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH)
  ? Number(fs.readFileSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH, "utf8"))
  : 0;
fs.writeFileSync(process.env.OPENCLAW_TEST_INVOCATIONS_PATH, String(count + 1));
const review = { payloads: [{ text: ${JSON.stringify(JSON.stringify(expected))} }], meta: { stopReason: "stop" } };
if (count > 0) {
  process.stdout.write(JSON.stringify(review));
} else {
  const prompt = fs.readFileSync(process.argv[process.argv.indexOf("--message-file") + 1], "utf8");
  const relativePath = JSON.parse(prompt.match(/^Path: (.+)$/m)[1]);
  process.stdout.write(JSON.stringify({
    payloads: [{ text: fs.readFileSync(path.join(process.env.OPENCLAW_WORKSPACE_DIR, relativePath), "utf8").trim() }],
    meta: { stopReason: "stop", toolSummary: { calls: 1, tools: ["read"], failures: 0 } },
  }));
}
`,
  );
  chmodSync(openclawPath, 0o755);
  const previous = {
    CLAWSWEEPER_RUNNER: process.env.CLAWSWEEPER_RUNNER,
    CLAWSWEEPER_OPENCLAW_BIN: process.env.CLAWSWEEPER_OPENCLAW_BIN,
    CLAWSWEEPER_OPENCLAW_MODEL: process.env.CLAWSWEEPER_OPENCLAW_MODEL,
    CODEX_BIN: process.env.CODEX_BIN,
    OPENCLAW_TEST_INVOCATIONS_PATH: process.env.OPENCLAW_TEST_INVOCATIONS_PATH,
  };
  process.env.CLAWSWEEPER_RUNNER = "openclaw";
  process.env.CLAWSWEEPER_OPENCLAW_BIN = openclawPath;
  process.env.CLAWSWEEPER_OPENCLAW_MODEL = "openai/gpt-5";
  process.env.CODEX_BIN = join(root, "missing-codex");
  process.env.OPENCLAW_TEST_INVOCATIONS_PATH = invocationsPath;
  try {
    const decision = runCodexForTest({
      item: item({ number: 83396 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "internal",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });
    assert.equal(decision.summary, "Reviewed with OpenClaw.");
    assert.equal(readFileSync(invocationsPath, "utf8"), "2");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex honors env login config unless preserving local Codex auth", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const argsPath = join(root, "codex-args.json");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ARGS_PATH: process.env.CODEX_ARGS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CLAWSWEEPER_CODEX_LOGIN_METHOD: process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ARGS_PATH = argsPath;
  process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD = "chatgpt";
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Keep open for maintainer follow-up.",
      bestSolution: "Review the routing invariant.",
      closeComment: "",
      workReason: "Maintainer review is required.",
    }),
  );

  const runAndReadArgs = (preserveCodexAuth: boolean): string[] => {
    const decision = runCodexForTest({
      item: item({ number: 83395 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      preserveCodexAuth,
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });
    assert.equal(decision.decision, "keep_open");
    return JSON.parse(readFileSync(argsPath, "utf8")) as string[];
  };

  try {
    const defaultArgs = runAndReadArgs(false);
    assert.deepEqual(defaultArgs, [
      "exec",
      "--model",
      "model-test",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'approval_policy="never"',
      "-C",
      openclawDir,
      "--output-schema",
      join(process.cwd(), "schema", "clawsweeper-decision.schema.json"),
      "--output-last-message",
      join(workDir, "83395.json"),
      "--json",
      "--sandbox",
      "read-only",
      "--add-dir",
      join(workDir, "proof-scratch", "83395"),
      "-",
    ]);
    assert.equal(runAndReadArgs(true).includes('forced_login_method="chatgpt"'), false);
    assert.equal(
      runAndReadArgs(true).some((arg) => arg.startsWith("forced_login_method=")),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex preserves redacted process output when Codex exits without a decision", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
process.stdout.write("startup banner GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 CODEX_ACCESS_TOKEN=codex-access-token-secret\\n");
process.stderr.write("Rate limit reached for model-test on tokens per min (TPM); OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456 {\\"CODEX_ACCESS_TOKEN\\":\\"codex-json-token-secret\\"}\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalAttempts = process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 83394 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "model-test",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error & {
          status?: number | null;
          stderr?: string;
          stdout?: string;
        };
        assert.equal(reviewError.status, 1);
        assert.match(reviewError.stderr ?? "", /Rate limit reached/);
        assert.match(reviewError.stderr ?? "", /OPENAI_API_KEY=\[REDACTED\]/);
        assert.match(reviewError.stderr ?? "", /"CODEX_ACCESS_TOKEN":"\[REDACTED\]"/);
        assert.doesNotMatch(reviewError.stderr ?? "", /sk-proj-/);
        assert.doesNotMatch(reviewError.stderr ?? "", /codex-json-token-secret/);
        assert.match(reviewError.stdout ?? "", /startup banner/);
        assert.match(reviewError.stdout ?? "", /GH_TOKEN=\[REDACTED\]/);
        assert.match(reviewError.stdout ?? "", /CODEX_ACCESS_TOKEN=\[REDACTED\]/);
        assert.doesNotMatch(reviewError.stdout ?? "", /ghp_/);
        assert.doesNotMatch(reviewError.stdout ?? "", /codex-access-token-secret/);
        return true;
      },
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAttempts === undefined) delete process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS;
    else process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = originalAttempts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex accepts structured output after more than 128 MiB of process output", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const chunk = Buffer.alloc(1024 * 1024, "x");
for (let index = 0; index < 129; index += 1) fs.writeSync(1, chunk);
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const originalPath = process.env.PATH;
  const originalDecision = process.env.CODEX_DECISION_JSON;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Review survived verbose Codex output.",
      bestSolution: "Keep file-backed process output.",
      closeComment: "",
      workReason: "No additional implementation is required.",
    }),
  );
  try {
    const decision = runCodexForTest({
      item: item({ number: 83395 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "model-test",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 20_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(decision.summary, "Review survived verbose Codex output.");
    assert.equal(statSync(join(workDir, "83395.1.codex.stdout.log")).size, 128 * 1024 * 1024);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDecision === undefined) delete process.env.CODEX_DECISION_JSON;
    else process.env.CODEX_DECISION_JSON = originalDecision;
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex failure decisions expose stderr and stdout separately", () => {
  const errorMessage =
    "Rate limit reached for model-test on tokens per min (TPM). Please try again in 1ms.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #278 with exit 1.",
    JSON.stringify({ type: "turn.failed", error: { message: errorMessage } }),
    "user\nThe reviewed prompt discusses rate limits.",
  );

  assert.equal(
    decision.summary,
    "Codex review failed: retryable codex transport failure (capacity) (exit 1).",
  );
  assert.equal(decision.localCheckoutAccess, "unverified");
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex stderr")?.detail,
    "user\nThe reviewed prompt discusses rate limits.",
  );
  assert.equal(decision.regressionAssessment, null);
  assert.match(
    decision.evidence.find((entry) => entry.label === "codex stdout")?.detail ?? "",
    /"type":"turn.failed"/,
  );
});

test("codex failure decisions do not infer buffer overflow from reviewed content", () => {
  const terminalError =
    "stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #89041 with exit 1.",
    JSON.stringify({ type: "turn.failed", error: { message: terminalError } }),
    "user\nThe reviewed PR discusses maxBufferedChunks and maxBuffer behavior.",
  );

  assert.equal(
    decision.summary,
    "Codex review failed: model unavailable or access denied (exit 1).",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error")?.detail,
    terminalError,
  );
  assert.equal(decision.codexTerminalFailure, true);
});

test("codex failure decisions classify structured ENOBUFS as output overflow", () => {
  const decision = codexFailureDecisionForTest(
    null,
    "Codex review failed before producing output.",
    "",
    "",
    { errorCode: "ENOBUFS", signal: "SIGTERM" },
  );

  assert.equal(decision.summary, "Codex review failed: output buffer overflow.");
  assert.equal(
    decision.evidence.find((entry) => entry.label === "process error code")?.detail,
    "ENOBUFS",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "process signal")?.detail,
    "SIGTERM",
  );
});

test("codex failure decisions ignore unstructured output and prompt stderr", () => {
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #92565 with exit 1.",
    "ERROR: The model quoted-model does not exist or you do not have access to it.",
    "ERROR: fetch failed",
  );

  assert.equal(decision.summary, "Codex review failed: codex execution failed (exit 1).");
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error"),
    undefined,
  );
  assert.equal(decision.codexTerminalFailure, false);
});

test("codex failure decisions trust a final stderr model access denial", () => {
  const terminalError =
    "ERROR: stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.";
  const decision = codexFailureDecisionForTest(
    1,
    "Codex review failed for #92565 with exit 1.",
    "",
    `reviewed patch text\n${terminalError}`,
  );

  assert.equal(
    decision.summary,
    "Codex review failed: model unavailable or access denied (exit 1).",
  );
  assert.equal(
    decision.evidence.find((entry) => entry.label === "codex terminal error")?.detail,
    terminalError,
  );
  assert.equal(decision.codexTerminalFailure, true);
});

test("runCodex retries a transient failure in a fresh process", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  initTrackedRepo(openclawDir);
  writeFileSync(join(codexHome, "config.toml"), 'model = "secret-model-for-test"\n');
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  process.stderr.write("user\\nERROR: The model contributor-quoted-model does not exist or you do not have access to it.\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.failed",
    error: {
      message: "stream disconnected: Rate limit reached for secret-model-for-test (for limit test) on tokens per min (TPM). Please try again in 1ms."
    }
  }) + "\\n");
  process.exit(1);
}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      confidence: "medium",
      summary: "Review completed after a fresh Codex process.",
      bestSolution: "Continue the existing review loop.",
      closeComment: "",
      workReason: "No additional implementation is required.",
    }),
  );
  process.env.CODEX_HOME = codexHome;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  try {
    const decision = runCodexForTest({
      item: item({ number: 83394 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "internal",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
    assert.equal(decision.summary, "Review completed after a fresh Codex process.");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex keeps high reasoning for the final transport retry", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  const attemptTimesPath = join(root, "attempt-times");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
// Consume the prompt like the real Codex CLI so early exits cannot race its stdin writer.
fs.readFileSync(0, "utf8");
const cfg = process.argv.find((a) => a.startsWith("model_reasoning_effort="));
const effort = cfg ? cfg.split("=")[1].replace(/"/g, "") : "";
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
fs.appendFileSync(process.env.CODEX_ATTEMPT_TIMES_PATH, \`\${Date.now()}\\n\`);
if (effort !== "high") {
  process.stderr.write(\`unexpected reasoning effort: \${effort}\\n\`);
  process.exit(9);
}
if (n < 3) {
  process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 100ms.\\n");
  process.exit(1);
}
const outputIndex = process.argv.indexOf("--output-last-message");
fs.writeFileSync(process.argv[outputIndex + 1], process.env.CODEX_DECISION_JSON);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CODEX_ATTEMPT_TIMES_PATH: process.env.CODEX_ATTEMPT_TIMES_PATH,
    CODEX_DECISION_JSON: process.env.CODEX_DECISION_JSON,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CODEX_ATTEMPT_TIMES_PATH = attemptTimesPath;
  process.env.CODEX_DECISION_JSON = JSON.stringify(
    closeDecision({
      decision: "close",
      closeReason: "duplicate_or_superseded",
      confidence: "high",
      summary: "Resolved on main already.",
      bestSolution: "Close as superseded.",
      closeComment: "Superseded by main.",
      workReason: "No additional implementation is required.",
    }),
  );
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "1";
  try {
    const decision = runCodexForTest({
      item: item({ number: 92181 }),
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: "abc123", latestRelease: null },
      model: "internal",
      openclawDir,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      serviceTier: "",
      timeoutMs: 10_000,
      workDir,
      prompt: "Return a review decision.",
    });

    assert.equal(readFileSync(attemptsPath, "utf8"), "3");
    const attemptTimes = readFileSync(attemptTimesPath, "utf8").trim().split("\n").map(Number);
    assert.equal(attemptTimes.length, 3);
    assert.ok((attemptTimes[2] ?? 0) - (attemptTimes[1] ?? 0) >= 90);
    assert.equal(decision.decision, "close");
    assert.equal(decision.confidence, "high");
    assert.equal(decision.summary, "Resolved on main already.");
    assert.equal(
      decision.evidence.some((entry) => entry.label === "degraded review mode"),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex keeps the transport classification when the final high retry also fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 1ms.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 92181 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "internal",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error;
        assert.equal(readFileSync(attemptsPath, "utf8"), "3");
        assert.match(reviewError.message, /Final high-reasoning retry also failed/);
        const failure = codexFailureDecisionForTest(
          1,
          reviewError.message,
          (reviewError as { stdout?: string }).stdout ?? "",
          (reviewError as { stderr?: string }).stderr ?? "",
        );
        assert.match(failure.summary, /retryable codex transport failure \(capacity\)/);
        return true;
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex skips the final high retry when the time budget is too small", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const n = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(n));
process.stderr.write("Rate limit reached on tokens per min (TPM). Please try again in 1ms.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
    CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS: process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "2";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  process.env.CLAWSWEEPER_CODEX_FALLBACK_MIN_BUDGET_MS = "10000000";
  try {
    assert.throws(() =>
      runCodexForTest({
        item: item({ number: 92181 }),
        context: { issue: {}, comments: [], timeline: [] },
        git: { mainSha: "abc123", latestRelease: null },
        model: "internal",
        openclawDir,
        reasoningEffort: "high",
        sandboxMode: "read-only",
        serviceTier: "",
        timeoutMs: 10_000,
        workDir,
        prompt: "Return a review decision.",
      }),
    );
    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodex does not retry terminal model access failures", () => {
  const root = mkdtempSync(tmpPrefix);
  const openclawDir = join(root, "openclaw");
  const workDir = join(root, "codex-work");
  const binDir = join(root, "bin");
  const attemptsPath = join(root, "attempts");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  initTrackedRepo(openclawDir);
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
${fakeCodexSandboxPass}
const fs = require("node:fs");
const attemptsPath = process.env.CODEX_ATTEMPTS_PATH;
const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, "utf8")) + 1 : 1;
fs.writeFileSync(attemptsPath, String(attempt));
process.stderr.write("reviewed patch text\\n");
process.stderr.write("stream disconnected before completion: The model secret-model-for-test does not exist or you do not have access to it.\\n");
process.exit(1);
`,
  );
  chmodSync(codexPath, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CODEX_ATTEMPTS_PATH: process.env.CODEX_ATTEMPTS_PATH,
    CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS: process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS,
    CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS: process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  };
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_ATTEMPTS_PATH = attemptsPath;
  process.env.CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS = "3";
  process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS = "1";
  try {
    assert.throws(
      () =>
        runCodexForTest({
          item: item({ number: 89041 }),
          context: { issue: {}, comments: [], timeline: [] },
          git: { mainSha: "abc123", latestRelease: null },
          model: "internal",
          openclawDir,
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          timeoutMs: 10_000,
          workDir,
          prompt: "Return a review decision.",
        }),
      (error: unknown) => {
        const reviewError = error as Error & { stderr?: string };
        assert.match(reviewError.stderr ?? "", /does not exist or you do not have access/);
        return true;
      },
    );
    assert.equal(readFileSync(attemptsPath, "utf8"), "1");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex failure redaction hides the configured internal model", () => {
  const root = mkdtempSync(tmpPrefix);
  writeFileSync(join(root, "config.toml"), 'model = "secret-model-for-test"\n');
  try {
    const redacted = redactInternalCodexModel(
      "selected secret-model-for-test; Rate limit reached for unknown-model (for limit test)",
      root,
    );
    assert.doesNotMatch(redacted, /secret-model-for-test|unknown-model/);
    assert.equal(redacted.match(/\[REDACTED_INTERNAL_MODEL\]/g)?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent failure redaction hides the configured OpenClaw model", () => {
  const previous = process.env.CLAWSWEEPER_OPENCLAW_MODEL;
  try {
    process.env.CLAWSWEEPER_OPENCLAW_MODEL = "private-provider/private-model";
    assert.equal(
      redactInternalCodexModel("selected private-provider/private-model"),
      "selected [REDACTED_INTERNAL_MODEL]",
    );
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_OPENCLAW_MODEL;
    else process.env.CLAWSWEEPER_OPENCLAW_MODEL = previous;
  }
});

test("Codex failure redaction reads the default home configuration", () => {
  const root = mkdtempSync(tmpPrefix);
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "default-secret-model"\n');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAWSWEEPER_INTERNAL_MODEL: process.env.CLAWSWEEPER_INTERNAL_MODEL,
  };
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.CODEX_HOME;
    delete process.env.CLAWSWEEPER_INTERNAL_MODEL;
    assert.equal(
      redactInternalCodexModel("selected default-secret-model"),
      "selected [REDACTED_INTERNAL_MODEL]",
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
