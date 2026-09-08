import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { scheduledReviewSemanticSourceRevision } from "../classify-scheduled-review-noop.ts";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "../..");
const workflowPath = ".github/workflows/sweep.yml";
const classifierPath = "scripts/classify-scheduled-review-noop.ts";
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

function snapshot(ref) {
  const workflow = YAML.parse(source(ref, workflowPath));
  const shell = workflow.jobs["event-review-apply"].steps.find(
    (step) => step.id === "live-item",
  )?.run;
  assert.equal(typeof shell, "string");
  const classifier = source(ref, classifierPath);
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  return { shell, classifier, hashes: { shell: hash(shell), classifier: hash(classifier) } };
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
        method: "GET",
        endpoint: `${url.pathname.slice(1)}${url.search}`,
        status: 200,
      });
      pages.push(response.body);
      next = kind === "comments" ? response.next : undefined;
    } while (next);
    body = kind === "comments" ? pages : pages[0];
  } else {
    const failure = config.failure;
    const failed =
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
        method: "GET",
        endpoint: `${endpoint}${kind === "comments" ? `&page=${page}` : ""}`,
      });
    }
    if (failed) {
      process.stderr.write(
        failure === "throttle"
          ? "HTTP 429\n"
          : ["missing", "inaccessible"].includes(failure)
            ? "HTTP 404 Not Found\n"
            : "HTTP 503\n",
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
            ? { head: { sha: config.head } }
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
    mkdirSync(join(temp, "scripts"));
    writeFileSync(join(temp, classifierPath), snapshot.classifier);
    writeFileSync(join(temp, "step.sh"), snapshot.shell);
    writeFileSync(join(temp, "config.json"), JSON.stringify(scenario), { mode: 0o600 });
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
      cwd: temp,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        HOME: process.env.HOME,
        PATH: `${join(temp, "bin")}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
        TMPDIR: temp,
        GH_TOKEN: "read-only-proof-adapter",
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
    assert.equal(result.status, scenario.status ?? 0, `${scenario.name}: shell exit`);
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
    const events = readFileSync(join(temp, "trace"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
  delete outcome.scheduled_noop;
  delete outcome.scheduled_noop_reason;
  return outcome;
}

export function runReadScopeProof({
  baselineRef,
  candidateRef,
  liveTargets = [],
  scenarioNames = [],
} = {}) {
  const candidate = snapshot(candidateRef);
  const baseline = baselineRef ? snapshot(baselineRef) : undefined;
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
    const before = baseline ? execute(baseline, scenario) : undefined;
    const after = execute(candidate, scenario);
    const isHot = scenario.decision.sourceAction === hotAction;
    const hydration = after.trace.filter((event) =>
      ["head", "comments", "classifier"].includes(event.kind),
    );
    if (!isHot)
      assert.equal(
        hydration.length,
        0,
        `${scenario.name}: wasted non-hot no-op reads/classification`,
      );
    if (before) {
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
      if (isHot) assert.deepEqual(after, before, `${scenario.name}: hot path drift`);
      else
        assert.deepEqual(
          after.trace,
          before.trace.filter((event) => !["head", "comments", "classifier"].includes(event.kind)),
          `${scenario.name}: required reads changed`,
        );
    }
    results.push({
      name: scenario.name,
      ...(before ? { baseline: before } : {}),
      candidate: after,
    });
  }
  return {
    environment: {
      node: process.version,
      platform: process.platform,
      bash: command("bash", ["--version"]).split("\n")[0],
    },
    sources: {
      baselineRef,
      candidateRef: candidateRef ?? "working-tree",
      baseline: baseline?.hashes,
      candidate: candidate.hashes,
    },
    results,
  };
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
        baseline: { type: "string" },
        candidate: { type: "string" },
        output: { type: "string" },
        "live-pr": { type: "string" },
        "live-issue": { type: "string" },
        scenario: { type: "string", multiple: true },
      },
    });
    const proof = runReadScopeProof({
      baselineRef: values.baseline,
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
