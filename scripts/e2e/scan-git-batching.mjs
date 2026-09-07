import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Run after building both revisions. All fixtures and receipts stay outside the checkout.
const { values } = parseArgs({
  options: {
    "before-dist": { type: "string" },
    output: { type: "string" },
    scanner: { type: "string" },
    rounds: { type: "string", default: "3" },
    blobs: { type: "string", default: "160" },
    section: { type: "string", default: "all" },
  },
});
assert.ok(values["before-dist"] && values.output && values.scanner);
const rounds = Number(values.rounds);
const blobCount = Number(values.blobs);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 2 && rounds <= 10);
assert.ok(Number.isSafeInteger(blobCount) && blobCount >= 2 && blobCount <= 1000);
assert.ok(["darwin", "linux"].includes(process.platform));
assert.ok(
  ["all", "many", "mixed", "snapshot", "content-budget", "negatives"].includes(values.section),
);
const selected = (section) => values.section === "all" || values.section === section;
const beforeDist = resolve(values["before-dist"]);
const scanner = fs.realpathSync(values.scanner);
const nativeSpawn = childProcess.spawnSync;
const nativeMkdtemp = fs.mkdtempSync;
const run = (executable, args, options = {}) => {
  const result = nativeSpawn(executable, args, { encoding: "utf8", timeout: 120_000, ...options });
  assert.equal(result.error, undefined, "fixture command failed");
  assert.equal(result.status, 0, "fixture command failed");
  return result.stdout.trim();
};
const scannerVersion = nativeSpawn(scanner, ["--version"], { encoding: "utf8" });
assert.equal(scannerVersion.status, 0);
assert.equal(`${scannerVersion.stdout}${scannerVersion.stderr}`.trim(), "trufflehog 3.97.1");
const gitBinary = fs.realpathSync(run("which", ["git"]));
const root = fs.mkdtempSync(join(tmpdir(), "scan-git-batching-proof-"));
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let active;
const results = [];
const compare = (before, after) => {
  assert.equal(after.outcome, before.outcome);
  assert.deepEqual(after.scans, before.scans);
};
try {
  const bin = join(root, "bin");
  const home = join(root, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.symlinkSync(scanner, join(bin, "trufflehog"));
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  // Observe actual native children and their inputs without adding production test hooks.
  childProcess.spawnSync = (executable, args, options) => {
    if (!active) return nativeSpawn(executable, args, options);
    if (executable === gitBinary || executable === "git") {
      const cat = args.indexOf("cat-file");
      const mode = cat < 0 ? "other" : args[cat + 1];
      const input = options.input?.toString() ?? "";
      active.git.push({
        mode,
        command:
          args.find((arg) =>
            ["merge-base", "rev-parse", "diff-index", "diff", "cat-file"].includes(arg),
          ) ?? "other",
        objects: input ? input.trim().split("\n").length : cat < 0 ? 0 : 1,
        maxBuffer: options.maxBuffer,
      });
      if (executable === gitBinary) {
        assert.ok(args.includes("protocol.allow=never"));
        assert.ok(args.includes("core.fsmonitor=false"));
        assert.ok(args.some((arg) => arg.startsWith("core.hooksPath=")));
        assert.ok(args.includes("diff.external="));
        for (const name of ["GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS"])
          assert.equal(options.env[name], "1");
        assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
      }
    }
    if (executable === scanner) {
      assert.deepEqual(args.slice(2), [
        "--results=verified,unknown",
        "--fail",
        "--fail-on-scan-errors",
        "--no-update",
        "--json",
        "--no-color",
      ]);
      const files = fs
        .readdirSync(args[1])
        .sort()
        .map((name) => {
          const file = join(args[1], name);
          assert.ok(fs.lstatSync(file).isFile());
          assert.equal(fs.statSync(file).mode & 0o777, 0o600);
          const bytes = fs.readFileSync(file);
          return { name, size: bytes.length, sha256: hash(bytes) };
        });
      active.scans.push(files);
      const result = nativeSpawn(executable, args, options);
      active.afterScanner?.();
      return result;
    }
    return nativeSpawn(executable, args, options);
  };
  fs.mkdtempSync = (...args) => {
    const path = nativeMkdtemp(...args);
    if (active && basename(path).startsWith("clawsweeper-input-scan-")) active.roots.push(path);
    return path;
  };
  syncBuiltinESMExports();
  const before = await import(pathToFileURL(join(beforeDist, "agent-input-scan.js")).href);
  const after = await import("../../dist/agent-input-scan.js");
  const beforeRunner = await import(pathToFileURL(join(beforeDist, "agent-runner.js")).href);
  const afterRunner = await import("../../dist/agent-runner.js");
  const { captureTargetCheckoutBinding, withTargetReviewSnapshot } =
    await import("../../dist/repair/target-validation.js");

  function fixture(name) {
    const cwd = join(root, name);
    fs.mkdirSync(cwd);
    const git = (...args) =>
      run(gitBinary, args, {
        cwd,
        env: { PATH: originalPath, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "-q");
    git("config", "user.name", "Scanner proof");
    git("config", "user.email", "scanner@example.invalid");
    git("config", "commit.gpgsign", "false");
    const commit = () => {
      git("add", "-A");
      git("commit", "-qm", "synthetic fixture");
      return git("rev-parse", "HEAD");
    };
    return { cwd, git, commit };
  }

  function measure(label, revision, options, { runner, afterScanner } = {}) {
    active = { git: [], scans: [], roots: [], afterScanner };
    const start = performance.now();
    let outcome = "admitted";
    try {
      if (runner) runner();
      else
        revision.scanAgentInput({
          prompt: "Review synthetic changes.",
          timeoutMs: 120_000,
          ...options,
        });
    } catch (error) {
      assert.equal(error.name, "AgentInputScanError");
      outcome = error.reason;
    }
    const elapsedMs = performance.now() - start;
    const observation = active;
    active = undefined;
    for (const path of observation.roots) assert.equal(fs.existsSync(path), false);
    assert.ok(observation.roots.length <= 1);
    const result = {
      label,
      outcome,
      elapsedMs,
      git: observation.git,
      scans: observation.scans,
      cleaned: true,
    };
    results.push(result);
    fs.writeFileSync(
      resolve(values.output),
      JSON.stringify({ complete: false, results }, null, 2) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(
      `${label}: ${outcome}; Git=${result.git.length}; scanners=${result.scans.length}; ${Math.round(elapsedMs)}ms\n`,
    );
    return result;
  }

  if (selected("many")) {
    const many = fixture("many");
    fs.writeFileSync(join(many.cwd, "seed"), "unchanged\n");
    const baseSha = many.commit();
    for (let i = 0; i < blobCount; i++)
      fs.writeFileSync(join(many.cwd, `file-${i}.txt`), `fixture ${i}\nline two\n`);
    const headSha = many.commit();
    const manyOptions = { cwd: many.cwd, source: { kind: "committed", baseSha, headSha } };
    let reference;
    for (let round = 0; round < rounds; round++) {
      // Alternate AB then BA; each sample retains both admission boundaries.
      for (const [name, revision] of round % 2
        ? [
            ["after", after],
            ["before", before],
          ]
        : [
            ["before", before],
            ["after", after],
          ]) {
        for (let boundary = 0; boundary < 2; boundary++) {
          const result = measure(`many/${round}/${name}/${boundary}`, revision, manyOptions);
          assert.equal(result.outcome, "admitted");
          assert.equal(result.scans.length, 1);
          reference ??= result;
          compare(reference, result);
          const blobReads = result.git.filter(({ mode }) => mode !== "other");
          assert.equal(
            blobReads.length,
            name === "before" ? 2 * blobCount : 2 * Math.ceil(blobCount / 160),
          );
        }
      }
    }
    assert.equal(many.git("status", "--porcelain"), "");
  }

  if (selected("mixed")) {
    const mixed = fixture("mixed");
    const binary = Buffer.from([0, 255, 10, 13, 128, 0]);
    fs.writeFileSync(join(mixed.cwd, ".gitattributes"), "*.txt text eol=lf\n");
    fs.writeFileSync(join(mixed.cwd, "old"), "renamed\n");
    fs.writeFileSync(join(mixed.cwd, "deleted"), "deleted\n");
    fs.writeFileSync(join(mixed.cwd, "binary"), binary);
    fs.writeFileSync(join(mixed.cwd, "empty"), "");
    fs.writeFileSync(join(mixed.cwd, "normalized.txt"), "base\n");
    const mixedBase = mixed.commit();
    mixed.git("mv", "old", "renamed");
    fs.rmSync(join(mixed.cwd, "deleted"));
    fs.writeFileSync(join(mixed.cwd, "binary"), Buffer.concat([binary, Buffer.from("\nnext\n")]));
    fs.writeFileSync(join(mixed.cwd, "empty"), "not empty\n");
    fs.writeFileSync(join(mixed.cwd, "normalized.txt"), "head\n");
    fs.symlinkSync("nonexistent-target", join(mixed.cwd, "link"));
    for (const [name, mib] of [
      ["large-a", 5],
      ["large-b", 5],
      ["large-c", 9],
    ]) {
      fs.writeFileSync(join(mixed.cwd, name), name);
      fs.truncateSync(join(mixed.cwd, name), mib * 1024 * 1024);
    }
    const mixedHead = mixed.commit();
    fs.writeFileSync(join(mixed.cwd, "normalized.txt"), "head\r\n");
    const schemaPath = join(root, "schema.json");
    fs.writeFileSync(schemaPath, '{"type":"object"}\n');
    const mixedOptions = {
      cwd: mixed.cwd,
      source: { kind: "committed", baseSha: mixedBase, headSha: mixedHead },
      additionalBytes: [Buffer.from("extra\ninput\0")],
      schemaPath,
    };
    const mixedBefore = measure("mixed/before", before, mixedOptions);
    const mixedAfter = measure("mixed/after", after, mixedOptions);
    compare(mixedBefore, mixedAfter);
    assert.equal(mixedAfter.outcome, "admitted");
    const contentBatches = mixedAfter.git.filter(({ mode }) => mode === "--batch");
    assert.ok(contentBatches.length > 1);
    assert.ok(
      contentBatches.some(({ maxBuffer, objects }) => maxBuffer > 9 * 1024 * 1024 && objects === 1),
    );
    for (const { maxBuffer, objects } of contentBatches)
      assert.ok(maxBuffer <= 8 * 1024 * 1024 + 160 * 100 || objects === 1);
    for (const bytes of [
      binary,
      Buffer.alloc(0),
      Buffer.from("deleted\n"),
      Buffer.from("renamed\n"),
      Buffer.from("head\r\n"),
      Buffer.from("nonexistent-target"),
    ])
      assert.ok(mixedAfter.scans[0].some(({ sha256 }) => sha256 === hash(bytes)));
  }

  if (selected("snapshot")) {
    // The same blob participates at base, head, index and tree under distinct paths.
    const snapshot = fixture("snapshot");
    fs.writeFileSync(join(snapshot.cwd, "a"), "shared\n");
    fs.writeFileSync(join(snapshot.cwd, "b"), "base\n");
    const snapshotBase = snapshot.commit();
    fs.writeFileSync(join(snapshot.cwd, "a"), "head\n");
    fs.writeFileSync(join(snapshot.cwd, "b"), "shared\n");
    snapshot.commit();
    fs.writeFileSync(join(snapshot.cwd, "a"), "shared\n");
    snapshot.git("add", "a");
    fs.writeFileSync(join(snapshot.cwd, "a"), "tree\r\n");
    fs.writeFileSync(join(snapshot.cwd, "c"), "shared\n");
    const binding = captureTargetCheckoutBinding(snapshot.cwd);
    withTargetReviewSnapshot(
      { cwd: snapshot.cwd, baseSha: snapshotBase, expected: binding, timeoutMs: 120_000 },
      (source) => {
        const first = measure("snapshot/before", before, { cwd: snapshot.cwd, source });
        const second = measure("snapshot/after", after, { cwd: snapshot.cwd, source });
        compare(first, second);
        assert.equal(second.outcome, "admitted");
        assert.ok(second.scans[0].some(({ sha256 }) => sha256 === hash(Buffer.from("tree\r\n"))));
      },
    );
  }

  if (selected("content-budget")) {
    const budget = fixture("content-budget");
    fs.writeFileSync(join(budget.cwd, "seed"), "unchanged\n");
    const budgetBase = budget.commit();
    for (let index = 0; index < 32; index++)
      fs.writeFileSync(join(budget.cwd, `binary-${index}`), Buffer.from([0, 255, index, 10]));
    const budgetHead = budget.commit();
    const diffArgs = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=none",
      budgetBase,
      budgetHead,
    ];
    const diffSize = (flags) => {
      const result = nativeSpawn(gitBinary, [...diffArgs, ...flags, "--"], { cwd: budget.cwd });
      assert.equal(result.status, 0);
      return result.stdout.length;
    };
    const prompt = "Review synthetic changes.";
    const materialBytes =
      Buffer.byteLength(prompt) +
      32 * 4 +
      diffSize(["--raw", "--no-abbrev", "-z"]) +
      diffSize(["--patch", "--binary", "--full-index"]);
    // Leave room for existing control reads, but less than the batch's framing.
    const filler = Buffer.alloc(256 * 1024 * 1024 - 1024 - materialBytes);
    const budgetOptions = {
      cwd: budget.cwd,
      prompt,
      source: { kind: "committed", baseSha: budgetBase, headSha: budgetHead },
      additionalBytes: [filler],
    };
    const budgetBefore = measure("content-budget/before", before, budgetOptions);
    const budgetAfter = measure("content-budget/after", after, budgetOptions);
    compare(budgetBefore, budgetAfter);
    assert.equal(budgetAfter.outcome, "admitted");
    assert.equal(
      budgetAfter.scans[0].reduce((sum, file) => sum + file.size, 0),
      256 * 1024 * 1024 - 1024,
    );
    assert.ok(budgetAfter.git.find(({ mode }) => mode === "--batch").maxBuffer > 1024 + 32 * 4);
  }

  if (selected("negatives")) {
    for (const scenario of [
      "missing",
      "oversize",
      "unsafe-path",
      "HEAD-drift",
      "index-drift",
      "raw-drift",
      "deadline",
      "finding",
    ]) {
      let previous;
      for (const [name, revision, runner] of [
        ["before", before, beforeRunner],
        ["after", after, afterRunner],
      ]) {
        const f = fixture(`${scenario}-${name}`);
        fs.writeFileSync(join(f.cwd, "a"), "base\n");
        if (scenario === "oversize") {
          for (const file of ["large-a", "large-b"]) {
            fs.writeFileSync(join(f.cwd, file), file);
            fs.truncateSync(join(f.cwd, file), 129 * 1024 * 1024);
          }
        }
        const base = f.commit();
        if (scenario === "oversize") {
          fs.rmSync(join(f.cwd, "large-a"));
          fs.rmSync(join(f.cwd, "large-b"));
        }
        fs.writeFileSync(join(f.cwd, "a"), "head\n");
        const head = f.commit();
        const source = { kind: "committed", baseSha: base, headSha: head };
        const calls = join(f.cwd, "..", `${scenario}-${name}-provider-calls`);
        const provider = join(f.cwd, "..", `${scenario}-${name}-provider`);
        fs.writeFileSync(
          provider,
          `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(calls)}, 'called');`,
          { mode: 0o700 },
        );
        let timeoutMs = 120_000;
        let prompt = "Review synthetic changes.";
        const extra = [];
        let afterScanner;
        if (scenario === "missing") {
          const oid = f.git("rev-parse", `${base}:a`);
          fs.rmSync(join(f.cwd, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
          f.git("config", "extensions.partialClone", "origin");
          f.git("config", "remote.origin.promisor", "true");
          f.git("config", "remote.origin.url", "https://fixture.example.invalid/unavailable.git");
        } else if (scenario === "unsafe-path") {
          fs.writeFileSync(join(f.cwd, "unsafe\nname"), "unsafe\n");
          source.headSha = f.commit();
        } else if (scenario === "HEAD-drift") {
          afterScanner = () => f.git("update-ref", "HEAD", base);
        } else if (scenario === "index-drift") {
          afterScanner = () => {
            fs.writeFileSync(join(f.cwd, "a"), "index drift\n");
            f.git("add", "a");
            fs.writeFileSync(join(f.cwd, "a"), "head\n");
          };
        } else if (scenario === "raw-drift") {
          afterScanner = () => fs.writeFileSync(join(f.cwd, "a"), "raw drift\n");
        } else if (scenario === "deadline") {
          timeoutMs = 0;
        } else if (scenario === "finding") {
          const uri = new URL("https://fixture.example.invalid/path");
          uri.username = "fixture-user";
          uri.password = "fixture-pass";
          prompt = `Review ${uri.href}\n`;
        }
        const result = measure(
          `${scenario}/${name}`,
          revision,
          {},
          {
            afterScanner,
            runner: () =>
              runner.runAgentProcess({
                label: "synthetic-refusal",
                cwd: f.cwd,
                prompt,
                scanSource: source,
                model: "test",
                timeoutMs,
                env: { PATH: process.env.PATH, HOME: home, CODEX_BIN: provider },
                codexExtraArgs: extra,
              }),
          },
        );
        assert.equal(fs.existsSync(calls), false, "refusal must precede provider launch");
        const expected =
          scenario === "missing"
            ? "incomplete_source"
            : scenario === "oversize"
              ? "staging_limit"
              : scenario === "unsafe-path"
                ? "unsafe_path"
                : scenario.endsWith("-drift")
                  ? "source_drift"
                  : scenario === "finding"
                    ? "findings"
                    : "deadline";
        assert.equal(result.outcome, expected);
        if (scenario === "oversize" && name === "after")
          assert.equal(result.git.filter(({ mode }) => mode === "--batch").length, 0);
        if (previous) compare(previous, result);
        previous = result;
      }
    }
  }
  fs.writeFileSync(
    resolve(values.output),
    JSON.stringify(
      {
        complete: true,
        section: values.section,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        git: run(gitBinary, ["--version"]),
        scanner: "3.97.1",
        sourceSha256: hash(
          fs.readFileSync(new URL("../../src/agent-input-scan.ts", import.meta.url)),
        ),
        beforeModuleSha256: hash(fs.readFileSync(join(beforeDist, "agent-input-scan.js"))),
        rounds,
        blobCount,
        results,
        limits:
          "Synthetic local scan admission only; no production latency, model, queue, publication or Bay claim.",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
} finally {
  active = undefined;
  childProcess.spawnSync = nativeSpawn;
  fs.mkdtempSync = nativeMkdtemp;
  syncBuiltinESMExports();
  for (const [name, value] of [
    ["PATH", originalPath],
    ["HOME", originalHome],
    ["XDG_CONFIG_HOME", originalXdg],
  ])
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  fs.rmSync(root, { recursive: true, force: true });
}
