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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  loadLocalRepositoryReviewConfig,
  loadRepositoryReviewConfig,
  repositoryReviewContentDigest,
} from "../dist/repository-review-config.js";
import { runAgentProcess } from "../dist/agent-runner.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
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
  const configure = (value: unknown = { version: 1, additionalPrompt: "APPENDED" }) =>
    put(".clawsweeper/review.json", JSON.stringify(value));
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

test("trusted scheduling config ignores head overrides and does not validate or pin native skills", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  const trusted = f.commit();
  const first = loadRepositoryReviewConfig(f.root, trusted)!;
  f.configure({ version: 1, additionalPrompt: "HEAD_OVERRIDE" });
  f.skill("HEAD_GUIDANCE [ordinary native reference](../../outside.md)");
  f.commit();
  const config = loadLocalRepositoryReviewConfig(f.root, trusted)!;
  assert.equal(config.revision, trusted);
  assert.equal(config.additionalPrompt, "APPENDED");
  assert.deepEqual(Object.keys(config).sort(), [
    "additionalPrompt",
    "configText",
    "digest",
    "revision",
  ]);
  assert.equal(config.digest, first.digest);
  f.configure();
  f.put(".agents/skills/sample/SKILL.md", "No frontmatter [native reference](../../outside.md)\0");
  const next = loadRepositoryReviewConfig(f.root, f.commit())!;
  assert.equal(next.digest, first.digest, "native source is not a custom bundle digest");
  assert.equal(next.additionalPrompt, "APPENDED");
});

for (const value of [
  null,
  [],
  { version: 2 },
  { version: 1, skills: [] },
  { version: 1, skills: ["sample"] },
  { version: 1, additionalPrompt: null },
  { version: 1, additionalPrompt: 4 },
  { version: 1, additionalPrompt: "x".repeat(5001) },
  { version: 1, multiModel: {} },
  { version: 1, endpoint: "https://invalid.example" },
])
  test("strict scheduling schema rejects " + JSON.stringify(value).slice(0, 70), (t) => {
    const f = fixture(t);
    f.configure(value);
    assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
  });

for (const native of [false, true])
  for (const models of [false, true])
    test(
      "native files and host model scheduling are independent native=" +
        native +
        " models=" +
        models,
      (t) => {
        const f = fixture(t);
        if (native) f.skill();
        const role = {
          runner: "codex",
          model: "fixture",
          reasoningEffort: "high",
          contextTier: "default",
        };
        f.configure({
          version: 1,
          ...(models ? { multiModel: { reviewers: [role, role], coordinator: role } } : {}),
        });
        const head = f.commit(),
          config = loadRepositoryReviewConfig(f.root, head);
        assert.equal(Boolean(config?.multiModel), models);
        assert.equal(Boolean(config), models);
        assert.equal(config ? "skills" in config : false, false);
        if (config) assert.equal(config.revision, head);
      },
    );

for (const mode of ["symlink", "invalid-utf8", "oversize"])
  test("configuration raw file admission rejects " + mode, (t) => {
    const f = fixture(t);
    f.configure();
    if (mode === "symlink") {
      rmSync(join(f.root, ".clawsweeper/review.json"));
      symlinkSync("../source.txt", join(f.root, ".clawsweeper/review.json"));
    }
    if (mode === "invalid-utf8") f.put(".clawsweeper/review.json", Buffer.from([255]));
    if (mode === "oversize") f.put(".clawsweeper/review.json", " ".repeat(17 * 1024));
    assert.throws(() => loadRepositoryReviewConfig(f.root, f.commit()));
  });

for (const runner of ["codex", "openclaw"] as const)
  test(
    "native runner keeps actual source CWD and leaves skill discovery to the harness: " + runner,
    (t) => {
      const f = fixture(t);
      f.configure({
        version: 1,
        additionalPrompt: "Use the native sample skill; return the normal Decision.",
      });
      f.skill("SAME_HEAD_NATIVE_GUIDANCE");
      const config = loadRepositoryReviewConfig(f.root, f.commit())!;
      const bin = useFakeScanner(t),
        binary = join(bin, "native-cwd"),
        receipt = join(bin, "native-cwd.json");
      writeFileSync(
        binary,
        "#!" +
          process.execPath +
          '\nconst fs=require("node:fs"),path=require("node:path"),a=process.argv.slice(2),native=a[0]==="agent",config=native?JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,"utf8")):undefined,prompt=native?fs.readFileSync(a[a.indexOf("--message-file")+1],"utf8"):fs.readFileSync(0,"utf8");fs.writeFileSync(' +
          JSON.stringify(receipt) +
          ',JSON.stringify({cwd:process.cwd(),args:a,config,prompt,skill:fs.readFileSync(path.join(process.cwd(),".agents/skills/sample/SKILL.md"),"utf8")}));console.log(native?JSON.stringify({payloads:[{text:"done"}]}):"done");',
        { mode: 0o755 },
      );
      const r = runAgentProcess({
        label: "native-cwd",
        prompt: "BASE_CONTRACT",
        scanSource: { kind: "prompt" },
        model: "internal",
        cwd: f.root,
        env: {
          ...process.env,
          CLAWSWEEPER_RUNNER: runner,
          CODEX_BIN: binary,
          CLAWSWEEPER_OPENCLAW_BIN: binary,
          CLAWSWEEPER_OPENCLAW_MODEL: "fixture/native",
        },
        timeoutMs: 10000,
        repositoryReview: config,
        codexExtraArgs: ["-C", f.root, "--sandbox", "read-only", "-"],
      });
      assert.equal(r.status, 0, r.stderr);
      const sent = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(sent.cwd, f.root);
      assert.match(sent.skill, /SAME_HEAD_NATIVE_GUIDANCE/);
      assert.match(sent.prompt, /BASE_CONTRACT/);
      assert.match(sent.prompt, /Use the native sample skill/);
      assert.ok(!sent.prompt.includes("SAME_HEAD_NATIVE_GUIDANCE"));
      assert.ok(!sent.prompt.includes("[$sample]"));
      assert.ok(!sent.args.includes("project_root_markers=[]"));
      assert.ok(!sent.args.includes("--skip-git-repo-check"));
      if (runner === "openclaw") {
        assert.equal(sent.config.agents.defaults.workspace, f.root);
        assert.equal(sent.config.agents.defaults.skills, undefined);
      } else assert.equal(sent.args[sent.args.indexOf("-C") + 1], f.root);
      assert.equal(f.git("status", "--porcelain"), "");
    },
  );

function partialClone(t: TestContext, source: string) {
  execFileSync("git", ["config", "uploadpack.allowFilter", "true"], { cwd: source });
  const clone = mkdtempSync(join(tmpdir(), "clawsweeper-config-partial-"));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", pathToFileURL(source).href, clone],
    { stdio: "pipe" },
  );
  return clone;
}
function missingObjects(clone: string, revision: string) {
  return execFileSync("git", ["rev-list", "--objects", "--missing=print", revision], {
    cwd: clone,
    encoding: "utf8",
  })
    .split("\n")
    .filter((s) => s.startsWith("?"));
}

test("hosted config hydration admits only its JSON blob, not native skill bundles", (t) => {
  const f = fixture(t);
  f.configure();
  f.skill();
  for (let i = 0; i < 70; i++)
    f.put(".agents/skills/sample/reference-" + i + ".md", "native ordinary source " + i);
  const revision = f.commit(),
    clone = partialClone(t, f.root),
    before = missingObjects(clone, revision);
  assert.ok(before.length > 64);
  assert.throws(() => loadRepositoryReviewConfig(clone, revision), /Cannot read pinned/);
  assert.equal(missingObjects(clone, revision).length, before.length);
  const requested: string[][] = [];
  const config = loadRepositoryReviewConfig(clone, revision, {
    allowFetch: true,
    resolveBlobSizes: (ids) => {
      requested.push([...ids]);
      return new Map(ids.map((id) => [id, Number(f.git("cat-file", "-s", id))]));
    },
  })!;
  assert.deepEqual(requested, [[f.git("rev-parse", revision + ":.clawsweeper/review.json")]]);
  assert.equal(config.digest, loadRepositoryReviewConfig(f.root, revision)!.digest);
  assert.equal(missingObjects(clone, revision).length, before.length - 1);
});

for (const mode of ["bytes", "disk"])
  test("config byte/disk admission refuses before missing-object hydration: " + mode, (t) => {
    const f = fixture(t);
    f.configure();
    if (mode === "bytes") f.put(".clawsweeper/review.json", " ".repeat(17 * 1024));
    const revision = f.commit(),
      clone = partialClone(t, f.root),
      before = missingObjects(clone, revision),
      original = fs.statfsSync;
    try {
      if (mode === "disk") {
        t.mock.method(fs, "statfsSync", (...args: Parameters<typeof fs.statfsSync>) => ({
          ...original(...args),
          bavail: 0,
        }));
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
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(missingObjects(clone, revision).length, before.length);
  });

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

test("native source CWD retains the same-thread structured Decision repair lifecycle", (t) => {
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
    f.configure({ version: 1, additionalPrompt: "é".repeat(8) });
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
