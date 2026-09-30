#!/usr/bin/env node
/**
 * Real-transport final-effect proof for apply source-drift classification.
 *
 * capture: read-only native gh reads of a live PR into a seed file.
 * run: for each scenario, rewinds the seed to its exact-review snapshot, serves it from a
 * stateful synthetic GitHub API over native gh's `http_unix_socket`, performs the between-
 * snapshot writes through native gh (ClawSweeper's own acknowledgement edit uses the compiled
 * `update-review-status` CLI), then runs the compiled `apply-decisions` CLI in non-dry-run
 * mode with the exact-event publication arguments. Every request and GitHub effect is traced.
 *
 *   node scripts/e2e/apply-source-drift-final-effect.mjs capture --out <seed-dir>
 *   node scripts/e2e/apply-source-drift-final-effect.mjs run --seed-dir <seed-dir> \
 *     --baseline <checkout-with-dist> --candidate <checkout-with-dist> --out <evidence-dir>
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = "openclaw/openclaw";
const BOT = "clawsweeper[bot]";
const TOKENS = {
  bot: "synthetic-clawsweeper-token",
  author: "synthetic-author-token",
  harness: "synthetic-harness-token",
};
// Exact-review tuples of the looping production runs (run logs and durable markers).
const ITEMS = {
  126549: {
    runId: 36365080254,
    headSha: "f96bfcced92e5ec857a13fb537921f1d60e6337a",
    leaseCommentId: 5861600942,
    leaseOwner: "github-run-36365080254-1",
    leaseAt: "2026-09-28T01:13:40Z",
    acknowledgementCommentId: 5351727124,
    durableCommentId: 5351817173,
    durableUpdatedAt: "2026-09-22T08:19:47Z",
    labels: [
      "docs",
      "app: web-ui",
      "gateway",
      "size: M",
      "P2",
      "rating: 🦪 silver shellfish",
      "status: 📣 needs proof",
    ],
    related: { issues: [129639, 129640], pulls: [129640] },
    records: {
      recorded: {
        close_reason: "implemented_on_main",
        fixed_pr_url: `https://github.com/${REPO}/pull/129640`,
        fixed_pr_number: "129640",
        fixed_pr_merged_at: "2026-08-26T00:27:42Z",
        fixed_pr_confidence: "high",
        fixed_pr_source: '"GitHub merged pull request"',
        triage_priority: "P2",
        rating: { overall: "D", proof: "D", patch: "C" },
        proof: "missing",
        evidence:
          "The merged canonical PR #129640 implements the same cursor snapshot recovery on main.",
        closeComment: "Closing this as already implemented on main by the merged canonical PR.",
      },
      "close-capable": {
        close_reason: "stalled_unproven_pr",
        item_category: "bug",
        triage_priority: "P2",
        rating: { overall: "D", proof: "F", patch: "D" },
        proof: "missing",
        evidence:
          "The review asked for real behavior proof on 2026-08-20 and the PR still has none.",
        closeComment:
          "ClawSweeper proposes closing this PR because the requested real-behavior proof never arrived.",
      },
    },
  },
  158447: {
    runId: 36361287813,
    headSha: "aa0ac129d45bf972e0c1e0b30624e98727385888",
    leaseCommentId: 5861136195,
    leaseOwner: "github-run-36361287813-1",
    leaseAt: "2026-09-28T00:13:39Z",
    acknowledgementCommentId: 5841202506,
    durableCommentId: 5841242718,
    durableUpdatedAt: "2026-09-26T00:02:00Z",
    labels: [
      "scripts",
      "size: S",
      "proof: sufficient",
      "P0",
      "rating: 🐚 platinum hermit",
      "status: 👀 ready for maintainer look",
    ],
    related: { issues: [158339, 158451], pulls: [158451] },
    records: {
      recorded: {
        close_reason: "implemented_on_main",
        fixed_pr_url: `https://github.com/${REPO}/pull/158451`,
        fixed_pr_number: "158451",
        fixed_pr_merged_at: "2026-09-26T00:56:50Z",
        fixed_pr_confidence: "high",
        fixed_pr_source: '"GitHub merged pull request"',
        triage_priority: "P0",
        rating: { overall: "B", proof: "B", patch: "B" },
        proof: "sufficient",
        evidence:
          "The merged canonical PR #158451 implements the same config-reader recursion fix on main.",
        closeComment: "Closing this as already implemented on main by the merged canonical PR.",
      },
    },
  },
};
const SCENARIOS = ["ack-only", "human-comment", "new-head", "title-edit"];

const source = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    out: { type: "string" },
    "seed-dir": { type: "string" },
    baseline: { type: "string" },
    candidate: { type: "string" },
    gh: { type: "string", default: process.env.DRIFT_PROOF_GH || "/opt/homebrew/bin/gh" },
    item: { type: "string" },
    record: { type: "string" },
    scenario: { type: "string" },
  },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

if (command === "capture") await capture();
else if (command === "run") await run();
else {
  console.error("usage: apply-source-drift-final-effect.mjs capture|run [options]");
  process.exit(2);
}

async function capture() {
  assert.ok(values.out, "--out is required");
  fs.mkdirSync(values.out, { recursive: true });
  const { reviewedPrActivityCursorV2Query } = await import(
    pathToFileURL(path.join(source, "dist/review-activity-cursor.js")).href
  );
  const get = (endpoint, paginate = false) =>
    JSON.parse(
      execFileSync(values.gh, ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  const flat = (value) =>
    Array.isArray(value) && value.every(Array.isArray) ? value.flat() : value;
  for (const [number, spec] of Object.entries(ITEMS)) {
    if (values.item && values.item !== number) continue;
    const base = `repos/${REPO}`;
    const [owner, name] = REPO.split("/");
    const seed = {
      capturedAt: new Date().toISOString(),
      issue: get(`${base}/issues/${number}`),
      pull: get(`${base}/pulls/${number}`),
      comments: flat(get(`${base}/issues/${number}/comments?per_page=100`, true)),
      timeline: flat(get(`${base}/issues/${number}/timeline?per_page=100`, true)),
      files: flat(get(`${base}/pulls/${number}/files?per_page=100`, true)),
      commits: flat(get(`${base}/pulls/${number}/commits?per_page=100`, true)),
      pullComments: flat(get(`${base}/pulls/${number}/comments?per_page=100`, true)),
      reviews: flat(get(`${base}/pulls/${number}/reviews?per_page=100`, true)),
      checkRuns: get(`${base}/commits/${spec.headSha}/check-runs?per_page=100`),
      status: get(`${base}/commits/${spec.headSha}/status?per_page=100`),
      actionsRuns: get(
        `${base}/actions/runs?head_sha=${spec.headSha}&event=pull_request&per_page=100`,
      ),
      // Read-only GraphQL query: the production review-activity cursor query for this PR.
      activityCursorGraphql: JSON.parse(
        execFileSync(
          values.gh,
          [
            "api",
            "graphql",
            "-f",
            `query=${reviewedPrActivityCursorV2Query(owner, name, [Number(number)])}`,
          ],
          { encoding: "utf8" },
        ),
      ),
      related: { issues: {}, pulls: {} },
    };
    for (const kind of ["issues", "pulls"])
      for (const related of spec.related[kind])
        seed.related[kind][related] = get(`${base}/${kind}/${related}`);
    for (const file of seed.files) delete file.patch;
    const target = path.join(values.out, `seed-${number}.json`);
    fs.writeFileSync(target, JSON.stringify(seed, null, 1) + "\n");
    console.log(
      JSON.stringify({ captured: number, target, sha256: sha256(fs.readFileSync(target)) }),
    );
  }
}

async function run() {
  for (const key of ["seed-dir", "baseline", "candidate", "out"])
    assert.ok(values[key], `--${key} is required`);
  const output = path.resolve(values.out);
  fs.mkdirSync(output, { recursive: true });
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drift-proof-")));
  const builds = {
    baseline: path.resolve(values.baseline),
    candidate: path.resolve(values.candidate),
  };
  const heads = Object.fromEntries(
    Object.entries(builds).map(([name, dir]) => [
      name,
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
    ]),
  );
  const ghVersion = execFileSync(values.gh, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const runtimes = {};
  for (const [name, dir] of Object.entries(builds)) {
    const runtime = path.join(scratch, `runtime-${name}`);
    fs.mkdirSync(runtime);
    for (const entry of ["dist", "config", "schema", "prompts", "package.json"])
      fs.cpSync(path.join(dir, entry), path.join(runtime, entry), { recursive: true });
    fs.symlinkSync(path.join(source, "node_modules"), path.join(runtime, "node_modules"), "dir");
    runtimes[name] = runtime;
  }
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(values.gh, path.join(bin, "gh"));
  const results = [];
  try {
    for (const [number, spec] of Object.entries(ITEMS)) {
      if (values.item && values.item !== number) continue;
      const seed = JSON.parse(
        fs.readFileSync(path.join(values["seed-dir"], `seed-${number}.json`), "utf8"),
      );
      for (const record of Object.keys(spec.records)) {
        if (values.record && values.record !== record) continue;
        for (const scenario of SCENARIOS) {
          if (values.scenario && values.scenario !== scenario) continue;
          for (const build of ["baseline", "candidate"]) {
            const result = await runScenario({
              number: Number(number),
              spec,
              seed,
              record,
              scenario,
              build,
              runtime: runtimes[build],
              scratch,
              bin,
              output,
            });
            result.head = heads[build];
            results.push(result);
            console.log(JSON.stringify(summarize(result)));
          }
        }
      }
    }
  } finally {
    if (!process.env.DRIFT_PROOF_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
    else console.error(`kept ${scratch}`);
  }
  const summary = {
    node: process.version,
    gh: ghVersion,
    transport: "native gh HTTP over http_unix_socket to a stateful synthetic GitHub API",
    heads,
    command: process.argv.slice(1).join(" "),
    results: results.map(summarize),
  };
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

function summarize(result) {
  return {
    item: result.number,
    record: result.record,
    scenario: result.scenario,
    build: result.build,
    head: result.head,
    exit: result.exit,
    applyActions: result.actions.map((entry) => `${entry.action}: ${entry.reason}`),
    disposition: result.disposition,
    requeueSourceDriftReview: result.requeue,
    applyRequests: result.applyRequests,
    closeRequests: result.effects.filter((effect) => effect.kind === "close").length,
    effects: result.effects.map(
      (effect) =>
        `${effect.method} ${effect.path} -> ${effect.status} ${effect.kind}${effect.role ? `(${effect.role})` : ""}${effect.labels ? ` ${JSON.stringify(effect.labels)}` : ""}`,
    ),
    serverErrors: result.serverErrors,
  };
}

async function runScenario({
  number,
  spec,
  seed,
  record,
  scenario,
  build,
  runtime,
  scratch,
  bin,
  output,
}) {
  const tag = `${number}-${record}-${scenario}-${build}`;
  const root = path.join(scratch, tag);
  for (const dir of ["items", "closed", "plans", "decision-packets", "gh-config", "home"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const dist = (file) => import(pathToFileURL(path.join(runtime, "dist", file)).href);
  const { renderReviewStartStatusComment } = await dist("clawsweeper.js");
  const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const beforeSnapshot = (entry) =>
    !entry.created_at || Date.parse(entry.created_at) <= Date.parse(spec.leaseAt);
  const comments = seed.comments.filter(beforeSnapshot).map((comment) => {
    // Durable comments are edited in place; a later sync must not leak into the snapshot.
    if (comment.id === spec.durableCommentId)
      return {
        ...comment,
        body: seed.durableCommentAtReview?.body ?? comment.body,
        updated_at: spec.durableUpdatedAt,
      };
    if (comment.id === spec.acknowledgementCommentId)
      return { ...comment, updated_at: spec.leaseAt };
    return comment;
  });
  comments.push({
    id: spec.leaseCommentId,
    html_url: `https://github.com/${REPO}/pull/${number}#issuecomment-${spec.leaseCommentId}`,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${number}`,
    user: { login: BOT, id: 1, type: "Bot" },
    author_association: "NONE",
    created_at: spec.leaseAt,
    updated_at: spec.leaseAt,
    body: renderReviewStartStatusComment({
      number,
      kind: "pull_request",
      title: seed.issue.title,
      headSha: spec.headSha,
      startedAt: spec.leaseAt,
      leaseExpiresAt,
      leaseOwner: spec.leaseOwner,
    }),
  });
  const labelCatalog = {};
  for (const name of spec.labels)
    labelCatalog[name] = {
      id: Object.keys(labelCatalog).length + 1,
      color: "ededed",
      description: "",
    };
  const state = {
    repo: REPO,
    number,
    botLogin: BOT,
    phase: "setup",
    tokens: {
      [TOKENS.bot]: BOT,
      [TOKENS.author]: seed.issue.user.login,
      [TOKENS.harness]: "proof-harness",
    },
    title: seed.issue.title,
    body: seed.pull.body ?? seed.issue.body ?? "",
    state: "open",
    closedAt: null,
    issue: { ...seed.issue, updated_at: spec.leaseAt },
    pull: { ...seed.pull, updated_at: spec.leaseAt },
    headSha: spec.headSha,
    capturedHeadSha: spec.headSha,
    labels: [...spec.labels],
    labelCatalog,
    comments,
    timeline: seed.timeline.filter(beforeSnapshot),
    files: seed.files,
    commits: seed.commits,
    pullComments: seed.pullComments,
    reviews: seed.reviews,
    checkRuns: seed.checkRuns,
    status: seed.status,
    actionsRuns: seed.actionsRuns,
    activityCursorGraphql: seed.activityCursorGraphql,
    related: seed.related,
    roles: { durable: spec.durableCommentId, acknowledgement: spec.acknowledgementCommentId },
    nextCommentId: 9_900_000_000,
    nextEventId: 9_800_000_000,
  };
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "d-"));
  const socket = path.join(socketDir, "s");
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("./apply-source-drift-final-effect-server.cjs", import.meta.url))],
    {
      env: { DRIFT_PROOF_ROOT: root, DRIFT_PROOF_SOCKET: socket },
      stdio: ["ignore", "ignore", fs.openSync(path.join(root, "server.stderr.log"), "a")],
    },
  );
  try {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(root, "server.ready")); i++)
      await sleep(20);
    assert.ok(fs.existsSync(path.join(root, "server.ready")), "synthetic GitHub API started");
    fs.writeFileSync(path.join(root, "gh-config/config.yml"), `http_unix_socket: ${socket}\n`);
    const env = (token) => ({
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      GH_CONFIG_DIR: path.join(root, "gh-config"),
      GH_HOST: "github.com",
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    });
    const control = (endpoint, payload) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = request(
          {
            // A pooled keep-alive socket can be closed by the server during a long apply run.
            agent: false,
            socketPath: socket,
            path: endpoint,
            method: "POST",
            headers: {
              authorization: `token ${TOKENS.harness}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              res.statusCode === 200
                ? resolve()
                : reject(new Error(`${endpoint} ${res.statusCode}`)),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    const nativeGh = (token, args) => {
      const result = spawnSync("gh", args, { env: env(token), encoding: "utf8", cwd: root });
      assert.equal(result.status, 0, `gh ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    const reviewStatus = (stateName) => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(runtime, "dist/repair/update-review-status.js"),
          "--repo",
          REPO,
          "--item-number",
          String(number),
          "--status-comment-id",
          String(spec.acknowledgementCommentId),
          "--state",
          stateName,
          "--run-url",
          `https://github.com/openclaw/clawsweeper/actions/runs/${spec.runId}`,
        ],
        { env: env(TOKENS.bot), encoding: "utf8", cwd: runtime },
      );
      assert.equal(result.status, 0, `update-review-status ${stateName}: ${result.stderr}`);
    };

    // Exact review: mark the acknowledgement "reviewing", then snapshot the item.
    reviewStatus("reviewing");
    await control("/__proof/phase", { phase: "review-snapshot" });
    const snapshot = JSON.parse(nativeGh(TOKENS.bot, ["api", `repos/${REPO}/issues/${number}`]));
    const reviewState = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
    const identity = await reviewIdentity(runtime, reviewState);
    await sleep(1100);
    const reviewedAt = new Date().toISOString();
    const reportBefore = reportMarkdown({
      number,
      spec,
      seed,
      record,
      snapshot,
      identity,
      reviewedAt,
    });
    fs.writeFileSync(path.join(root, "items", `${number}.md`), reportBefore);
    await sleep(1100);

    // Between the review snapshot and apply.
    await control("/__proof/phase", { phase: "after-snapshot" });
    if (scenario === "human-comment")
      nativeGh(TOKENS.author, [
        "api",
        `repos/${REPO}/issues/${number}/comments`,
        "-f",
        "body=Synthetic proof: this still reproduces for me on current main.",
      ]);
    if (scenario === "title-edit")
      nativeGh(TOKENS.author, [
        "api",
        "--method",
        "PATCH",
        `repos/${REPO}/issues/${number}`,
        "-f",
        `title=${seed.issue.title} (synthetic edit)`,
      ]);
    if (scenario === "new-head") await control("/__proof/push-head", { sha: "3".repeat(40) });
    if (scenario !== "ack-only") await sleep(1100);
    // Production "Mark automatic review complete" step: the ClawSweeper-owned acknowledgement edit.
    reviewStatus("complete");
    await sleep(1100);

    await control("/__proof/phase", { phase: "apply" });
    const reportPath = path.join(root, "apply-report.json");
    // Arguments of src/repair/publish-event-result.ts runApplyDecisions (non-dry-run).
    const applyArgs = [
      path.join(runtime, "dist/clawsweeper.js"),
      "apply-decisions",
      "--target-repo",
      REPO,
      "--item-numbers",
      String(number),
      "--apply-kind",
      "all",
      "--apply-close-reasons",
      "all",
      "--stale-min-age-days",
      "60",
      "--limit",
      "1",
      "--processed-limit",
      "20",
      "--min-age-minutes",
      "0",
      "--close-delay-ms",
      "1000",
      "--comment-sync-min-age-days",
      "0",
      "--progress-every",
      "1",
      "--event-apply-proof",
      "--exact-event-publication",
      "--skip-dashboard",
      "--report-path",
      reportPath,
      "--record-root",
      root,
      "--items-dir",
      path.join(root, "items"),
      "--closed-dir",
      path.join(root, "closed"),
      "--plans-dir",
      path.join(root, "plans"),
      "--decision-packets-dir",
      path.join(root, "decision-packets"),
    ];
    const apply = spawnSync(process.execPath, applyArgs, {
      cwd: runtime,
      env: { ...env(TOKENS.bot), CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: path.join(root, "ledger") },
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    await control("/__proof/phase", { phase: "done" });
    const trace = fs
      .readFileSync(path.join(root, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const actions = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
      : [];
    const { exactEventApplyProof, eventApplyRequeueLatestExpected } = await dist(
      "repair/event-apply-proof.js",
    );
    const proof = exactEventApplyProof(actions, number, "proposed_close");
    const applyTrace = trace.filter((entry) => entry.phase === "apply");
    const effects = applyTrace
      .filter((entry) => entry.effect)
      .map((entry) => ({
        method: entry.method,
        path: entry.path,
        status: entry.status,
        ...entry.effect,
      }));
    const dir = path.join(output, tag);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "http-trace.jsonl"),
      trace.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(dir, "apply.stdout.log"), apply.stdout ?? "");
    fs.writeFileSync(path.join(dir, "apply.stderr.log"), apply.stderr ?? "");
    fs.writeFileSync(path.join(dir, "apply-report.json"), JSON.stringify(actions, null, 2) + "\n");
    fs.copyFileSync(path.join(root, "state.json"), path.join(dir, "final-state.json"));
    fs.writeFileSync(path.join(dir, "report-before.md"), reportBefore);
    for (const [folder, name] of [
      ["items", "report-after.md"],
      ["closed", "report-after-archived.md"],
    ]) {
      const after = path.join(root, folder, `${number}.md`);
      if (fs.existsSync(after)) fs.copyFileSync(after, path.join(dir, name));
    }
    return {
      number,
      record,
      scenario,
      build,
      exit: apply.status,
      actions,
      disposition: proof.disposition,
      requeue: eventApplyRequeueLatestExpected({
        disposition: proof.disposition,
        exactEventPublication: true,
        legacyTuplelessReviewLease: proof.legacyTuplelessReviewLease,
      }),
      applyRequests: applyTrace.length,
      effects,
      serverErrors: trace
        .filter((entry) => entry.error)
        .map((entry) => `${entry.phase} ${entry.method} ${entry.path}: ${entry.error}`),
    };
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("close", resolve));
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
}

// Recompute the review's recorded activity identity from the served snapshot with the
// production digest owners (clawsweeper-source-revision, review-activity-cursor).
async function reviewIdentity(runtime, state) {
  const load = (file) => import(pathToFileURL(path.join(runtime, "dist", file)).href);
  const { createSourceRevisionTools } = await load("clawsweeper-source-revision.js");
  const { asRecord, login, normalizeLabelName } = await load("clawsweeper-item-policy.js");
  const { reviewedPrActivityCursorsV2FromGraphql } = await load("review-activity-cursor.js");
  const { stableJson } = await load("stable-json.js");
  const bots = new Set(["clawsweeper", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
  const tools = createSourceRevisionTools({
    asRecord,
    clawsweeperBotAuthors: bots,
    githubCount: (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null),
    isClawSweeperComment: (value) => bots.has((login(asRecord(value).user) ?? "").toLowerCase()),
    login,
    normalizeAuthorAssociation: (value) => String(value ?? "").toUpperCase(),
    normalizeLabelName,
    pullHeadShaFromContext: () => null,
    sha256,
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
  });
  const issue = {
    title: state.title,
    body: state.body,
    labels: state.labels.map((name) => ({ name })),
  };
  const timeline = state.timeline.map((event) => ({
    id: event.id,
    event: event.event,
    createdAt: event.created_at,
    actor: login(event.actor),
    commitId: event.commit_id,
    label: asRecord(event.label).name,
    rename: event.rename,
    sourceIssue: event.source?.issue
      ? {
          number: event.source.issue.number,
          title: event.source.issue.title,
          url: event.source.issue.html_url,
          state: event.source.issue.state,
        }
      : undefined,
  }));
  return {
    sourceRevision: tools.itemSourceRevisionSha256(issue, state.comments),
    timelineRevision: sha256(stableJson(tools.reviewTimelineDigestParts(timeline))),
    activityCursor: reviewedPrActivityCursorsV2FromGraphql(state.activityCursorGraphql, [
      state.number,
    ]).cursors[String(state.number)],
  };
}

function reportMarkdown({ number, spec, seed, record, snapshot, identity, reviewedAt }) {
  const facts = spec.records[record];
  const frontMatter = {
    number,
    repository: REPO,
    type: "pull_request",
    title: JSON.stringify(seed.issue.title),
    url: `https://github.com/${REPO}/pull/${number}`,
    state_at_review: "open",
    item_created_at: seed.issue.created_at,
    item_updated_at: snapshot.updated_at,
    author: seed.issue.user.login,
    author_association: seed.issue.author_association,
    labels: JSON.stringify(spec.labels),
    reviewed_at: reviewedAt,
    review_lease_owner: spec.leaseOwner,
    review_lease_comment_id: spec.leaseCommentId,
    pull_head_sha: spec.headSha,
    decision: "close",
    close_reason: facts.close_reason,
    confidence: "high",
    action_taken: "proposed_close",
    review_status: "complete",
    local_checkout_access: "verified",
    local_checkout_access_source: "runner_preflight_v1",
    work_candidate: "none",
    work_status: "none",
    triage_priority: facts.triage_priority,
    item_snapshot_hash: sha256(`${number}:${snapshot.updated_at}`),
    item_source_revision: identity.sourceRevision,
    review_timeline_revision: identity.timelineRevision,
    review_activity_cursor: identity.activityCursor,
    ...(facts.item_category ? { item_category: facts.item_category } : {}),
    ...Object.fromEntries(Object.entries(facts).filter(([key]) => key.startsWith("fixed_pr_"))),
  };
  return `---\n${Object.entries(frontMatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n
## Summary

Reconstructed exact-review record for the real-transport source-drift proof.

## Evidence

- **review evidence:** ${facts.evidence}

## Real Behavior Proof

Status: ${facts.proof}
Evidence kind: ${facts.proof === "sufficient" ? "terminal" : "not_applicable"}
Needs contributor action: ${facts.proof !== "sufficient"}
Summary: ${facts.proof === "sufficient" ? "The PR includes real behavior proof." : "The review asked for real behavior proof and none was supplied."}

## PR Rating

Overall tier: ${facts.rating.overall}
Proof tier: ${facts.rating.proof}
Patch tier: ${facts.rating.patch}
Summary: Reconstructed rating matching the live rating label.
Next rank-up steps:
- Provide a live run, logs, or a reproducible validation transcript.

## Close Comment

${facts.closeComment}
`;
}
