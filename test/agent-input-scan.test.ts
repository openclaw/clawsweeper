import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runAgentProcess, runAgentCheckoutInspection } from "../dist/agent-runner.js";
import {
  AgentInputScanError,
  AGENT_INPUT_FINDINGS_EXIT_CODE,
  INCOMPLETE_AGENT_INPUT_SOURCE_EXIT_CODE,
  agentInputScanFailureExitCode,
  managedScannerCacheRoot,
  reviewToolBootstrapEnvironment,
  scanAgentInput,
} from "../dist/agent-input-scan.js";
import {
  captureTargetCheckoutBinding,
  withTargetReviewSnapshot,
} from "../dist/repair/target-validation.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { writeExactReviewFailureDiagnostics } from "../dist/clawsweeper-review-failure-diagnostics.js";

test("unchanged source scan refusals receive terminal review exit codes", () => {
  assert.equal(
    agentInputScanFailureExitCode(new AgentInputScanError("incomplete_source")),
    INCOMPLETE_AGENT_INPUT_SOURCE_EXIT_CODE,
  );
  assert.equal(
    agentInputScanFailureExitCode(new AgentInputScanError("findings")),
    AGENT_INPUT_FINDINGS_EXIT_CODE,
  );
  assert.equal(agentInputScanFailureExitCode(new AgentInputScanError("scanner_failed")), null);
  assert.equal(agentInputScanFailureExitCode(new Error("review failed")), null);
});

test("managed scanner bootstrap forwards only required proxy and CA configuration", () => {
  assert.deepEqual(
    reviewToolBootstrapEnvironment({
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://proxy.example",
      no_proxy: "localhost",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\corp.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      CLAWSWEEPER_TOKEN: "secret",
    }),
    {
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://proxy.example",
      no_proxy: "localhost",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\corp.pem",
    },
  );
});

function fixture(t: test.TestContext, prompt = "Review the change.") {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-input-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "target");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Scanner fixture");
  git("config", "user.email", "scanner@example.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const calls = join(root, "provider-calls");
  const diagnosticPromptPath = join(root, "diagnostic.prompt.md");
  const binary = join(root, "codex");
  writeFileSync(
    binary,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'called'); require('node:fs').readFileSync(0);`,
    { mode: 0o755 },
  );
  const run = (source: Parameters<typeof scanAgentInput>[0]["source"], timeoutMs = 30_000) =>
    runAgentProcess({
      label: "scan-fixture",
      prompt,
      diagnosticPromptPath,
      scanSource: source,
      model: "internal",
      cwd,
      env: { ...process.env, CODEX_BIN: binary },
      timeoutMs,
    });
  return { root, cwd, git, commit, calls, diagnosticPromptPath, run };
}

function disableManagedScanner(t: test.TestContext) {
  const previous = process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  // A relative cache root is rejected before download. These tests exercise the
  // fail-closed branch where no trusted host scanner and no usable managed
  // cache are available, while keeping checkout-controlled executables inert.
  process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = "relative-managed-scanner-cache";
  t.after(() => {
    if (previous === undefined) delete process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
    else process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = previous;
  });
}

for (const scenario of ["deletion", "multiline", "past-display-limits", "comment-only"]) {
  test(`raw admission catches ${scenario} input before dispatch`, (t) => {
    const f = fixture(t);
    const receipt = join(f.root, "scan-root");
    const needle = "scan-fixture-sensitive\nsecond-sensitive-line";
    writeFileSync(f.diagnosticPromptPath, needle);
    useFakeScanner(
      t,
      `assert.equal(fs.existsSync(${JSON.stringify(f.diagnosticPromptPath)}), false);
fs.writeFileSync(${JSON.stringify(receipt)}, path.dirname(inputDir));
if (inputs.some(({bytes}) => bytes.includes(${JSON.stringify(needle)}))) {
  process.stdout.write(JSON.stringify({Raw: 'must-not-escape'})); process.exit(183);
}`,
    );
    writeFileSync(join(f.cwd, "a.ts"), scenario === "deletion" ? needle : "export const a = 1;\n");
    const baseSha = f.commit();
    if (scenario === "deletion") rmSync(join(f.cwd, "a.ts"));
    else if (scenario === "past-display-limits") {
      for (let i = 0; i < 85; i++)
        writeFileSync(join(f.cwd, `${String(i).padStart(3, "0")}.txt`), "clean\n".repeat(8000));
      writeFileSync(join(f.cwd, "z.txt"), "prefix\n".repeat(8000) + needle);
    } else writeFileSync(join(f.cwd, "a.ts"), `export const a = 1;\n/* ${needle} */\n`);
    const headSha = f.commit();
    assert.throws(
      () => f.run({ kind: "committed", baseSha, headSha }),
      (error) => {
        assert.ok(error instanceof AgentInputScanError);
        assert.equal(error.reason, "scanner_failed");
        assert.doesNotMatch(String(error), /must-not-escape/);
        return true;
      },
    );
    assert.equal(existsSync(f.calls), false);
    assert.equal(existsSync(f.diagnosticPromptPath), false);
    assert.equal(existsSync(readFileSync(receipt, "utf8")), false);
  });
}

test("raw snapshots scan uncommitted bytes without normalization and reject source drift", (t) => {
  const f = fixture(t);
  const receipt = join(f.root, "raw-bytes");
  useFakeScanner(
    t,
    `fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(inputs.map(({bytes}) => bytes.toString('base64'))));`,
  );
  writeFileSync(join(f.cwd, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  const dirty = Buffer.from("changed\r\nraw bytes\r\n");
  writeFileSync(join(f.cwd, "a.txt"), dirty);
  const expected = captureTargetCheckoutBinding(f.cwd);
  withTargetReviewSnapshot(
    { cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 },
    (source, timeoutMs) => {
      scanAgentInput({ cwd: f.cwd, prompt: "Review dirty change.", source, timeoutMs });
      assert.ok(JSON.parse(readFileSync(receipt, "utf8")).includes(dirty.toString("base64")));
    },
  );
  writeFileSync(join(f.cwd, "a.txt"), "drift\n");
  assert.throws(
    () => withTargetReviewSnapshot({ cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 }, f.run),
    /source_drift/,
  );
  assert.equal(existsSync(f.calls), false);
});

test("scan rejects a source changed while the scanner is running", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "a.txt"), "change\n");
  const headSha = f.commit();
  useFakeScanner(t, `fs.writeFileSync(${JSON.stringify(join(f.cwd, "a.txt"))}, 'drift');`);
  assert.throws(() => f.run({ kind: "committed", baseSha, headSha }), /source_drift/);
  assert.equal(existsSync(f.calls), false);
});

test("symlink target bytes are regular scan files and changed gitlinks/LFS refuse", (t) => {
  const f = fixture(t);
  const receipt = join(f.root, "links");
  useFakeScanner(
    t,
    `fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(inputs.map(({bytes}) => bytes.toString())));`,
  );
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  symlinkSync("/outside/private/never-follow", join(f.cwd, "link"));
  let headSha = f.commit();
  assert.equal(f.run({ kind: "committed", baseSha, headSha }).status, 0);
  assert.ok(JSON.parse(readFileSync(receipt, "utf8")).includes("/outside/private/never-follow"));
  rmSync(f.calls);
  f.git("update-index", "--add", "--cacheinfo", `160000,${baseSha},submodule`);
  f.git("commit", "-qm", "gitlink");
  headSha = f.git("rev-parse", "HEAD");
  assert.throws(() => f.run({ kind: "committed", baseSha, headSha }), /unsupported_content/);
  f.git("update-index", "--force-remove", "submodule");
  writeFileSync(
    join(f.cwd, "large.lfs"),
    "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 100\n",
  );
  headSha = f.commit();
  assert.throws(() => f.run({ kind: "committed", baseSha, headSha }), /unsupported_content/);
  assert.equal(existsSync(f.calls), false);
});

test("OpenClaw inspection cannot launch a provider on scan refusal", (t) => {
  const f = fixture(t);
  useFakeScanner(t, "process.exit(2);");
  writeFileSync(join(f.cwd, "a.txt"), "tracked checkout content\n");
  f.commit();
  assert.throws(
    () =>
      runAgentCheckoutInspection({
        cwd: f.cwd,
        initialPrompt: "Inspect checkout.",
        scanSource: { kind: "prompt" },
        timeoutMs: 30_000,
        env: {
          ...process.env,
          CLAWSWEEPER_RUNNER: "openclaw",
          CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
          CLAWSWEEPER_OPENCLAW_BIN: join(f.root, "codex"),
        },
      }),
    /scanner_failed/,
  );
  assert.equal(existsSync(f.calls), false);
});

test("checkout-controlled scanner is never executed", (t) => {
  const f = fixture(t);
  disableManagedScanner(t);
  const previousPath = process.env.PATH;
  process.env.PATH = f.cwd;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  writeFileSync(
    join(f.cwd, "trufflehog"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(f.calls)}, 'bad');`,
    { mode: 0o755 },
  );
  assert.throws(() => f.run({ kind: "prompt" }), /scanner_unavailable/);
  assert.equal(existsSync(f.calls), false);
});

test("managed scanner cache roots inside either checkout refuse before bootstrap writes", (t) => {
  const f = fixture(t);
  for (const root of [
    join(f.cwd, "managed-scanner-cache"),
    join(process.cwd(), `.managed-scanner-cache-${Date.now()}`),
  ]) {
    assert.throws(
      () => managedScannerCacheRoot({ CLAWSWEEPER_REVIEW_TOOLS_DIR: root }, f.cwd, f.cwd),
      /unsafe_path/,
    );
    assert.equal(existsSync(root), false, "rejected cache roots must not be created");
  }
});

test(
  "managed scanner cache symlinks refuse before bootstrap writes",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    const cacheRoot = join(f.root, "managed-scanner-cache-link");
    const target = join(f.cwd, "managed-scanner-cache");
    symlinkSync(target, cacheRoot);
    assert.throws(
      () =>
        managedScannerCacheRoot(
          { CLAWSWEEPER_REVIEW_TOOLS_DIR: cacheRoot },
          realpathSync(f.cwd),
          f.cwd,
        ),
      /unsafe_path/,
    );
    assert.equal(existsSync(target), false, "rejected cache symlinks must not create their target");
  },
);

test(
  "managed scanner cache may sit below an external symlinked ancestor",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    const external = join(f.root, "external-cache-parent");
    const alias = join(f.root, "external-cache-alias");
    mkdirSync(external);
    symlinkSync(external, alias);
    const cacheRoot = join(alias, "managed-scanner-cache");
    assert.equal(
      managedScannerCacheRoot({ CLAWSWEEPER_REVIEW_TOOLS_DIR: cacheRoot }, f.cwd, f.cwd),
      cacheRoot,
    );
    assert.equal(existsSync(cacheRoot), false, "validation must not create an external cache");
  },
);

for (const location of ["bin", "..tools", "..tools-copy"]) {
  test(`checkout scanner trust rejects ${location} even with an external symlink`, (t) => {
    const f = fixture(t);
    disableManagedScanner(t);
    const bin = join(f.cwd, location);
    mkdirSync(bin);
    if (location === "..tools-copy") copyFileSync("/usr/bin/true", join(bin, "trufflehog"));
    else symlinkSync("/usr/bin/true", join(bin, "trufflehog"));
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    t.after(() => {
      process.env.PATH = previousPath;
    });
    assert.throws(() => f.run({ kind: "prompt" }), /scanner_unavailable/);
    assert.equal(existsSync(f.calls), false);
  });
}

test("repair admission includes staged bytes when working bytes were restored", (t) => {
  const f = fixture(t);
  useFakeScanner(
    t,
    `if (inputs.some(({bytes}) => bytes.includes('staged-sensitive-marker'))) process.exit(183);`,
  );
  writeFileSync(join(f.cwd, "a.txt"), "clean\n");
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "a.txt"), "staged-sensitive-marker\n");
  f.git("add", "a.txt");
  writeFileSync(join(f.cwd, "a.txt"), "clean\n");
  const expected = captureTargetCheckoutBinding(f.cwd);
  assert.throws(
    () => withTargetReviewSnapshot({ cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 }, f.run),
    /scanner_failed/,
  );
  assert.equal(existsSync(f.calls), false);
});

function useGitConfigHome(t: test.TestContext, root: string) {
  const home = join(root, "home");
  mkdirSync(home);
  const previous = new Map(["HOME", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  for (const key of previous.keys()) process.env[key] = home;
  t.after(() => {
    for (const [key, original] of previous) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
}

for (const { scope, value } of [
  { scope: "repository", value: "true" },
  { scope: "global", value: "true" },
  { scope: "global", value: "1" },
]) {
  test(`clean CRLF checkout preserves raw bytes with ${scope} autocrlf=${value}`, (t) => {
    const f = fixture(t);
    const receipt = join(f.root, "raw-crlf");
    useFakeScanner(
      t,
      `fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(inputs.map(({bytes}) => bytes.toString('base64'))));`,
    );
    if (scope === "global") {
      useGitConfigHome(t, f.root);
      f.git("config", "--global", "core.autocrlf", value);
    } else {
      f.git("config", "core.autocrlf", value);
    }
    writeFileSync(join(f.cwd, "a.txt"), "one\r\n");
    const baseSha = f.commit();
    writeFileSync(join(f.cwd, "a.txt"), "two\r\n");
    const headSha = f.commit();
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.run({ kind: "committed", baseSha, headSha }).status, 0);
    assert.ok(
      JSON.parse(readFileSync(receipt, "utf8")).includes(Buffer.from("two\r\n").toString("base64")),
    );
  });
}

test("host normalization queries never execute filter or fsmonitor callbacks", (t) => {
  const f = fixture(t);
  useGitConfigHome(t, f.root);
  useFakeScanner(t);
  f.git("config", "--global", "core.autocrlf", "true");
  writeFileSync(join(f.cwd, ".gitattributes"), "*.txt text filter=review-scan-proof\n");
  writeFileSync(join(f.cwd, "a.txt"), "one\r\n");
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "a.txt"), "two\r\n");
  const headSha = f.commit();
  const marker = join(f.root, "callback-ran");
  const callback = join(f.root, "forbidden-callback");
  writeFileSync(
    callback,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`,
    { mode: 0o755 },
  );
  f.git("config", "--global", "filter.review-scan-proof.clean", callback);
  f.git("config", "--global", "core.fsmonitor", callback);
  assert.throws(() => f.run({ kind: "committed", baseSha, headSha }), /unsupported_content/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.calls), false);
});

for (const failure of [
  "signal",
  "deadline",
  "oversize",
  "missing",
  "error",
  "finding",
  "unexpected-output",
]) {
  test(`scan ${failure} refuses without provider invocation and cleans private staging`, (t) => {
    const f = fixture(t);
    const receipt = join(f.root, "temporary-root");
    const bin = useFakeScanner(
      t,
      `assert.equal(fs.existsSync(${JSON.stringify(f.diagnosticPromptPath)}), false);
fs.writeFileSync(${JSON.stringify(receipt)}, path.dirname(inputDir));
${failure === "signal" ? "process.kill(process.pid, 'SIGTERM');" : failure === "deadline" ? "setTimeout(() => {}, 60000);" : failure === "error" ? "process.exit(42);" : failure === "finding" ? 'process.stdout.write(\'{"Raw":"synthetic-sensitive-value"}\'); process.exit(183);' : failure === "unexpected-output" ? 'process.stdout.write(\'{"Raw":"synthetic-sensitive-value"}\');' : ""}`,
    );
    if (failure === "missing") {
      rmSync(join(bin, "trufflehog"));
      process.env.PATH = bin;
      disableManagedScanner(t);
    }
    writeFileSync(f.diagnosticPromptPath, "stale-sensitive-diagnostic");
    const schema = join(f.root, "schema");
    writeFileSync(schema, "");
    if (failure === "oversize") truncateSync(schema, 256 * 1024 * 1024 + 1);
    assert.throws(
      () =>
        runAgentProcess({
          label: "refusal",
          cwd: f.cwd,
          prompt: "Review.\r\nsynthetic-sensitive-value\n",
          diagnosticPromptPath: f.diagnosticPromptPath,
          model: "internal",
          scanSource: { kind: "prompt" },
          env: { ...process.env, CODEX_BIN: join(f.root, "codex") },
          codexExtraArgs: ["--output-schema", schema],
          timeoutMs: failure === "deadline" ? 2000 : 30_000,
        }),
      (error) => {
        assert.ok(error instanceof AgentInputScanError);
        assert.equal(
          error.reason,
          failure === "signal" || failure === "error"
            ? "scanner_failed"
            : failure === "oversize"
              ? "staging_limit"
              : failure === "missing"
                ? "scanner_unavailable"
                : failure === "deadline"
                  ? "deadline"
                  : "scanner_failed",
        );
        assert.doesNotMatch(String(error), /synthetic-sensitive-value/);
        return true;
      },
    );
    assert.equal(existsSync(f.calls), false);
    assert.equal(existsSync(f.diagnosticPromptPath), false);
    assert.equal(existsSync(schema), true, "original schema input must survive refusal");
    if (existsSync(receipt)) assert.equal(existsSync(readFileSync(receipt, "utf8")), false);
  });
}

test("unsafe Git paths refuse before a scanner or provider can consume them", (t) => {
  const f = fixture(t);
  useFakeScanner(t, "throw new Error('must not start scanner');");
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "unsafe\nname.txt"), "change\n");
  const headSha = f.commit();
  assert.throws(() => f.run({ kind: "committed", baseSha, headSha }), /unsafe_path/);
  assert.equal(existsSync(f.calls), false);
});

for (const replacement of ["file", "symlink"]) {
  test(`committed directory-to-${replacement} replacement scans removed bytes without traversal`, (t) => {
    const f = fixture(t);
    useFakeScanner(t);
    mkdirSync(join(f.cwd, "old"));
    writeFileSync(join(f.cwd, "old", "child.txt"), "old bytes\n");
    const baseSha = f.commit();
    rmSync(join(f.cwd, "old"), { recursive: true });
    if (replacement === "file") writeFileSync(join(f.cwd, "old"), "new bytes\n");
    else symlinkSync("/outside/not-followed", join(f.cwd, "old"));
    const headSha = f.commit();
    assert.equal(f.run({ kind: "committed", baseSha, headSha }).status, 0);
  });
}

test("expired repair scan budgets report a deadline without starting a provider", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  const expected = captureTargetCheckoutBinding(f.cwd);
  assert.throws(
    () => withTargetReviewSnapshot({ cwd: f.cwd, baseSha, expected, timeoutMs: 0 }, f.run),
    (error) => error instanceof AgentInputScanError && error.reason === "deadline",
  );
  assert.equal(existsSync(f.calls), false);
});

test("repair scan binds raw bytes even when normalization leaves the same canonical tree", (t) => {
  const f = fixture(t);
  useFakeScanner(t, `fs.writeFileSync(${JSON.stringify(join(f.cwd, "a.txt"))}, 'change\\n');`);
  writeFileSync(join(f.cwd, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(f.cwd, "a.txt"), "base\n");
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "a.txt"), "change\r\n");
  const expected = captureTargetCheckoutBinding(f.cwd);
  assert.throws(
    () => withTargetReviewSnapshot({ cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 }, f.run),
    /source_drift/,
  );
  assert.equal(existsSync(f.calls), false);
});

const ledgerSource = "test/action-ledger-runtime.test.ts";
const autoreviewSources = [
  "skills/autoreview/tests/test_autoreview_hardening.py",
  ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
];
const browserChromeSource = "extensions/browser/src/browser/chrome.test.ts";
const browserServerContextSource =
  "extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts";
const browserDocsSource = "docs/tools/browser.md";
const browserToolSource = "extensions/browser/src/browser-tool.test.ts";
const browserCdpHelpersSource = "extensions/browser/src/browser/cdp.helpers.test.ts";
const browserMcpSource = "extensions/browser/src/browser/chrome-mcp.test.ts";
const macDashboardSource = "apps/macos/Tests/OpenClawIPCTests/DashboardWindowSmokeTests.swift";
const mcpAppsSource = "src/config/config-misc.test.ts";
const mattermostSource = "extensions/mattermost/src/mattermost/slash-http.test.ts";
const ledgerFixtureSha256 = "a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e";
const nativeContractFailures = new Map([
  ["missing completion", "incomplete_scan"],
  ["detector error", "scan_error"],
  ["info error", "scan_error"],
  ["info errors", "scan_error"],
  ["wrong count", "completion_mismatch"],
  ["verified count", "completion_mismatch"],
  ["wrong version", "completion_mismatch"],
  ["duplicate completion", "incomplete_scan"],
  ["trailing log", "incomplete_scan"],
  ["unterminated output", "invalid_stdout"],
  ["unterminated stderr", "invalid_stderr"],
  ["malformed stderr", "invalid_stderr"],
  ["malformed output", "invalid_stdout"],
  ["unexpected successful output", "unexpected_exit"],
]);

for (const scenarioName of [
  "reviewed fixture",
  "browser local Chrome fixture",
  "browser remote Chrome fixture",
  "browser remote server fixture",
  "browser local server mismatch",
  "browser docs fixture",
  "browser page URL fixture",
  "browser CDP relay fixture",
  "browser CDP relay shifted HTML without companion",
  "browser CDP encoded fixture",
  "browser CDP encoded HTML fixture",
  "browser MCP endpoint fixture",
  "browser MCP endpoint shifted HTML without companion",
  "browser CDP relay changed username",
  "browser CDP encoded changed password",
  "browser MCP endpoint changed host",
  "browser CDP relay source mismatch",
  "browser MCP endpoint source mismatch",
  "browser CDP relay query mutation",
  "browser MCP endpoint query mutation",
  "browser CDP relay unapproved line",
  "browser CDP encoded duplicate on unapproved line",
  "browser MCP endpoint duplicate on approved line",
  "browser MCP endpoint encoded-only",
  "browser CDP relay BASE64 fixture",
  "browser CDP encoded shifted BASE64 without companion",
  "browser CDP encoded BASE64 encoded-only",
  "browser MCP endpoint BASE64 fixture",
  "mattermost api input fixture",
  "mattermost api redacted fixture",
  "mattermost hooks input fixture",
  "mattermost hooks redacted fixture",
  "mattermost hooks input fixture duplicate on unapproved line",
  "mattermost hooks redacted fixture duplicate on unapproved line",
  "mattermost changed username",
  "mattermost changed password",
  "mattermost changed host",
  "mattermost changed path",
  "mattermost mismatched authority raw",
  "mattermost source mismatch",
  "mattermost different approved literal",
  "browser docs source mismatch",
  "browser page URL source mismatch",
  "browser page URL changed path",
  "browser page URL synthetic query record",
  "browser docs shifted HTML",
  "browser docs shifted HTML first",
  "browser docs shifted HTML without companion",
  "browser docs shifted HTML repeated literal",
  "browser docs literal in other blob",
  "browser remote Chrome different approved literal",
  "browser docs shifted HTML encoded-only",
  "shifted PLAIN",
  "PLAIN duplicate",
  "HTML duplicate",
  "shared approved path OIDs",
  "shared approved and unapproved path OIDs",
  "shared endpoint OID 644 to 755",
  "shared endpoint OID 755 to 644",
  "executable head snapshot",
  "executable index snapshot",
  "executable worktree snapshot",
  "repeated regular snapshot OID",
  "canonical autoreview path",
  "vendored autoreview path",
  "both autoreview paths",
  "executable source",
  "changed raw",
  "changed full URI",
  "changed matching raw values",
  "verified",
  "mixed findings",
  "unapproved first",
  "wrong source",
  "invalid line",
  "invalid UTF-8 literal blob",
  "other file",
  "many source references",
  "untrusted finding metadata",
  "prompt",
  "schema",
  "additional",
  "diff",
  "raw diff",
  "normalized worktree",
  "decoded only",
  "wrong detector",
  "wrong source type",
  "wrong decoder",
  "missing verification error",
  "unexpected extra data",
  "unexpected structured data",
  "wrong secret parts",
  "missing completion",
  "detector error",
  "info error",
  "info errors",
  "wrong count",
  "verified count",
  "wrong version",
  "duplicate completion",
  "trailing log",
  "unterminated output",
  "unterminated stderr",
  "malformed stderr",
  "malformed output",
  "unexpected successful output",
  "source drift",
  ...[
    "reviewed fixture",
    "changed raw",
    "changed full URI",
    "changed matching raw values",
    "other file",
    "unapproved line",
    "duplicate on approved line",
    "executable source",
    "prompt",
    "diff",
    "verified",
    "mixed findings",
    "wrong detector",
    "wrong source type",
    "wrong decoder",
    "unreviewed HTML",
    "wrong secret parts",
    "missing verification error",
    "wrong version",
    "missing completion",
  ].flatMap((scenario) => [`mac dashboard ${scenario}`, `mcp apps ${scenario}`]),
]) {
  const macDashboardFixture = scenarioName.startsWith("mac dashboard ");
  const mcpAppsFixture = scenarioName.startsWith("mcp apps ");
  const scenario = scenarioName.replace(/^(?:mac dashboard|mcp apps) /, "");
  test(`reviewed synthetic fixture admission: ${scenarioName}`, (t) => {
    const notices: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => notices.push(args));
    // Read the existing malformed-configuration fixture without reproducing its
    // credential-shaped bytes in another source file or assertion diagnostic.
    const existing = readFileSync(
      new URL("./action-ledger-runtime.test.ts", import.meta.url),
      "utf8",
    );
    let uri = [...existing.matchAll(/"([^"\n]+)"/g)]
      .map((match) => match[1]!)
      .find((value) => createHash("sha256").update(value).digest("hex") === ledgerFixtureSha256);
    const mattermostFixture = scenario.startsWith("mattermost ");
    const browserDocsFixture = scenario.startsWith("browser docs");
    const browserPageFixture = scenario.startsWith("browser page URL");
    const browserCdpFixture = scenario.startsWith("browser CDP ");
    const browserMcpFixture = scenario.startsWith("browser MCP ");
    const browserExactFixture = browserCdpFixture || browserMcpFixture;
    const encodedCdpFixture = browserCdpFixture && scenario.includes("encoded");
    // Preserve the literal witnesses captured from the native OpenClaw scan.
    const literalLine = mcpAppsFixture
      ? 763
      : macDashboardFixture
        ? 273
        : browserCdpFixture
          ? encodedCdpFixture
            ? 406
            : 293
          : browserMcpFixture
            ? 1339
            : 42;
    const scannerLine = scenario.includes("shifted BASE64") ? literalLine - 4 : literalLine;
    const primaryDecoder = scenario.includes("BASE64")
      ? "BASE64"
      : scenario === "browser CDP encoded HTML fixture" || scenario === "unreviewed HTML"
        ? "HTML"
        : "PLAIN";
    if (browserExactFixture) {
      const url = new URL(
        browserCdpFixture ? "http://127.0.0.1:9222/json/version" : "https://example.com/chrome",
      );
      url.username = browserCdpFixture && !encodedCdpFixture ? "openclaw" : "alice";
      url.password = browserCdpFixture
        ? encodedCdpFixture
          ? "p@ss word"
          : "relay-token"
        : "supersecretpasswordvalue1234";
      if (scenario.endsWith("changed username")) url.username += "changed";
      if (scenario.endsWith("changed password")) url.password += "changed";
      if (scenario.endsWith("changed host")) url.hostname = "other.example.com";
      uri = url.href;
    } else if (scenario.startsWith("browser ")) {
      const local = scenario.includes("local");
      const url = new URL(
        browserDocsFixture
          ? "https://provider.example"
          : browserPageFixture
            ? "https://example.com/path"
            : local
              ? "http://127.0.0.1"
              : "https://browserless.example.com",
      );
      url.username = local ? "browser-user" : "user";
      url.password = browserPageFixture ? "secret" : local ? "browser-password" : "pass";
      if (scenario === "browser page URL changed path") url.pathname = "/changed";
      // Parser-only control: native URI matching excludes query text.
      if (scenario === "browser page URL synthetic query record") url.search = "?changed=1";
      uri = browserPageFixture ? url.href : url.href.slice(0, -1);
    }
    if (mattermostFixture) {
      // Native URI output stops before query text in these reviewed sanitization fixtures.
      const url = new URL(
        scenario.includes("hooks")
          ? "https://chat.example.com/hooks"
          : "https://chat.example.com/api",
      );
      url.username = scenario.includes("redacted") ? "redacted" : "user";
      url.password = scenario.includes("redacted") ? "redacted" : "pass";
      if (scenario === "mattermost changed username") url.username += "changed";
      if (scenario === "mattermost changed password") url.password += "changed";
      if (scenario === "mattermost changed host") url.hostname = "other.example.com";
      if (scenario === "mattermost changed path") url.pathname = "/changed";
      uri = url.href;
    }
    if (macDashboardFixture) {
      // Native 3.97.1 witness from OpenClaw 9ba01d6c7b1c, line 273.
      const url = new URL("http://localhost:18890/embed/channel/T01/C01");
      url.username = "user";
      url.password = "pass";
      uri = url.href;
    }
    if (mcpAppsFixture) {
      const url = new URL("https://mcp-apps.example.com");
      url.username = "user";
      url.password = "pass";
      uri = url.href.slice(0, -1);
    }
    assert.ok(uri, "reviewed synthetic fixture is present");
    const authority = new URL(uri);
    authority.pathname = "";
    authority.search = "";
    authority.hash = "";
    if (scenario === "mattermost mismatched authority raw") {
      authority.username = "redacted";
      authority.password = "redacted";
    }
    const raw =
      macDashboardFixture || browserPageFixture || browserExactFixture || mattermostFixture
        ? authority.href.slice(0, -1)
        : uri;
    let otherReviewedUri: string | undefined;
    if (scenario.endsWith("different approved literal")) {
      if (mattermostFixture) {
        const other = new URL(uri);
        other.pathname = "/hooks";
        otherReviewedUri = other.href;
      } else {
        const other = new URL("http://127.0.0.1");
        other.username = "browser-user";
        other.password = "browser-password";
        otherReviewedUri = other.href.slice(0, -1);
      }
    }
    const findingValues = [uri, raw, ...(otherReviewedUri ? [otherReviewedUri] : [])];
    const f = fixture(t, scenario === "prompt" ? uri : undefined);
    let files =
      scenario === "many source references"
        ? Array.from({ length: 8 }, (_, index) => `unapproved-${index}.test.ts`)
        : mattermostFixture
          ? [
              scenario === "mattermost source mismatch"
                ? "extensions/mattermost/src/slash-http.test.ts"
                : mattermostSource,
            ]
          : scenario.startsWith("browser ")
            ? [
                browserDocsFixture
                  ? scenario.endsWith("source mismatch")
                    ? browserToolSource
                    : browserDocsSource
                  : browserExactFixture
                    ? scenario.endsWith("source mismatch")
                      ? browserCdpFixture
                        ? browserMcpSource
                        : browserCdpHelpersSource
                      : browserCdpFixture
                        ? browserCdpHelpersSource
                        : browserMcpSource
                    : browserPageFixture
                      ? scenario.endsWith("source mismatch")
                        ? browserDocsSource
                        : browserToolSource
                      : scenario.includes("server")
                        ? browserServerContextSource
                        : browserChromeSource,
              ]
            : scenario === "shared approved path OIDs"
              ? [...autoreviewSources, ledgerSource]
              : scenario === "shared approved and unapproved path OIDs"
                ? [ledgerSource, "other.test.ts"]
                : scenario === "both autoreview paths"
                  ? autoreviewSources
                  : [
                      scenario === "canonical autoreview path"
                        ? autoreviewSources[0]!
                        : scenario === "vendored autoreview path"
                          ? autoreviewSources[1]!
                          : scenario === "other file"
                            ? "other.test.ts"
                            : ledgerSource,
                    ];
    if (macDashboardFixture)
      files = [scenario === "other file" ? "other.test.swift" : macDashboardSource];
    if (mcpAppsFixture) files = [scenario === "other file" ? "other.test.ts" : mcpAppsSource];
    const value =
      scenario === "decoded only" || scenario.endsWith("encoded-only")
        ? primaryDecoder === "BASE64"
          ? Buffer.from(uri).toString("base64")
          : uri.replace(":", "&#58;")
        : uri;
    const sourceValue = browserMcpFixture
      ? `${value}?token=supersecrettokenvalue1234567890${scenario.endsWith("query mutation") ? "changed" : ""}`
      : `${value}${browserCdpFixture && scenario.endsWith("query mutation") ? "?changed=1" : ""}`;
    const reviewedBrowserLine = browserExactFixture
      ? scenario === "browser CDP relay unapproved line"
        ? JSON.stringify(sourceValue)
        : browserCdpFixture
          ? `      fetchOk(${JSON.stringify(sourceValue)}, 250),`
          : `          ${JSON.stringify(sourceValue)},`
      : undefined;
    const reviewedMattermostLine =
      mattermostFixture && scenario.includes("fixture")
        ? scenario.includes("redacted")
          ? `    expect(message).toContain(${JSON.stringify(uri)});`
          : scenario.includes("hooks")
            ? `        ${JSON.stringify(`fallback\r\nsecond-line botToken: secret-bot ${uri}?token=secret-query`)},`
            : `        ${JSON.stringify(`primary\ntoken=secret-token ${uri}?access_token=secret-access&client_secret=secret-client`)},`
        : undefined;
    const reviewedMacDashboardLine = macDashboardFixture
      ? scenario === "unapproved line"
        ? JSON.stringify(value)
        : `        let credentialedFrame = try #require(URL(string: "${value}"))`
      : undefined;
    const reviewedFixtureLine = mcpAppsFixture
      ? scenario === "unapproved line"
        ? JSON.stringify(value)
        : `      ${JSON.stringify(value)},`
      : (reviewedMacDashboardLine ?? reviewedBrowserLine ?? reviewedMattermostLine);
    const contents =
      "// context\n".repeat(literalLine - 2) +
      (reviewedFixtureLine ?? JSON.stringify(otherReviewedUri ?? value)) +
      "\n" +
      (scenario.includes("duplicate on unapproved line")
        ? (browserExactFixture ? JSON.stringify(sourceValue) : reviewedMattermostLine) + "\n"
        : scenario.includes("duplicate on approved line")
          ? reviewedFixtureLine + "\n"
          : scenario.endsWith("repeated literal")
            ? JSON.stringify(value) + "\n"
            : "");
    const fixtureContent = (prefix: string) =>
      Buffer.concat([
        Buffer.from(prefix + contents),
        ...(scenario === "invalid UTF-8 literal blob" ? [Buffer.from([0xff])] : []),
      ]);
    for (const file of files) {
      mkdirSync(dirname(join(f.cwd, file)), { recursive: true });
      writeFileSync(
        join(f.cwd, file),
        scenario === "diff" ? "// before\n" : fixtureContent("// before\n"),
      );
      if (scenario === "executable source" || scenario === "shared endpoint OID 755 to 644")
        chmodSync(join(f.cwd, file), 0o755);
    }
    if (scenario === "normalized worktree")
      writeFileSync(join(f.cwd, ".gitattributes"), "*.ts text eol=crlf\n");
    const baseSha = f.commit();
    for (const file of files) {
      if (scenario === "shared endpoint OID 644 to 755" || scenario === "executable head snapshot")
        chmodSync(join(f.cwd, file), 0o755);
      else if (scenario === "shared endpoint OID 755 to 644") chmodSync(join(f.cwd, file), 0o644);
      else
        writeFileSync(
          join(f.cwd, file),
          scenario === "browser docs literal in other blob"
            ? "// after: no reviewed literal\n"
            : fixtureContent("// after\n"),
        );
    }
    const headSha = f.commit();
    if (scenario === "normalized worktree")
      writeFileSync(
        join(f.cwd, files[0]!),
        fixtureContent("// after\n").toString().replaceAll("\n", "\r\n"),
      );
    const modeOnly =
      scenario.startsWith("shared endpoint OID") || scenario === "executable head snapshot";
    if (modeOnly) {
      assert.equal(
        f.git("rev-parse", `${baseSha}:${ledgerSource}`),
        f.git("rev-parse", `${headSha}:${ledgerSource}`),
      );
      assert.equal(f.git("diff", baseSha, headSha, "--", ledgerSource).includes(uri), false);
    }
    if (scenario === "executable head snapshot") {
      chmodSync(join(f.cwd, ledgerSource), 0o644);
      f.git("add", "--", ledgerSource);
    } else if (scenario === "executable index snapshot") {
      chmodSync(join(f.cwd, ledgerSource), 0o755);
      f.git("add", "--", ledgerSource);
      chmodSync(join(f.cwd, ledgerSource), 0o644);
    } else if (scenario === "executable worktree snapshot") {
      chmodSync(join(f.cwd, ledgerSource), 0o755);
    } else if (scenario === "repeated regular snapshot OID") {
      writeFileSync(join(f.cwd, ledgerSource), fixtureContent("// before\n"));
      f.git("add", "--", ledgerSource);
      writeFileSync(join(f.cwd, ledgerSource), fixtureContent("// after\n"));
    }
    const receipt = join(f.root, "scan-root");
    const schemaPath = join(f.root, "schema.json");
    if (scenario === "schema") writeFileSync(schemaPath, uri);
    useFakeScanner(
      t,
      String.raw`
const uri = ${JSON.stringify(uri)};
const raw = ${JSON.stringify(raw)};
const scenario = ${JSON.stringify(scenario)};
const literalLine = ${literalLine};
const scannerLine = ${scannerLine};
fs.writeFileSync(${JSON.stringify(receipt)}, path.dirname(inputDir));
const parsed = new URL(uri);
const blobs = inputs.filter(({name}) => /^[a-f0-9]{40}$/.test(name));
assert.equal(blobs.length, ${modeOnly ? 1 : 2});
let findings = inputs.filter(({name, bytes}) =>
  (/^[a-f0-9]{40}$/.test(name) && (scenario !== 'diff' || bytes.includes(uri))) ||
  (scenario === 'prompt' && name === 'prompt') ||
  (scenario === 'schema' && name === 'schema') ||
  (scenario === 'additional' && name === '0') ||
  (scenario === 'diff' && /^\d+$/.test(name) && bytes.includes(uri)) ||
  (scenario === 'raw diff' && name === '0') ||
  (scenario === 'normalized worktree' && /^\d+$/.test(name) && bytes.includes('\r\n'))
).map(({name, bytes}) => ({
  SourceType: 15, DetectorType: 17, DetectorName: 'URI', DecoderName: ${JSON.stringify(primaryDecoder)}, Verified: false,
  VerificationError: 'synthetic verification error', Raw: raw, RawV2: uri,
  SourceMetadata: {Data: {Filesystem: {file: path.join(inputDir, name), line: /^[a-f0-9]{40}$/.test(name) ? scannerLine : scenario === 'raw diff' ? 1 : bytes.toString().split('\n').findIndex(line => line.includes(uri)) + 1}}},
  SecretParts: {host: parsed.host, username: parsed.username, password: parsed.password},
  ExtraData: null, StructuredData: null,
}));
if (scenario.includes('shifted HTML')) {
  const plain = findings;
  const html = plain.map(finding => ({
    ...finding, DecoderName: 'HTML',
    SourceMetadata: {Data: {Filesystem: {...finding.SourceMetadata.Data.Filesystem, line: literalLine - 4}}},
  }));
  findings = scenario.endsWith('first') ? [...html, ...plain] : [...plain, ...html];
  if (scenario.endsWith('without companion')) findings = [html[0], plain[1], html[1]];
  if (scenario.endsWith('encoded-only')) findings = html;
  if (scenario.endsWith('repeated literal')) findings.unshift(...plain.map(finding => ({
    ...finding, SourceMetadata: {Data: {Filesystem: {...finding.SourceMetadata.Data.Filesystem, line: 43}}},
  })));
}
if (scenario === 'shifted PLAIN') for (const finding of findings) finding.SourceMetadata.Data.Filesystem.line++;
if (scenario === 'PLAIN duplicate') findings.push({...findings[0]});
if (scenario === 'HTML duplicate') findings.push({...findings[0], DecoderName: 'HTML'});
if (scenario === 'changed raw') findings[0].Raw += 'changed';
if (scenario === 'changed full URI') findings[0].RawV2 += '/changed';
if (scenario === 'changed matching raw values') findings[0].Raw = findings[0].RawV2 = uri + '/changed';
if (scenario === 'verified') findings[0].Verified = true;
if (scenario === 'mixed findings') findings.push({...findings[0], Raw: 'unreviewed', RawV2: 'unreviewed'});
if (scenario === 'unapproved first') findings.unshift({...findings[0], Raw: 'unreviewed', RawV2: 'unreviewed'});
if (scenario === 'wrong source') findings[0].SourceMetadata.Data.Filesystem.file = path.join(inputDir, 'prompt');
if (scenario === 'invalid line') findings[0].SourceMetadata.Data.Filesystem.line = 0;
if (scenario === 'wrong detector') findings[0].DetectorType = 18;
if (scenario === 'wrong source type') findings[0].SourceType = 16;
if (scenario === 'wrong decoder') findings[0].DecoderName = 'BASE64';
if (scenario === 'missing verification error') findings[0].VerificationError = '';
if (scenario === 'unexpected extra data') findings[0].ExtraData = {};
if (scenario === 'unexpected structured data') findings[0].StructuredData = {};
if (scenario === 'wrong secret parts') findings[0].SecretParts.host = 'mismatch';
if (scenario === 'untrusted finding metadata') {
  findings[0].DetectorType = findings[0].DetectorName = findings[0].DecoderName = uri;
  findings[0].SourceMetadata.Data.Filesystem.file = '/outside/' + uri;
  findings[0].SourceMetadata.Data.Filesystem.line = Number.MAX_VALUE;
}
if (scenario === 'source drift') fs.appendFileSync(${JSON.stringify(join(f.cwd, files[0]!))}, '// drift');
process.stdout.write(findings.map(value => JSON.stringify(value)).join('\n') + (scenario === 'unterminated output' ? '' : '\n'));
if (scenario === 'malformed output') process.stdout.write('{');
if (scenario === 'detector error') process.stderr.write(JSON.stringify({level:'error', logger:'trufflehog', msg:'error finding results in chunk'}) + '\n');
if (scenario === 'info error') process.stderr.write(JSON.stringify({level:'info-0', logger:'trufflehog', msg:'detector failed', error:'synthetic'}) + '\n');
if (scenario === 'info errors') process.stderr.write(JSON.stringify({level:'info-0', logger:'trufflehog', msg:'detector failed', errors:[]}) + '\n');
const completion = JSON.stringify({
  level:'info-0', logger:'trufflehog', msg:'finished scanning', trufflehog_version:scenario === 'wrong version' ? 'changed' : '3.97.1',
  chunks:2, bytes:1000, verified_secrets:findings.filter(value => value.Verified).length + (scenario === 'verified count' ? 1 : 0), unverified_secrets:findings.filter(value => !value.Verified).length + (scenario === 'wrong count' ? 1 : 0),
}) + (scenario === 'unterminated stderr' ? '' : '\n');
if (scenario !== 'missing completion') process.stderr.write(completion);
if (scenario === 'duplicate completion') process.stderr.write(completion);
if (scenario === 'trailing log') process.stderr.write(JSON.stringify({level:'info-0', logger:'trufflehog', msg:'trailing'}) + '\n');
if (scenario === 'malformed stderr') process.stderr.write('{');
process.exit(scenario === 'unexpected successful output' ? 0 : 183);
`,
    );
    const run = () => {
      if (scenario.includes("snapshot")) {
        const expected = captureTargetCheckoutBinding(f.cwd);
        return withTargetReviewSnapshot(
          // Admission fixtures include repeated Git fences; deadline failures have separate tests.
          { cwd: f.cwd, baseSha, expected, timeoutMs: 120_000 },
          f.run,
        );
      }
      const source = { kind: "committed" as const, baseSha, headSha };
      if (scenario === "schema" || scenario === "additional") {
        scanAgentInput({
          cwd: f.cwd,
          prompt: "Review the change.",
          source,
          timeoutMs: 30_000,
          ...(scenario === "schema" ? { schemaPath } : { additionalBytes: [Buffer.from(uri)] }),
        });
        return { status: 0 };
      }
      return f.run(source);
    };
    if (
      [
        "reviewed fixture",
        "browser local Chrome fixture",
        "browser remote Chrome fixture",
        "browser remote server fixture",
        "browser docs fixture",
        "browser page URL fixture",
        "browser CDP relay fixture",
        "browser CDP relay shifted HTML without companion",
        "browser CDP encoded fixture",
        "browser CDP encoded HTML fixture",
        "browser MCP endpoint fixture",
        "browser MCP endpoint shifted HTML without companion",
        "browser CDP relay BASE64 fixture",
        "browser CDP encoded shifted BASE64 without companion",
        "mattermost api input fixture",
        "mattermost api redacted fixture",
        "mattermost hooks input fixture",
        "mattermost hooks redacted fixture",
        "browser docs shifted HTML",
        "browser docs shifted HTML first",
        "browser docs shifted HTML without companion",
        "browser docs shifted HTML repeated literal",
        "shifted PLAIN",
        "PLAIN duplicate",
        "HTML duplicate",
        "repeated regular snapshot OID",
      ].includes(scenario)
    ) {
      assert.equal(run().status, 0);
      assert.equal(readFileSync(f.calls, "utf8"), "called");
      assert.equal(notices.length, 1);
      assert.equal(
        findingValues.some((candidate) => JSON.stringify(notices).includes(candidate)),
        false,
        "audit never exposes finding bytes",
      );
      const notice = JSON.parse(String(notices[0]![0]));
      assert.equal(notice.event, "agent_input_scan_classified");
      assert.equal(notice.source, files[0]);
      assert.equal(notice.fixtureSha256, createHash("sha256").update(uri).digest("hex"));
      assert.equal(notice.detector, "URI");
      assert.match(notice.notice, /classified as non-sensitive/);
      const shiftedHtml = scenario.includes("shifted HTML");
      const expectedLocations = (
        shiftedHtml
          ? [
              { scannerLine: literalLine, decoder: "PLAIN" },
              ...(scenario.endsWith("without companion")
                ? []
                : [{ scannerLine: literalLine, decoder: "PLAIN" }]),
              ...(scenario.endsWith("repeated literal")
                ? [
                    { scannerLine: 43, decoder: "PLAIN" },
                    { scannerLine: 43, decoder: "PLAIN" },
                  ]
                : []),
              { scannerLine: literalLine - 4, decoder: "HTML" },
              { scannerLine: literalLine - 4, decoder: "HTML" },
            ]
          : [
              {
                scannerLine: scenario === "shifted PLAIN" ? 43 : scannerLine,
                decoder: primaryDecoder,
              },
              {
                scannerLine: scenario === "shifted PLAIN" ? 43 : scannerLine,
                decoder: primaryDecoder,
              },
              ...(scenario === "HTML duplicate" ? [{ scannerLine: 42, decoder: "HTML" }] : []),
            ]
      ).map((location) => ({ ...location, literalLine }));
      const expectedFindings = expectedLocations.length;
      assert.equal(
        notice.findings.reduce(
          (sum: number, finding: { occurrences: number }) => sum + finding.occurrences,
          0,
        ),
        expectedFindings + (scenario === "PLAIN duplicate" ? 1 : 0),
      );
      assert.equal(notice.findings.length, expectedFindings);
      const locations = notice.findings.map(
        ({ blob, occurrences, ...location }: Record<string, unknown>) => {
          assert.match(String(blob), /^[a-f0-9]{40}$/);
          assert.ok(Number(occurrences) > 0);
          return location;
        },
      );
      const orderLocations = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number(a.scannerLine) - Number(b.scannerLine) ||
        String(a.decoder).localeCompare(String(b.decoder));
      assert.deepEqual(locations.sort(orderLocations), expectedLocations.sort(orderLocations));
    } else {
      assert.throws(run, (error) => {
        assert.ok(error instanceof AgentInputScanError);
        const contractFailure = nativeContractFailures.get(scenario);
        assert.equal(
          error.reason,
          scenario === "source drift"
            ? "source_drift"
            : contractFailure
              ? "scanner_failed"
              : "findings",
        );
        const outputDir = writeExactReviewFailureDiagnostics({
          artifactDir: join(f.root, "artifacts"),
          error,
          prompt: "Review the change.",
          model: "internal",
          classification: "codex_execution",
          repo: "openclaw/clawsweeper",
          itemKind: "pull_request",
          itemNumber: 1,
          sourceSha: headSha,
          retryable: error.retryable,
          workflowExit: 1,
          env: {},
        });
        const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
        assert.equal(manifest.failure.stage, "agent_input_scan");
        assert.equal(manifest.failure.reason_code, error.reason);
        assert.equal(manifest.source.sha, headSha);
        assert.equal(manifest.retryable, false);
        const diagnostic = manifest.failure.scan;
        if (scenario !== "source drift") {
          assert.equal(
            diagnostic?.kind,
            contractFailure ? "native_contract" : "unclassified_finding",
          );
          if (contractFailure) assert.equal(diagnostic.reason, contractFailure);
          else {
            if (mattermostFixture) {
              assert.equal(
                diagnostic.reason,
                scenario.includes("duplicate on unapproved line") ||
                  scenario === "mattermost different approved literal"
                  ? "literal_mismatch"
                  : scenario === "mattermost source mismatch"
                    ? "source_not_reviewed"
                    : "literal_not_reviewed",
              );
            }
            assert.ok(diagnostic.findingCount > diagnostic.findingIndex);
            if (scenario === "untrusted finding metadata") {
              assert.equal(diagnostic.detectorType, null);
              assert.equal(diagnostic.decoder, "OTHER");
              assert.equal(diagnostic.scannerLine, null);
              assert.equal(diagnostic.material, undefined);
            }
            const kind = new Map([
              ["prompt", "prompt"],
              ["schema", "schema"],
              ["additional", "additional"],
              ["diff", "patch"],
              ["raw diff", "raw_diff"],
              ["normalized worktree", "worktree"],
              ["other file", "blob"],
              ["many source references", "blob"],
            ]).get(scenario);
            if (kind) {
              assert.equal(diagnostic.material.kind, kind);
              if (kind === "patch" || kind === "raw_diff") {
                assert.equal(diagnostic.material.from, baseSha);
                assert.equal(diagnostic.material.to, headSha);
              } else if (kind === "blob") {
                assert.ok(
                  [baseSha, headSha].some(
                    (revision) =>
                      f.git("rev-parse", `${revision}:${files[0]!}`) === diagnostic.material.id,
                  ),
                );
                assert.equal(
                  diagnostic.material.referenceCount,
                  scenario === "many source references" ? 8 : 1,
                );
                assert.equal(
                  diagnostic.material.references.length,
                  scenario === "many source references" ? 4 : 1,
                );
                assert.equal(
                  diagnostic.material.references[0].pathSha256,
                  createHash("sha256").update(files[0]!).digest("hex"),
                );
                assert.equal(diagnostic.material.references[0].mode, "100644");
              } else if (kind === "worktree") {
                assert.equal(diagnostic.material.references[0].revision, headSha);
                assert.equal(
                  diagnostic.material.references[0].pathSha256,
                  createHash("sha256").update(files[0]!).digest("hex"),
                );
              }
            }
          }
        }
        const diagnosticBytes = [
          "manifest.json",
          "error.txt",
          "stdout.error.txt",
          "stderr.tail.txt",
        ]
          .map((name) => readFileSync(join(outputDir, name), "utf8"))
          .join("\n");
        assert.equal(
          [...findingValues, f.root, ...files].some((candidate) =>
            (String(error) + diagnosticBytes).includes(candidate),
          ),
          false,
          "finding bytes and raw source paths stay private",
        );
        assert.equal(
          diagnosticBytes.includes(createHash("sha256").update(uri).digest("hex")),
          false,
          "refusal diagnostics do not publish literal digests",
        );
        return true;
      });
      assert.equal(existsSync(f.calls), false);
      assert.equal(existsSync(f.diagnosticPromptPath), false);
      assert.deepEqual(notices, []);
    }
    assert.equal(existsSync(readFileSync(receipt, "utf8")), false, "private staging is removed");
  });
}
