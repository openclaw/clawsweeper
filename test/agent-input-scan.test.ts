import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
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
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
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
import {
  classifyReviewedFixtureScan,
  type ReviewedAttribution,
  type ScanSourceRole,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";
import { useFakeScanner, writeFakeScanner } from "./agent-input-scan-helpers.ts";
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

test("an older trusted PATH scanner selects the qualified managed scanner", (t) => {
  const f = fixture(t);
  const oldCalls = join(f.root, "old-scanner-calls");
  const managedCalls = join(f.root, "managed-scanner-calls");
  const bin = useFakeScanner(t);
  writeFileSync(
    join(bin, "trufflehog"),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(oldCalls)}, process.argv[2] + '\\n');
if (process.argv[2] === '--version') console.log('trufflehog 3.97.1');
else process.exit(73);
`,
    { mode: 0o755 },
  );
  const managedBin = join(f.root, "managed-bin");
  writeFakeScanner(managedBin, `fs.writeFileSync(${JSON.stringify(managedCalls)}, 'scanned');`);
  const managedPath = realpathSync(join(managedBin, "trufflehog"));
  const originalCache = process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = join(f.root, "managed-cache");
  const nativeSpawn = childProcess.spawnSync;
  let installs = 0;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof nativeSpawn>) => {
    if (args[0] === process.execPath && args[1]?.[0]?.endsWith("setup-review-tools.mjs")) {
      installs++;
      assert.ok(Number(args[1][2]) > 0 && Number(args[1][2]) <= 5000);
      return nativeSpawn(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(`${managedPath}\n`)});`],
        args[2],
      );
    }
    return nativeSpawn(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalCache === undefined) delete process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
    else process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = originalCache;
  });
  scanAgentInput({
    cwd: f.cwd,
    prompt: "Synthetic input",
    source: { kind: "prompt" },
    timeoutMs: 5000,
  });
  assert.equal(readFileSync(oldCalls, "utf8"), "--version\n");
  assert.equal(readFileSync(managedCalls, "utf8"), "scanned");
  assert.equal(installs, 1);
});

test("malformed PATH scanner version output refuses instead of falling through", (t) => {
  const f = fixture(t);
  disableManagedScanner(t);
  const bin = useFakeScanner(t);
  writeFileSync(
    join(bin, "trufflehog"),
    `#!${process.execPath}\nconsole.log('private malformed output');`,
    { mode: 0o755 },
  );
  assert.throws(
    () =>
      scanAgentInput({
        cwd: f.cwd,
        prompt: "Synthetic input",
        source: { kind: "prompt" },
        timeoutMs: 5000,
      }),
    (error: unknown) =>
      error instanceof AgentInputScanError &&
      error.reason === "scanner_failed" &&
      !error.message.includes("private malformed output"),
  );
});

test("scanner bounds Git process growth while preserving complete binary inputs in both scans", (t) => {
  const f = fixture(t);
  const expected = new Map<string, string>();
  const receipt = join(f.root, "staged-inputs");
  useFakeScanner(
    t,
    `fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(inputs.map(({name, bytes}) => [name, bytes.toString('base64')])) + '\\n');`,
  );
  const content = (i: number, version: string) =>
    i === 0 && version === "before"
      ? Buffer.alloc(0)
      : Buffer.concat([
          Buffer.from(`${version} ${i}\n${"f".repeat(40)} blob 42\n`),
          Buffer.from([0, 255, 10, 13, 128]),
        ]);
  for (let i = 0; i < 81; i++) {
    writeFileSync(join(f.cwd, `${i}.bin`), content(i, "before"));
  }
  const baseSha = f.commit();
  for (let i = 0; i < 81; i++) {
    writeFileSync(join(f.cwd, `${i}.bin`), content(i, "after"));
  }
  const headSha = f.commit();
  for (const [revision, version] of [
    [baseSha, "before"],
    [headSha, "after"],
  ]) {
    for (let i = 0; i < 81; i++)
      expected.set(
        f.git("rev-parse", `${revision}:${i}.bin`),
        content(i, version!).toString("base64"),
      );
  }
  const nativeSpawn = childProcess.spawnSync;
  const commands: string[][] = [];
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof nativeSpawn>) => {
    if (args[1]?.includes("cat-file")) commands.push([...args[1]]);
    return nativeSpawn(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (let scan = 0; scan < 2; scan++)
    scanAgentInput({
      cwd: f.cwd,
      prompt: "Review binary changes.",
      source: { kind: "committed", baseSha, headSha },
      timeoutMs: 120_000,
    });
  const scans = readFileSync(receipt, "utf8")
    .trim()
    .split("\n")
    .map((line) => new Map<string, string>(JSON.parse(line)));
  assert.equal(scans.length, 2, "each admission boundary must scan independently");
  assert.deepEqual(scans[0], scans[1]);
  for (const [oid, bytes] of expected) assert.equal(scans[0]!.get(oid), bytes);
  assert.equal(scans[0]!.size, expected.size + 3, "prompt, complete raw diff and binary patch");
  assert.ok(
    commands.length <= 8,
    `162 unique blobs across two scans must use bounded batches, observed ${commands.length} Git children`,
  );
});

test("scanner refuses malformed batch metadata and binary frames before provider dispatch", (t) => {
  const f = fixture(t);
  const receipt = join(f.root, "unexpected-scan");
  useFakeScanner(t, `fs.writeFileSync(${JSON.stringify(receipt)}, 'called');`);
  writeFileSync(join(f.cwd, "a"), Buffer.from([0, 10, 255]));
  const baseSha = f.commit();
  writeFileSync(join(f.cwd, "a"), Buffer.from([0, 10, 255, 13]));
  const headSha = f.commit();
  const source = { kind: "committed" as const, baseSha, headSha };
  const nativeSpawn = childProcess.spawnSync;
  let fault = "";
  let contentReads = 0;
  let injected = false;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof nativeSpawn>) => {
    const result = nativeSpawn(...args);
    const command = args[1] ?? [];
    const metadata = command.includes("--batch-check");
    const content = command.includes("--batch");
    if (content) contentReads++;
    if (!metadata && !content) return result;
    const output = Buffer.from(result.stdout);
    const headerEnd = output.indexOf(10);
    let changed: Buffer | undefined;
    if (metadata && fault.startsWith("metadata/")) {
      const lines = output.toString().trimEnd().split("\n");
      const fields = lines[0]!.split(" ");
      if (fault === "metadata/missing") lines[0] = `${fields[0]} missing`;
      if (fault === "metadata/type") fields[1] = "tree";
      if (fault === "metadata/identity") fields[0] = "0".repeat(40);
      if (fault === "metadata/negative") fields[2] = "-1";
      if (fault === "metadata/nondecimal") fields[2] = "1e2";
      if (fault === "metadata/unsafe-integer") fields[2] = "9007199254740992";
      if (fault !== "metadata/missing") lines[0] = fields.join(" ");
      if (fault === "metadata/count") lines.pop();
      if (fault === "metadata/aggregate")
        for (let i = 0; i < lines.length; i++)
          lines[i] = lines[i]!.replace(/\d+$/, String(128 * 1024 * 1024));
      changed = Buffer.from(lines.join("\n") + "\n");
      if (fault === "metadata/unterminated") changed = changed.subarray(0, -1);
    } else if (content && fault.startsWith("content/")) {
      changed = Buffer.from(output);
      if (fault === "content/identity") changed[0] = changed[0] === 97 ? 98 : 97;
      if (fault === "content/size") changed[headerEnd - 1] = 57;
      if (fault === "content/delimiter") changed[headerEnd + 1 + 3] = 0;
      if (fault === "content/truncated") changed = changed.subarray(0, -1);
      if (fault === "content/trailing") changed = Buffer.concat([changed, Buffer.from("\n")]);
      if (fault === "content/header-newline") changed[headerEnd] = 0;
    }
    if (!changed) return result;
    injected = true;
    return { ...result, stdout: changed };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (fault of [
    "metadata/missing",
    "metadata/type",
    "metadata/identity",
    "metadata/negative",
    "metadata/nondecimal",
    "metadata/unsafe-integer",
    "metadata/count",
    "metadata/aggregate",
    "metadata/unterminated",
    "content/identity",
    "content/size",
    "content/delimiter",
    "content/truncated",
    "content/trailing",
    "content/header-newline",
  ]) {
    contentReads = 0;
    injected = false;
    assert.throws(
      () => f.run(source),
      (error) => {
        assert.ok(error instanceof AgentInputScanError);
        assert.equal(
          error.reason,
          fault === "metadata/aggregate" ? "staging_limit" : "incomplete_source",
          fault,
        );
        return true;
      },
    );
    assert.ok(injected, fault);
    if (fault.startsWith("metadata/")) assert.equal(contentReads, 0, fault);
    assert.equal(existsSync(receipt), false, fault);
    assert.equal(existsSync(f.calls), false, fault);
  }
});

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
  const globalConfig = join(home, ".gitconfig");
  const previous = new Map(
    ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"].map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, original] of previous) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
  mkdirSync(home);
  writeFileSync(globalConfig, "", { mode: 0o600 });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  // GIT_CONFIG_GLOBAL overrides HOME, including a host's read-only /dev/null binding.
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
}

test("Git config fixtures restore unset, empty, and disabled global bindings", async (t) => {
  const previous = process.env.GIT_CONFIG_GLOBAL;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  for (const original of [undefined, "", devNull]) {
    if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = original;
    const home = process.env.HOME;
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    await t.test(original === undefined ? "unset" : original === "" ? "empty" : "disabled", (t) => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-git-config-test-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      useGitConfigHome(t, root);
      const config = join(root, "home", ".gitconfig");
      assert.equal(process.env.HOME, join(root, "home"));
      assert.equal(process.env.XDG_CONFIG_HOME, process.env.HOME);
      assert.equal(process.env.GIT_CONFIG_GLOBAL, config);
      assert.equal(readFileSync(config, "utf8"), "");
      if (process.platform !== "win32") assert.equal(statSync(config).mode & 0o777, 0o600);
      execFileSync("git", ["config", "--global", "fixture.scope", "private"], { cwd: root });
      assert.equal(
        execFileSync("git", ["config", "--global", "--get", "fixture.scope"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        "private",
      );
      assert.match(readFileSync(config, "utf8"), /scope = private/);
    });
    assert.equal(process.env.GIT_CONFIG_GLOBAL, original);
    assert.equal(Object.hasOwn(process.env, "GIT_CONFIG_GLOBAL"), original !== undefined);
    assert.equal(process.env.HOME, home);
    assert.equal(process.env.XDG_CONFIG_HOME, xdgConfigHome);
  }
});

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

for (const expectedRole of ["base", "head", "index", "tree"] as const) {
  test(`scan staging preserves ${expectedRole} blob provenance before provider launch`, (t) => {
    const f = fixture(t);
    const markers = {
      base: "base-role-marker",
      head: "head-role-marker",
      index: "index-role-marker",
      tree: "tree-role-marker",
    };
    writeFileSync(join(f.cwd, "a.txt"), `${markers.base}\n`);
    const baseSha = f.commit();
    writeFileSync(join(f.cwd, "a.txt"), `${markers.head}\n`);
    const headSha = f.commit();
    if (expectedRole === "index" || expectedRole === "tree") {
      writeFileSync(join(f.cwd, "a.txt"), `${markers.index}\n`);
      f.git("add", "a.txt");
      writeFileSync(join(f.cwd, "a.txt"), `${markers.tree}\n`);
    }
    const uri = new URL("https://fixture.example.invalid/path");
    uri.username = "fixture-user";
    uri.password = "fixture-pass";
    useFakeScanner(
      t,
      String.raw`
const marker = ${JSON.stringify(markers[expectedRole])};
const uri = ${JSON.stringify(uri.href)};
const parsed = new URL(uri);
const input = inputs.find(({name, bytes}) => /^[a-f0-9]{40}$/.test(name) && bytes.includes(marker));
assert.ok(input);
process.stdout.write(JSON.stringify({
  SourceType: 15, DetectorType: 17, DetectorName: 'URI', DecoderName: 'PLAIN',
  Verified: false, VerificationError: 'synthetic verification error',
  Raw: uri, RawV2: uri,
  SourceMetadata: {Data: {Filesystem: {file: path.join(inputDir, input.name), line: 1}}},
  SecretParts: {host: parsed.host, username: parsed.username, password: parsed.password},
  ExtraData: null, StructuredData: null,
}) + '\n');
process.stderr.write(JSON.stringify({
  level: 'info-0', logger: 'trufflehog', msg: 'finished scanning',
  trufflehog_version: '3.97.4', chunks: 1, bytes: 1,
  verified_secrets: 0, unverified_secrets: 1,
}) + '\n');
process.exit(183);
`,
    );
    const run = () => {
      if (expectedRole === "base" || expectedRole === "head")
        return f.run({ kind: "committed", baseSha, headSha });
      const expected = captureTargetCheckoutBinding(f.cwd);
      return withTargetReviewSnapshot({ cwd: f.cwd, baseSha, expected, timeoutMs: 30_000 }, f.run);
    };
    assert.throws(run, (error) => {
      assert.ok(error instanceof AgentInputScanError);
      assert.equal(error.reason, "findings");
      assert.equal(error.scanDiagnostic?.kind, "unclassified_finding");
      if (error.scanDiagnostic?.kind === "unclassified_finding") {
        assert.equal(error.scanDiagnostic.material?.kind, "blob");
        assert.deepEqual(
          error.scanDiagnostic.material?.references?.map((reference) => reference.role),
          [expectedRole],
        );
      }
      return true;
    });
    assert.equal(existsSync(f.calls), false);
  });
}

const ledgerSource = "test/action-ledger-runtime.test.ts";
const autoreviewSources = [
  "skills/autoreview/tests/test_autoreview_hardening.py",
  ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
];
const browserChromeSource = "extensions/browser/src/browser/chrome.test.ts";
const browserServerContextSource =
  "extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts";
const browserDocsSource = "docs/tools/browser.md";
const browserRemoteDocsSource = "docs/tools/browser/remote.md";
const browserToolSource = "extensions/browser/src/browser-tool.test.ts";
const browserCdpHelpersSource = "extensions/browser/src/browser/cdp.helpers.test.ts";
const browserMcpSource = "extensions/browser/src/browser/chrome-mcp.test.ts";
const browserProfilesSource = "extensions/browser/src/browser/server-context.list-profiles.test.ts";
const firecrawlSource = "extensions/firecrawl/src/firecrawl-client.test.ts";
const macDashboardSource = "apps/macos/Tests/OpenClawIPCTests/DashboardWindowSmokeTests.swift";
const mcpAppsSource = "src/config/config-misc.test.ts";
const marketplaceFeedSource = "src/cli/plugins-cli.marketplace-refresh.test.ts";
const gatewayConfigSource = "src/gateway/server.config-patch.test.ts";
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

type ExactDetector = "URI" | "MongoDB" | "Postgres";
type ExactDecoder = "PLAIN" | "ESCAPED_UNICODE";

interface ExactCase {
  detectorType: 17 | 895 | 968;
  detectorName: ExactDetector;
  decoder: ExactDecoder;
  raw: string;
  rawV2: string;
  line: string;
  secretParts: Record<string, string>;
  extraData: Record<string, string> | null;
}

const exactSource = "src/logging/redact.test.ts";

function exactCase(detectorName: ExactDetector, decoder: ExactDecoder): ExactCase {
  if (detectorName === "URI") {
    const uri = new URL(`https://${decoder.toLowerCase()}.example.invalid/path`);
    uri.username = "fixture-user";
    uri.password = "fixture-pass";
    const rawV2 = uri.href;
    const authority = new URL(rawV2);
    authority.pathname = "";
    return {
      detectorType: 17,
      detectorName,
      decoder,
      raw: authority.href.slice(0, -1),
      rawV2,
      line: `const fixture = ${JSON.stringify(rawV2)};`,
      secretParts: {
        host: uri.host,
        username: uri.username,
        password: uri.password,
      },
      extraData: null,
    };
  }
  const raw = `${detectorName.toLowerCase()}://${decoder.toLowerCase()}.example.invalid/db`;
  if (detectorName === "MongoDB") {
    return {
      detectorType: 895,
      detectorName,
      decoder,
      raw,
      rawV2: "",
      line: `const fixture = ${JSON.stringify(raw)};`,
      secretParts: { key: raw },
      extraData: {
        database: "db",
        host: `${decoder.toLowerCase()}.example.invalid`,
        rotation_guide: "reviewed synthetic guidance",
        username: "fixture-user",
      },
    };
  }
  return {
    detectorType: 968,
    detectorName,
    decoder,
    raw,
    rawV2: raw,
    line: `const fixture = ${JSON.stringify(raw)};`,
    secretParts: { connection_string: raw },
    extraData: {
      database: "db",
      host: `${decoder.toLowerCase()}.example.invalid`,
      sslmode: "require",
      username: "fixture-user",
    },
  };
}

function exactFixture(
  cases: readonly ExactCase[],
  roles: readonly (readonly ScanSourceRole[])[] = cases.map(() => ["base"]),
) {
  const inputs = new Map<string, StagedScanInput>();
  const findings = cases.map((entry, index) => {
    const file = `/private/scanner/${index.toString(16).padStart(40, "0")}`;
    inputs.set(file, {
      kind: "blob",
      id: index.toString(16).padStart(40, "0"),
      bytes: Buffer.from(`// context\n${entry.line}\n`),
      references: (roles[index] ?? ["base"]).map((role) => ({
        source: exactSource,
        mode: "100644",
        revision: role === "base" ? "a".repeat(40) : "b".repeat(40),
        role,
      })),
    });
    return {
      SourceType: 15,
      DetectorType: entry.detectorType,
      DetectorName: entry.detectorName,
      DecoderName: entry.decoder,
      Verified: false,
      VerificationError: "synthetic verification error",
      Raw: entry.raw,
      RawV2: entry.rawV2,
      SourceMetadata: { Data: { Filesystem: { file, line: 2 } } },
      SecretParts: entry.secretParts,
      ExtraData: entry.extraData,
      StructuredData: null,
    };
  });
  const policy = [
    ...new Map(
      cases.map((entry) => {
        const row: ReviewedAttribution = [
          entry.detectorType,
          entry.detectorName,
          entry.decoder,
          createHash("sha256").update(entry.raw).digest("hex"),
          createHash("sha256").update(entry.rawV2).digest("hex"),
          createHash("sha256").update(entry.line).digest("hex"),
          exactSource,
          "100644",
        ];
        return [row.join("\0"), row] as const;
      }),
    ).values(),
  ];
  return { findings, inputs, policy };
}

function classifyExact(
  findings: readonly Record<string, unknown>[],
  inputs: ReadonlyMap<string, StagedScanInput>,
  policy: readonly ReviewedAttribution[],
) {
  return classifyReviewedFixtureScan(
    183,
    Buffer.from(`${findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`),
    Buffer.from(
      `${JSON.stringify({
        level: "info-0",
        logger: "trufflehog",
        msg: "finished scanning",
        trufflehog_version: "3.97.4",
        chunks: 1,
        bytes: 1,
        verified_secrets: 0,
        unverified_secrets: findings.length,
      })}\n`,
    ),
    inputs,
    policy,
  );
}

function classifyWithProductionPolicy(
  findings: readonly Record<string, unknown>[],
  inputs: ReadonlyMap<string, StagedScanInput>,
) {
  const verifiedCount = findings.filter((finding) => finding.Verified === true).length;
  return classifyReviewedFixtureScan(
    183,
    Buffer.from(`${findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`),
    Buffer.from(
      `${JSON.stringify({
        level: "info-0",
        logger: "trufflehog",
        msg: "finished scanning",
        trufflehog_version: "3.97.4",
        chunks: 1,
        bytes: 1,
        verified_secrets: verifiedCount,
        unverified_secrets: findings.length - verifiedCount,
      })}\n`,
    ),
    inputs,
  );
}

function marketplaceTelemetryCase(twoOccurrences: boolean): ExactCase {
  const uri = new URL("https://packages.acme.example/openclaw/feed");
  uri.username = "user";
  uri.password = "secret";
  const rawV2 = uri.href;
  uri.pathname = "";
  const value = JSON.stringify(`${rawV2}?token=leak#frag`);
  return {
    detectorType: 17,
    detectorName: "URI",
    decoder: "PLAIN",
    raw: uri.href.slice(0, -1),
    rawV2,
    line: `        url: ${value},${twoOccurrences ? `\n          url: ${value},` : ""}`,
    secretParts: { host: uri.host, username: uri.username, password: uri.password },
    extraData: null,
  };
}

for (const source of [marketplaceFeedSource, "src/cli/plugins-cli.marketplace-entries.test.ts"]) {
  for (const role of ["base", "head", "index", "tree", "worktree"] as const) {
    for (const decoder of ["PLAIN", "HTML"] as const) {
      test(`marketplace telemetry attribution preserves ${source} ${role} ${decoder}`, () => {
        const entries = source !== marketplaceFeedSource;
        const fixture = exactFixture([marketplaceTelemetryCase(entries)], [[role]]);
        for (const input of fixture.inputs.values()) {
          if (input.kind !== "blob") throw new Error("expected blob");
          input.references = input.references.map((reference) => ({ ...reference, source }));
        }
        const result = classifyWithProductionPolicy(
          fixture.findings.map((finding) => ({ ...finding, DecoderName: decoder })),
          fixture.inputs,
        );
        assert.equal(
          result.kind,
          (entries ? role === "base" || role === "head" : decoder === "PLAIN")
            ? "classified"
            : "refused",
        );
      });
    }
  }
}

for (const mutation of [
  "missing",
  "reordered",
  "extra",
  "query",
  "mode",
  "refresh alias",
  "unknown alias",
] as const) {
  test(`marketplace entries attribution refuses ${mutation}`, () => {
    const fixture = exactFixture([marketplaceTelemetryCase(true)]);
    for (const input of fixture.inputs.values()) {
      if (input.kind !== "blob" || !input.bytes) throw new Error("expected blob");
      input.references = input.references.map((reference) => ({
        ...reference,
        source: "src/cli/plugins-cli.marketplace-entries.test.ts",
        mode: mutation === "mode" ? "100755" : "100644",
      }));
      const lines = input.bytes.toString().trimEnd().split("\n");
      if (mutation === "missing") lines.pop();
      if (mutation === "reordered") [lines[1], lines[2]] = [lines[2]!, lines[1]!];
      if (mutation === "extra") lines.push(lines[1]!);
      if (mutation === "query") lines[2] = lines[2]!.replace("#frag", "#changed");
      input.bytes = Buffer.from(lines.join("\n") + "\n");
      if (mutation.endsWith("alias")) {
        input.references = [
          ...input.references,
          {
            ...input.references[0]!,
            source: mutation === "refresh alias" ? marketplaceFeedSource : "another.test.ts",
          },
        ];
      }
    }
    assert.equal(classifyWithProductionPolicy(fixture.findings, fixture.inputs).kind, "refused");
  });
}

function matrixCredentialFixture(decoder: "PLAIN" | "HTML" = "PLAIN") {
  const source = "extensions/matrix/src/matrix/client.test.ts";
  const uri = new URL("https://matrix.example.org");
  uri.username = "user";
  uri.password = "pass";
  const raw = uri.href.slice(0, -1);
  const line = `          homeserver: ${JSON.stringify(raw)},`;
  const inputs = new Map<string, StagedScanInput>();
  const findings = (["base", "head"] as const).map((role, index) => {
    const id = String(index).repeat(40);
    const file = `/private/scanner/${id}`;
    const literalLine = index === 0 ? 268 : 314;
    inputs.set(file, {
      kind: "blob",
      id,
      bytes: Buffer.from(`${"// context\n".repeat(literalLine - 1)}${line}\n`),
      references: [{ source, mode: "100644", revision: id, role }],
    });
    return {
      SourceType: 15,
      DetectorType: 17,
      DetectorName: "URI",
      DecoderName: decoder,
      Verified: false,
      VerificationError: "synthetic verification error",
      Raw: raw,
      RawV2: raw,
      SourceMetadata: { Data: { Filesystem: { file, line: literalLine } } },
      SecretParts: { host: uri.host, username: uri.username, password: uri.password },
      ExtraData: null,
      StructuredData: null,
    };
  });
  return { source, raw, line, inputs, findings };
}

test("reviewed Matrix fixture qualifies exact base/head and shared references", () => {
  // These decoder variants are constructed controls, not recovered hosted records.
  for (const decoder of ["PLAIN", "HTML"] as const) {
    const f = matrixCredentialFixture(decoder);
    for (const findings of [f.findings, f.findings.toReversed(), [f.findings[0]!]]) {
      const result = classifyWithProductionPolicy(findings, f.inputs);
      assert.equal(result.kind, "classified", decoder);
      if (result.kind === "classified") {
        assert.equal(result.notices.length, 1);
        assert.equal(result.notices[0]!.source, f.source);
        assert.deepEqual(
          result.notices[0]!.findings.map(({ literalLine }) => literalLine).sort(),
          findings.map((finding) => finding.SourceMetadata.Data.Filesystem.line).sort(),
        );
      }
    }
    const first = f.findings[0]!;
    const file = first.SourceMetadata.Data.Filesystem.file;
    const input = f.inputs.get(file)!;
    assert.ok(input.kind === "blob");
    f.inputs.set(file, {
      ...input,
      references: [
        ...input.references,
        { ...input.references[0]!, role: "head", revision: "b".repeat(40) },
      ],
    });
    const shared = classifyWithProductionPolicy([first], f.inputs);
    assert.equal(shared.kind, "classified");
    if (shared.kind === "classified")
      assert.deepEqual(shared.notices[0]!.findings.map(({ role }) => role).sort(), [
        "base",
        "head",
      ]);
  }
});

test("reviewed Matrix fixture refuses changed identities and every unqualified reference", () => {
  const f = matrixCredentialFixture();
  const first = f.findings[0]!;
  const file = first.SourceMetadata.Data.Filesystem.file;
  const input = f.inputs.get(file)!;
  assert.ok(input.kind === "blob");
  const refuses = (
    findings: readonly Record<string, unknown>[],
    inputs: ReadonlyMap<string, StagedScanInput>,
    reason: string,
  ) => {
    const result = classifyWithProductionPolicy(findings, inputs);
    assert.equal(result.kind, "refused");
    assert.equal("notices" in result, false);
    if (result.kind === "refused") assert.equal(result.diagnostic.reason, reason);
  };
  for (const change of [{ Raw: `${f.raw}/changed` }, { RawV2: `${f.raw}/changed` }])
    refuses([{ ...first, ...change }], f.inputs, "literal_not_reviewed");
  for (const change of [
    { DecoderName: "BASE64" },
    { DecoderName: "ESCAPED_UNICODE" },
    { DetectorType: 895, DetectorName: "MongoDB" },
    { Verified: true },
    { VerificationError: "" },
    { SourceType: 16 },
  ])
    refuses([{ ...first, ...change }], f.inputs, "finding_not_reviewed");
  refuses([{ ...first, SecretParts: { host: "other" } }], f.inputs, "metadata_mismatch");
  for (const bytes of [
    Buffer.from(`${f.line} // changed\n`),
    Buffer.from(`${f.line}\n${f.line}\n`),
    Buffer.from(Buffer.from(f.raw).toString("base64")),
  ])
    refuses([first], new Map([[file, { ...input, bytes }]]), "literal_mismatch");
  for (const reference of [
    { ...input.references[0]!, source: "other.test.ts" },
    { ...input.references[0]!, mode: "100755" },
    ...(["index", "tree", "worktree"] as const).map((role) => ({
      ...input.references[0]!,
      role,
    })),
  ]) {
    for (const references of [[reference], [...input.references, reference]])
      refuses([first], new Map([[file, { ...input, references }]]), "source_not_reviewed");
  }
  for (const kind of ["prompt", "schema", "additional", "patch", "raw_diff"] as const)
    refuses(
      [first],
      new Map([
        [
          file,
          { kind, id: input.id, bytes: input.bytes, from: "a".repeat(40), to: "b".repeat(40) },
        ],
      ]),
      "material_not_reviewed",
    );
  refuses(
    [first, { ...first, Raw: "unreviewed", RawV2: "unreviewed" }],
    f.inputs,
    "literal_not_reviewed",
  );
  refuses([first, first], f.inputs, "duplicate_finding");
});

for (const scenario of ["PLAIN", "HTML", "mixed unknown"] as const) {
  test(`reviewed Matrix fixture admission: ${scenario}`, (t) => {
    const matrix = matrixCredentialFixture();
    const f = fixture(t);
    const notices: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => notices.push(args));
    const target = join(f.cwd, matrix.source);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `// before\n${"// context\n".repeat(20)}${matrix.line}\n`);
    const baseSha = f.commit();
    writeFileSync(target, `// after\n${"// context\n".repeat(20)}${matrix.line}\n`);
    const headSha = f.commit();
    const receipt = join(f.root, "scan-root");
    useFakeScanner(
      t,
      String.raw`
fs.writeFileSync(${JSON.stringify(receipt)}, path.dirname(inputDir));
const template = ${JSON.stringify(matrix.findings[0])};
const findings = inputs.filter(({name}) => /^[a-f0-9]{40}$/.test(name)).map(({name}) => ({
  ...template,
  DecoderName: ${JSON.stringify(scenario === "HTML" ? "HTML" : "PLAIN")},
  SourceMetadata: {Data: {Filesystem: {file: path.join(inputDir, name), line: 22}}},
}));
assert.equal(findings.length, 2);
if (${scenario === "mixed unknown"}) findings.push({...findings[0], Raw: 'unreviewed', RawV2: 'unreviewed'});
process.stdout.write(findings.map(finding => JSON.stringify(finding)).join('\n') + '\n');
process.stderr.write(JSON.stringify({
  level: 'info-0', logger: 'trufflehog', msg: 'finished scanning',
  trufflehog_version: '3.97.4', chunks: 2, bytes: 1000,
  verified_secrets: 0, unverified_secrets: findings.length,
}) + '\n');
process.exit(183);
`,
    );
    const run = () => f.run({ kind: "committed", baseSha, headSha });
    if (scenario === "mixed unknown") {
      assert.throws(run, (error) => {
        assert.ok(error instanceof AgentInputScanError);
        assert.equal(error.reason, "findings");
        assert.equal(error.scanDiagnostic?.kind, "unclassified_finding");
        if (error.scanDiagnostic?.kind === "unclassified_finding") {
          assert.equal(error.scanDiagnostic.reason, "literal_not_reviewed");
          assert.equal(error.scanDiagnostic.findingIndex, 2);
        }
        return true;
      });
      assert.equal(existsSync(f.calls), false);
      assert.deepEqual(notices, []);
    } else {
      assert.equal(run().status, 0);
      assert.equal(readFileSync(f.calls, "utf8"), "called");
      assert.equal(notices.length, 1);
      const notice = JSON.parse(String(notices[0]![0]));
      assert.equal(notice.event, "agent_input_scan_classified");
      assert.equal(notice.source, matrix.source);
      assert.deepEqual(notice.findings.map(({ role }: { role: string }) => role).sort(), [
        "base",
        "head",
      ]);
      assert.equal(JSON.stringify(notices).includes(matrix.raw), false);
    }
    assert.equal(existsSync(readFileSync(receipt, "utf8")), false);
  });
}

test("reviewed Signal fixtures preserve exact source, line, decoder, and verification bindings", () => {
  const sources = [
    "extensions/signal/src/client.test.ts",
    "extensions/signal/src/client-container.test.ts",
  ];
  for (const [index, host] of ["127.0.0.1", "localhost"].entries()) {
    const url = new URL(`http://${host}:8080`);
    url.username = "user";
    url.password = "pass";
    const raw = url.href.slice(0, -1);
    const line =
      index === 0
        ? `        baseUrl: "${raw}",`
        : `    await expect(containerCheck("${raw}")).rejects.toThrow(`;
    const file = `/private/scanner/${String(index).repeat(40)}`;
    const input: StagedScanInput = {
      kind: "blob",
      id: String(index).repeat(40),
      bytes: Buffer.from(`${line}\n`),
      references: [
        { source: sources[index]!, mode: "100644", revision: "a".repeat(40), role: "head" },
      ],
    };
    const finding = {
      SourceType: 15,
      DetectorType: 17,
      DetectorName: "URI",
      DecoderName: "PLAIN",
      Verified: false,
      VerificationError: "synthetic verification error",
      Raw: raw,
      RawV2: raw,
      SourceMetadata: { Data: { Filesystem: { file, line: 1 } } },
      SecretParts: { host: url.host, username: url.username, password: url.password },
      ExtraData: null,
      StructuredData: null,
    };
    for (const decoder of ["PLAIN", "HTML"]) {
      const result = classifyWithProductionPolicy(
        [{ ...finding, DecoderName: decoder }],
        new Map([[file, input]]),
      );
      assert.equal(result.kind, "classified", `${host}: ${decoder}`);
      if (result.kind === "classified") {
        assert.equal(result.notices.length, 1);
        assert.equal(result.notices[0]!.source, sources[index]);
        assert.equal(result.notices[0]!.findings[0]!.decoder, decoder);
      }
    }
    const otherSource: StagedScanInput = {
      ...input,
      references: [{ ...input.references[0]!, source: sources[1 - index]! }],
    };
    for (const [name, changedFinding, changedInput, reason] of [
      ["other approved path", finding, otherSource, "source_not_reviewed"],
      [
        "changed source line",
        finding,
        { ...input, bytes: Buffer.from(`${line} // changed\n`) },
        "literal_mismatch",
      ],
      [
        "duplicate literal",
        finding,
        { ...input, bytes: Buffer.from(`${line}\n${line}\n`) },
        "literal_mismatch",
      ],
      ["unapproved decoder", { ...finding, DecoderName: "BASE64" }, input, "finding_not_reviewed"],
      ["verified finding", { ...finding, Verified: true }, input, "finding_not_reviewed"],
    ] as const) {
      const result = classifyWithProductionPolicy(
        [changedFinding],
        new Map([[file, changedInput]]),
      );
      assert.equal(result.kind, "refused", `${host}: ${name}`);
      if (result.kind === "refused") {
        assert.equal(result.diagnostic.kind, "unclassified_finding", `${host}: ${name}`);
        assert.equal(result.diagnostic.reason, reason, `${host}: ${name}`);
      }
    }
  }
});

function crabboxPostgresDocsFixture() {
  const raw = ["postgresql://crabbox", ":password@db.example.com", ":5432"].join("");
  const sourceUri = [
    "postgresql://crabbox",
    ":password@db.example.com/crabbox",
    "?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem",
  ].join("");
  const line = ["DATABASE_URL='", sourceUri, "' \\"].join("");
  const inputs = new Map<string, StagedScanInput>();
  const blobs = [
    {
      id: "4fa440e5879379b16bcb570cc0adc46439f075fd",
      revision: "b".repeat(40),
      role: "head",
    },
    {
      id: "75f9bd02e4948b6b214997ab7e3878718740b4d8",
      revision: "a".repeat(40),
      role: "base",
    },
  ] as const;
  for (const blob of blobs) {
    const file = `/private/scanner/${blob.id}`;
    inputs.set(file, {
      kind: "blob",
      id: blob.id,
      bytes: Buffer.from(`${"\n".repeat(352)}${line}\n`),
      references: [
        {
          source: "docs/operations.md",
          mode: "100644",
          revision: blob.revision,
          role: blob.role,
        },
      ],
    });
  }
  const findings = blobs.flatMap((blob) =>
    (["PLAIN", "HTML"] as const).map((decoder) => ({
      SourceType: 15,
      DetectorType: 968,
      DetectorName: "Postgres",
      DecoderName: decoder,
      Verified: false,
      VerificationError: "lookup db.example.com: no such host",
      Raw: raw,
      RawV2: raw,
      SourceMetadata: {
        Data: { Filesystem: { file: `/private/scanner/${blob.id}`, line: 353 } },
      },
      SecretParts: { connection_string: raw },
      ExtraData: {
        database: "crabbox",
        host: "db.example.com:5432",
        sslmode: "verify-full",
        username: "crabbox",
      },
      StructuredData: null,
    })),
  );
  return { findings, inputs, raw, line };
}

test("Crabbox Postgres docs attribution accepts only the observed committed variants", () => {
  const accepted = crabboxPostgresDocsFixture();
  assert.equal(
    createHash("sha256").update(accepted.raw).digest("hex"),
    "b296b6d2d18690f50a8088d03ce813c6147aaf1642e9f774a88b7c10b4c1948b",
  );
  assert.equal(
    createHash("sha256").update(accepted.line).digest("hex"),
    "222f928b39fd053a8a3b088b53f703bccbb7d3cd58ede6ae974e985cae4d6406",
  );
  for (let mask = 1; mask < 1 << accepted.findings.length; mask++) {
    const subset = accepted.findings.filter((_, index) => mask & (1 << index));
    assert.equal(classifyWithProductionPolicy(subset, accepted.inputs).kind, "classified");
    assert.equal(
      classifyWithProductionPolicy([...subset].reverse(), accepted.inputs).kind,
      "classified",
    );
  }

  const firstFile = String(
    (accepted.findings[0]!.SourceMetadata as { Data: { Filesystem: { file: string } } }).Data
      .Filesystem.file,
  );
  const cases: Array<{
    name: string;
    expected: string;
    mutate: (findings: Record<string, unknown>[], inputs: Map<string, StagedScanInput>) => void;
  }> = [
    {
      name: "value",
      expected: "finding_not_reviewed",
      mutate: (findings) => {
        findings[0]!.Raw = `${findings[0]!.Raw}changed`;
        findings[0]!.RawV2 = findings[0]!.Raw;
      },
    },
    {
      name: "line",
      expected: "literal_mismatch",
      mutate: (_findings, inputs) => {
        const staged = inputs.get(firstFile)!;
        inputs.set(firstFile, {
          ...staged,
          bytes: Buffer.from(`${staged.bytes!.toString().trimEnd()} # changed\n`),
        });
      },
    },
    {
      name: "path",
      expected: "source_not_reviewed",
      mutate: (_findings, inputs) => {
        const staged = inputs.get(firstFile)!;
        inputs.set(firstFile, {
          ...staged,
          references: [{ ...staged.references[0]!, source: "docs/infrastructure.md" }],
        });
      },
    },
    {
      name: "mode",
      expected: "source_not_reviewed",
      mutate: (_findings, inputs) => {
        const staged = inputs.get(firstFile)!;
        inputs.set(firstFile, {
          ...staged,
          references: [{ ...staged.references[0]!, mode: "100755" }],
        });
      },
    },
    {
      name: "detector",
      expected: "finding_not_reviewed",
      mutate: (findings) => {
        findings[0]!.DetectorType = 895;
        findings[0]!.DetectorName = "MongoDB";
      },
    },
    {
      name: "decoder",
      expected: "finding_not_reviewed",
      mutate: (findings) => {
        findings[0]!.DecoderName = "ESCAPED_UNICODE";
      },
    },
    ...(["index", "tree", "worktree"] as const).map((role) => ({
      name: `${role} role`,
      expected: "source_not_reviewed",
      mutate: (_findings: Record<string, unknown>[], inputs: Map<string, StagedScanInput>) => {
        const staged = inputs.get(firstFile)!;
        inputs.set(firstFile, {
          ...staged,
          references: [{ ...staged.references[0]!, role }],
        });
      },
    })),
    {
      name: "duplicate",
      expected: "duplicate_finding",
      mutate: (findings) => {
        findings.splice(1, findings.length - 1, structuredClone(findings[0]!));
      },
    },
    {
      name: "mixed unknown",
      expected: "finding_not_reviewed",
      mutate: (findings) => {
        findings.push({
          ...structuredClone(findings[0]!),
          Raw: "unknown",
          RawV2: "unknown",
        });
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = crabboxPostgresDocsFixture();
    const findings = structuredClone(fixture.findings) as Record<string, unknown>[];
    const inputs = new Map(fixture.inputs);
    scenario.mutate(findings, inputs);
    const result = classifyWithProductionPolicy(findings, inputs);
    assert.equal(result.kind, "refused", scenario.name);
    if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding")
      assert.equal(result.diagnostic.reason, scenario.expected, scenario.name);
  }
});

test("exact reviewed attributions accept emitted detector subsets in any order", () => {
  const cases = (["URI", "MongoDB", "Postgres"] as const).flatMap((detector) =>
    (["PLAIN", "ESCAPED_UNICODE"] as const).map((decoder) => exactCase(detector, decoder)),
  );
  const fixture = exactFixture(
    cases,
    cases.map(() => ["base", "head"]),
  );
  const selections = [
    cases.map((_, index) => index),
    cases.map((_, index) => index).reverse(),
    cases.map((_, index) => index).filter((index) => index % 2 === 0),
    cases.map((_, index) => index).filter((index) => index % 2 === 1),
    ...cases.map((_, index) => [index]),
  ];
  for (const selection of selections) {
    const result = classifyExact(
      selection.map((index) => fixture.findings[index]!),
      fixture.inputs,
      fixture.policy,
    );
    assert.equal(result.kind, "classified");
    if (result.kind === "classified" && selection.length === cases.length) {
      assert.deepEqual([...new Set(result.notices.map((notice) => notice.detector))].sort(), [
        "MongoDB",
        "Postgres",
        "URI",
      ]);
      assert.deepEqual(
        [
          ...new Set(
            result.notices.flatMap((notice) => notice.findings.map((finding) => finding.role)),
          ),
        ].sort(),
        ["base", "head"],
      );
    }
  }
});

test("exact reviewed attributions accept role-neutral tuples from committed references", () => {
  for (const decoder of ["PLAIN", "ESCAPED_UNICODE"] as const) {
    const entry = exactCase("URI", decoder);
    const separate = exactFixture([entry, entry], [["base"], ["head"]]);
    assert.equal(
      classifyExact(separate.findings, separate.inputs, separate.policy).kind,
      "classified",
    );

    const deduplicated = exactFixture([entry], [["base", "head"]]);
    const result = classifyExact(deduplicated.findings, deduplicated.inputs, deduplicated.policy);
    assert.equal(result.kind, "classified");
    if (result.kind === "classified") {
      assert.deepEqual(
        result.notices.flatMap((notice) => notice.findings.map((finding) => finding.role)).sort(),
        ["base", "head"],
      );
    }
  }
});

test("exact reviewed attributions reject drift, duplicates, and mixed unknown findings", () => {
  const entry = exactCase("URI", "PLAIN");
  const base = exactFixture([entry]);
  const valid = base.findings[0]!;
  const inputFile = String(
    (valid.SourceMetadata as { Data: { Filesystem: { file: string } } }).Data.Filesystem.file,
  );
  const cases: Array<{
    name: string;
    expected: string;
    mutate: (
      finding: Record<string, unknown>,
      inputs: Map<string, StagedScanInput>,
      policy: ReviewedAttribution[],
    ) => Record<string, unknown>[];
  }> = [
    {
      name: "raw drift",
      expected: "literal_not_reviewed",
      mutate: (finding) => [{ ...finding, Raw: `${finding.Raw}changed` }],
    },
    {
      name: "RawV2 drift",
      expected: "literal_not_reviewed",
      mutate: (finding) => [{ ...finding, RawV2: `${finding.RawV2}changed` }],
    },
    {
      name: "wrong detector",
      expected: "finding_not_reviewed",
      mutate: (finding) => [{ ...finding, DetectorType: 895 }],
    },
    {
      name: "wrong name",
      expected: "finding_not_reviewed",
      mutate: (finding) => [{ ...finding, DetectorName: "Postgres" }],
    },
    {
      name: "wrong decoder",
      expected: "finding_not_reviewed",
      mutate: (finding) => [{ ...finding, DecoderName: "HTML" }],
    },
    {
      name: "lossy OTHER decoder",
      expected: "finding_not_reviewed",
      mutate: (finding) => [{ ...finding, DecoderName: "OTHER" }],
    },
    {
      name: "swapped hashes",
      expected: "literal_not_reviewed",
      mutate: (finding, _inputs, policy) => {
        const row = policy[0]!;
        policy[0] = [
          row[0],
          row[1],
          row[2],
          row[4],
          row[3],
          ...row.slice(5),
        ] as ReviewedAttribution;
        return [finding];
      },
    },
    {
      name: "wrong line",
      expected: "literal_mismatch",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          bytes: Buffer.from(`// context\n${entry.line} // changed\n`),
        });
        return [finding];
      },
    },
    {
      name: "wrong path",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [{ ...staged.references[0]!, source: "other.test.ts" }],
        });
        return [finding];
      },
    },
    {
      name: "wrong mode",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [{ ...staged.references[0]!, mode: "100755" }],
        });
        return [finding];
      },
    },
    {
      name: "index reference",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [{ ...staged.references[0]!, role: "index" }],
        });
        return [finding];
      },
    },
    {
      name: "tree reference",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [{ ...staged.references[0]!, role: "tree" }],
        });
        return [finding];
      },
    },
    {
      name: "worktree reference",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [{ ...staged.references[0]!, role: "worktree" }],
        });
        return [finding];
      },
    },
    {
      name: "mixed authorized and unauthorized references",
      expected: "source_not_reviewed",
      mutate: (finding, inputs) => {
        const staged = inputs.get(inputFile)!;
        inputs.set(inputFile, {
          ...staged,
          references: [...staged.references, { ...staged.references[0]!, role: "index" }],
        });
        return [finding];
      },
    },
    {
      name: "wrong metadata",
      expected: "metadata_mismatch",
      mutate: (finding) => [{ ...finding, SecretParts: { host: "mismatch" } }],
    },
    {
      name: "duplicate",
      expected: "duplicate_finding",
      mutate: (finding) => [finding, { ...finding }],
    },
    {
      name: "mixed unknown",
      expected: "literal_not_reviewed",
      mutate: (finding) => [finding, { ...finding, Raw: "unknown", RawV2: "unknown" }],
    },
  ];
  for (const scenario of cases) {
    const fixture = exactFixture([exactCase("URI", "PLAIN")]);
    const finding = structuredClone(fixture.findings[0]!);
    const inputs = new Map(fixture.inputs);
    const policy = [...fixture.policy];
    const result = classifyExact(scenario.mutate(finding, inputs, policy), inputs, policy);
    assert.equal(result.kind, "refused", scenario.name);
    if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding")
      assert.equal(result.diagnostic.reason, scenario.expected, scenario.name);
  }
});

test("exact refusal diagnostics retain the escaped-unicode decoder", () => {
  const fixture = exactFixture([exactCase("URI", "ESCAPED_UNICODE")], [["index"]]);
  const result = classifyExact(fixture.findings, fixture.inputs, fixture.policy);
  assert.equal(result.kind, "refused");
  if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding") {
    assert.equal(result.diagnostic.reason, "source_not_reviewed");
    assert.equal(result.diagnostic.decoder, "ESCAPED_UNICODE");
  }
});

test("exact attribution policy rejects duplicate and malformed rows", () => {
  const fixture = exactFixture([exactCase("URI", "PLAIN")]);
  const nativeFailure = classifyReviewedFixtureScan(0, Buffer.alloc(0), Buffer.alloc(0), new Map());
  assert.deepEqual(nativeFailure, {
    kind: "refused",
    reason: "scanner_failed",
    diagnostic: { kind: "native_contract", reason: "incomplete_scan" },
  });
  assert.throws(
    () =>
      classifyReviewedFixtureScan(0, Buffer.alloc(0), Buffer.alloc(0), new Map(), [
        ...fixture.policy,
        fixture.policy[0]!,
      ]),
    /duplicate reviewed attribution policy/,
  );
  const row = fixture.policy[0]!;
  assert.throws(
    () =>
      classifyReviewedFixtureScan(0, Buffer.alloc(0), Buffer.alloc(0), new Map(), [
        [895, row[1], row[2], ...row.slice(3)] as ReviewedAttribution,
      ]),
    /invalid reviewed attribution policy/,
  );
});

test("exact detector metadata contracts reject malformed MongoDB and Postgres findings", () => {
  const cases: Array<{
    detector: "MongoDB" | "Postgres";
    name: string;
    mutate: (finding: Record<string, unknown>, policy: ReviewedAttribution[]) => void;
  }> = [
    {
      detector: "MongoDB",
      name: "nonempty RawV2",
      mutate: (finding, policy) => {
        finding.RawV2 = String(finding.Raw);
        const row = policy[0]!;
        policy[0] = [
          ...row.slice(0, 4),
          createHash("sha256").update(String(finding.RawV2)).digest("hex"),
          ...row.slice(5),
        ] as ReviewedAttribution;
      },
    },
    {
      detector: "MongoDB",
      name: "wrong key",
      mutate: (finding) => {
        finding.SecretParts = { key: `${finding.Raw}changed` };
      },
    },
    {
      detector: "MongoDB",
      name: "wrong ExtraData shape",
      mutate: (finding) => {
        finding.ExtraData = {
          ...(finding.ExtraData as Record<string, string>),
          unexpected: "value",
        };
      },
    },
    {
      detector: "Postgres",
      name: "RawV2 differs",
      mutate: (finding, policy) => {
        finding.RawV2 = `${finding.Raw}changed`;
        const row = policy[0]!;
        policy[0] = [
          ...row.slice(0, 4),
          createHash("sha256").update(String(finding.RawV2)).digest("hex"),
          ...row.slice(5),
        ] as ReviewedAttribution;
      },
    },
    {
      detector: "Postgres",
      name: "wrong connection string",
      mutate: (finding) => {
        finding.SecretParts = { connection_string: `${finding.Raw}changed` };
      },
    },
    {
      detector: "Postgres",
      name: "wrong ExtraData shape",
      mutate: (finding) => {
        finding.ExtraData = {
          ...(finding.ExtraData as Record<string, string>),
          unexpected: "value",
        };
      },
    },
  ];
  for (const testCase of cases) {
    const fixture = exactFixture([exactCase(testCase.detector, "PLAIN")]);
    const finding = structuredClone(fixture.findings[0]!);
    const policy = [...fixture.policy];
    testCase.mutate(finding, policy);
    const result = classifyExact([finding], fixture.inputs, policy);
    assert.equal(result.kind, "refused", testCase.name);
    if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding")
      assert.equal(result.diagnostic.reason, "metadata_mismatch", testCase.name);
  }
});

for (const scenarioName of [
  "reviewed fixture",
  "browser local Chrome fixture",
  "browser remote Chrome fixture",
  "browser remote server fixture",
  "browser local server mismatch",
  "browser docs fixture",
  "browser docs relocated fixture",
  "browser docs relocated source mismatch",
  "browser docs relocated changed password",
  "browser page URL fixture",
  "firecrawl target URL fixture",
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
  ].flatMap((scenario) => [
    `mac dashboard ${scenario}`,
    `mcp apps ${scenario}`,
    `marketplace feed ${scenario}`,
    `gateway config ${scenario}`,
  ]),
  "marketplace feed query mutation",
  "gateway config query mutation",
  ...[
    "reviewed fixture",
    "HTML repeated literal",
    "changed raw",
    "changed full URI",
    "changed matching raw values",
    "other file",
    "executable source",
    "prompt",
    "schema",
    "additional",
    "diff",
    "decoded only",
    "verified",
    "mixed findings",
    "wrong detector",
    "wrong source type",
    "wrong decoder",
    "wrong secret parts",
    "missing verification error",
    "wrong version",
    "missing completion",
  ].map((scenario) => `browser profiles ${scenario}`),
]) {
  const browserProfilesFixture = scenarioName.startsWith("browser profiles ");
  const macDashboardFixture = scenarioName.startsWith("mac dashboard ");
  const mcpAppsFixture = scenarioName.startsWith("mcp apps ");
  const marketplaceFeedFixture = scenarioName.startsWith("marketplace feed ");
  const gatewayConfigFixture = scenarioName.startsWith("gateway config ");
  const scenario = scenarioName.replace(
    /^(?:mac dashboard|mcp apps|marketplace feed|gateway config|browser profiles) /,
    "",
  );
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
    const firecrawlFixture = scenario === "firecrawl target URL fixture";
    const encodedCdpFixture = browserCdpFixture && scenario.includes("encoded");
    // Preserve the literal witnesses captured from the native OpenClaw scan.
    const literalLine = gatewayConfigFixture
      ? 866
      : marketplaceFeedFixture
        ? 342
        : mcpAppsFixture
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
      : scenario === "browser CDP encoded HTML fixture" ||
          scenario === "unreviewed HTML" ||
          (browserProfilesFixture && scenario === "HTML repeated literal")
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
      if (scenario === "browser docs relocated changed password") url.password += "changed";
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
    if (firecrawlFixture) {
      const url = new URL("http://127.0.0.1");
      url.username = "user";
      url.password = "pass";
      uri = url.href.slice(0, -1);
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
    if (marketplaceFeedFixture) {
      // Native 3.97.1 witness from OpenClaw base blob 0515b909, line 342.
      const url = new URL("https://packages.acme.example/openclaw/feed");
      url.username = "user";
      url.password = "secret";
      uri = url.href;
    }
    if (gatewayConfigFixture) {
      // Native 3.97.1 witness from OpenClaw base blob 57d0322c, line 866.
      const url = new URL("https://chrome.remote.example.com");
      url.username = "alice";
      url.password = "secret";
      uri = url.href.slice(0, -1);
    }
    if (browserProfilesFixture) {
      const url = new URL("http://127.0.0.1:9222");
      url.username = "openclaw";
      url.password = "relay-token";
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
      macDashboardFixture ||
      marketplaceFeedFixture ||
      browserPageFixture ||
      browserExactFixture ||
      mattermostFixture
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
                  ? scenario === "browser docs relocated source mismatch"
                    ? "docs/tools/browser/other.md"
                    : scenario.endsWith("source mismatch")
                      ? browserToolSource
                      : scenario.startsWith("browser docs relocated")
                        ? browserRemoteDocsSource
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
    if (marketplaceFeedFixture)
      files = [scenario === "other file" ? "other.test.ts" : marketplaceFeedSource];
    if (gatewayConfigFixture)
      files = [scenario === "other file" ? "other.test.ts" : gatewayConfigSource];
    if (browserProfilesFixture)
      files = [scenario === "other file" ? "other.test.ts" : browserProfilesSource];
    if (firecrawlFixture) files = [firecrawlSource];
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
    const reviewedMarketplaceFeedLine = marketplaceFeedFixture
      ? scenario === "unapproved line"
        ? JSON.stringify(value)
        : `        url: ${JSON.stringify(`${value}?token=leak#frag${scenario === "query mutation" ? "changed" : ""}`)},`
      : undefined;
    const reviewedGatewayConfigLine = gatewayConfigFixture
      ? scenario === "unapproved line"
        ? JSON.stringify(value)
        : `              cdpUrl: ${JSON.stringify(`${value}?token=profile-secret${scenario === "query mutation" ? "changed" : ""}`)},`
      : undefined;
    const reviewedFixtureLine = mcpAppsFixture
      ? scenario === "unapproved line"
        ? JSON.stringify(value)
        : `      ${JSON.stringify(value)},`
      : (reviewedGatewayConfigLine ??
        reviewedMarketplaceFeedLine ??
        reviewedMacDashboardLine ??
        reviewedBrowserLine ??
        reviewedMattermostLine);
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
  level:'info-0', logger:'trufflehog', msg:'finished scanning', trufflehog_version:scenario === 'wrong version' ? 'changed' : '3.97.4',
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
        "HTML repeated literal",
        "browser local Chrome fixture",
        "browser remote Chrome fixture",
        "browser remote server fixture",
        "browser docs fixture",
        "browser docs relocated fixture",
        "browser page URL fixture",
        "firecrawl target URL fixture",
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
            if (scenario.startsWith("browser docs relocated")) {
              assert.equal(
                diagnostic.reason,
                scenario.endsWith("source mismatch")
                  ? "source_not_reviewed"
                  : "literal_not_reviewed",
              );
            }
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
                assert.equal(
                  diagnostic.material.references[0].role,
                  diagnostic.material.references[0].revision === baseSha ? "base" : "head",
                );
              } else if (kind === "worktree") {
                assert.equal(diagnostic.material.references[0].revision, headSha);
                assert.equal(diagnostic.material.references[0].role, "worktree");
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

function contextPatchFixture(
  entry: ExactCase,
  options: {
    source?: string;
    beforeTail?: string;
    afterTail?: string;
    crlf?: boolean;
    finalNewline?: boolean;
  } = {},
) {
  const source = options.source ?? exactSource;
  const beforeTail = options.beforeTail ?? "const version = 1;";
  const afterTail = options.afterTail ?? "const version = 2;";
  const ending = options.crlf ? "\r\n" : "\n";
  const before = Buffer.from(
    ["// context", entry.line, beforeTail].join(ending) +
      (options.finalNewline === false ? "" : ending),
  );
  const after = Buffer.from(
    ["// context", entry.line, afterTail].join(ending) +
      (options.finalNewline === false ? "" : ending),
  );
  const oid = (bytes: Buffer) =>
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const from = "a".repeat(40);
  const to = "b".repeat(40);
  const beforeId = oid(before);
  const afterId = oid(after);
  const suffix = options.crlf ? "\r" : "";
  const patch = [
    `diff --git a/${source} b/${source}`,
    `index ${beforeId}..${afterId} 100644`,
    `--- a/${source}`,
    `+++ b/${source}`,
    "@@ -1,3 +1,3 @@",
    ` // context${suffix}`,
    ` ${entry.line}${suffix}`,
    `-${beforeTail}${options.finalNewline === false ? "" : suffix}`,
    ...(options.finalNewline === false ? ["\\ No newline at end of file"] : []),
    `+${afterTail}${options.finalNewline === false ? "" : suffix}`,
    ...(options.finalNewline === false ? ["\\ No newline at end of file"] : []),
    "",
  ].join("\n");
  const file = "/private/scanner/patch";
  const finding = {
    ...exactFixture([entry]).findings[0]!,
    SourceMetadata: { Data: { Filesystem: { file, line: 7 } } },
  };
  const inputs = new Map<string, StagedScanInput>([
    [file, { kind: "patch", id: "patch", bytes: Buffer.from(patch), from, to }],
    [
      `/private/scanner/${beforeId}`,
      {
        kind: "blob",
        id: beforeId,
        bytes: before,
        references: [{ source, mode: "100644", revision: from, role: "base" }],
      },
    ],
    [
      `/private/scanner/${afterId}`,
      {
        kind: "blob",
        id: afterId,
        bytes: after,
        references: [{ source, mode: "100644", revision: to, role: "head" }],
      },
    ],
  ]);
  return { finding, inputs, patch, beforeId, afterId, file };
}

test("marketplace refresh keeps legacy context and duplicate-record admission", () => {
  const value = contextPatchFixture(marketplaceTelemetryCase(false), {
    source: marketplaceFeedSource,
  });
  const result = classifyWithProductionPolicy([value.finding, value.finding], value.inputs);
  assert.equal(result.kind, "classified");
  if (result.kind === "classified") {
    assert.deepEqual(
      result.notices.flatMap((notice) => notice.findings.map((finding) => finding.occurrences)),
      [2, 2],
    );
  }
});

test("approved URI findings in unchanged patch context require both exact Git witnesses", () => {
  const entry = exactCase("URI", "PLAIN");
  const policy = exactFixture([entry]).policy;
  const fixture = contextPatchFixture(entry);
  const classify = (inputs = fixture.inputs, findings = [fixture.finding]) =>
    classifyExact(findings, inputs, policy);
  const accepted = classify();
  assert.equal(accepted.kind, "classified");
  if (accepted.kind === "classified") {
    const witnesses = accepted.notices.flatMap((notice) => notice.findings);
    assert.equal(witnesses.length, 2);
    assert.ok(witnesses.every((witness) => witness.blob === "patch" && witness.literalLine === 7));
    assert.deepEqual(
      witnesses.map((witness) => witness.patch?.sourceBlob).sort(),
      [fixture.beforeId, fixture.afterId].sort(),
    );
  }
  // Decoder coordinates may shift; independently prove every literal occurrence.
  assert.equal(
    classify(fixture.inputs, [
      {
        ...fixture.finding,
        SourceMetadata: { Data: { Filesystem: { file: fixture.file, line: 99 } } },
      },
    ]).kind,
    "classified",
  );
  const duplicate = classify(fixture.inputs, [fixture.finding, fixture.finding]);
  assert.equal(duplicate.kind, "refused");
  if (duplicate.kind === "refused") assert.equal(duplicate.diagnostic.reason, "duplicate_finding");
  for (const [name, mutate] of [
    [
      "header occurrence",
      (text: string) => text.replace("@@ -1,3 +1,3 @@", `@@ -1,3 +1,3 @@ ${entry.rawV2}`),
    ],
    ["wrong coordinates", (text: string) => text.replace("@@ -1,3 +1,3 @@", "@@ -2,3 +1,3 @@")],
    ["unfinished hunk", (text: string) => text.replace("@@ -1,3 +1,3 @@", "@@ -1,4 +1,3 @@")],
    [
      "invented trailing blank context",
      (text: string) => text.replace("@@ -1,3 +1,3 @@", "@@ -1,4 +1,4 @@") + " \n",
    ],
    ["wrong path", (text: string) => text.replace(`+++ b/${exactSource}`, "+++ b/another.test.ts")],
    ["wrong mode", (text: string) => text.replace(" 100644\n", " 100755\n")],
    ["wrong object", (text: string) => text.replace(fixture.beforeId, "c".repeat(40))],
    ["encoded-only content", (text: string) => text.replace(entry.rawV2, "encoded fixture")],
  ] as const) {
    const inputs = new Map(fixture.inputs);
    inputs.set(fixture.file, {
      ...inputs.get(fixture.file)!,
      bytes: Buffer.from(mutate(fixture.patch)),
    });
    const result = classify(inputs);
    assert.equal(result.kind, "refused", name);
    if (result.kind === "refused" && result.diagnostic.kind === "unclassified_finding")
      assert.equal(result.diagnostic.material?.kind, "patch", name);
  }
  for (const name of [
    "changed bytes",
    "mixed source references",
    "wrong role",
    "wrong revision",
    "missing blob",
  ] as const) {
    const inputs = new Map(fixture.inputs);
    const key = `/private/scanner/${fixture.afterId}`;
    const input = inputs.get(key)!;
    if (input.kind !== "blob") throw new Error("expected blob fixture");
    if (name === "missing blob") inputs.delete(key);
    else if (name === "changed bytes")
      inputs.set(key, { ...input, bytes: Buffer.from("different bytes\n") });
    else
      inputs.set(key, {
        ...input,
        references:
          name === "mixed source references"
            ? [...input.references, { ...input.references[0]!, source: "another.test.ts" }]
            : input.references.map((reference) => ({
                ...reference,
                ...(name === "wrong role"
                  ? { role: "worktree" as const }
                  : { revision: "c".repeat(40) }),
              })),
      });
    assert.equal(classify(inputs).kind, "refused", name);
  }
  assert.equal(classify(fixture.inputs, [{ ...fixture.finding, Verified: true }]).kind, "refused");
  assert.equal(
    classify(fixture.inputs, [{ ...fixture.finding, DecoderName: "BASE64" }]).kind,
    "refused",
  );
});

test("patch admission keeps legacy duplicate records and rejects coherent non-context occurrences", () => {
  const username = "openclaw";
  const password = "relay-token";
  const url = new URL("http://127.0.0.1:9222");
  url.username = username;
  url.password = password;
  const raw = url.href.slice(0, -1);
  const entry: ExactCase = {
    detectorType: 17,
    detectorName: "URI",
    decoder: "PLAIN",
    raw,
    rawV2: raw,
    line: `const fixture = ${JSON.stringify(raw)};`,
    secretParts: { host: url.host, username, password },
    extraData: null,
  };
  const fixture = contextPatchFixture(entry, { source: browserProfilesSource });
  const classify = (value: ReturnType<typeof contextPatchFixture>, findings = [value.finding]) =>
    classifyWithProductionPolicy(findings, value.inputs);
  for (const options of [{}, { crlf: true }, { finalNewline: false }]) {
    const value = contextPatchFixture(entry, { source: browserProfilesSource, ...options });
    assert.equal(classify(value).kind, "classified");
  }
  const records = [fixture.finding, { ...fixture.finding, DecoderName: "HTML" }, fixture.finding];
  const accepted = classify(fixture, records);
  assert.equal(accepted.kind, "classified");
  if (accepted.kind === "classified") {
    const findings = accepted.notices.flatMap((notice) => notice.findings);
    assert.equal(findings.length, 4);
    assert.deepEqual(
      findings
        .filter((finding) => finding.decoder === "PLAIN")
        .map((finding) => finding.occurrences),
      [2, 2],
    );
    assert.deepEqual(
      findings
        .filter((finding) => finding.decoder === "HTML")
        .map((finding) => finding.occurrences),
      [1, 1],
    );
  }
  for (const [name, options] of [
    ["added occurrence", { afterTail: entry.line, source: browserProfilesSource }],
    ["removed occurrence", { beforeTail: entry.line, source: browserProfilesSource }],
    ["unapproved source", { source: "another.test.ts" }],
  ] as const) {
    const coherent = contextPatchFixture(entry, options);
    // Every source byte, OID and hunk coordinate agrees; only the admission contract fails.
    const result = classify(coherent);
    assert.equal(result.kind, "refused", name);
    if (result.kind === "refused")
      assert.equal(
        result.diagnostic.reason,
        name === "unapproved source" ? "source_not_reviewed" : "material_not_reviewed",
        name,
      );
  }
});

function changedPatchFixture(
  t: test.TestContext,
  entry: ExactCase,
  change: "add" | "remove" | "new" | "delete",
  finalNewline = true,
  content?: { before?: string; after?: string; context?: number; source?: string },
) {
  const repo = fixture(t);
  const source = content?.source ?? exactSource;
  const target = join(repo.cwd, source);
  const before =
    change === "new"
      ? undefined
      : Buffer.from(
          content?.before ??
            `// before\n${change === "add" ? "" : entry.line + (finalNewline ? "\n" : "")}`,
        );
  const after =
    change === "delete"
      ? undefined
      : Buffer.from(
          content?.after ??
            `// after\n${change === "remove" ? "" : entry.line + (finalNewline ? "\n" : "")}`,
        );
  writeFileSync(join(repo.cwd, "anchor.txt"), "unchanged\n");
  mkdirSync(dirname(target), { recursive: true });
  if (before) writeFileSync(target, before);
  const from = repo.commit();
  if (after) writeFileSync(target, after);
  else rmSync(target);
  const to = repo.commit();
  const diff = (...args: string[]) =>
    execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", ...args, from, to, "--"],
      { cwd: repo.cwd },
    );
  const file = "/private/scanner/patch";
  const rawFile = "/private/scanner/raw";
  const patch = diff(
    "--patch",
    "--binary",
    "--full-index",
    ...(content?.context === undefined ? [] : [`--unified=${content.context}`]),
  );
  const inputs = new Map<string, StagedScanInput>([
    [file, { kind: "patch", id: "patch", bytes: patch, from, to }],
    [rawFile, { kind: "raw_diff", id: "raw", bytes: diff("--raw", "--no-abbrev", "-z"), from, to }],
  ]);
  for (const [bytes, revision, role] of [
    [before, from, "base"],
    [after, to, "head"],
  ] as const) {
    if (!bytes) continue;
    const id = repo.git("rev-parse", `${revision}:${source}`);
    inputs.set(`/private/scanner/${id}`, {
      kind: "blob",
      id,
      bytes,
      references: [{ source, mode: "100644", revision, role }],
    });
  }
  const finding = {
    ...exactFixture([entry]).findings[0]!,
    SourceMetadata: {
      Data: {
        Filesystem: {
          file,
          line:
            patch
              .toString()
              .split("\n")
              .findIndex((line) => line.includes(entry.rawV2)) + 1,
        },
      },
    },
  };
  return { inputs, finding, file, rawFile, from, to, source };
}

for (const change of ["add", "remove", "new", "delete"] as const) {
  test(`marketplace refresh still refuses ${change} beside an exact entries patch`, (t) => {
    const refresh = changedPatchFixture(t, marketplaceTelemetryCase(false), change, true, {
      source: marketplaceFeedSource,
    });
    const entries = changedPatchFixture(t, marketplaceTelemetryCase(true), change, true, {
      source: "src/cli/plugins-cli.marketplace-entries.test.ts",
    });
    assert.equal(
      classifyWithProductionPolicy([entries.finding], entries.inputs).kind,
      "classified",
    );
    assert.equal(classifyWithProductionPolicy([refresh.finding], refresh.inputs).kind, "refused");
    // Both coherent file diffs share one staged revision pair, as a multi-file scan does.
    const combine = (refreshInputs: Map<string, StagedScanInput>) => {
      const inputs = new Map<string, StagedScanInput>();
      for (const sourceInputs of [entries.inputs, refreshInputs]) {
        for (const [file, input] of sourceInputs) {
          if (input.kind === "blob") {
            const previous = inputs.get(file);
            if (previous?.kind === "blob") assert.deepEqual(previous.bytes, input.bytes);
            inputs.set(file, {
              ...input,
              references: [
                ...(previous?.kind === "blob" ? previous.references : []),
                ...input.references.map((reference) => ({
                  ...reference,
                  revision: reference.role === "base" ? "a".repeat(40) : "b".repeat(40),
                })),
              ],
            });
          } else if (input.kind === "patch" || input.kind === "raw_diff") {
            inputs.set(file, {
              ...input,
              from: "a".repeat(40),
              to: "b".repeat(40),
              bytes: Buffer.concat([inputs.get(file)?.bytes ?? Buffer.alloc(0), input.bytes!]),
            });
          }
        }
      }
      return inputs;
    };
    const context = contextPatchFixture(marketplaceTelemetryCase(false), {
      source: marketplaceFeedSource,
    });
    assert.equal(
      classifyWithProductionPolicy([entries.finding], combine(context.inputs)).kind,
      "classified",
    );
    const refused = classifyWithProductionPolicy([entries.finding], combine(refresh.inputs));
    assert.equal(refused.kind, "refused");
    if (refused.kind === "refused")
      assert.equal(refused.diagnostic.reason, "material_not_reviewed");
  });
}

for (const change of ["add", "remove", "new", "delete"] as const) {
  test(`exact reviewed patch fixtures qualify ${change} with committed Git witnesses`, (t) => {
    const entry = exactCase("URI", "PLAIN");
    const policy = exactFixture([entry]).policy;
    for (const finalNewline of [true, false]) {
      const f = changedPatchFixture(t, entry, change, finalNewline);
      const result = classifyExact([f.finding], f.inputs, policy);
      assert.equal(result.kind, "classified", `${change}/${finalNewline}`);
      if (result.kind === "classified") {
        const findings = result.notices.flatMap((notice) => notice.findings);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]!.role, change === "add" || change === "new" ? "head" : "base");
        assert.equal(findings[0]!.patch?.sourceLine, 2);
      }
    }
  });
}

for (const change of ["new", "delete"] as const) {
  test(`exact reviewed ${change} fixtures require unambiguous raw endpoint evidence`, (t) => {
    const entry = exactCase("URI", "PLAIN");
    const policy = exactFixture([entry]).policy;
    const f = changedPatchFixture(t, entry, change);
    const raw = f.inputs.get(f.rawFile)!;
    const text = raw.bytes!.toString();
    const classify = (inputs: Map<string, StagedScanInput>) =>
      classifyExact([f.finding], inputs, policy);
    for (const [name, mutate] of [
      ["wrong path", (value: string) => value.replace(f.source, "another.test.ts")],
      ["wrong status", (value: string) => value.replace(/ [AD]\0/, " M\0")],
      ["wrong mode", (value: string) => value.replace("100644", "100755")],
      ["invented endpoint", (value: string) => value.replace("0".repeat(40), "c".repeat(40))],
      ["duplicate record", (value: string) => value + value],
      ["incomplete record", (value: string) => value.slice(0, -1)],
    ] as const) {
      const inputs = new Map(f.inputs);
      inputs.set(f.rawFile, { ...raw, bytes: Buffer.from(mutate(text)) });
      assert.equal(classify(inputs).kind, "refused", name);
    }
    for (const name of [
      "missing raw",
      "wrong revision",
      "duplicate raw",
      "contrary endpoint",
    ] as const) {
      const inputs = new Map(f.inputs);
      if (name === "missing raw") inputs.delete(f.rawFile);
      else if (name === "wrong revision") {
        if (raw.kind !== "raw_diff") throw new Error("expected raw diff");
        inputs.set(f.rawFile, { ...raw, from: "c".repeat(40) });
      } else if (name === "duplicate raw") inputs.set(`${f.rawFile}-duplicate`, raw);
      else {
        const blob = [...inputs.values()].find((input) => input.kind === "blob")!;
        if (blob.kind !== "blob") throw new Error("expected blob");
        inputs.set("/private/scanner/contrary", {
          ...blob,
          id: "c".repeat(40),
          references: [
            {
              source: f.source,
              mode: "100644",
              revision: change === "new" ? f.from : f.to,
              role: change === "new" ? "base" : "head",
            },
          ],
        });
      }
      assert.equal(classify(inputs).kind, "refused", name);
    }
  });
}

test("changed fixture admission rejects malformed patches and unreviewed source evidence", (t) => {
  const entry = exactCase("URI", "PLAIN");
  const policy = exactFixture([entry]).policy;
  for (const change of ["add", "remove", "new", "delete"] as const) {
    const f = changedPatchFixture(t, entry, change, false);
    const patch = f.inputs.get(f.file)!;
    const text = patch.bytes!.toString();
    for (const [name, mutate] of [
      ["wrong counts", (value: string) => value.replace(/(@@ -\d+)(?:,\d+)?/, "$1,99")],
      ["wrong coordinates", (value: string) => value.replace(/@@ -\d+/, "@@ -99")],
      [
        "missing newline marker",
        (value: string) => value.replaceAll("\\ No newline at end of file\n", ""),
      ],
      ["extra newline marker", (value: string) => value + "\\ No newline at end of file\n"],
      [
        "truncated present file",
        (value: string) => value.replace(/^[-+]\/\/ (before|after)\n/m, ""),
      ],
      ["wrong header mode", (value: string) => value.replace("100644", "100755")],
      ["wrong object", (value: string) => value.replace(/[a-f0-9]{40}/, "c".repeat(40))],
      ["ambiguous path", (value: string) => value.replace(`b/${f.source}`, "b/another.test.ts")],
      ["encoded-only match", (value: string) => value.replace(entry.rawV2, "encoded fixture")],
    ] as const) {
      const inputs = new Map(f.inputs);
      inputs.set(f.file, { ...patch, bytes: Buffer.from(mutate(text)) });
      assert.equal(
        classifyExact([f.finding], inputs, policy).kind,
        "refused",
        `${change}: ${name}`,
      );
    }
    const [key, blob] = [...f.inputs].find(
      ([, input]) => input.kind === "blob" && input.bytes?.includes(entry.rawV2),
    )!;
    if (blob.kind !== "blob") throw new Error("expected blob");
    for (const name of [
      "missing blob",
      "changed bytes",
      "wrong role",
      "wrong revision",
      "wrong mode",
      "unreviewed alias",
    ] as const) {
      const inputs = new Map(f.inputs);
      if (name === "missing blob") inputs.delete(key);
      else if (name === "changed bytes")
        inputs.set(key, { ...blob, bytes: Buffer.from("other bytes\n") });
      else
        inputs.set(key, {
          ...blob,
          references:
            name === "unreviewed alias"
              ? [...blob.references, { ...blob.references[0]!, source: "another.test.ts" }]
              : blob.references.map((reference) => ({
                  ...reference,
                  ...(name === "wrong role"
                    ? { role: "index" as const }
                    : name === "wrong revision"
                      ? { revision: "c".repeat(40) }
                      : { mode: "100755" }),
                })),
        });
      assert.equal(
        classifyExact([f.finding], inputs, policy).kind,
        "refused",
        `${change}: ${name}`,
      );
    }
    for (const finding of [
      { ...f.finding, Verified: true },
      { ...f.finding, DecoderName: "BASE64" },
      { ...f.finding, SecretParts: { ...entry.secretParts, username: "other-user" } },
      { ...f.finding, DetectorType: 9999 },
    ])
      assert.equal(classifyExact([finding], f.inputs, policy).kind, "refused");
    assert.equal(
      classifyExact([f.finding, { ...f.finding, Verified: true }], f.inputs, policy).kind,
      "refused",
      "mixed verified findings",
    );
  }
  for (const [name, line] of [
    ["changed full line", `// different ${entry.line}`],
    ["additional query", entry.line.replace("/path", "/path?extra=value")],
    ["duplicate occurrence", `${entry.line}\n${entry.line}`],
  ]) {
    // The patch and both Git endpoints remain coherent; only the reviewed
    // whole-line witness fails, including occurrences elsewhere in the blob.
    const f = changedPatchFixture(t, { ...entry, line: line! }, "add");
    assert.equal(classifyExact([f.finding], f.inputs, policy).kind, "refused", name);
  }
});

test("modified-file fixture hunks validate empty-side coordinates", (t) => {
  const entry = exactCase("URI", "PLAIN");
  const policy = exactFixture([entry]).policy;
  for (const change of ["add", "remove"] as const) {
    for (const finalNewline of [true, false]) {
      const text = entry.line + (finalNewline ? "\n" : "");
      const f = changedPatchFixture(t, entry, change, finalNewline, {
        before: change === "add" ? "" : text,
        after: change === "remove" ? "" : text,
      });
      assert.equal(classifyExact([f.finding], f.inputs, policy).kind, "classified");
      const patch = f.inputs.get(f.file)!;
      const inputs = new Map(f.inputs);
      inputs.set(f.file, {
        ...patch,
        bytes: Buffer.from(
          patch
            .bytes!.toString()
            .replace(change === "add" ? "-0,0" : "+0,0", change === "add" ? "-99,0" : "+99,0"),
        ),
      });
      assert.equal(
        classifyExact([f.finding], inputs, policy).kind,
        "refused",
        `${change}/${finalNewline}`,
      );
    }
  }
});

test("modified-file fixture hunks stay ordered and do not overlap", (t) => {
  const entry = exactCase("URI", "PLAIN");
  const policy = exactFixture([entry]).policy;
  const middle = Array.from({ length: 20 }, (_, i) => `// unchanged ${i}`).join("\n");
  const f = changedPatchFixture(t, entry, "add", true, {
    before: `// before\n${middle}\n// old end\n`,
    after: `${entry.line}\n${middle}\n// new end\n// added tail\n`,
  });
  assert.equal(classifyExact([f.finding], f.inputs, policy).kind, "classified");
  const patch = f.inputs.get(f.file)!;
  const parts = patch.bytes!.toString().split(/(?=^@@ )/m);
  assert.equal(parts.length, 3, "Git emitted two separated hunks");
  for (const [name, text] of [
    ["reverse order", parts[0]! + parts[2]! + parts[1]!],
    ["overlapping hunk", parts[0]! + parts[1]! + parts[1]! + parts[2]!],
    ["omitted final hunk", parts[0]! + parts[1]!],
  ]) {
    const inputs = new Map(f.inputs);
    inputs.set(f.file, { ...patch, bytes: Buffer.from(text!) });
    assert.equal(classifyExact([f.finding], inputs, policy).kind, "refused", name);
  }
});

test("zero-context fixture hunks bind the same insertion boundary in both blobs", (t) => {
  const entry = exactCase("URI", "PLAIN");
  const policy = exactFixture([entry]).policy;
  const unchanged = ["// first", "// last"];
  for (const change of ["add", "remove"] as const) {
    for (const position of [0, 1, 2]) {
      const changed = [...unchanged];
      changed.splice(position, 0, entry.line);
      const f = changedPatchFixture(t, entry, change, true, {
        before: (change === "add" ? unchanged : changed).join("\n") + "\n",
        after: (change === "remove" ? unchanged : changed).join("\n") + "\n",
        context: 0,
      });
      assert.equal(
        classifyExact([f.finding], f.inputs, policy).kind,
        "classified",
        `${change}/${position}`,
      );
      const patch = f.inputs.get(f.file)!;
      const side = change === "add" ? "-" : "+";
      const inputs = new Map(f.inputs);
      inputs.set(f.file, {
        ...patch,
        bytes: Buffer.from(
          patch.bytes!.toString().replace(`${side}${position},0`, `${side}${(position + 1) % 3},0`),
        ),
      });
      assert.equal(
        classifyExact([f.finding], inputs, policy).kind,
        "refused",
        `${change}/${position}: shifted boundary`,
      );
    }
  }
});

test("browser status-redaction qualification preserves exact fixture boundaries", () => {
  const username = "openclaw";
  const password = "relay-token";
  const host = "127.0.0.1:18800";
  const raw = `http://${username}:${password}@${host}`;
  const line = `        cdpUrl: "${raw}",`;
  const entry: ExactCase = {
    detectorType: 17,
    detectorName: "URI",
    decoder: "PLAIN",
    raw,
    rawV2: raw,
    line,
    secretParts: { host, username, password },
    extraData: null,
  };
  for (const role of ["base", "head"] as const) {
    const fixture = exactFixture([entry], [[role]]);
    const file = fixture.inputs.keys().next().value!;
    const input = fixture.inputs.get(file)!;
    if (input.kind !== "blob") throw new Error("expected blob fixture");
    const scoped = {
      ...input,
      references: input.references.map((reference) => ({
        ...reference,
        source: "extensions/browser/src/browser/routes/basic.existing-session.test.ts",
      })),
    };
    const finding = fixture.findings[0]!;
    const classify = (value: StagedScanInput, record = finding) =>
      classifyWithProductionPolicy([record], new Map([[file, value]]));
    assert.equal(classify(scoped).kind, "classified", role);
    for (const [name, changed] of [
      ["line drift", { ...scoped, bytes: Buffer.from(`${line.replace("cdpUrl", "otherUrl")}\n`) }],
      ["duplicate literal", { ...scoped, bytes: Buffer.from(`${line}\n${line}\n`) }],
      [
        "uncommitted",
        {
          ...scoped,
          references: scoped.references.map((reference) => ({
            ...reference,
            role: "worktree" as const,
          })),
        },
      ],
      ["wrong source", input],
      ["mixed source", { ...scoped, references: [...scoped.references, ...input.references] }],
    ] as const)
      assert.equal(classify(changed).kind, "refused", `${role}: ${name}`);
    assert.equal(classify(scoped, { ...finding, Verified: true }).kind, "refused");
    assert.equal(classify(scoped, { ...finding, DecoderName: "HTML" }).kind, "refused");
    assert.equal(classify(scoped, { ...finding, RawV2: `${raw}/different` }).kind, "refused");
    assert.equal(
      classifyWithProductionPolicy(
        [finding, { ...finding, Raw: "unknown", RawV2: "unknown" }],
        new Map([[file, scoped]]),
      ).kind,
      "refused",
    );
  }
});

test("create-profile redaction qualification binds the full line and observed native decoders", () => {
  const username = "browser-user";
  const password = "browser-password";
  const url = new URL("http://127.0.0.1:9222/");
  url.username = username;
  url.password = password;
  url.searchParams.set("token", "browser-token");
  const line = `    const cdpUrl = "${url.href}";`;
  const raw = `${url.protocol}//${username}:${password}@${url.host}`;
  const entry: ExactCase = {
    detectorType: 17,
    detectorName: "URI",
    decoder: "PLAIN",
    raw,
    rawV2: raw,
    line,
    secretParts: { host: url.host, username, password },
    extraData: null,
  };
  const fixture = exactFixture([entry]);
  const file = fixture.inputs.keys().next().value!;
  const input = fixture.inputs.get(file)!;
  if (input.kind !== "blob") throw new Error("expected blob fixture");
  const scoped = {
    ...input,
    references: input.references.map((reference) => ({
      ...reference,
      source: "extensions/browser/src/browser/profiles-service.test.ts",
    })),
  };
  for (const decoder of ["PLAIN", "HTML"]) {
    const finding = { ...fixture.findings[0]!, DecoderName: decoder };
    const classify = (value: StagedScanInput, record = finding) =>
      classifyWithProductionPolicy([record], new Map([[file, value]]));
    assert.equal(classify(scoped).kind, "classified", decoder);
    for (const [name, changed] of [
      [
        "query drift",
        { ...scoped, bytes: Buffer.from(`${line.replace("?token=", "?changed=")}\n`) },
      ],
      ["duplicate literal", { ...scoped, bytes: Buffer.from(`${line}\n${line}\n`) }],
      [
        "uncommitted",
        {
          ...scoped,
          references: scoped.references.map((reference) => ({
            ...reference,
            role: "worktree" as const,
          })),
        },
      ],
      ["wrong source", input],
    ] as const)
      assert.equal(classify(changed).kind, "refused", `${decoder}: ${name}`);
    assert.equal(classify(scoped, { ...finding, Verified: true }).kind, "refused");
    assert.equal(classify(scoped, { ...finding, DecoderName: "BASE64" }).kind, "refused");
  }
});

for (const {
  name,
  protocol,
  host,
  suffix,
  path = "/json/version",
  username = "user",
  password = "pass",
  source = "extensions/browser/src/browser/config.test.ts",
  lines,
} of [
  {
    name: "explicit HTTPS default port",
    protocol: "https:",
    host: "remote-browser.example.com:443",
    suffix: "?token=abc#frag",
    lines: (value: string) => [`            cdpUrl: "${value}",`, `        "${value}",`],
  },
  {
    name: "userinfo without a port",
    protocol: "http:",
    host: "127.0.0.1",
    suffix: "",
    lines: (value: string) => [`            cdpUrl: "${value}",`],
  },
  {
    name: "configured port insertion",
    protocol: "http:",
    host: "127.0.0.1:18800",
    suffix: "",
    lines: (value: string) => [`      expect(profile?.cdpUrl).toBe("${value}");`],
  },
  {
    name: "plugin setting draft redaction",
    protocol: "https:",
    host: "example.invalid",
    username: "fixture-user",
    password: "fixture-password",
    path: "",
    suffix: "/",
    source: "ui/src/pages/custodian/custodian-session-store.test.ts",
    lines: (value: string) => [`      "${value}",`, `      { "${value}": "route" },`],
  },
  {
    name: "plugin help unsaved credential redaction",
    protocol: "https:",
    host: "example.invalid",
    username: "fixture-user",
    password: "fixture-password",
    path: "",
    suffix: "/?token=fixture-token",
    source: "ui/src/e2e/plugins-help.e2e.test.ts",
    lines: (value: string) => [`          "${value}";`],
  },
]) {
  test(`reviewed URI fixture qualification preserves ${name}`, () => {
    const raw = `${protocol}//${username}:${password}@${host}`;
    const rawV2 = `${raw}${path}`;
    const sourceLines = lines(`${rawV2}${suffix}`);
    const fixture = exactFixture([
      {
        detectorType: 17,
        detectorName: "URI",
        decoder: "PLAIN",
        raw,
        rawV2,
        line: sourceLines[0]!,
        secretParts: { host, username, password },
        extraData: null,
      },
    ]);
    const file = fixture.inputs.keys().next().value!;
    const input = fixture.inputs.get(file)!;
    if (input.kind !== "blob") throw new Error("expected blob fixture");
    for (const role of ["base", "head"] as const) {
      const scoped = {
        ...input,
        bytes: Buffer.from(`${sourceLines.join("\n")}\n`),
        references: input.references.map((reference) => ({
          ...reference,
          role,
          source,
        })),
      };
      for (const decoder of ["PLAIN", "HTML"]) {
        const finding = { ...fixture.findings[0]!, DecoderName: decoder };
        const classify = (value: StagedScanInput, record = finding) =>
          classifyWithProductionPolicy([record], new Map([[file, value]]));
        assert.equal(classify(scoped).kind, "classified", `${role}/${decoder}`);
        for (const changedLines of [
          [...sourceLines, sourceLines[0]!],
          sourceLines.slice(1),
          sourceLines.map((line) => `${line} // changed`),
          sourceLines.map((line) => line.replace(rawV2, `${rawV2}?changed`)),
          ...(sourceLines.length > 1
            ? [[...sourceLines].reverse(), [sourceLines[0]!, sourceLines[0]!]]
            : []),
        ]) {
          assert.equal(
            classify({ ...scoped, bytes: Buffer.from(`${changedLines.join("\n")}\n`) }).kind,
            "refused",
          );
        }
        for (const update of [
          { role: "worktree" as const },
          { source: "another.test.ts" },
          { mode: "100755" },
        ]) {
          assert.equal(
            classify({
              ...scoped,
              references: scoped.references.map((reference) => ({ ...reference, ...update })),
            }).kind,
            "refused",
          );
        }
        assert.equal(classify(scoped, { ...finding, Verified: true }).kind, "refused");
        assert.equal(classify(scoped, { ...finding, DecoderName: "BASE64" }).kind, "refused");
        assert.equal(classify(scoped, { ...finding, VerificationError: "" }).kind, "refused");
        assert.equal(
          classify(scoped, {
            ...finding,
            SecretParts: { host: "wrong.example", username, password },
          }).kind,
          "refused",
        );
        if (host.endsWith(":443")) {
          assert.equal(
            classify(scoped, {
              ...finding,
              SecretParts: { host: new URL(rawV2).host, username, password },
            }).kind,
            "refused",
          );
        }
      }
    }
  });
}
