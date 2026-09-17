import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { scheduledReviewSemanticSourceRevision } from "../../src/scheduled-review-noop.ts";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "../..");
const workflowPath = ".github/workflows/sweep.yml";
const classifierPath = "src/scheduled-review-noop.ts";
const legacyClassifierPath = "scripts/classify-scheduled-review-noop.ts";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const hotAction = "scheduled_hot_intake";
const sha = "a".repeat(40);

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 60_000, ...options });
  // Never include raw ghx responses, credentials, or host paths in proof errors.
  assert.equal(result.status, 0, `${file.split("/").at(-1)} failed (${result.status})`);
  return result.stdout;
}

function source(ref, path) {
  return ref
    ? command("git", ["show", `${ref}:${path}`], { cwd: root })
    : readFileSync(join(root, path), "utf8");
}

function treeHash(directory, suffix) {
  const files = readdirSync(join(root, directory), { recursive: true })
    .filter((name) => name.endsWith(suffix))
    .sort();
  return hash(
    files.map((name) => `${name}\0${hash(readFileSync(join(root, directory, name)))}\n`).join(""),
  );
}

function buildInputs() {
  return {
    source: treeHash("src", ".ts"),
    runtimeConfig: treeHash("config", ".json"),
    configs: Object.fromEntries(
      [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "tsconfig.repair.json",
        "tsconfig.dashboard.json",
      ].map((name) => [name, hash(readFileSync(join(root, name)))]),
    ),
  };
}

function snapshot(ref, capsule, runtimes) {
  const input = (path) => (capsule ? capsule.files[path].text : source(ref, path));
  const workflowSource = input(workflowPath);
  const workflow = YAML.parse(workflowSource);
  const shell = (capsule ? workflow : workflow.jobs["event-review-apply"].steps).find(
    (step) => step.id === "live-item",
  )?.run;
  assert.equal(typeof shell, "string");
  const native = shell.includes("workflow -- exact-review-admission");
  const classifier = input(native ? classifierPath : legacyClassifierPath);
  const owners = native
    ? [
        classifierPath,
        "src/repair/exact-review-admission.ts",
        "src/repair/workflow-utils.ts",
        "src/repair/github-cli.ts",
        "src/repair/process-env.ts",
        "src/github-public-read.ts",
        "src/github-retry.ts",
        "src/clawsweeper-oversized-pr-policy.ts",
      ]
    : ["src/clawsweeper-oversized-pr-policy.ts"];
  // A ref label cannot attest which compiled owner ran. Bind the inputs to
  // this checkout and freeze the emitted tree used by each subprocess.
  const inputs = Object.fromEntries(
    owners.map((name) => {
      const text = input(name);
      assert.equal(text, source(undefined, name), `compiled checkout differs from ${name}`);
      return [name, hash(text)];
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), "exact-review-read-runtime-"));
  // Register before copying so partial construction shares the proof cleanup.
  runtimes.push(directory);
  cpSync(join(root, "dist"), join(directory, "dist"), { recursive: true });
  cpSync(join(root, "config"), join(directory, "config"), { recursive: true });
  // pnpm verifies dependencies before running a script and may reinstall.
  // Give that lifecycle its own files; a borrowed node_modules symlink lets
  // fixture manifests reconcile the source checkout's active installation.
  const modules = realpathSync(join(root, "node_modules"));
  cpSync(modules, join(directory, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
    filter(path) {
      if (lstatSync(path).isSymbolicLink()) {
        assert.ok(!isAbsolute(readlinkSync(path)), "fixture dependency link must be relative");
        assert.ok(
          realpathSync(path).startsWith(`${modules}${sep}`),
          "fixture dependency link must stay within the install",
        );
      }
      return true;
    },
  });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    cpSync(join(root, name), join(directory, name));
  }
  return {
    shell,
    classifier,
    native,
    directory,
    hashes: {
      workflow: hash(workflowSource),
      shell: hash(shell),
      classifier: hash(classifier),
      inputs,
      compiled: treeHash("dist", ".js"),
    },
  };
}

function scenarios() {
  const cases = [];
  for (const kind of ["issue", "pull_request"]) {
    const issue = {
      number: 41,
      title: "Read-scope fixture",
      body: "Synthetic issue body",
      state: "open",
      locked: false,
      updated_at: "2026-08-09T21:12:38Z",
      labels: [],
      ...(kind === "pull_request" ? { pull_request: {} } : {}),
    };
    const comments = Array.from({ length: 101 }, (_, i) => ({
      id: i + 1,
      user: { login: "reporter" },
      body: `Synthetic evidence ${i}`,
      updated_at: "2026-08-09T19:00:00Z",
    }));
    const revision = scheduledReviewSemanticSourceRevision(issue, comments);
    comments.push({
      id: 102,
      user: { login: "clawsweeper[bot]" },
      body: `<!-- clawsweeper-review-version sha=${kind === "pull_request" ? sha : "na"} source_revision=${revision} -->`,
      updated_at: "2026-08-09T21:12:33Z",
    });
    const make = (name, sourceAction, extra = {}) => ({
      name: `${kind}:${name}`,
      repo: "example/project",
      number: 41,
      issue,
      comments,
      head: sha,
      decision: { sourceAction, sourceUpdatedAt: issue.updated_at, targetBranch: "main" },
      expected: { proceed: "true", scheduled_semantic_noop: "false" },
      ...extra,
    });
    for (const [name, action] of [
      ["normal", "scheduled_normal_backfill"],
      ["command", "review"],
      ["event", "edited"],
      ["absent", undefined],
      ["near-match", `${hotAction} `],
      ["array", [hotAction]],
    ]) {
      cases.push(make(name, action));
    }
    cases.push(
      make("hot-unchanged", hotAction, {
        expected: { proceed: "false", scheduled_semantic_noop: "true" },
      }),
      make("hot-human", hotAction, {
        comments: [
          ...comments,
          {
            id: 103,
            user: { login: "maintainer" },
            body: "New synthetic evidence",
            updated_at: "2026-08-09T21:12:35Z",
          },
        ],
      }),
      make("hot-comment-failure", hotAction, { failure: "comments" }),
      make("hot-classifier-failure", hotAction, { comments: { invalid: true } }),
    );
    if (kind === "pull_request") {
      cases.push(
        make("hot-head-change", hotAction, { head: "b".repeat(40) }),
        make("hot-head-failure", hotAction, { failure: "head" }),
      );
    }
    for (const action of ["scheduled_normal_backfill", hotAction]) {
      const prefix = action === hotAction ? "hot" : "nonhot";
      cases.push(
        make(`${prefix}-closed`, action, {
          issue: { ...issue, state: "closed" },
          expected: { proceed: "false", terminal_noop: "true" },
        }),
        make(`${prefix}-locked`, action, {
          issue: { ...issue, locked: true },
          expected: { proceed: "false", guarded_open_action: "skipped_locked_conversation" },
        }),
        make(`${prefix}-missing`, action, {
          failure: "missing",
          expected: { proceed: "false", terminal_missing: "true" },
        }),
        make(`${prefix}-throttle`, action, {
          failure: "throttle",
          expected: { proceed: "false", admission_retry: "true", retry_kind: "throttle" },
        }),
        make(`${prefix}-read-failure`, action, { failure: "issue", status: 1, expected: {} }),
      );
    }
    cases.push(
      make("branch-resolution", "edited", {
        decision: { sourceAction: "edited", targetBranch: "0" },
        expected: { proceed: "true", target_branch: "trunk" },
      }),
      make("branch-failure", "edited", {
        decision: { sourceAction: "edited", targetBranch: "" },
        failure: "repo",
        expected: { proceed: "false", admission_retry: "true" },
      }),
      make("missing-inaccessible", "edited", {
        failure: "inaccessible",
        status: 1,
        expected: {},
      }),
    );
  }
  const issue = cases.find((entry) => entry.name === "pull_request:hot-unchanged");
  const core = (name, extra = {}) => ({
    ...issue,
    name: `quota:${name}`,
    repo: "openclaw/openclaw",
    candidateOnly: true,
    expected: { proceed: "true", scheduled_semantic_noop: "false" },
    ...extra,
  });
  cases.push(
    core("mandatory-fallback", {
      baselineExpected: { proceed: "false", admission_retry: "true", retry_kind: "throttle" },
      tokenFailures: {
        "actions:issue": "HTTP 429",
        "actions:head": "HTTP 429",
        "actions:comments": "HTTP 429",
      },
      credentials: ["actions:issue", "app:issue", "actions:head", "actions:comments"],
      warnings: ["Unable to read PR admission metadata", "Unable to read comments"],
    }),
    core("optional-fallback-once", {
      tokenFailures: { "actions:head": "HTTP 429", "actions:comments": "HTTP 429" },
      credentials: ["actions:issue", "actions:head", "app:head", "actions:comments"],
      warnings: ["Unable to read comments"],
    }),
    core("comments-fallback", {
      tokenFailures: { "actions:comments": "HTTP 429" },
      credentials: [
        "actions:issue",
        "actions:head",
        "actions:comments",
        "app:comments",
        "app:comments",
      ],
      expected: { proceed: "false", scheduled_semantic_noop: "true" },
    }),
    core("both-throttled", {
      tokenFailures: { "actions:issue": "HTTP 429", "app:issue": "HTTP 429" },
      credentials: ["actions:issue", "app:issue"],
      expected: { proceed: "false", admission_retry: "true", retry_kind: "throttle" },
    }),
    core("missing-app", {
      appToken: "",
      credentials: ["actions:issue", "actions:head", "actions:comments", "actions:comments"],
      expected: { proceed: "false", scheduled_semantic_noop: "true" },
    }),
    core("missing-app-branch", {
      appToken: "",
      decision: { targetBranch: "0" },
      credentials: ["actions:repo", "actions:issue", "actions:head"],
      expected: { proceed: "true", target_branch: "trunk" },
    }),
    core("missing-app-404", {
      appToken: "",
      failure: "missing",
      credentials: ["actions:issue", "actions:repo"],
      expected: { proceed: "false", terminal_missing: "true" },
    }),
    core("missing-app-root-failure", {
      appToken: "",
      failure: "inaccessible",
      status: 1,
      credentials: ["actions:issue", "actions:repo"],
      expected: {},
    }),
    core("fallback-404-root-throttle", {
      tokenFailures: {
        "actions:issue": "HTTP 429",
        "app:issue": "HTTP 404 Not Found",
        "actions:repo": "HTTP 429",
      },
      credentials: ["actions:issue", "app:issue", "actions:repo"],
      status: 1,
      expected: {},
    }),
    core("branch-throttle", {
      decision: { targetBranch: "0" },
      tokenFailures: { "actions:repo": "HTTP 429" },
      credentials: ["actions:repo"],
      expected: { proceed: "false", admission_retry: "true" },
    }),
    core("missing-actions", { publicToken: "", credentials: [], status: 1, expected: {} }),
    core("private-missing-app", {
      repo: "example/private",
      appToken: "",
      credentials: [],
      status: 1,
      expected: {},
    }),
    core("private-app", {
      repo: "example/private",
      credentials: ["app:issue", "app:head", "app:comments", "app:comments"],
      expected: { proceed: "false", scheduled_semantic_noop: "true" },
    }),
    core("oversized", {
      additions: 50001,
      credentials: ["actions:issue", "actions:head"],
      expected: { proceed: "true", oversized: "true" },
    }),
    ...[
      ["boundary", { additions: 50000 }],
      [
        "exempt",
        { additions: 166686, issue: { ...issue.issue, labels: ["size: accepted-large"] } },
      ],
      ["unknown-size", { missingAdditions: true }],
    ].map(([name, size]) =>
      core(`oversized-${name}`, {
        ...size,
        decision: { targetBranch: "main" },
        credentials: ["actions:issue", "actions:head"],
        expected: { proceed: "true", oversized: "false" },
      }),
    ),
  );
  return cases;
}

function trace(event) {
  appendFileSync(process.env.READ_SCOPE_TRACE, `${JSON.stringify(event)}\n`);
}

function liveGet(endpoint) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  // ghx wrappers must resolve the real gh, not this proof's recording adapter.
  env.PATH = process.env.READ_SCOPE_GHX_PATH ?? process.env.PATH;
  const raw = command("ghx", ["--no-cache", "api", "--method", "GET", "--include", endpoint], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const split = raw.search(/\r?\n\r?\n/);
  assert.ok(split >= 0, "ghx must include response headers for page accounting");
  const headers = raw.slice(0, split);
  assert.match(headers, /^HTTP\/[\d.]+ 200\b/);
  const next = headers.match(/^link:.*?<([^>]+)>;\s*rel="next"/im)?.[1];
  return { body: JSON.parse(raw.slice(split).trim()), next };
}

function ghAdapter(args) {
  const config = JSON.parse(readFileSync(process.env.READ_SCOPE_CONFIG, "utf8"));
  const [api, ...flags] = args;
  const credential =
    process.env.GH_TOKEN === "proof-actions"
      ? "actions"
      : process.env.GH_TOKEN === "proof-app"
        ? "app"
        : "unexpected";
  assert.notEqual(credential, "unexpected", "ambient or unknown credential must not be used");
  assert.equal(api, "api");
  const endpoint = flags.find((flag) => flag.startsWith("repos/"));
  const base = `repos/${config.repo}`;
  const endpoints = {
    [base]: "repo",
    [`${base}/issues/${config.number}`]: "issue",
    [`${base}/pulls/${config.number}`]: "head",
    [`${base}/issues/${config.number}/comments?per_page=100`]: "comments",
  };
  const kind = endpoints[endpoint];
  assert.ok(kind, "proof adapter refuses unrelated endpoints");
  if (config.native) assert.equal(flags[0], endpoint, "native reads must be endpoint-first");
  const query = flags.includes("--jq") ? flags[flags.indexOf("--jq") + 1] : undefined;
  const expectedArgs = [
    endpoint,
    ...(query ? ["--jq", query] : []),
    ...(kind === "comments" ? ["--paginate", "--slurp"] : []),
  ];
  assert.deepEqual([...flags].sort(), expectedArgs.sort(), "proof adapter is GET-only");
  assert.ok(!query || query === ".head.sha" || query === ".default_branch // empty");
  let body;
  if (config.live) {
    let next = endpoint;
    const pages = [];
    do {
      const url = next.startsWith("repos/")
        ? new URL(`https://api.github.com/${next}`)
        : new URL(next);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, `/${endpoint.split("?")[0]}`);
      const response = liveGet(`${url.pathname.slice(1)}${url.search}`);
      trace({
        kind,
        credential,
        method: "GET",
        endpoint: `${url.pathname.slice(1)}${url.search}`,
        status: 200,
        ...(kind === "head" ? { headSha: response.body.head.sha } : {}),
      });
      pages.push(response.body);
      next = kind === "comments" ? response.next : undefined;
    } while (next);
    body = kind === "comments" ? pages : pages[0];
  } else {
    const failure = config.failure;
    const tokenFailure = config.tokenFailures?.[`${credential}:${kind}`];
    const failed =
      Boolean(tokenFailure) ||
      failure === kind ||
      (kind === "issue" && ["missing", "inaccessible", "throttle"].includes(failure)) ||
      (kind === "repo" && failure === "inaccessible");
    const pages =
      !failed && kind === "comments" && Array.isArray(config.comments)
        ? Math.max(1, Math.ceil(config.comments.length / 100))
        : 1;
    for (let page = 1; page <= pages; page++) {
      trace({
        kind,
        credential,
        method: "GET",
        endpoint: `${endpoint}${kind === "comments" ? `&page=${page}` : ""}`,
        ...(kind === "head" && !failed ? { headSha: config.head } : {}),
      });
    }
    if (failed) {
      process.stderr.write(
        tokenFailure ??
          (failure === "throttle"
            ? "HTTP 429\n"
            : ["missing", "inaccessible"].includes(failure)
              ? "HTTP 404 Not Found\n"
              : "HTTP 503\n"),
      );
      process.exitCode = 1;
      return;
    }
    body =
      kind === "repo"
        ? { default_branch: "trunk" }
        : kind === "issue"
          ? config.issue
          : kind === "head"
            ? {
                ...config.issue,
                ...(config.missingAdditions ? {} : { additions: config.additions ?? 1 }),
                deletions: 0,
                changed_files: 1,
                head: { sha: config.head },
              }
            : Array.isArray(config.comments)
              ? Array.from({ length: pages }, (_, i) =>
                  config.comments.slice(i * 100, (i + 1) * 100),
                )
              : [config.comments];
  }
  process.stdout.write(
    query === ".head.sha"
      ? `${body.head.sha}\n`
      : query === ".default_branch // empty"
        ? `${body.default_branch}\n`
        : JSON.stringify(body),
  );
}

function execute(snapshot, scenario) {
  const temp = mkdtempSync(join(tmpdir(), "exact-review-read-scope-"));
  try {
    mkdirSync(join(temp, "bin"));
    mkdirSync(join(snapshot.directory, "scripts"), { recursive: true });
    if (!snapshot.native)
      writeFileSync(join(snapshot.directory, legacyClassifierPath), snapshot.classifier);
    writeFileSync(join(temp, "step.sh"), snapshot.shell);
    writeFileSync(
      join(temp, "config.json"),
      JSON.stringify({ ...scenario, native: snapshot.native }),
      { mode: 0o600 },
    );
    writeFileSync(join(temp, "output"), "");
    writeFileSync(join(temp, "trace"), "");
    writeFileSync(
      join(temp, "bin/gh"),
      '#!/bin/sh\nexec "$READ_SCOPE_NODE" "$READ_SCOPE_SCRIPT" --gh "$@"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(temp, "bin/node"),
      '#!/bin/sh\nif [ "$1" = scripts/classify-scheduled-review-noop.ts ]; then\n  printf \'{"kind":"classifier"}\\n\' >> "$READ_SCOPE_TRACE"\nfi\nexec "$READ_SCOPE_NODE" "$@"\n',
      { mode: 0o700 },
    );
    const startedAt = Date.now();
    const result = spawnSync("bash", ["--noprofile", "--norc", join(temp, "step.sh")], {
      cwd: snapshot.directory,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        HOME: process.env.HOME,
        PATH: `${join(temp, "bin")}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
        TMPDIR: temp,
        GH_TOKEN: snapshot.native
          ? (scenario.appToken ?? "proof-app")
          : scenario.repo === "openclaw/openclaw"
            ? "proof-actions"
            : "proof-app",
        GITHUB_TOKEN: "forbidden-ambient",
        CLAWSWEEPER_PUBLIC_GH_TOKEN: scenario.publicToken ?? "proof-actions",
        CLAIM_DECISION: JSON.stringify(scenario.decision),
        CLAIM_TARGET_BRANCH: scenario.decision.targetBranch,
        TARGET_REPO: scenario.repo,
        ITEM_NUMBER: String(scenario.number),
        GITHUB_OUTPUT: join(temp, "output"),
        READ_SCOPE_NODE: process.execPath,
        READ_SCOPE_SCRIPT: scriptPath,
        READ_SCOPE_GHX_PATH: process.env.PATH,
        READ_SCOPE_CONFIG: join(temp, "config.json"),
        READ_SCOPE_TRACE: join(temp, "trace"),
      },
    });
    assert.equal(
      result.status,
      scenario.status ?? 0,
      `${scenario.name}: shell exit: ${result.stderr.slice(-4000).replaceAll(root, "<source>").replaceAll(snapshot.directory, "<runtime>").replaceAll(temp, "<fixture>")}`,
    );
    for (const warning of scenario.warnings ?? [])
      assert.ok(result.stderr.includes(warning), `${scenario.name}: missing warning`);
    const outputs = Object.fromEntries(
      readFileSync(join(temp, "output"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (outputs.retry_at) {
      const delay = outputs.retry_kind === "throttle" ? 20 * 60_000 : 5 * 60_000;
      const deadline = Date.parse(outputs.retry_at);
      assert.ok(deadline >= startedAt + delay && deadline <= Date.now() + delay);
      outputs.retry_at = `<now+${delay}ms>`;
    }
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(outputs[key], value, `${scenario.name}: ${key}`);
    }
    if (scenario.name === "quota:branch-throttle") assert.equal(outputs.retry_kind, undefined);
    if (
      scenario.name.endsWith("root-failure") ||
      scenario.name === "quota:fallback-404-root-throttle"
    )
      assert.notEqual(outputs.terminal_missing, "true");
    const events = readFileSync(join(temp, "trace"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (outputs.pr_admission_file) {
      const artifact = JSON.parse(
        readFileSync(join(snapshot.directory, outputs.pr_admission_file), "utf8"),
      );
      assert.equal(artifact.repo, scenario.repo);
      const observedHead = events.findLast(
        (event) => event.kind === "head" && event.headSha,
      )?.headSha;
      assert.match(observedHead, /^[0-9a-f]{40}$/);
      assert.equal(artifact.pull.head.sha, observedHead);
      assert.ok(
        Date.parse(artifact.observedAt) >= startedAt &&
          Date.parse(artifact.observedAt) <= Date.now(),
      );
    }
    assert.ok(
      !events.some((event) => event.kind === "adapter_error"),
      `${scenario.name}: adapter failed`,
    );
    return {
      status: result.status,
      outputs,
      trace: events,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function admission(outputs) {
  const outcome = { ...outputs };
  delete outcome.pr_admission_file;
  delete outcome.oversized;
  delete outcome.scheduled_noop;
  delete outcome.scheduled_noop_reason;
  return outcome;
}

export function runReadScopeProof({
  baselineRef,
  baselineCapsule,
  candidateRef,
  liveTargets = [],
  scenarioNames = [],
  build = false,
} = {}) {
  let capsule;
  if (baselineCapsule) {
    const text = readFileSync(baselineCapsule, "utf8");
    assert.ok(text.length <= 128 * 1024, "baseline capsule exceeds its bounded source inputs");
    capsule = JSON.parse(text);
    assert.equal(capsule.schema, 1);
    assert.match(capsule.ref, /^[0-9a-f]{40}$/);
    if (baselineRef) assert.equal(capsule.ref, baselineRef);
    baselineRef = capsule.ref;
    assert.deepEqual(
      Object.keys(capsule.files).sort(),
      [workflowPath, legacyClassifierPath, "src/clawsweeper-oversized-pr-policy.ts"].sort(),
    );
    for (const file of Object.values(capsule.files)) assert.equal(hash(file.text), file.sha256);
  }
  const inputs = buildInputs();
  if (build) {
    command("pnpm", ["run", "build:all"], { cwd: root, timeout: 600_000 });
    assert.deepEqual(buildInputs(), inputs, "source changed during build");
  }
  const runtimes = [];
  try {
    const candidate = snapshot(candidateRef, undefined, runtimes);
    const buildReceipt = build
      ? { command: "pnpm run build:all", inputs, compiled: candidate.hashes.compiled }
      : undefined;
    const baseline = baselineRef ? snapshot(baselineRef, capsule, runtimes) : undefined;
    const cases = scenarios();
    for (const { kind, target } of liveTargets) {
      const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(target);
      assert.ok(match, "live target must be owner/repo#number");
      const [, repo, number] = match;
      assert.equal(
        liveGet(`repos/${repo}`).body.private,
        false,
        "live proof requires a public repository",
      );
      cases.push({
        name: `live:${kind}`,
        repo,
        number,
        live: true,
        decision: { sourceAction: "scheduled_normal_backfill", targetBranch: "main" },
        expected: { proceed: "true", item_kind: kind, scheduled_semantic_noop: "false" },
      });
    }
    const results = [];
    for (const name of scenarioNames) {
      assert.ok(
        cases.some((scenario) => scenario.name === name),
        "unknown proof scenario",
      );
    }
    for (const scenario of cases.filter(
      (entry) => scenarioNames.length === 0 || scenarioNames.includes(entry.name),
    )) {
      const before =
        baseline && (!scenario.candidateOnly || scenario.baselineExpected)
          ? execute(
              baseline,
              scenario.baselineExpected
                ? { ...scenario, expected: scenario.baselineExpected, warnings: [] }
                : scenario,
            )
          : undefined;
      const after = execute(candidate, scenario);
      if (scenario.credentials)
        assert.deepEqual(
          after.trace
            .filter((event) => event.kind !== "classifier")
            .map((event) => `${event.credential}:${event.kind}`),
          scenario.credentials,
          `${scenario.name}: credential sequence`,
        );
      const isHot = scenario.decision.sourceAction === hotAction;
      const hydration = after.trace.filter((event) =>
        ["comments", "classifier"].includes(event.kind),
      );
      if (!isHot)
        assert.equal(
          hydration.length,
          0,
          `${scenario.name}: wasted non-hot no-op reads/classification`,
        );
      if (
        !scenario.candidateOnly &&
        after.outputs.item_kind === "pull_request" &&
        (scenario.live || (scenario.issue.state === "open" && !scenario.issue.locked))
      ) {
        assert.equal(
          after.trace.filter((event) => event.kind === "head").length,
          1,
          `${scenario.name}: PR size admission reads metadata exactly once`,
        );
      }
      if (before && scenario.baselineExpected) {
        assert.deepEqual(
          before.trace.map((event) => `${event.credential}:${event.kind}`),
          ["actions:issue"],
        );
      }
      if (before && !scenario.candidateOnly) {
        if (scenario.live) {
          assert.equal(before.outputs.scheduled_noop_reason, "not_scheduled_hot");
          for (const kind of [
            "issue",
            "comments",
            ...(scenario.expected.item_kind === "pull_request" ? ["head"] : []),
          ]) {
            assert.ok(
              before.trace.some((event) => event.kind === kind && event.status === 200),
              `live ${kind} read must succeed`,
            );
          }
        }
        assert.deepEqual(
          admission(after.outputs),
          admission(before.outputs),
          `${scenario.name}: admission drift`,
        );
        if (isHot)
          assert.deepEqual(
            after.trace.filter((event) => event.kind !== "classifier"),
            before.trace.filter((event) => event.kind !== "classifier"),
            `${scenario.name}: hot path drift`,
          );
        else
          assert.deepEqual(
            after.trace.filter((event) => !["head", "comments", "classifier"].includes(event.kind)),
            before.trace.filter(
              (event) => !["head", "comments", "classifier"].includes(event.kind),
            ),
            `${scenario.name}: required reads changed`,
          );
      }
      results.push({
        name: scenario.name,
        ...(before ? { baseline: before } : {}),
        candidate: after,
      });
    }
    assert.equal(
      treeHash("dist", ".js"),
      candidate.hashes.compiled,
      "compiled owner changed during proof",
    );
    assert.deepEqual(buildInputs(), inputs, "source changed during proof");
    return {
      build: buildReceipt,
      environment: {
        node: process.version,
        platform: process.platform,
        bash: command("bash", ["--version"]).split("\n")[0],
      },
      sources: {
        baselineRef,
        baselineCapsule: capsule ? hash(JSON.stringify(capsule)) : undefined,
        candidateRef: candidateRef ?? "working-tree",
        baseline: baseline?.hashes,
        candidate: candidate.hashes,
      },
      results,
    };
  } finally {
    for (const directory of runtimes) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === "--gh") {
    try {
      ghAdapter(process.argv.slice(3));
    } catch (error) {
      trace({ kind: "adapter_error" });
      throw error;
    }
  } else {
    const { values } = parseArgs({
      options: {
        build: { type: "boolean", default: false },
        baseline: { type: "string" },
        "baseline-capsule": { type: "string" },
        candidate: { type: "string" },
        output: { type: "string" },
        "live-pr": { type: "string" },
        "live-issue": { type: "string" },
        scenario: { type: "string", multiple: true },
      },
    });
    const proof = runReadScopeProof({
      build: values.build,
      baselineRef: values.baseline,
      baselineCapsule: values["baseline-capsule"],
      candidateRef: values.candidate,
      scenarioNames: values.scenario,
      liveTargets: [
        ...(values["live-pr"] ? [{ kind: "pull_request", target: values["live-pr"] }] : []),
        ...(values["live-issue"] ? [{ kind: "issue", target: values["live-issue"] }] : []),
      ],
    });
    if (values.output) {
      assert.ok(!existsSync(values.output), "proof output already exists");
      writeFileSync(values.output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(
      `PASS: ${proof.results.length} admission scenarios; requested output and read-scope assertions passed.`,
    );
  }
}
