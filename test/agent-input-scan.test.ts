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

test("only incomplete source scan failures receive the terminal review exit code", () => {
  assert.equal(
    agentInputScanFailureExitCode(new AgentInputScanError("incomplete_source")),
    INCOMPLETE_AGENT_INPUT_SOURCE_EXIT_CODE,
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
  const run = (source: Parameters<typeof scanAgentInput>[0]["source"]) =>
    runAgentProcess({
      label: "scan-fixture",
      prompt,
      diagnosticPromptPath,
      scanSource: source,
      model: "internal",
      cwd,
      env: { ...process.env, CODEX_BIN: binary },
      timeoutMs: 30_000,
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
        assert.equal(error.reason, "findings");
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
    /findings/,
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
                  : "findings",
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
const ledgerFixtureSha256 = "a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e";

for (const scenario of [
  "reviewed fixture",
  "browser local Chrome fixture",
  "browser remote Chrome fixture",
  "browser remote server fixture",
  "browser local server mismatch",
  "browser docs fixture",
  "browser page URL fixture",
  "browser docs source mismatch",
  "browser page URL source mismatch",
  "browser page URL changed path",
  "browser page URL changed query",
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
  "prompt",
  "schema",
  "additional",
  "diff",
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
]) {
  test(`reviewed synthetic fixture admission: ${scenario}`, (t) => {
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
    const browserDocsFixture = scenario.startsWith("browser docs");
    const browserPageFixture = scenario.startsWith("browser page URL");
    if (scenario.startsWith("browser ")) {
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
      if (scenario === "browser page URL changed query") url.search = "?changed=1";
      uri = browserPageFixture ? url.href : url.href.slice(0, -1);
    }
    assert.ok(uri, "reviewed synthetic fixture is present");
    const authority = new URL(uri);
    authority.pathname = "";
    authority.search = "";
    authority.hash = "";
    const raw = browserPageFixture ? authority.href.slice(0, -1) : uri;
    let otherReviewedUri: string | undefined;
    if (scenario.endsWith("different approved literal")) {
      const other = new URL("http://127.0.0.1");
      other.username = "browser-user";
      other.password = "browser-password";
      otherReviewedUri = other.href.slice(0, -1);
    }
    const findingValues = [uri, raw, ...(otherReviewedUri ? [otherReviewedUri] : [])];
    const f = fixture(t, scenario === "prompt" ? uri : undefined);
    const files = scenario.startsWith("browser ")
      ? [
          browserDocsFixture
            ? scenario.endsWith("source mismatch")
              ? browserToolSource
              : browserDocsSource
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
    const value =
      scenario === "decoded only" || scenario.endsWith("encoded-only")
        ? uri.replace(":", "&#58;")
        : uri;
    const contents =
      "// context\n".repeat(40) +
      JSON.stringify(otherReviewedUri ?? value) +
      "\n" +
      (scenario.endsWith("repeated literal") ? JSON.stringify(value) + "\n" : "");
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
fs.writeFileSync(${JSON.stringify(receipt)}, path.dirname(inputDir));
const parsed = new URL(uri);
const blobs = inputs.filter(({name}) => /^[a-f0-9]{40}$/.test(name));
assert.equal(blobs.length, ${modeOnly ? 1 : 2});
let findings = inputs.filter(({name, bytes}) =>
  (/^[a-f0-9]{40}$/.test(name) && (scenario !== 'diff' || bytes.includes(uri))) ||
  (scenario === 'prompt' && name === 'prompt') ||
  (scenario === 'schema' && name === 'schema') ||
  (scenario === 'additional' && name === '0') ||
  (scenario === 'diff' && /^\d+$/.test(name) && bytes.includes(uri))
).map(({name, bytes}) => ({
  SourceType: 15, DetectorType: 17, DetectorName: 'URI', DecoderName: 'PLAIN', Verified: false,
  VerificationError: 'synthetic verification error', Raw: raw, RawV2: uri,
  SourceMetadata: {Data: {Filesystem: {file: path.join(inputDir, name), line: /^[a-f0-9]{40}$/.test(name) ? 42 : bytes.toString().split('\n').findIndex(line => line.includes(uri)) + 1}}},
  SecretParts: {host: parsed.host, username: parsed.username, password: parsed.password},
  ExtraData: null, StructuredData: null,
}));
if (scenario.includes('shifted HTML')) {
  const plain = findings;
  const html = plain.map(finding => ({
    ...finding, DecoderName: 'HTML',
    SourceMetadata: {Data: {Filesystem: {...finding.SourceMetadata.Data.Filesystem, line: 38}}},
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
if (scenario === 'source drift') fs.appendFileSync(${JSON.stringify(join(f.cwd, files[0]!))}, '// drift');
process.stdout.write(findings.map(value => JSON.stringify(value)).join('\n') + (scenario === 'unterminated output' ? '' : '\n'));
if (scenario === 'malformed output') process.stdout.write('{');
if (scenario === 'detector error') process.stderr.write(JSON.stringify({level:'error', logger:'trufflehog', msg:'error finding results in chunk'}) + '\n');
if (scenario === 'info error') process.stderr.write(JSON.stringify({level:'info-0', logger:'trufflehog', msg:'detector failed', error:'synthetic'}) + '\n');
if (scenario === 'info errors') process.stderr.write(JSON.stringify({level:'info-0', logger:'trufflehog', msg:'detector failed', errors:[]}) + '\n');
const completion = JSON.stringify({
  level:'info-0', logger:'trufflehog', msg:'finished scanning', trufflehog_version:scenario === 'wrong version' ? 'changed' : '3.97.1',
  chunks:2, bytes:1000, verified_secrets:scenario === 'verified count' ? 1 : 0, unverified_secrets:findings.length + (scenario === 'wrong count' ? 1 : 0),
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
          { cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 },
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
              { scannerLine: 42, decoder: "PLAIN" },
              ...(scenario.endsWith("without companion")
                ? []
                : [{ scannerLine: 42, decoder: "PLAIN" }]),
              ...(scenario.endsWith("repeated literal")
                ? [
                    { scannerLine: 43, decoder: "PLAIN" },
                    { scannerLine: 43, decoder: "PLAIN" },
                  ]
                : []),
              { scannerLine: 38, decoder: "HTML" },
              { scannerLine: 38, decoder: "HTML" },
            ]
          : [
              { scannerLine: scenario === "shifted PLAIN" ? 43 : 42, decoder: "PLAIN" },
              { scannerLine: scenario === "shifted PLAIN" ? 43 : 42, decoder: "PLAIN" },
              ...(scenario === "HTML duplicate" ? [{ scannerLine: 42, decoder: "HTML" }] : []),
            ]
      ).map((location) => ({ ...location, literalLine: 42 }));
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
        assert.equal(error.reason, scenario === "source drift" ? "source_drift" : "findings");
        assert.equal(
          findingValues.some((candidate) => String(error).includes(candidate)),
          false,
          "finding bytes stay private",
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
