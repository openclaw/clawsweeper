import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
} from "../dist/validation-recovery.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { closeDecision, item } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  loadLocalRepositoryReviewConfig,
  loadRepositoryReviewConfig,
  materializeNativeReviewSkills,
  repositoryReviewContentDigest,
} from "../dist/repository-review-config.js";
import { runAgentProcess } from "../dist/agent-runner.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
import { reviewDecisionParser } from "../dist/clawsweeper-decision-parser.js";
import { reviewContentCacheHit, shouldReviewItem } from "../dist/scheduler-policy.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-native-config-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  const put = (path: string, text: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "test: synthetic native configuration",
      "-m",
      "Co-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>",
    );
    return git("rev-parse", "HEAD");
  };
  put("source.txt", "ordinary reviewed source");
  const empty = commit();
  const configure = (
    value: unknown = { version: 1, skills: ["sample"], additionalPrompt: "APPENDED" },
  ) => put(".clawsweeper/review.json", JSON.stringify(value));
  const skill = (body = "Read [contract](references/contract.md).") => {
    put(
      ".agents/skills/sample/SKILL.md",
      "---\nname: sample\ndescription: Sample review\n---\n" + body,
    );
    put(".agents/skills/sample/references/contract.md", "PINNED-REFERENCE");
  };
  return { root, git, put, commit, empty, configure, skill };
}

test("missing and empty configuration preserve ordinary cache identity", (t) => {
  const f = fixture(t);
  assert.equal(loadRepositoryReviewConfig(f.root, f.empty), undefined);
  assert.equal(loadLocalRepositoryReviewConfig(f.root, "main"), undefined);
  assert.equal(repositoryReviewContentDigest("ordinary"), "ordinary");
  f.configure({ version: 1 });
  assert.equal(loadRepositoryReviewConfig(f.root, f.commit()), undefined);
});

test("pinned config, skill and references ignore PR-head edits and bind cache identity", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const main = f.commit();
  f.configure({ version: 1, skills: ["../escape"] });
  f.skill("HEAD-OVERRIDE");
  f.commit();
  const config = loadLocalRepositoryReviewConfig(f.root, main)!;
  assert.equal(config.revision, main);
  assert.equal(config.additionalPrompt, "APPENDED");
  assert.equal(config.files.length, 2);
  const native = materializeNativeReviewSkills(config, f.root);
  assert.equal(
    readFileSync(join(native.cwd, ".agents/skills/sample/references/contract.md"), "utf8"),
    "PINNED-REFERENCE",
  );
  assert.equal(
    readFileSync(join(native.cwd, ".agents/skills/sample/SKILL.md"), "utf8"),
    f.git("show", main + ":.agents/skills/sample/SKILL.md"),
  );
  assert.notEqual(repositoryReviewContentDigest("ordinary", config), "ordinary");
  assert.equal(config.digest, loadRepositoryReviewConfig(f.root, main)!.digest);
  native.cleanup();
  assert.equal(existsSync(native.cwd), false);
  f.put(".agents/skills/sample/references/contract.md", "CHANGED-REFERENCE");
  f.configure();
  assert.notEqual(loadRepositoryReviewConfig(f.root, f.commit())!.digest, config.digest);
  assert.equal(f.git("status", "--porcelain"), "");
});

for (const value of [
  { version: 2 },
  { version: 1, skills: null },
  { version: 1, additionalPrompt: null },
  { version: 1, multiModel: {} },
  { version: 1, skills: ["../sample"] },
  { version: 1, skills: ["sample", "sample"] },
  { version: 1, additionalPrompt: "x".repeat(5001) },
]) {
  test("reject invalid repository configuration " + JSON.stringify(value).slice(0, 90), (t) => {
    const f = fixture(t);
    f.configure(value);
    assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
  });
}

test("offline configuration uses the operator base despite head deletion and no remote", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const trusted = f.commit();
  f.git("checkout", "-qb", "pull-head");
  rmSync(join(f.root, ".clawsweeper/review.json"));
  f.commit();
  assert.equal(f.git("remote"), "");
  assert.equal(loadLocalRepositoryReviewConfig(f.root, "main")!.revision, trusted);
  assert.equal(loadLocalRepositoryReviewConfig(f.root, "main")!.additionalPrompt, "APPENDED");
  for (const ref of ["", "missing-base", "--help"]) {
    assert.throws(() => loadLocalRepositoryReviewConfig(f.root, ref), /valid trusted --base/);
  }
});

test("offline configuration uses the base tip rather than a head-dependent merge-base", (t) => {
  const f = fixture(t);
  f.git("checkout", "-qb", "pull-head");
  f.configure({ version: 1, additionalPrompt: "HEAD-INSTRUCTION" });
  f.commit();
  f.git("checkout", "main");
  f.configure({ version: 1, additionalPrompt: "TRUSTED-TIP" });
  const trusted = f.commit();
  f.git("checkout", "pull-head");
  assert.equal(f.git("merge-base", "main", "HEAD"), f.empty);
  const config = loadLocalRepositoryReviewConfig(f.root, "main")!;
  assert.equal(config.revision, trusted);
  assert.equal(config.additionalPrompt, "TRUSTED-TIP");
});

for (const kind of [
  "missing",
  "escape",
  "binary",
  "oversize",
  "symlink",
  "tools",
  "tools-case",
  "nested",
  "nested-case",
] as const) {
  test(
    "reject unsafe native bundle " + kind,
    { skip: kind === "symlink" && process.platform === "win32" },
    (t) => {
      const f = fixture(t);
      f.configure();
      f.skill();
      if (kind === "missing") rmSync(join(f.root, ".agents/skills/sample/references/contract.md"));
      if (kind === "escape") f.skill("Read [outside](../../outside.md).");
      if (kind === "binary")
        f.put(".agents/skills/sample/references/contract.md", Buffer.from([0, 255]));
      if (kind === "oversize")
        f.put(".agents/skills/sample/references/contract.md", "x".repeat(256 * 1024));
      if (kind === "symlink")
        symlinkSync("../../source.txt", join(f.root, ".agents/skills/sample/link"));
      if (kind === "tools" || kind === "tools-case")
        f.put(
          ".agents/skills/sample/agents/" + (kind === "tools" ? "openai.yaml" : "OpenAI.yaml"),
          "dependencies: { tools: [] }",
        );
      if (kind === "nested" || kind === "nested-case")
        f.put(
          ".agents/skills/sample/nested/" + (kind === "nested" ? "SKILL.md" : "Skill.md"),
          "---\nname: rogue\ndescription: rogue\n---\nrogue",
        );
      assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
    },
  );
}

for (const file of [
  "agents/openai.yaml::$DATA",
  "agents/openai.yaml.",
  "agents/openai.yaml ",
  "agents./openai.yaml",
  "NUL.txt",
  "COM¹.md",
]) {
  test(
    "reject Windows-aliasing native bundle path " + file,
    { skip: process.platform === "win32" ? "fixture names are not creatable on Windows" : false },
    (t) => {
      const f = fixture(t);
      f.configure();
      f.skill();
      f.put(".agents/skills/sample/" + file, "dependencies: { tools: [] }");
      assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()), /Unsafe native skill/);
    },
  );
}

test("case-colliding native bundle paths fail before materialization on any host", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const base = f.commit();
  const blob = f.git("rev-parse", base + ":.agents/skills/sample/references/contract.md");
  // Construct the collision in Git, including on a case-insensitive test filesystem.
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    "100644," + blob + ",.agents/skills/sample/references/CONTRACT.md",
  );
  const revision = f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    f.git("write-tree"),
    "-p",
    base,
    "-m",
    "test: synthetic case collision",
    "-m",
    "Co-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>",
  );
  assert.throws(() => loadRepositoryReviewConfig(f.root, revision), /Case-colliding/);
});

test("Codex receives native bundle separately, scanners receive selected bytes, and cleanup runs on failure", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const config = loadRepositoryReviewConfig(f.root, f.commit())!;
  const bin = useFakeScanner(
    t,
    'assert.ok(inputs.some(({bytes})=>bytes.toString().includes("PINNED-REFERENCE"))); assert.ok(inputs.some(({bytes})=>bytes.toString()==="APPENDED"));',
  );
  const binary = join(bin, "codex-fixture");
  const receipt = join(bin, "receipt.json");
  writeFileSync(
    binary,
    '#!/usr/bin/env node\nconst fs=require("node:fs"); fs.writeFileSync(process.env.RECEIPT,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),prompt:fs.readFileSync(0,"utf8"),skill:fs.readFileSync(".agents/skills/sample/SKILL.md","utf8")})); process.exit(7);',
    { mode: 0o755 },
  );
  const result = runAgentProcess({
    label: "native-fixture",
    prompt: "BASE-CONTRACT",
    scanSource: { kind: "prompt" },
    model: "internal",
    cwd: f.root,
    env: { ...process.env, CODEX_BIN: binary, RECEIPT: receipt },
    timeoutMs: 10_000,
    repositoryReview: config,
    codexExtraArgs: ["-C", f.root, "--sandbox", "read-only", "-"],
  });
  assert.equal(result.status, 7);
  const sent = JSON.parse(readFileSync(receipt, "utf8"));
  assert.notEqual(sent.cwd, f.root);
  assert.equal(sent.args[sent.args.indexOf("-C") + 1], sent.cwd);
  assert.equal(sent.args[sent.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(sent.args.includes("project_root_markers=[]"));
  assert.equal(sent.args.at(-1), "-");
  assert.ok(sent.prompt.startsWith("BASE-CONTRACT"));
  assert.ok(sent.prompt.includes("[$sample]("));
  assert.ok(sent.prompt.includes("APPENDED"));
  assert.ok(!sent.prompt.includes("Read [contract]")); // native body was not pasted into caller prompt
  assert.ok(sent.skill.includes("Read [contract]"));
  assert.equal(existsSync(sent.cwd), false);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("OpenClaw selected skills without an owned workspace fail before scanner or inference", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  assert.throws(
    () =>
      runAgentProcess({
        label: "unsupported",
        prompt: "base",
        scanSource: { kind: "prompt" },
        model: "internal",
        cwd: f.root,
        env: { CLAWSWEEPER_RUNNER: "openclaw" },
        timeoutMs: 1000,
        repositoryReview: loadRepositoryReviewConfig(f.root, f.commit()),
      }),
    /isolated owned native workspace/,
  );
});

test("compiled local review rejects invalid trusted base despite head deletion and no remote", (t) => {
  const f = fixture(t);
  f.configure({ version: 2 });
  f.commit();
  f.git("checkout", "-qb", "pull-head");
  rmSync(join(f.root, ".clawsweeper/review.json"));
  f.put("source.txt", "changed reviewed source");
  f.commit();
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/clawsweeper-local.js"),
      "review",
      "--target-repo",
      "steipete/target",
      "--target-dir",
      f.root,
      "--base",
      "main",
      "--result-format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_BIN: join(f.root, "must-not-launch") },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "failed");
  assert.deepEqual(output.reports, []);
  assert.match(output.error.message, /Unsupported repository review configuration/);
  assert.equal(f.git("status", "--porcelain"), "");
});

for (const skills of [false, true])
  for (const models of [false, true]) {
    test("public opt-in matrix skills=" + skills + " models=" + models, (t) => {
      const f = fixture(t);
      if (skills) f.skill();
      const selection = {
        runner: "codex",
        model: "fixture-model",
        reasoningEffort: "high",
        contextTier: "default",
      };
      f.configure({
        version: 1,
        ...(skills ? { skills: ["sample"] } : {}),
        ...(models
          ? { multiModel: { reviewers: [selection, selection], coordinator: selection } }
          : {}),
      });
      const sha = f.commit();
      const config = loadRepositoryReviewConfig(f.root, sha);
      assert.equal(Boolean(config?.skills.length), skills);
      assert.equal(Boolean(config?.multiModel), models);
      if (config) assert.equal(config.revision, sha);
      const hash = repositoryReviewContentDigest("base", config);
      f.configure({ version: 1, additionalPrompt: "changed target guidance" });
      f.commit();
      assert.equal(
        repositoryReviewContentDigest("base", loadRepositoryReviewConfig(f.root, sha)),
        hash,
      );
    });
  }
for (const invalid of [
  { runner: "codex", model: "valid", contextTier: "long_context" },
  { runner: "codex", model: "valid", args: ["--dangerous"] },
  { runner: "codex", model: "valid", apiKey: "not-allowed" },
  { runner: "codex", model: "https://private.invalid" },
  { runner: "openclaw", model: "missing-provider" },
  { runner: "codex", model: "valid", reasoningEffort: "invented" },
])
  test("reject unsupported public model binding " + JSON.stringify(invalid), (t) => {
    const f = fixture(t);
    f.configure({
      version: 1,
      multiModel: { reviewers: [invalid, invalid], coordinator: invalid },
    });
    assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
  });
for (const size of [0, 1, 5])
  test("multi-model admission rejects reviewer count " + size, (t) => {
    const f = fixture(t);
    const selection = { runner: "codex", model: "fixture" };
    f.configure({
      version: 1,
      multiModel: { reviewers: Array(size).fill(selection), coordinator: selection },
    });
    assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
  });

test("OpenClaw rejects parent residue and admits the next configured review", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const head = f.commit();
  const config = loadRepositoryReviewConfig(f.root, head)!;
  const owned = mkdtempSync(join(tmpdir(), "clawsweeper-native-residue-"));
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const source = join(owned, "42");
  f.git("worktree", "add", "--detach", source, head);
  const bin = useFakeScanner(t),
    binary = join(bin, "openclaw-residue");
  const codexSource = join(bin, "codex"),
    targetDir = join(bin, "target");
  mkdirSync(targetDir);
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", f.root, codexSource]);
  symlinkSync(codexSource, join(owned, "codex"), "dir");
  const codexFile = join(codexSource, "source.txt");
  const originalMode = statSync(codexFile).mode;
  const originalRootMode = statSync(codexSource).mode;
  const setupScript = join(bin, "setup.sh");
  writeFileSync(setupScript, "#!/bin/sh\nexit 0\n");
  const setup = {
    CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT: setupScript,
    CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR: targetDir,
    CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR: join(bin, "cache"),
  };
  for (const [key, value] of Object.entries(setup)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
  const valid = closeDecision({
    decision: "keep_open",
    closeReason: "none",
    likelyOwners: [
      {
        person: "Fixture",
        role: "source author",
        reason: "Synthetic fixture commit",
        commits: [head],
        files: ["source.txt"],
        confidence: "high",
      },
    ],
  });
  writeFileSync(
    binary,
    [
      "#!" + process.execPath,
      'const fs=require("node:fs"),p=require("node:path"),args=process.argv.slice(2);',
      'const prompt=fs.readFileSync(args[args.indexOf("--message-file")+1],"utf8");let text;',
      'const reference=p.join(process.cwd(),"codex","source.txt");if(fs.statSync(reference).mode & 0o222)throw Error("reference is writable");',
      'if(process.getuid?.()!==0){let refused=false;try{fs.writeFileSync(reference,"tampered");}catch(e){if(!["EACCES","EPERM"].includes(e.code))throw e;refused=true;}if(!refused)throw Error("reference write unexpectedly succeeded");}',
      'if(prompt.startsWith("Use the read tool")){',
      " const file=JSON.parse(prompt.match(/^Path: (.+)$/m)[1]),line=Number(prompt.match(/Return exactly line (\\d+)/)[1]);",
      ' text=fs.readFileSync(p.resolve(process.cwd(),file),"utf8").split(/\\r?\\n/)[line-1].trim();',
      ' const id=args[args.indexOf("--session-id")+1],dir=p.join(process.env.OPENCLAW_STATE_DIR,"agents","main","sessions");fs.mkdirSync(dir,{recursive:true});',
      ' const entries=[{message:{role:"assistant",content:[{type:"toolCall",id:"read",name:"read",arguments:{path:file}}]}},{message:{role:"toolResult",toolCallId:"read",toolName:"read",isError:false}}];',
      ' fs.writeFileSync(p.join(dir,id+".jsonl"),entries.map(x=>JSON.stringify(x)).join("\\n"));',
      "}else{",
      ' if(process.env.GIT_OPTIONAL_LOCKS!=="0")throw Error("optional Git writes not disabled");require("child_process").execFileSync("git",["-C",p.dirname(reference),"status","--porcelain"]);',
      ' if(process.env.OPENCLAW_TEST_REFERENCE_CHANGE==="file"){fs.chmodSync(reference,0o644);fs.writeFileSync(reference,"tampered");}',
      ' if(process.env.OPENCLAW_TEST_REFERENCE_CHANGE==="directory")fs.chmodSync(p.dirname(reference),0);',
      ' if(process.env.OPENCLAW_TEST_REFERENCE_CHANGE==="metadata")fs.appendFileSync(p.join(p.dirname(reference),".git/config"),String.fromCharCode(10)+"[proof]"+String.fromCharCode(10)+" changed = true"+String.fromCharCode(10));',
      ' if(process.env.OPENCLAW_TEST_WRITE_PARENT==="1"){fs.writeFileSync("residue.txt","unwanted");fs.mkdirSync("residue-dir");fs.writeFileSync("residue-dir/nested.txt","unwanted");}',
      ' if(process.env.OPENCLAW_TEST_FAIL_AFTER_MUTATION==="1")process.exit(1);',
      ' if(process.env.OPENCLAW_TEST_MOVE_PARENT_SOURCE==="1")fs.renameSync("42","42-moved");',
      " text=" + JSON.stringify(JSON.stringify(valid)) + ";",
      "}",
      'console.log(JSON.stringify({payloads:[{text}],meta:{stopReason:"stop"}}));',
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
    CLAWSWEEPER_OPENCLAW_BIN: binary,
    OPENCLAW_TEST_WRITE_PARENT: "1",
    OPENCLAW_TEST_REFERENCE_CHANGE: "",
  };
  const runtime = createReviewRuntime({
    ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
    run: (command: string, args: string[], options: { cwd?: string } = {}) =>
      execFileSync(command, args, { ...options, encoding: "utf8" }),
    untrustedCodexEnv: () => env,
    decisionSchemaPath: resolve("schema/clawsweeper-decision.schema.json"),
    parseDecision: reviewDecisionParser.parseDecision,
    defaultRootCauseCluster: reviewDecisionParser.defaultRootCauseCluster,
  } as Parameters<typeof createReviewRuntime>[0]);
  const options = {
    item: item({ repo: "openclaw/openclaw", number: 42, kind: "pull_request" }),
    context: { pullRequest: { base: { sha: head }, head: { sha: head } } },
    git: { mainSha: head, latestRelease: null, releaseStateComplete: true },
    repositoryReview: config,
    openclawDir: source,
    reviewTreeRoot: owned,
    prompt: "BASE",
    workDir: join(bin, "output"),
    reviewEnv: env,
    timeoutMs: 10000,
    resultFileBytes: 128 * 1024,
    model: "test",
    sandboxMode: "read-only",
    reasoningEffort: "medium",
    serviceTier: "",
  } as Parameters<typeof runtime.runCodexForTest>[0];
  assert.throws(
    () => runtime.runCodexForTest(options),
    (error) => {
      assert.match((error as Error).message, /changed its owned workspace/);
      assert.equal(runtime.codexReviewFailureRetryable(error), false);
      return true;
    },
  );
  assert.equal(existsSync(join(owned, "residue.txt")), false);
  assert.equal(existsSync(join(owned, "residue-dir")), false);
  assert.equal(existsSync(join(owned, ".agents")), false);
  assert.equal(f.git("-C", source, "status", "--porcelain"), "");
  env.OPENCLAW_TEST_WRITE_PARENT = "0";
  assert.equal(statSync(codexFile).mode, originalMode);
  assert.equal(runtime.runCodexForTest(options).localCheckoutAccess, "verified");
  assert.equal(statSync(codexFile).mode, originalMode);
  assert.equal(readFileSync(codexFile, "utf8"), "ordinary reviewed source");
  assert.equal(f.git("-C", codexSource, "status", "--porcelain"), "");
  const gitConfigPath = join(codexSource, ".git/config");
  const gitConfig = readFileSync(gitConfigPath);
  for (const change of ["file", "metadata", "directory"]) {
    env.OPENCLAW_TEST_REFERENCE_CHANGE = change;
    assert.throws(
      () => runtime.runCodexForTest(options),
      (error) => {
        assert.match((error as Error).message, /reference source changed|EACCES|EPERM/);
        assert.equal(runtime.codexReviewFailureRetryable(error), false);
        return true;
      },
    );
    assert.equal(statSync(codexFile).mode, originalMode);
    assert.equal(statSync(codexSource).mode, originalRootMode);
    writeFileSync(gitConfigPath, gitConfig);
    f.git("-C", codexSource, "restore", "source.txt");
  }
  env.OPENCLAW_TEST_REFERENCE_CHANGE = "metadata";
  env.OPENCLAW_TEST_FAIL_AFTER_MUTATION = "1";
  assert.throws(
    () => runtime.runCodexForTest(options),
    (error) => {
      const recovery = validationRecoveryRequired(error);
      assert.ok(recovery);
      assert.ok(recovery.recoveryPaths.has(codexSource));
      assert.ok(recovery.cause instanceof Error);
      assert.match(recovery.cause.message, /exit|failed/i);
      assert.equal(runtime.codexReviewFailureRetryable(error), false);
      return true;
    },
  );
  assert.ok(readFileSync(gitConfigPath, "utf8").includes("[proof]"));
  writeFileSync(gitConfigPath, gitConfig);
  delete env.OPENCLAW_TEST_FAIL_AFTER_MUTATION;
  delete env.OPENCLAW_TEST_REFERENCE_CHANGE;
  const originalChmod = fs.chmodSync;
  const restoreCause = new Error("fixture restore denied");
  try {
    fs.chmodSync = ((file, mode) => {
      if (String(file) === codexFile && mode === originalMode) throw restoreCause;
      return originalChmod(file, mode);
    }) as typeof fs.chmodSync;
    syncBuiltinESMExports();
    assert.throws(
      () => runtime.runCodexForTest(options),
      (error) => {
        const recovery = validationRecoveryRequired(error);
        assert.ok(recovery);
        assert.ok(recovery.recoveryPaths.has(codexSource));
        assert.ok(recovery.recoveryPaths.has(owned));
        assert.match(recovery.message, /modes could not be restored/);
        return true;
      },
    );
  } finally {
    fs.chmodSync = originalChmod;
    syncBuiltinESMExports();
    originalChmod(codexFile, originalMode);
  }
  const relocated = join(owned, "42-moved");
  Object.assign(env, { OPENCLAW_TEST_MOVE_PARENT_SOURCE: "1" });
  try {
    assert.throws(
      () => runtime.runCodexForTest(options),
      (error) => {
        const recovery = validationRecoveryRequired(error);
        assert.ok(recovery);
        assert.ok(recovery.recoveryPaths.has(owned));
        assert.ok(recovery.cause instanceof Error);
        assert.equal(runtime.codexReviewFailureRetryable(error), false);
        return true;
      },
    );
    assert.equal(existsSync(join(relocated, "source.txt")), true);
  } finally {
    if (existsSync(relocated)) renameSync(relocated, source);
    rmSync(join(owned, ".agents"), { recursive: true, force: true });
  }
  const originalWrite = fs.writeFileSync;
  const preparationCause = new Error("fixture materialization failed after source relocation");
  try {
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).startsWith(join(owned, ".agents"))) {
        renameSync(source, relocated);
        throw preparationCause;
      }
      return originalWrite(...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    assert.throws(
      () => runtime.runCodexForTest(options),
      (error) => {
        const recovery = validationRecoveryRequired(error);
        assert.ok(recovery);
        assert.equal(recovery.cause, preparationCause);
        assert.ok(recovery.recoveryPaths.has(owned));
        assert.equal(existsSync(join(relocated, "source.txt")), true);
        return true;
      },
    );
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    if (existsSync(relocated)) renameSync(relocated, source);
    rmSync(join(owned, ".agents"), { recursive: true, force: true });
  }
});

test("OpenClaw owned parent isolates native skills, preserves source and cleans failed preflight", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const trusted = f.commit();
  const config = loadRepositoryReviewConfig(f.root, trusted)!;
  f.skill("HEAD-OVERRIDE");
  const head = f.commit();
  const owned = mkdtempSync(join(tmpdir(), "clawsweeper-owned-native-test-"));
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const source = join(owned, "42");
  f.git("worktree", "add", "--detach", source, head);
  const native = materializeNativeReviewSkills(config, source, owned);
  assert.equal(native.cwd, owned);
  assert.ok(
    readFileSync(join(owned, ".agents/skills/sample/SKILL.md"), "utf8").includes("Read [contract]"),
  );
  assert.ok(
    readFileSync(join(source, ".agents/skills/sample/SKILL.md"), "utf8").includes("HEAD-OVERRIDE"),
  );
  const bin = useFakeScanner(t);
  const binary = join(bin, "openclaw-fixture");
  const receipt = join(bin, "native.json");
  writeFileSync(
    binary,
    '#!/usr/bin/env node\nconst fs=require("node:fs"); const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")); fs.writeFileSync(process.env.OPENCLAW_TEST_RECORD,JSON.stringify({config,cwd:process.env.OPENCLAW_WORKSPACE_DIR,prompt:fs.readFileSync(process.argv[process.argv.indexOf("--message-file")+1],"utf8")})); process.exit(7);',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    CLAWSWEEPER_RUNNER: "openclaw",
    CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
    CLAWSWEEPER_OPENCLAW_BIN: binary,
    OPENCLAW_TEST_RECORD: receipt,
  };
  const result = runAgentProcess({
    label: "native-test",
    prompt: "BASE",
    scanSource: { kind: "prompt" },
    model: "test",
    cwd: source,
    env,
    timeoutMs: 10_000,
    repositoryReview: config,
    nativeWorkspace: native,
  });
  assert.equal(result.status, 7);
  const sent = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(sent.cwd, owned);
  assert.deepEqual(sent.config.agents.defaults.skills, ["sample"]);
  assert.equal(sent.config.tools.fs.workspaceOnly, true);
  assert.ok(sent.prompt.includes("APPENDED"));
  native.cleanup();
  assert.equal(existsSync(join(owned, ".agents")), false);
  assert.equal(existsSync(source), true);
  const runtime = createReviewRuntime({
    ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
    run: (command: string, args: string[], options: { cwd?: string } = {}) =>
      execFileSync(command, args, { ...options, encoding: "utf8" }),
    untrustedCodexEnv: () => env,
    decisionSchemaPath: resolve("schema/clawsweeper-decision.schema.json"),
  } as Parameters<typeof createReviewRuntime>[0]);
  assert.throws(
    () =>
      runtime.runCodexForTest({
        item: { repo: "steipete/fixture", number: 42, kind: "pull_request" },
        context: { pullRequest: { base: { sha: trusted }, head: { sha: head } } },
        repositoryReview: config,
        openclawDir: source,
        reviewTreeRoot: owned,
        prompt: "BASE",
        workDir: join(bin, "output"),
        reviewEnv: env,
        timeoutMs: 10_000,
        resultFileBytes: 4096,
      } as Parameters<typeof runtime.runCodexForTest>[0]),
    /Read-only checkout inspection failed/,
  );
  const probe = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(probe.cwd, owned);
  assert.deepEqual(probe.config.agents.defaults.skills, []);
  assert.equal(probe.config.tools.fs.workspaceOnly, true);
  assert.ok(JSON.parse(probe.prompt.match(/^Path: (.+)$/m)[1]).startsWith("42" + sep));
  assert.equal(existsSync(join(owned, ".agents")), false);
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }),
    "",
  );
  for (const movedKind of ["source", "workspace"]) {
    const guarded = materializeNativeReviewSkills(config, source, owned);
    const original = movedKind === "source" ? source : owned;
    const moved = original + "-moved";
    renameSync(original, moved);
    const inherited = new ValidationRecoveryRequiredError(
      "reference drift",
      new Error("original"),
      [join(f.root, "retained-reference")],
    );
    assert.throws(
      () => guarded.cleanup(inherited),
      (error) => {
        const recovery = validationRecoveryRequired(error);
        assert.ok(recovery);
        assert.ok(recovery.recoveryPaths.has(owned));
        assert.equal(recovery, inherited);
        assert.ok(recovery.recoveryPaths.has(join(f.root, "retained-reference")));
        return true;
      },
    );
    assert.equal(
      existsSync(movedKind === "source" ? join(moved, "source.txt") : join(moved, "42/source.txt")),
      true,
    );
    renameSync(moved, original);
    assert.equal(guarded.cleanup(), false);
  }
  const cachedProbe = runtime.runReviewCheckoutInspection({
    itemNumber: 42,
    openclawDir: source,
    timeoutMs: 10_000,
    scanSource: { kind: "committed", baseSha: trusted, headSha: head },
    initialPrompt: "cached review context",
    disableSkills: true,
  });
  assert.equal(cachedProbe.status, 7);
  const cached = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(cached.cwd, source);
  assert.deepEqual(cached.config.agents.defaults.skills, []);
  assert.equal(cached.config.tools.fs.workspaceOnly, true);
  const pinnedSource = mkdtempSync(join(tmpdir(), "clawsweeper-pinned-codex-test-"));
  t.after(() => rmSync(pinnedSource, { recursive: true, force: true }));
  symlinkSync(pinnedSource, join(owned, "codex"), "dir");
  assert.throws(() => materializeNativeReviewSkills(config, source, owned), /isolated owned/);
  assert.throws(
    () => materializeNativeReviewSkills(config, source, owned, f.root),
    /isolated owned/,
  );
  const withSibling = materializeNativeReviewSkills(config, source, owned, pinnedSource);
  assert.equal(withSibling.cwd, owned);
  withSibling.cleanup();
  assert.equal(existsSync(join(owned, "codex")), true);
  assert.equal(existsSync(source), true);
  const replaced = materializeNativeReviewSkills(config, source, owned, pinnedSource);
  rmSync(join(owned, "codex"));
  symlinkSync(f.root, join(owned, "codex"), "dir");
  assert.throws(
    () => replaced.cleanup(),
    (error) => {
      assert.ok(validationRecoveryRequired(error));
      return true;
    },
  );
  assert.equal(readlinkSync(join(owned, "codex")), f.root);
  assert.equal(existsSync(join(owned, ".agents")), true);
  assert.equal(existsSync(source), true);
  rmSync(join(owned, ".agents"), { recursive: true });
  rmSync(join(owned, "codex"));
  mkdirSync(join(owned, "codex"));
  assert.throws(
    () => materializeNativeReviewSkills(config, source, owned, pinnedSource),
    /isolated owned/,
  );
  rmSync(join(owned, "codex"), { recursive: true });
  mkdirSync(join(owned, "other-source"));
  assert.throws(() => materializeNativeReviewSkills(config, source, owned), /isolated owned/);
  assert.equal(existsSync(join(owned, ".agents")), false);
});

test("repository config invalidates content reuse without changing admission policy", (t) => {
  const f = fixture(t);
  f.configure({ version: 1, additionalPrompt: "FIRST" });
  const first = loadRepositoryReviewConfig(f.root, f.commit())!;
  f.configure({ version: 1, additionalPrompt: "SECOND" });
  const second = loadRepositoryReviewConfig(f.root, f.commit())!;
  const item = {
    repo: "steipete/fixture",
    number: 1,
    kind: "pull_request" as const,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
  };
  const review = {
    reviewStatus: "complete",
    decision: "keep_open",
    reviewPolicy: "host-policy",
    reviewedAt: "2026-10-22T00:00:00Z",
    lastFullReviewAt: "2026-10-22T00:00:00Z",
    itemUpdatedAt: item.updatedAt,
    lastFullReviewDecision: "keep_open",
    contentDigest: repositoryReviewContentDigest("item-content", first),
  };
  const now = Date.parse(review.reviewedAt) + 60_000;
  assert.equal(shouldReviewItem(item, review, now, "host-policy"), false);
  const cached = (config?: typeof first) =>
    reviewContentCacheHit({
      review,
      reviewPolicy: "host-policy",
      contentDigest: repositoryReviewContentDigest("item-content", config),
      now,
      explicitDispatch: false,
      maintainerRequest: false,
    });
  assert.equal(cached(first), true);
  assert.equal(cached(second), false);
  assert.equal(cached(undefined), false);
  assert.equal(shouldReviewItem(item, review, now, "host-policy"), false);
});

test("hosted blob:none hydration batches the full bounded native bundle", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  for (let i = 0; i < 62; i++)
    f.put(".agents/skills/sample/references/note-" + i + ".md", "unique reference " + i);
  const revision = f.commit();
  f.git("config", "uploadpack.allowFilter", "true");
  const clone = mkdtempSync(join(tmpdir(), "clawsweeper-native-partial-"));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(f.root).href, clone],
    { stdio: "pipe" },
  );
  const missing = () =>
    execFileSync("git", ["rev-list", "--objects", "--missing=print", revision], {
      cwd: clone,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.startsWith("?")).length;
  const before = missing();
  assert.ok(before >= 65);
  assert.throws(() => loadRepositoryReviewConfig(clone, revision), /Cannot read pinned/);
  const trace = join(clone, ".git", "fetch.trace");
  const priorTrace = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = trace;
    const config = loadRepositoryReviewConfig(clone, revision, {
      allowFetch: true,
      resolveBlobSizes: (ids) =>
        new Map(ids.map((id) => [id, Number(f.git("cat-file", "-s", id))])),
    })!;
    assert.equal(config.files.length, 64);
    assert.equal(config.digest, loadRepositoryReviewConfig(f.root, revision)!.digest);
    assert.equal(missing(), before - 65);
    const uploads = readFileSync(trace, "utf8")
      .split("\n")
      .filter((line) => line.includes("built-in: git upload-pack"));
    assert.equal(uploads.length, 2, readFileSync(trace, "utf8"));
  } finally {
    if (priorTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = priorTrace;
  }
});

test("model configuration changes invalidate content but never reopen ordinary admission", (t) => {
  const f = fixture(t);
  const role = { runner: "codex", model: "first-model" };
  f.configure({ version: 1, multiModel: { reviewers: [role, role], coordinator: role } });
  const first = loadRepositoryReviewConfig(f.root, f.commit())!;
  f.configure({
    version: 1,
    multiModel: { reviewers: [{ ...role, model: "second-model" }, role], coordinator: role },
  });
  const second = loadRepositoryReviewConfig(f.root, f.commit())!;
  const item = {
    repo: "steipete/fixture",
    number: 1,
    kind: "pull_request" as const,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
  };
  const review = {
    reviewStatus: "complete",
    decision: "keep_open",
    reviewPolicy: "host-policy",
    reviewedAt: "2026-10-22T00:00:00Z",
    lastFullReviewAt: "2026-10-22T00:00:00Z",
    itemUpdatedAt: item.updatedAt,
    lastFullReviewDecision: "keep_open",
    contentDigest: repositoryReviewContentDigest("item-content", first),
  };
  const now = Date.parse(review.reviewedAt) + 60_000;
  assert.notEqual(
    repositoryReviewContentDigest("item-content", first),
    repositoryReviewContentDigest("item-content", second),
  );
  assert.equal(
    reviewContentCacheHit({
      review,
      reviewPolicy: "host-policy",
      contentDigest: repositoryReviewContentDigest("item-content", second),
      now,
      explicitDispatch: false,
      maintainerRequest: false,
    }),
    false,
  );
  assert.equal(shouldReviewItem(item, review, now, "host-policy"), false);
});

for (const mode of ["config-budget", "bundle-budget", "disk-budget"] as const)
  test("hosted native bundle admits bytes and disk before hydration: " + mode, (t) => {
    const f = fixture(t);
    f.configure();
    f.skill();
    if (mode === "config-budget") f.put(".clawsweeper/review.json", "x".repeat(17 * 1024));
    if (mode === "bundle-budget")
      f.put(".agents/skills/sample/references/large.bin", Buffer.alloc(512 * 1024));
    const revision = f.commit();
    f.git("config", "uploadpack.allowFilter", "true");
    const clone = mkdtempSync(join(tmpdir(), "clawsweeper-bounded-config-"));
    t.after(() => rmSync(clone, { recursive: true, force: true }));
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(f.root).href, clone],
      { stdio: "pipe" },
    );
    const missing = () =>
      execFileSync("git", ["rev-list", "--objects", "--missing=print", revision], {
        cwd: clone,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("?")).length;
    const before = missing(),
      original = fs.statfsSync;
    try {
      if (mode === "disk-budget") {
        fs.statfsSync = ((...args: Parameters<typeof fs.statfsSync>) => ({
          ...original(...args),
          bavail: 0,
        })) as typeof fs.statfsSync;
        syncBuiltinESMExports();
      }
      assert.throws(
        () =>
          loadRepositoryReviewConfig(clone, revision, {
            allowFetch: true,
            resolveBlobSizes: (ids) =>
              new Map(ids.map((id) => [id, Number(f.git("cat-file", "-s", id))])),
          }),
        /budget|available|capacity/,
      );
    } finally {
      fs.statfsSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(missing(), before - (mode === "bundle-budget" ? 1 : 0));
  });

test("selected native Codex skills retain the same-thread decision repair lifecycle", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const config = loadRepositoryReviewConfig(f.root, f.commit())!;
  const bin = useFakeScanner(t),
    binary = join(bin, "native-repair"),
    calls = join(bin, "repair-calls.jsonl"),
    output = join(bin, "repair-result.json");
  const session = "019f0560-0000-7000-8000-0000000000a1",
    valid = closeDecision({ decision: "keep_open", closeReason: "none" });
  writeFileSync(
    binary,
    "#!" +
      process.execPath +
      '\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.readFileSync(0,"utf8");fs.appendFileSync(' +
      JSON.stringify(calls) +
      ',JSON.stringify(args)+"\\n");process.stderr.write(' +
      JSON.stringify(
        "OpenAI Codex v0.0.0\n--------\nsandbox: read-only\nsession id: " +
          session +
          "\n--------\nuser\n",
      ) +
      ');console.log(args.includes("resume")?' +
      JSON.stringify(JSON.stringify(valid)) +
      ":" +
      JSON.stringify('{"decision":"keep_open"}') +
      ");",
    { mode: 0o755 },
  );
  const result = runAgentProcess({
    label: "native-skill-repair",
    prompt: "Review",
    scanSource: { kind: "prompt" },
    model: "internal",
    cwd: f.root,
    env: { ...process.env, CODEX_BIN: binary },
    timeoutMs: 10000,
    repositoryReview: config,
    decisionRepair: { item: item({ kind: "pull_request" }) },
    outputLastMessageBytes: 128 * 1024,
    codexExtraArgs: [
      "-C",
      f.root,
      "--sandbox",
      "read-only",
      "--output-last-message",
      output,
      "--json",
      "-",
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].at(-1), "-");
  assert.deepEqual(rows[1], [...rows[0].slice(0, -1), "resume", session, "-"]);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).decision, "keep_open");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("public model selection preserves nested native model namespaces", (t) => {
  const f = fixture(t),
    native = { runner: "openclaw", model: "fixture/vendor/model" };
  f.configure({ version: 1, multiModel: { reviewers: [native, native], coordinator: native } });
  const config = loadRepositoryReviewConfig(f.root, f.commit())!;
  assert.equal(config.multiModel!.reviewers[0]!.model, "fixture/vendor/model");
  assert.equal(config.multiModel!.coordinator.model, "fixture/vendor/model");
});

for (const runner of ["codex", "openclaw"] as const)
  test("final native prompt bytes are admitted before retention or assessment: " + runner, (t) => {
    const f = fixture(t);
    f.configure({ version: 1, skills: ["sample"], additionalPrompt: "é".repeat(8) });
    f.skill();
    const config = loadRepositoryReviewConfig(f.root, f.commit())!;
    const bin = useFakeScanner(t),
      binary = join(bin, "budget-runner");
    const receipt = join(bin, "called.json"),
      diagnostic = join(bin, "prompt.md");
    const schema = join(bin, "schema.json"),
      scratch = join(bin, "native-temp");
    mkdirSync(scratch);
    writeFileSync(schema, JSON.stringify({ type: "object", description: "é".repeat(20) }));
    writeFileSync(
      binary,
      "#!" +
        process.execPath +
        String.fromCharCode(10) +
        'const fs=require("node:fs"),args=process.argv.slice(2);const prompt=args[0]==="agent"?fs.readFileSync(args[args.indexOf("--message-file")+1],"utf8"):fs.readFileSync(0,"utf8");fs.writeFileSync(' +
        JSON.stringify(receipt) +
        ',JSON.stringify({prompt}));console.log(JSON.stringify({payloads:[{text:"done"}]}));',
      { mode: 0o755 },
    );
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const options = {
        label: "prompt-budget",
        prompt: "BASE",
        scanSource: { kind: "prompt" as const },
        model: "internal",
        cwd: f.root,
        timeoutMs: 10000,
        repositoryReview: config,
        diagnosticPromptPath: diagnostic,
        env: {
          ...process.env,
          CLAWSWEEPER_RUNNER: runner,
          CODEX_BIN: binary,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          CLAWSWEEPER_OPENCLAW_MODEL: "openai/test",
        },
        ...(runner === "openclaw"
          ? { nativeWorkspace: { cwd: f.root, prompt: "PINNED NATIVE é" } }
          : {}),
        codexExtraArgs: ["-C", f.root, "--sandbox", "read-only", "--output-schema", schema, "-"],
      };
      assert.equal(runAgentProcess(options).status, 0);
      const prompt = JSON.parse(readFileSync(receipt, "utf8")).prompt as string;
      const bytes = Buffer.byteLength(prompt);
      assert.ok(bytes > prompt.length);
      assert.equal(Buffer.byteLength(readFileSync(diagnostic, "utf8")), bytes);
      assert.equal(runAgentProcess({ ...options, promptFileBytes: bytes }).status, 0);
      rmSync(receipt);
      assert.throws(
        () => runAgentProcess({ ...options, promptFileBytes: bytes - 1 }),
        (error) => {
          assert.match((error as Error).message, /prompt exceeded/);
          const runtime = createReviewRuntime({} as Parameters<typeof createReviewRuntime>[0]);
          assert.equal(runtime.codexReviewFailureRetryable(error), false);
          return true;
        },
      );
      assert.equal(existsSync(receipt), false);
      assert.equal(existsSync(diagnostic), false);
      assert.deepEqual(
        fs.readdirSync(scratch).filter((name) => name.startsWith("clawsweeper-native-skills-")),
        [],
      );
      assert.equal(
        runAgentProcess({ ...options, diagnosticPromptPath: undefined, promptFileBytes: 0 }).status,
        0,
      );
      assert.equal(existsSync(diagnostic), false);
      assert.equal(f.git("status", "--porcelain"), "");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

test("authenticated repository preparation accepts canonical GitHub SSH URLs only", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", f.root);
  let origin = "";
  const runtime = createReviewRuntime({
    targetRepo: () => "steipete/fixture",
    ghJson: () => ({ full_name: "steipete/fixture", default_branch: "main" }),
    run: (command: string, args: string[], options: { cwd?: string } = {}) =>
      args.join(" ") === "remote get-url origin"
        ? origin
        : execFileSync(command, args, { ...options, encoding: "utf8" }),
  } as Parameters<typeof createReviewRuntime>[0]);
  for (const url of [
    "https://github.com/steipete/fixture.git",
    "https://github.com/steipete/fixture/",
    "https://github.com:443/steipete/fixture.git",
    "git@github.com:steipete/fixture",
    "ssh://git@github.com/steipete/fixture.git",
    "ssh://git@github.com:22/steipete/fixture",
    "ssh://git@ssh.github.com:443/steipete/fixture.git",
  ]) {
    origin = url;
    assert.equal(runtime.repositoryReviewConfig(f.root), undefined, url);
  }
  for (const url of [
    "ssh://git@github.com.evil/steipete/fixture.git",
    "ssh://git@github.com:443/steipete/fixture.git",
    "ssh://git@github.com/other/fixture.git",
    "https://github.com@evil/steipete/fixture.git",
  ]) {
    origin = url;
    assert.throws(() => runtime.repositoryReviewConfig(f.root), /canonical target origin/);
  }
  assert.equal(f.git("status", "--porcelain"), "");
});
