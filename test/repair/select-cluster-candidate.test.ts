import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSelectedCandidateStillOpen,
  collectClusterSelectionEvidence,
  durableClusterSelectionDecision,
  selectClusterCandidateWithModel,
  validateClusterSelectionDecision,
} from "../../dist/repair/select-cluster-candidate.js";

function job(root: string, clusterId: number, candidates: number[], context = candidates): string {
  const relative = `jobs/openclaw/inbox/gitcrawl-${clusterId}-candidate.md`;
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    [
      "---",
      "repo: openclaw/openclaw",
      `cluster_id: gitcrawl-${clusterId}-candidate`,
      "candidates:",
      ...candidates.map((number) => `  - "#${number}"`),
      "cluster_refs:",
      ...context.map((number) => `  - "#${number}"`),
      "---",
      "candidate",
      "",
    ].join("\n"),
  );
  return relative;
}

test("selector evidence presents live cluster facts without semantic filtering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-selector-"));
  const relative = job(root, 42, [100], [100, 101]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const evidence = collectClusterSelectionEvidence({
      repo: "openclaw/openclaw",
      paths: [relative],
      readItem: (number) => ({
        number,
        state: number === 100 ? "open" : "closed",
        title: number === 100 ? "Proposal requiring a product decision" : "Security regression",
        body: "The selector must reason about this text rather than matching it.",
        updated_at: "2026-07-27T00:00:00Z",
        labels: [{ name: number === 100 ? "enhancement" : "security" }],
        ...(number === 101 ? { pull_request: {} } : {}),
      }),
      readPull: () => ({ draft: true, maintainer_can_modify: false }),
    });
    assert.equal(evidence.length, 1);
    assert.deepEqual(
      evidence[0].members.map((member) => [member.number, member.role, member.state]),
      [
        [100, "candidate", "open"],
        [101, "context", "closed"],
      ],
    );
    assert.equal(evidence[0].members[1].pull_request?.draft, true);
  } finally {
    process.chdir(previous);
  }
});

test("structured selector may choose one offered cluster", () => {
  const paths = ["jobs/openclaw/inbox/gitcrawl-1-a.md", "jobs/openclaw/inbox/gitcrawl-2-b.md"];
  const decision = validateClusterSelectionDecision(
    {
      selected_path: paths[1],
      rationale: "The second cluster has a concrete shared regression and validation path.",
      assessments: [
        { path: paths[0], decision: "rejected", rationale: "Already fixed on main." },
        { path: paths[1], decision: "selected", rationale: "Narrow and reproducible." },
      ],
    },
    paths,
  );
  assert.equal(decision.selected_path, paths[1]);
});

test("structured selector may reject the entire batch", () => {
  const pathValue = "jobs/openclaw/inbox/gitcrawl-1-a.md";
  const decision = validateClusterSelectionDecision(
    {
      selected_path: null,
      rationale: "No candidate is useful.",
      assessments: [{ path: pathValue, decision: "rejected", rationale: "Unrelated reports." }],
    },
    [pathValue],
  );
  assert.equal(decision.selected_path, null);
});

test("selector decision becomes durable without relying on generated job paths", () => {
  const pathValue = "jobs/openclaw/inbox/gitcrawl-42-a.md";
  const evidence = [
    {
      path: pathValue,
      cluster_id: "gitcrawl-42-a",
      members: [
        {
          number: 420,
          role: "candidate" as const,
          kind: "issue" as const,
          state: "open",
          title: "Live bug",
          body: "Reproduction",
          url: "https://github.com/openclaw/openclaw/issues/420",
          author_association: "NONE",
          created_at: "2026-07-27T00:00:00Z",
          updated_at: "2026-07-27T01:00:00Z",
          closed_at: null,
          labels: [],
          pull_request: null,
        },
        {
          number: 421,
          role: "context" as const,
          kind: "issue" as const,
          state: "closed",
          title: "Prior fix",
          body: "Fixed earlier",
          url: "https://github.com/openclaw/openclaw/issues/421",
          author_association: "NONE",
          created_at: "2026-07-20T00:00:00Z",
          updated_at: "2026-07-26T00:00:00Z",
          closed_at: "2026-07-26T00:00:00Z",
          labels: [],
          pull_request: null,
        },
      ],
    },
  ];
  const decision = validateClusterSelectionDecision(
    {
      selected_path: null,
      rationale: "The prior fix already covers the remaining report.",
      assessments: [{ path: pathValue, decision: "rejected", rationale: "Already fixed." }],
    },
    [pathValue],
  );

  assert.deepEqual(durableClusterSelectionDecision(decision, evidence), {
    rationale: "The prior fix already covers the remaining report.",
    assessments: [
      {
        cluster_id: 42,
        decision: "rejected",
        rationale: "Already fixed.",
        candidate_refs: [420],
        cluster_refs: [420, 421],
      },
    ],
  });
});

test("structured selector cannot choose unoffered or inconsistently assessed work", () => {
  const offered = "jobs/openclaw/inbox/gitcrawl-1-a.md";
  assert.throws(
    () =>
      validateClusterSelectionDecision(
        {
          selected_path: "jobs/openclaw/inbox/gitcrawl-2-b.md",
          rationale: "Choose another path.",
          assessments: [{ path: offered, decision: "rejected", rationale: "No." }],
        },
        [offered],
      ),
    /unoffered path/,
  );
  assert.throws(
    () =>
      validateClusterSelectionDecision(
        {
          selected_path: offered,
          rationale: "Choose it.",
          assessments: [{ path: offered, decision: "rejected", rationale: "No." }],
        },
        [offered],
      ),
    /does not match/,
  );
});

test("selected candidate is fenced when live state changes after model evaluation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-selector-"));
  const relative = job(root, 43, [200, 201]);
  const previous = process.cwd();
  process.chdir(root);
  try {
    assert.throws(
      () =>
        assertSelectedCandidateStillOpen({
          path: relative,
          readItem: (number) => ({
            number,
            state: number === 201 ? "closed" : "open",
            title: "Bug",
          }),
        }),
      /#201 no longer open/,
    );
  } finally {
    process.chdir(previous);
  }
});

test("model request uses structured comparative selection without scores", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const candidate = {
    path: "jobs/openclaw/inbox/gitcrawl-1-a.md",
    cluster_id: "gitcrawl-1-a",
    members: [],
  };
  let requestBody = "";
  try {
    const decision = await selectClusterCandidateWithModel({
      repo: "openclaw/openclaw",
      evidence: [candidate],
      model: "internal",
      request: async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              selected_path: null,
              rationale: "The evidence does not establish useful work.",
              assessments: [
                { path: candidate.path, decision: "rejected", rationale: "Not actionable." },
              ],
            }),
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(decision.selected_path, null);
    assert.match(requestBody, /select at most one, or select none/i);
    assert.doesNotMatch(requestBody, /confidence|selection.score|STOP_WORDS|DECISION_LABELS/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

for (const stage of ["headers", "body"])
  test(`model deadline aborts native fetch stalled at ${stage}`, async (t) => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-selector-key";
    const nativeTimeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.equal(ms, 120_000);
      return nativeTimeout(100);
    });
    let received = false;
    const server = createServer((request, response) => {
      received = true;
      request.resume();
      if (stage === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
    });
    t.after(() => {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const candidate = {
      path: "jobs/openclaw/inbox/gitcrawl-1-a.md",
      cluster_id: "gitcrawl-1-a",
      members: [],
    };
    await assert.rejects(
      selectClusterCandidateWithModel({
        repo: "openclaw/openclaw",
        evidence: [candidate],
        model: "gpt-5.4",
        request: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      }),
      /timeout|abort/i,
    );
    assert.equal(received, true);
  });

test("cluster selection source contains no semantic word lists, thresholds, or scoring", () => {
  const sources = [
    fs.readFileSync("src/repair/select-cluster-candidate.ts", "utf8"),
    fs.readFileSync("src/repair/import-gitcrawl-clusters.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(sources, /STOP_WORDS|BUG_WORDS|FEATURE_WORDS|DECISION_WORDS/);
  assert.doesNotMatch(sources, /DECISION_LABELS|FEATURE_LABELS|BUG_LABELS/);
  assert.doesNotMatch(sources, /selection score|title cohesion|closedPercent|maxAgeDays/);
});

test("default selector issue, pull and final-open reads honor the shared gh deadline", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-selector-gh-"));
  const relative = job(root, 42, [100]);
  const script = path.join(root, "gh.cjs");
  fs.writeFileSync(
    script,
    `if (process.env.SELECTOR_TEST_STALL) setInterval(()=>{},1000);
else console.log(JSON.stringify(process.argv.at(-1).includes('/pulls/') ? {draft:false} : {number:100,state:'open',title:'synthetic report',pull_request:{}}));`,
  );
  const previous = { ...process.env };
  const cwd = process.cwd();
  Object.assign(process.env, {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([script]),
    CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "90000",
  });
  delete process.env.SELECTOR_TEST_STALL;
  process.chdir(root);
  const nativeExec = childProcess.execFileSync;
  const calls: string[] = [];
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    assert.equal(options.timeout, 90_000);
    calls.push(args.at(-1));
    return nativeExec(file, args, { ...options, timeout: 250 });
  });
  syncBuiltinESMExports();
  t.after(() => {
    process.chdir(cwd);
    for (const key of [
      "GH_BIN",
      "GH_BIN_ARGS",
      "CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS",
      "SELECTOR_TEST_STALL",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const evidence = collectClusterSelectionEvidence({
    repo: "openclaw/openclaw",
    paths: [relative],
  });
  assert.equal(evidence[0].members[0].pull_request?.draft, false);
  assertSelectedCandidateStillOpen({ path: relative });
  assert.deepEqual(calls, [
    "repos/openclaw/openclaw/issues/100",
    "repos/openclaw/openclaw/pulls/100",
    "repos/openclaw/openclaw/issues/100",
  ]);
  process.env.SELECTOR_TEST_STALL = "1";
  assert.throws(
    () => collectClusterSelectionEvidence({ repo: "openclaw/openclaw", paths: [relative] }),
    { code: "ETIMEDOUT" },
  );
  assert.throws(
    () =>
      collectClusterSelectionEvidence({
        repo: "openclaw/openclaw",
        paths: [relative],
        readItem: () => ({ number: 100, state: "open", title: "report", pull_request: {} }),
      }),
    { code: "ETIMEDOUT" },
  );
  assert.throws(() => assertSelectedCandidateStillOpen({ path: relative }), { code: "ETIMEDOUT" });
});
