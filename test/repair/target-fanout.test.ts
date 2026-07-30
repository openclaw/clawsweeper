import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SCHEDULED_REVIEW_PLAN_BATCH_SIZE,
  defaultLimit,
  filterEligibleRepositories,
  publishReviewCoverageInventory,
  renderFleetReviewCoverage,
  reviewCoverageInventorySnapshot,
  reviewPlanningRepositories,
  selectRepositories,
  summarizeFleetReviewCoverage,
  type InventoryConfig,
  type ListedRepository,
} from "../../dist/repair/target-fanout.js";
import { mockGhBinEnv } from "../helpers.ts";

const config: InventoryConfig = {
  owners: ["openclaw", "steipete"],
  denyRepositories: ["openclaw/clawsweeper-state"],
  includePrivate: false,
  includeArchived: false,
  includeForks: false,
  requireIssues: true,
};

test("target fanout defaults match the scheduled cursor batch sizes", () => {
  assert.equal(defaultLimit("hot-intake"), "20");
  assert.equal(defaultLimit("normal-review"), "12");
  assert.equal(defaultLimit("audit"), "12");
});

test("scheduled normal fanout can offer the configured hourly review target", () => {
  const wrangler = readFileSync("dashboard/wrangler.toml", "utf8");
  const configuredRate = Number(
    wrangler.match(/^EXACT_REVIEW_TARGET_RATE_PER_HOUR = "(\d+)"$/m)?.[1],
  );
  const offersPerHour = SCHEDULED_REVIEW_PLAN_BATCH_SIZE * Number(defaultLimit("normal-review"));

  assert.equal(configuredRate, 600);
  assert.equal(SCHEDULED_REVIEW_PLAN_BATCH_SIZE, 50);
  assert.equal(offersPerHour, 600);
  assert.ok(offersPerHour >= configuredRate);
});

test("normal fanout prioritizes repositories with untracked live items and skips empty repos", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-planning-inventory-"));
  const repositories = [
    { targetRepo: "openclaw/empty", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/huge", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/tracked", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "steipete/small", defaultBranch: "main", visibility: "PUBLIC" },
  ];
  try {
    const hugeItems = join(root, "openclaw-huge", "items");
    const trackedItems = join(root, "openclaw-tracked", "items");
    mkdirSync(hugeItems, { recursive: true });
    mkdirSync(trackedItems, { recursive: true });
    writeFileSync(join(hugeItems, "1.md"), "---\nreview_status: complete\n---\n");
    writeFileSync(join(trackedItems, "1.md"), "---\nreview_status: complete\n---\n");
    writeFileSync(join(trackedItems, "2.md"), "---\nreview_status: complete\n---\n");

    assert.deepEqual(
      reviewPlanningRepositories({
        repositories,
        recordsRoot: root,
        openCounts: new Map([
          ["openclaw/empty", { issues: 0, pullRequests: 0 }],
          ["openclaw/huge", { issues: 100, pullRequests: 1 }],
          ["openclaw/tracked", { issues: 1, pullRequests: 1 }],
          ["steipete/small", { issues: 1, pullRequests: 0 }],
        ]),
      }),
      [
        {
          ...repositories[1],
          openItems: 101,
          trackedRecords: 1,
          untrackedOpen: 100,
        },
        {
          ...repositories[3],
          openItems: 1,
          trackedRecords: 0,
          untrackedOpen: 1,
        },
        {
          ...repositories[2],
          openItems: 2,
          trackedRecords: 2,
          untrackedOpen: 0,
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target fanout summarizes trailing weekly coverage from canonical open records", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-coverage-"));
  const now = Date.parse("2026-07-29T12:00:00Z");
  const repositories = [
    { targetRepo: "openclaw/a", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "steipete/b", defaultBranch: "main", visibility: "PUBLIC" },
  ];
  try {
    const aItems = join(root, "openclaw-a", "items");
    const bItems = join(root, "steipete-b", "items");
    mkdirSync(aItems, { recursive: true });
    mkdirSync(bItems, { recursive: true });
    writeFileSync(
      join(aItems, "1.md"),
      "---\nreview_status: complete\nreviewed_at: 2026-07-28T12:00:00Z\n---\n",
    );
    writeFileSync(
      join(aItems, "2.md"),
      "---\nreview_status: complete\nreviewed_at: 2026-07-20T12:00:00Z\n---\n",
    );
    writeFileSync(
      join(bItems, "3.md"),
      "---\nreview_status: failed\nreviewed_at: 2026-07-29T11:00:00Z\n---\n",
    );
    const coverage = summarizeFleetReviewCoverage({
      repositories,
      openCounts: new Map([
        ["openclaw/a", { issues: 2, pullRequests: 1 }],
        ["steipete/b", { issues: 0, pullRequests: 1 }],
      ]),
      windowDays: 7,
      recordsRoot: root,
      now,
    });

    assert.deepEqual(coverage, {
      generatedAt: "2026-07-29T12:00:00.000Z",
      windowDays: 7,
      repositoryCount: 2,
      repositoriesWithOpenItems: 2,
      openIssues: 2,
      openPullRequests: 2,
      openTotal: 4,
      scannedOpenRecords: 1,
      remainingOpenItems: 3,
      coveragePercent: 25,
      requiredItemsPerHourWithHeadroom: (4 / 168) * 1.3,
    });
    assert.match(renderFleetReviewCoverage(coverage), /Items scanned in trailing 7 days \| 1/);
    assert.match(renderFleetReviewCoverage(coverage), /Trailing coverage \| 25\.0%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target fanout publishes signed live open counts for dashboard coverage", async () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  const repositories = [
    { targetRepo: "openclaw/openclaw", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "steipete/tool", defaultBranch: "main", visibility: "PUBLIC" },
  ];
  const snapshot = reviewCoverageInventorySnapshot(
    repositories,
    new Map([
      ["openclaw/openclaw", { issues: 3596, pullRequests: 2319 }],
      ["steipete/tool", { issues: 2, pullRequests: 1 }],
    ]),
    now,
  );
  assert.deepEqual(snapshot, {
    generated_at: "2026-07-29T12:00:00.000Z",
    repositories: [
      {
        repo: "openclaw/openclaw",
        repo_slug: "openclaw-openclaw",
        open_issues: 3596,
        open_pull_requests: 2319,
      },
      {
        repo: "steipete/tool",
        repo_slug: "steipete-tool",
        open_issues: 2,
        open_pull_requests: 1,
      },
    ],
  });

  const requests: Array<{ body: string; signature: string }> = [];
  const waits: number[] = [];
  await publishReviewCoverageInventory({
    baseUrl: "https://queue.example/",
    webhookSecret: "coverage-secret",
    snapshot,
    attempts: 2,
    fetchImpl: async (_input, init) => {
      const body = String(init?.body ?? "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        body,
        signature: String(headers["x-clawsweeper-exact-review-signature"]),
      });
      return requests.length === 1
        ? Response.json({ error: "busy" }, { status: 503 })
        : Response.json({ ok: true }, { status: 202 });
    },
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [5_000]);
  assert.equal(requests[0]?.body, JSON.stringify(snapshot));
  assert.equal(
    requests[0]?.signature,
    `sha256=${createHmac("sha256", "coverage-secret").update(JSON.stringify(snapshot)).digest("hex")}`,
  );
});

test("target fanout filters eligible repositories conservatively", () => {
  const repositories: ListedRepository[] = [
    repo("openclaw/openclaw"),
    repo("openclaw/clawsweeper-state"),
    repo("openclaw/archived", { isArchived: true }),
    repo("openclaw/forked", { isFork: true }),
    repo("openclaw/no-issues", { hasIssuesEnabled: false }),
    repo("openclaw/empty", { defaultBranch: "" }),
    repo("steipete/private-tool", { visibility: "PRIVATE" }),
    repo("steipete/internal-tool", { visibility: "INTERNAL" }),
  ];

  assert.deepEqual(filterEligibleRepositories(repositories, config), [
    { targetRepo: "openclaw/openclaw", defaultBranch: "main", visibility: "PUBLIC" },
  ]);
});

test("target fanout skips owners without minted inventory tokens in Actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
  ]));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/dispatches")) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        ...mockGhBinEnv(ghPath),
        GH_TOKEN: "workflow-token",
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; total: number };
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.dispatched, ["openclaw/b"]);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw"],
  );
});

test("target fanout can use anonymous public inventory in Actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  const owner = args[2];
  const data = owner === "openclaw"
    ? [{nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}]
    : [{nameWithOwner:"steipete/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}];
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/dispatches")) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        ...mockGhBinEnv(ghPath),
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "__public__",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; total: number };
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.dispatched, ["openclaw/b", "steipete/a"]);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw", "dispatch-token"],
  );
});

test("target fanout falls back to public inventory env outside Actions", () => {
  const source = readFileSync("src/repair/target-fanout.ts", "utf8");
  const helperStart = source.indexOf("function inventoryEnv(");
  const helperEnd = source.indexOf("function publicInventoryEnv(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(process\.env\.GITHUB_ACTIONS === "true"\) return null;/);
  assert.match(helper, /return publicInventoryEnv\(\);/);
  assert.doesNotMatch(helper, /GH_TOKEN: ""/);
});

test("target fanout selection advances cursor with wraparound", () => {
  const repositories = [
    { targetRepo: "openclaw/a", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/b", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/c", defaultBranch: "main", visibility: "PUBLIC" },
  ];

  assert.deepEqual(selectRepositories(repositories, { limit: 2, cursor: 2 }), {
    repositories: [repositories[2], repositories[0]],
    cursor: 1,
    total: 3,
  });
});

test("target fanout CLI lists repos and dispatches selected workflow runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  const owner = args[2];
  const data = owner === "openclaw"
    ? [
        {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}},
        {nameWithOwner:"openclaw/clawsweeper-state",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
      ]
    : [
        {nameWithOwner:"steipete/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"master"}}
      ];
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}
if ((args[0] === "workflow" && args[1] === "run") || (args[0] === "api" && args[1].endsWith("/dispatches"))) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...mockGhBinEnv(ghPath),
        GH_TOKEN: "workflow-token",
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "inventory-steipete",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; next_cursor: number };
  assert.deepEqual(summary.dispatched, ["openclaw/b", "steipete/a"]);
  assert.equal(summary.next_cursor, 0);
  assert.match(readFileSync(cursorPath, "utf8"), /"next_cursor": 0/);

  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw", "inventory-steipete"],
  );
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "api").map((call) => call.ghToken),
    ["dispatch-token", "dispatch-token"],
  );
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "api").map((call) => call.args.join(" ")),
    [
      "api repos/openclaw/clawsweeper/dispatches -f event_type=clawsweeper_target_sweep -f client_payload[target_repo]=openclaw/b -f client_payload[target_branch]=main -f client_payload[hot_intake]=true -f client_payload[batch_size]=50 -f client_payload[shard_count]=1",
      "api repos/openclaw/clawsweeper/dispatches -f event_type=clawsweeper_target_sweep -f client_payload[target_repo]=steipete/a -f client_payload[target_branch]=master -f client_payload[hot_intake]=true -f client_payload[batch_size]=50 -f client_payload[shard_count]=1",
    ],
  );
});

test("target fanout dry-run does not advance cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(cursorPath, `${JSON.stringify({ next_cursor: 1 }, null, 2)}\n`);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {nameWithOwner:"openclaw/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}},
    {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
  ]));
  process.exit(0);
}
if ((args[0] === "workflow" && args[1] === "run") || (args[0] === "api" && args[1].endsWith("/dispatches"))) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "1",
      "--cursor-path",
      cursorPath,
      "--dry-run",
      "--owners",
      "openclaw",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...mockGhBinEnv(ghPath),
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
      },
    },
  );

  const summary = JSON.parse(output.slice(output.indexOf("{\n"))) as {
    dispatched: string[];
    cursor_written: boolean;
  };
  assert.deepEqual(summary.dispatched, ["openclaw/b"]);
  assert.equal(summary.cursor_written, false);
  assert.match(readFileSync(cursorPath, "utf8"), /"next_cursor": 1/);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.filter((call) => call[0] === "api").length, 0);
});

function repo(nameWithOwner: string, overrides: Partial<ListedRepository> = {}): ListedRepository {
  return {
    nameWithOwner,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    hasIssuesEnabled: true,
    visibility: "PUBLIC",
    defaultBranch: "main",
    ...overrides,
  };
}
