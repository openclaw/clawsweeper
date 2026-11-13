import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  mockGhBinEnv,
  promotionGhMock,
  reportWithSyncedReviewComment,
  verifiedImplementationPullRequestReport,
  workPlanCandidateReport,
} from "./helpers.ts";

import { renderReviewStartStatusComment } from "../dist/clawsweeper.js";
import { itemSourceRevisionSha256 } from "../dist/clawsweeper-source-revision.js";

const repository = "openclaw/clawsweeper";
const snapshot = `pg-gitcrawl-clusters-v1:${"a".repeat(32)}:1`;
const updatedAt = "2026-05-01T00:00:00Z";
const bindingColumns =
  "profile archive binding_id snapshot_id manifest_sha256 inventory_sha256 repository github_repo_id view captured_at scope_status selection_source selection_run_id provider_complete full_native_scope_complete selected_input_complete retained_prior_memberships identity_reconciliation_complete publication_status analysis_status analysis_run_id analysis_publication_status structural_complete source_through source_observed_at analysis_source_through analysis_source_observed_at".split(
    " ",
  );
const relatedColumns =
  "cluster_id member_count representative_number representative_kind representative_state representative_title number kind state title body labels_json updated_at scope_status structural_complete".split(
    " ",
  );

type Scenario =
  | "success"
  | "source-drift"
  | "unavailable"
  | "unqualified"
  | "retry-revoked"
  | "legacy-hash"
  | "missing-counterpart";

async function fixture(t: TestContext, scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "service-apply-"));
  let stopService = async () => {};
  t.after(async () => {
    try {
      await stopService();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  const reportPath = join(root, "apply.json");
  const statePath = join(root, "state.json");
  const eventsPath = join(root, "events.jsonl");
  mkdirSync(itemsDir);
  mkdirSync(plansDir);
  mkdirSync(join(root, "bin"));
  writeFileSync(statePath, JSON.stringify({ labels: [], updatedAt, revoked: false }));
  writeFileSync(eventsPath, "");
  const isCounterpart = scenario === "missing-counterpart";
  const repo = isCounterpart ? "openclaw/openclaw" : repository;
  const issue = {
    number: 321, title: "Render work plans", body: "Reviewed source.",
    html_url: `https://github.com/${repository}/issues/321`, created_at: updatedAt,
    updated_at: updatedAt, closed_at: null, state: "open", locked: false,
    active_lock_reason: null, author_association: "CONTRIBUTOR", user: { login: "reporter" },
    labels: [], comments: scenario === "retry-revoked" ? 2 : 1, pull_request: null,
  };
  const sourceRevision = itemSourceRevisionSha256(issue, []);
  const leaseOwner = "service-apply-review";
  const leaseId = 700321;
  const report = isCounterpart
    ? verifiedImplementationPullRequestReport({
        repository: repo,
        number: 321,
        type: "pull_request",
        pull_head_sha: "head-sha",
        title: "Render work plans",
        author: "reporter",
        author_association: "CONTRIBUTOR",
        work_cluster_refs: "[]",
      })
    : workPlanCandidateReport(
        {
          number: 321,
          reviewed_at: updatedAt,
          item_snapshot_hash: "reviewed-snapshot-321",
          ...(scenario === "legacy-hash" ? {} : { item_updated_at: updatedAt }),
          ...(scenario === "retry-revoked" ? {
            item_source_revision: sourceRevision,
            review_lease_owner: leaseOwner,
            review_lease_comment_id: String(leaseId),
          } : {}),
          triage_priority: "P2",
          impact_labels: JSON.stringify(["impact:message-loss"]),
          work_cluster_refs: "[]",
        },
        { triagePriority: "P2", impactLabels: ["impact:message-loss"] },
      );
  const synced = reportWithSyncedReviewComment(
    report,
    321,
    isCounterpart ? "implemented_on_main" : "none",
  );
  const itemPath = join(itemsDir, "321.md");
  writeFileSync(itemPath, synced.report);
  if (isCounterpart) {
    writeFileSync(
      join(itemsDir, "320.md"),
      verifiedImplementationPullRequestReport({
        repository: repo,
        number: 320,
        type: "issue",
        author: "reporter",
        work_cluster_refs: "[]",
      }),
    );
  }
  const durable = {
    id: 9321,
    html_url: `https://github.com/${repo}/issues/321#issuecomment-9321`,
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]", type: "Bot" },
    body: synced.comment,
  };
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const lease = {
    id: leaseId, html_url: `https://github.com/${repo}/issues/321#issuecomment-${leaseId}`,
    created_at: startedAt, updated_at: startedAt, user: { login: "clawsweeper[bot]" },
    body: renderReviewStartStatusComment({ number: 321, kind: "issue", title: issue.title,
      headSha: sourceRevision, startedAt, leaseExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), leaseOwner }),
  };
  const ghPath = join(root, "bin", "gh.cjs");
  const common = `
const fs = require("node:fs");
const raw = process.argv.slice(2);
const actual = raw[0] === "--repo" ? raw.slice(2) : raw;
const endpoint = actual[1] === "-i" ? actual[2] : actual[1] || "";
const statePath = ${JSON.stringify(statePath)};
const eventsPath = ${JSON.stringify(eventsPath)};
const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(eventsPath, JSON.stringify({ type: "gh", args: actual }) + "\\n");
`;
  writeFileSync(
    ghPath,
    common +
      (isCounterpart
        ? `
if (actual[0] === "api" && /\\/issues\\/320$/.test(endpoint)) {
  console.error("gh: Not Found (HTTP 404)"); process.exit(1);
}
` +
          promotionGhMock({
            number: 321,
            title: "Render work plans",
            comment: synced.comment,
            // The directive is outside compact context; apply must use the full PR body.
            body: "Reviewed implementation. ".repeat(600) + "\nFixes #320",
            labels: [],
            commandLogPath: undefined,
          })
        : `
const current = state();
const durable = ${JSON.stringify(durable)};
const lease = ${JSON.stringify(lease)};
const issue = ${JSON.stringify(issue)};
if (actual[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(endpoint) && !actual.includes("--method")) {
  const comments = [{ ...durable, body: current.revoked ? "Maintainer replaced the reviewed decision." : durable.body }];
  if (${JSON.stringify(scenario)} === "retry-revoked" && !current.revoked) comments.push(lease);
  console.log(JSON.stringify(actual.includes("--slurp") ? [comments] : comments));
} else if (actual[0] === "api" && /\\/issues\\/321$/.test(endpoint)) {
  console.log(JSON.stringify({ ...issue, updated_at: current.updatedAt,
    labels: current.labels.map(name => ({ name })) }));
} else if (actual[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(endpoint)) {
  console.log(actual.includes("-i") ? "HTTP/2 200\\n\\n[]" : JSON.stringify(actual.includes("--slurp") ? [[]] : []));
} else if (actual[0] === "issue" && actual[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (actual[0] === "api" && endpoint.startsWith("search/issues")) {
  console.log(JSON.stringify({ items: [], total_count: 0, incomplete_results: false }));
} else if (actual[0] === "label" && actual[1] === "create") {
  console.log("");
} else if (actual[0] === "issue" && actual[1] === "edit") {
  if (${JSON.stringify(scenario)} === "retry-revoked" && !current.revoked) {
    fs.writeFileSync(statePath, JSON.stringify({ ...current, revoked: true, updatedAt: "2026-05-02T00:00:00Z" }));
    console.error("HTTP 503: Service Unavailable"); process.exit(1);
  }
  const label = actual[actual.indexOf("--add-label") + 1];
  fs.writeFileSync(statePath, JSON.stringify({ ...current, labels: [...new Set([...current.labels, label])] }));
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(actual)); process.exit(1);
}
`),
  );
  // A separate child serves HTTP while the actual CLI synchronously invokes GH_BIN.
  const serviceErrorPath = join(root, "service.stderr");
  const serviceErrorFd = openSync(serviceErrorPath, "w", 0o600);
  const service = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
const { createServer } = require("node:http");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const scenario = ${JSON.stringify(scenario)};
const eventsPath = ${JSON.stringify(eventsPath)};
const statePath = ${JSON.stringify(statePath)};
const snapshot = ${JSON.stringify(snapshot)};
const server = createServer(async (req, res) => {
  assert.equal(req.url, "/v1/apps/gitcrawl/archives/fixture/query");
  assert.equal(req.headers.authorization, "Bearer fixture-reader");
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const query = JSON.parse(Buffer.concat(chunks));
  fs.appendFileSync(eventsPath, JSON.stringify({ type: "service", query }) + "\\n");
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  if (scenario === "unavailable") { res.writeHead(401).end("denied"); return; }
  const binding = query.name === "gitcrawl.clusters.binding";
  if (!binding) {
    assert.equal(query.name, "gitcrawl.clusters.related-issues");
    assert.equal(query.snapshot_id, snapshot);
    assert.equal(query.args.number, "321");
    if (scenario === "source-drift") {
      await new Promise(resolve => setTimeout(resolve, 50));
      const state = JSON.parse(fs.readFileSync(statePath));
      fs.writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: "2026-05-02T00:00:00Z" }));
    }
  }
  const values = [scenario === "unqualified" ? "wrong-profile" : "gitcrawl.public-durable-cluster-context/v1",
    "fixture", "binding", snapshot, "b".repeat(64), "c".repeat(64), ${JSON.stringify(repo)},
    "9007199254740993", "durable-active/v1", "2026-05-01T00:00:00Z", "partial", "durable_cluster",
    "9007199254740994", false, false, true, "0", true, "published", "complete",
    "9007199254740995", "published", true, "2026-04-01T00:00:00Z", null, "2026-04-01T00:00:00Z", null];
  res.end(JSON.stringify({ columns: binding ? ${JSON.stringify(bindingColumns)} : ${JSON.stringify(relatedColumns)},
    rows: binding ? [values] : [], stats: { schema_version: 1, snapshot_id: snapshot } }));
});
server.listen(0, "127.0.0.1", () => process.send(server.address().port));
`,
    ],
    {
      stdio: ["ignore", "ignore", serviceErrorFd, "ipc"],
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
    },
  );
  closeSync(serviceErrorFd);
  const serviceError = () => readFileSync(serviceErrorPath, "utf8");
  stopService = async () => {
    if (service.exitCode === null && service.signalCode === null) {
      const stopped = once(service, "exit");
      service.kill();
      await stopped;
    }
  };
  const port = await new Promise<number>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(
      () => reject(new Error(`service startup timed out: ${serviceError()}`)),
      10_000,
    );
    service.once("message", (port) => {
      ready = true;
      clearTimeout(timer);
      resolve(Number(port));
    });
    service.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    service.once("exit", () => {
      clearTimeout(timer);
      if (!ready) reject(new Error(serviceError()));
    });
  });
  const env = {
    ...process.env,
    ...mockGhBinEnv(ghPath),
    CLAWSWEEPER_GITCRAWL_ENDPOINT: `http://127.0.0.1:${port}`,
    CLAWSWEEPER_GITCRAWL_ARCHIVE: "fixture",
    CLAWSWEEPER_GITCRAWL_READER_TOKEN: "fixture-reader",
  };
  delete env.CLAWSWEEPER_GITCRAWL_DB;
  delete env.EXACT_REVIEW_DECISION;
  const result = spawnSync(
    process.execPath,
    [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      repo,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      closedDir,
      "--plans-dir",
      plansDir,
      "--report-path",
      reportPath,
      "--limit",
      "10",
      "--processed-limit",
      "1",
      "--close-delay-ms",
      "0",
      "--skip-dashboard",
      "--item-number",
      "321",
      ...(isCounterpart ? ["--apply-kind", "all"] : []),
    ],
    { env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(serviceError(), "", "the HTTP fixture must not fail instead of exercising apply");
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; args?: string[]; query?: { name: string } });
  const effects = events.filter(
    ({ type, args }) =>
      type === "gh" &&
      args &&
      (args[0] === "label" ||
        (args[0] === "issue" && ["edit", "close", "comment"].includes(args[1]!)) ||
        (args[0] === "pr" && args[1] === "close") ||
        args.includes("--method")),
  );
  return {
    result,
    events,
    effects,
    itemPath,
    closedDir,
    state: JSON.parse(readFileSync(statePath, "utf8")),
    output: `${result.stdout}\n${result.stderr}\n${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""}`,
  };
}

for (const scenario of [
  "success",
  "source-drift",
  "unavailable",
  "unqualified",
  "legacy-hash",
  "retry-revoked",
] as const) {
  test(`built apply-decisions with a selected service: ${scenario}`, async (t) => {
    const f = await fixture(t, scenario);
    assert.ok(
      f.events.some((event) => event.type === "service"),
      f.output,
    );
    assert.equal(existsSync(f.itemPath), true, "an apply refusal must retain the primary report");
    assert.equal(existsSync(join(f.closedDir, "321.md")), false);
    if (scenario === "success") {
      assert.equal(f.result.status, 0, f.output);
      assert.ok(f.state.labels.includes("P2"), f.output);
      assert.ok(f.state.labels.includes("impact:message-loss"), f.output);
      const prepared = f.events.findIndex(
        (event) => event.query?.name === "gitcrawl.clusters.related-issues",
      );
      const firstEffect = f.events.indexOf(f.effects[0]!);
      assert.ok(prepared >= 0 && firstEffect > prepared, "service preparation precedes mutation");
    } else if (scenario === "retry-revoked") {
      assert.equal(f.state.revoked, true, "the first native mutation attempt must actually run");
      assert.deepEqual(f.state.labels, [], f.output);
      assert.equal(
        f.effects.filter((event) => event.args?.[0] === "issue" && event.args[1] === "edit").length,
        1,
        "a transient error must not retry after the live source revision changes",
      );
      assert.match(f.output, /review|lease|changed|stale/i);
    } else {
      assert.deepEqual(f.effects, [], f.output);
      assert.deepEqual(f.state.labels, []);
      if (scenario === "source-drift") {
        assert.equal(f.state.updatedAt, "2026-05-02T00:00:00Z");
        const serviceRead = f.events.findIndex(
          (event) => event.query?.name === "gitcrawl.clusters.related-issues",
        );
        assert.ok(
          f.events
            .slice(serviceRead + 1)
            .some((event) => event.args?.[1] === `repos/${repository}/issues/321`),
          "the live issue must be fetched again after service preparation",
        );
      } else if (scenario !== "legacy-hash") {
        assert.match(f.output, /unavailable or unqualified/);
      }
    }
  });
}

test("service preparation preserves the primary PR when a long-body linked counterpart is missing", async (t) => {
  const f = await fixture(t, "missing-counterpart");
  assert.ok(
    f.events.some((event) => event.args?.includes("repos/openclaw/openclaw/issues/320")),
    f.output,
  );
  assert.match(f.output, /404|not found/i);
  assert.deepEqual(f.effects, [], f.output);
  assert.equal(existsSync(f.itemPath), true);
  assert.equal(
    existsSync(join(f.closedDir, "321.md")),
    false,
    "the counterpart's 404 is not evidence that the primary PR was deleted",
  );
});
