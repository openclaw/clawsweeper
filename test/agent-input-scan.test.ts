import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import {
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
import { join } from "node:path";
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
import { useFakeScanner, writeFakeScanner } from "./agent-input-scan-helpers.ts";

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

test("failed scanner bootstrap exposes only validated facts and never starts a provider", (t) => {
  const f = fixture(t);
  const bin = useFakeScanner(t);
  const scanner = realpathSync(
    join(bin, process.platform === "win32" ? "trufflehog.exe" : "trufflehog"),
  );
  const originalCache = process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR;
  process.env.CLAWSWEEPER_REVIEW_TOOLS_DIR = join(f.root, "managed-cache");
  const line =
    '{"event":"review_tool_bootstrap_failed","phase":"download","category":"http","http_status":403}\n';
  let stderr = "";
  let installs = 0;
  const messages: string[] = [];
  const nativeSpawn = childProcess.spawnSync;
  t.mock.method(console, "error", (...args) => {
    messages.push(args.join(" "));
  });
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof nativeSpawn>) => {
    if (args[0] === scanner && args[1]?.[0] === "--version") {
      return nativeSpawn(process.execPath, ["-e", "console.log('trufflehog 3.97.1');"], args[2]);
    }
    if (args[0] === process.execPath && args[1]?.[0]?.endsWith("setup-review-tools.mjs")) {
      installs++;
      return nativeSpawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write('private failed path'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`,
        ],
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
  const cases = [
    line,
    ' { "http_status":403, "category":"http", "phase":"download", "event":"review_tool_bootstrap_failed" }\n',
    "",
    "private provider/loader error\n",
    line + line,
    line + "private extra data\n",
    " ".repeat(256) + line,
    line.replace('"phase":"download"', '"phase":"cache"'),
    line.replace('"http_status":403', '"http_status":403,"private":"secret"'),
  ];
  for (const [index, text] of cases.entries()) {
    stderr = text;
    messages.length = 0;
    assert.throws(
      () => f.run({ kind: "prompt" }),
      (error: unknown) => {
        assert.ok(error instanceof AgentInputScanError);
        assert.equal(error.reason, "scanner_unavailable");
        assert.equal(error.retryable, false);
        assert.equal(agentInputScanFailureExitCode(error), null);
        assert.equal(error.message.includes("403"), false);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
    assert.deepEqual(messages, index < 2 ? [line.trimEnd()] : []);
    assert.equal(existsSync(f.calls), false);
    assert.equal(existsSync(f.diagnosticPromptPath), false);
  }
  assert.equal(installs, cases.length);
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

for (const expectedRole of ["base", "head"] as const) {
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
    const uri = new URL("https://fixture.openclaw.ai/path");
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
  trufflehog_version: '3.99.4', chunks: 1, bytes: 1,
  verified_secrets: 0, unverified_secrets: 1,
}) + '\n');
process.exit(183);
`,
    );
    const run = () => f.run({ kind: "committed", baseSha, headSha });
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
