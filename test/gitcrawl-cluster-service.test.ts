import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readGitcrawlClusterService } from "../dist/gitcrawl-cluster-service.js";
import { createRelatedContext } from "../dist/clawsweeper-related-context.js";
import { createApplyDecisionWorkflow } from "../dist/clawsweeper-apply-decision-workflow.js";
import { createCommandOperations } from "../dist/clawsweeper-command-operations.js";
import { postReviewStartStatusComment } from "../dist/clawsweeper-review-comment-leases.js";

const repository = "fixture/repository";
const bindingColumns =
  "profile archive binding_id snapshot_id manifest_sha256 inventory_sha256 repository github_repo_id view captured_at scope_status selection_source selection_run_id provider_complete full_native_scope_complete selected_input_complete retained_prior_memberships identity_reconciliation_complete publication_status analysis_status analysis_run_id analysis_publication_status structural_complete source_through source_observed_at analysis_source_through analysis_source_observed_at".split(
    " ",
  );
const relatedColumns =
  "cluster_id member_count representative_number representative_kind representative_state representative_title number kind state title body labels_json updated_at scope_status structural_complete".split(
    " ",
  );
const item = {
  repo: repository,
  number: 1,
  kind: "issue" as const,
  title: "Fixture",
  url: "https://github.com/fixture/repository/issues/1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  author: "fixture",
  authorAssociation: "NONE" as const,
  labels: [],
};

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cluster-service-"));
  mkdirSync(join(root, "items"));
  mkdirSync(join(root, "closed"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let sequence = 1;
  let fault = "";
  let rows: unknown[][] = [relatedRow("2"), relatedRow("3")];
  const requests: Record<string, unknown>[] = [];
  const pin = () => `pg-gitcrawl-clusters-v1:${"a".repeat(32)}:${sequence}`;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/apps/gitcrawl/archives/fixture/query");
    assert.equal(req.headers.authorization, "Bearer fixture-reader");
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    const query = JSON.parse(Buffer.concat(body).toString("utf8"));
    requests.push(query);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (fault === "401") {
      res.writeHead(401).end("denied");
      return;
    }
    if (fault === "redirect") {
      res.writeHead(302, { location: "/unexpected" }).end();
      return;
    }
    const binding = query.name === "gitcrawl.clusters.binding";
    if (!binding) {
      assert.equal(query.name, "gitcrawl.clusters.related-issues");
      assert.equal(query.snapshot_id, pin());
      assert.deepEqual(query.args, { repository, number: "1" });
      assert.equal(query.limit, 6);
    }
    const values = [
      "gitcrawl.public-durable-cluster-context/v1",
      "fixture",
      "binding",
      pin(),
      "b".repeat(64),
      "c".repeat(64),
      repository,
      "9007199254740993",
      "durable-active/v1",
      "2026-01-01T00:00:00Z",
      "partial",
      "durable_cluster",
      "9007199254740994",
      false,
      false,
      true,
      "0",
      true,
      "published",
      "complete",
      "9007199254740995",
      "published",
      true,
      "2025-12-01T00:00:00Z",
      null,
      "2025-12-01T00:00:00Z",
      null,
    ];
    if (fault === "profile") values[0] = "gitcrawl-private-report-v1";
    const page = {
      columns: binding ? bindingColumns : relatedColumns,
      rows: binding ? [values] : rows,
      stats: { schema_version: 1, snapshot_id: !binding && fault === "pin" ? `${pin()}0` : pin() },
    };
    res.end(fault === "oversize" ? " ".repeat(1024 * 1024 + 1) : JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const config = {
    endpoint: `http://127.0.0.1:${address.port}`,
    archive: "fixture",
    token: "fixture-reader",
  };
  const names = [
    "CLAWSWEEPER_GITCRAWL_ENDPOINT",
    "CLAWSWEEPER_GITCRAWL_ARCHIVE",
    "CLAWSWEEPER_GITCRAWL_READER_TOKEN",
    "CLAWSWEEPER_GITCRAWL_DB",
  ];
  const prior = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    }),
  );
  process.env.CLAWSWEEPER_GITCRAWL_ENDPOINT = config.endpoint;
  process.env.CLAWSWEEPER_GITCRAWL_ARCHIVE = config.archive;
  process.env.CLAWSWEEPER_GITCRAWL_READER_TOKEN = config.token;
  delete process.env.CLAWSWEEPER_GITCRAWL_DB;
  const context = createRelatedContext({
    root,
    targetRepo: () => repository,
    reportUrl: (x) => x,
    defaultItemsDir: () => join(root, "items"),
    defaultClosedDir: () => join(root, "closed"),
    isMarkdownForActiveRepo: () => true,
    gitHubRuntimeBudgetError: class extends Error {},
    ghJsonEach: (requests) =>
      requests.map(() => ({ ok: true as const, value: { number: 2 } as never })),
    ghJsonOnce: () => {
      throw new Error("unexpected GitHub read");
    },
    compactIssue: (x) => x,
    compactPullRequest: (x) => x,
    displayTitle: (x) => x,
    repoRelativePath: (x) => x,
  });
  return {
    config,
    context,
    requests,
    pin,
    setFault: (value: string) => {
      fault = value;
    },
    setRows: (value: unknown[][]) => {
      rows = value;
    },
    advance: () => {
      sequence++;
    },
  };
}

function relatedRow(number: string): unknown[] {
  return [
    "9007199254740993",
    "9007199254740994",
    "2",
    "issue",
    "open",
    "Representative",
    number,
    "issue",
    "open",
    "Fixture related",
    "bounded body\u0000☃",
    "[]",
    null,
    "partial",
    true,
  ];
}

test("service review relations retain exact IDs, clocks and nullable timestamps through the existing dedupe", async (t) => {
  const f = await fixture(t);
  const result = await readGitcrawlClusterService(f.config, repository, 1);
  assert.equal(result.rows[0]?.clusterId, "9007199254740993");
  assert.equal(result.rows[0]?.memberCount, "9007199254740994");
  assert.equal(result.rows[0]?.updatedAt, null);
  assert.equal(result.sourceThrough, "2025-12-01T00:00:00Z");
  const prepared = await f.context.prepareReviewRelations(item);
  const related = prepared.relatedItemsContext({
    item,
    issue: { body: "See #2" },
    comments: [],
    timeline: [],
  }) as Array<{
    issue?: { number: number };
    gitcrawlThread?: { number: number; body: string };
    gitcrawlCluster?: { snapshotId: string };
  }>;
  assert.equal(related.length, 2);
  assert.equal(related[0]?.issue?.number, 2);
  assert.equal(related[1]?.gitcrawlThread?.number, 3);
  assert.equal(related[1]?.gitcrawlThread?.body, "bounded body\u0000☃");
  assert.equal(related[1]?.gitcrawlCluster?.snapshotId, f.pin());
  assert.equal(f.requests.length, 4, "each preparation owns one binding and pinned query");
  assert(!JSON.stringify(related).includes(f.config.token));
  assert(!JSON.stringify(related).includes(f.config.endpoint));
});

test("each structural service probe reads fresh binding and treats empty historical completeness as unknown", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.context.structuralExternalRelationSensitivity(item), true);
  f.advance();
  f.setRows([]);
  assert.equal(await f.context.structuralExternalRelationSensitivity(item), null);
  assert.equal(f.requests.length, 4);
  assert.notEqual(f.requests[1]?.snapshot_id, f.requests[3]?.snapshot_id);
  f.setFault("401");
  assert.equal(await f.context.structuralExternalRelationSensitivity(item), null);
});

test("selected service failures cannot become empty context or fall back to SQLite", async (t) => {
  const f = await fixture(t);
  for (const fault of ["401", "profile", "pin", "oversize", "redirect"]) {
    f.setFault(fault);
    await assert.rejects(f.context.prepareReviewRelations(item), {
      message: "Gitcrawl cluster service is unavailable or unqualified",
    });
  }
  f.setFault("");
  f.setRows([relatedRow("9007199254740993")]);
  await assert.rejects(f.context.prepareReviewRelations(item), /unavailable or unqualified/);
  assert.throws(
    () => f.context.relatedItemsContext({ item, issue: {}, comments: [], timeline: [] }),
    /does not support/,
  );
  process.env.CLAWSWEEPER_GITCRAWL_DB = "unused.sqlite";
  const before = f.requests.length;
  await assert.rejects(f.context.prepareReviewRelations(item), /unavailable or unqualified/);
  assert.equal(f.requests.length, before, "mixed configuration must refuse before either source");
});

test("service mode holds synchronous apply and review-start entrypoints before dependencies or effects", async (t) => {
  await fixture(t);
  const dependencies = new Proxy(
    {},
    { get: () => () => assert.fail("held operation reached a dependency") },
  );
  const commands = createCommandOperations(dependencies as never);
  for (const operation of [
    commands.applyDecisionsCommand,
    commands.applyArtifactsCommand,
    commands.reserveReviewLeaseCommand,
  ]) {
    assert.throws(() => operation({}), /does not support apply or review-start/);
  }
  const apply = createApplyDecisionWorkflow(dependencies as never);
  assert.throws(
    () => apply.applyDecisionsCommandInner({}, {} as never),
    /does not support apply or review-start/,
  );
  assert.throws(
    () => postReviewStartStatusComment({} as never, () => assert.fail("revision read")),
    /does not support apply or review-start/,
  );
});
