import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTeamCoverage,
  buildSnapshot,
  collectWorkspaceItems,
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  parseArgs,
  resolveToken,
  SNAPSHOT_SCHEMA,
} from "../scripts/linear-snapshot.mjs";
import type { LinearIssue, LinearProject, LinearTeam } from "../dist/linear/types.js";

// ---------------------------------------------------------------------------
// Fixtures + a fake read-only source (no network, no clock)
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<LinearTeam> = {}): LinearTeam {
  return { id: "team-1", key: "PAR", name: "PartnerAI", ...overrides };
}

function makeProject(overrides: Partial<LinearProject> = {}): LinearProject {
  return { id: "proj-1", name: "ClawSweeper", teamId: "team-1", state: "started", ...overrides };
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "PAR-209",
    title: "Read-only Linear item source",
    url: "https://linear.app/partnerai/issue/PAR-209",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-18T00:00:00Z",
    teamId: "team-1",
    projectId: "proj-1",
    stateId: "state-1",
    stateName: "Backlog",
    stateType: "backlog",
    priority: 2,
    labels: [],
    ...overrides,
  };
}

// Minimal fake of LinearItemSource exposing only what collectWorkspaceItems uses.
function makeFakeSource(spec: {
  teams: LinearTeam[];
  projectsByTeam?: Record<string, LinearProject[]>;
  issuesByTeam?: Record<string, LinearIssue[]>;
  onListIssues?: (options: { teamId: string; updatedAfter?: string; pageSize?: number }) => void;
}) {
  return {
    async listTeams(_pageSize?: number): Promise<LinearTeam[]> {
      return spec.teams;
    },
    async listProjects(teamId: string, _pageSize?: number): Promise<LinearProject[]> {
      return spec.projectsByTeam?.[teamId] ?? [];
    },
    async listIssues(options: {
      teamId: string;
      updatedAfter?: string;
      pageSize?: number;
    }): Promise<LinearIssue[]> {
      spec.onListIssues?.(options);
      return spec.issuesByTeam?.[options.teamId] ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs defaults: empty team list, default keychain coordinates, no out", () => {
  const opts = parseArgs([]);
  assert.deepEqual(opts.teamKeys, []);
  assert.equal(opts.updatedAfter, undefined);
  assert.equal(opts.pageSize, undefined);
  assert.equal(opts.out, "");
  assert.equal(opts.keychainService, DEFAULT_KEYCHAIN_SERVICE);
  assert.equal(opts.keychainAccount, DEFAULT_KEYCHAIN_ACCOUNT);
  assert.equal(opts.help, false);
});

test("parseArgs collects repeated --team and reads scalar options", () => {
  const opts = parseArgs([
    "--team",
    "PAR",
    "--team",
    "ENG",
    "--updated-after",
    "2026-06-01T00:00:00Z",
    "--page-size",
    "50",
    "--out",
    "snap.json",
  ]);
  assert.deepEqual(opts.teamKeys, ["PAR", "ENG"]);
  assert.equal(opts.updatedAfter, "2026-06-01T00:00:00Z");
  assert.equal(opts.pageSize, 50);
  assert.equal(opts.out, "snap.json");
});

test("parseArgs honors --help and keychain overrides", () => {
  const opts = parseArgs(["--help", "--keychain-service", "svc", "--keychain-account", "acct"]);
  assert.equal(opts.help, true);
  assert.equal(opts.keychainService, "svc");
  assert.equal(opts.keychainAccount, "acct");
});

test("parseArgs rejects unknown args, missing values, and non-positive page size", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument: --nope/);
  assert.throws(() => parseArgs(["--team"]), /--team requires a value/);
  assert.throws(() => parseArgs(["--page-size", "0"]), /--page-size must be a positive integer/);
  assert.throws(() => parseArgs(["--page-size", "x"]), /--page-size must be a positive integer/);
});

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

test("resolveToken prefers LINEAR_API_KEY, then LINEAR_TOKEN", () => {
  const never = () => {
    throw new Error("keychain should not be consulted when env token is set");
  };
  assert.equal(
    resolveToken({
      env: { LINEAR_API_KEY: "lin_api", LINEAR_TOKEN: "lin_tok" },
      runKeychain: never,
    }),
    "lin_api",
  );
  assert.equal(resolveToken({ env: { LINEAR_TOKEN: "lin_tok" }, runKeychain: never }), "lin_tok");
});

test("resolveToken trims and falls through whitespace-only env tokens to the keychain", () => {
  const token = resolveToken({
    env: { LINEAR_API_KEY: "   " },
    runKeychain: () => "lin_keychain\n",
  });
  assert.equal(token, "lin_keychain");
});

test("resolveToken consults the keychain with the given service/account", () => {
  const seen: Array<[string, string]> = [];
  const token = resolveToken({
    env: {},
    service: "my-svc",
    account: "my-acct",
    runKeychain: (service: string, account: string) => {
      seen.push([service, account]);
      return "lin_from_keychain";
    },
  });
  assert.equal(token, "lin_from_keychain");
  assert.deepEqual(seen, [["my-svc", "my-acct"]]);
});

test("resolveToken throws a token-free error when nothing resolves", () => {
  assert.throws(
    () => resolveToken({ env: {}, runKeychain: () => "" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /No Linear API token found/);
      assert.match(message, /LINEAR_API_KEY/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// collectWorkspaceItems
// ---------------------------------------------------------------------------

test("collectWorkspaceItems with no filter sweeps all teams and joins projects", async () => {
  const source = makeFakeSource({
    teams: [makeTeam(), makeTeam({ id: "team-2", key: "ENG", name: "Engineering" })],
    projectsByTeam: { "team-1": [makeProject()], "team-2": [] },
    issuesByTeam: {
      "team-1": [makeIssue()],
      "team-2": [makeIssue({ id: "i2", identifier: "ENG-1", teamId: "team-2", projectId: null })],
    },
  });

  const { items, teamsSeen } = await collectWorkspaceItems(source, {});
  assert.deepEqual(teamsSeen, ["PAR", "ENG"]);
  assert.equal(items.length, 2);
  // Project is joined by projectId for the PAR issue, null for the ENG issue.
  assert.equal(items[0]?.project?.id, "proj-1");
  assert.equal(items[0]?.team.key, "PAR");
  assert.equal(items[1]?.project, null);
});

test("collectWorkspaceItems restricts to requested team keys", async () => {
  const source = makeFakeSource({
    teams: [makeTeam(), makeTeam({ id: "team-2", key: "ENG", name: "Engineering" })],
    projectsByTeam: { "team-1": [makeProject()] },
    issuesByTeam: { "team-1": [makeIssue()], "team-2": [makeIssue({ teamId: "team-2" })] },
  });

  const { items, teamsSeen } = await collectWorkspaceItems(source, { teamKeys: ["PAR"] });
  assert.deepEqual(teamsSeen, ["PAR"]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.issue.identifier, "PAR-209");
});

test("collectWorkspaceItems maps an unknown projectId to a null project", async () => {
  const source = makeFakeSource({
    teams: [makeTeam()],
    projectsByTeam: { "team-1": [makeProject()] },
    issuesByTeam: { "team-1": [makeIssue({ projectId: "ghost" })] },
  });
  const { items } = await collectWorkspaceItems(source, {});
  assert.equal(items.length, 1);
  assert.equal(items[0]?.project, null);
});

test("collectWorkspaceItems threads updatedAfter and pageSize into the issue query", async () => {
  const calls: Array<{ teamId: string; updatedAfter?: string; pageSize?: number }> = [];
  const source = makeFakeSource({
    teams: [makeTeam()],
    projectsByTeam: { "team-1": [makeProject()] },
    issuesByTeam: { "team-1": [makeIssue()] },
    onListIssues: (options) => calls.push(options),
  });

  await collectWorkspaceItems(source, { updatedAfter: "2026-06-01T00:00:00Z", pageSize: 100 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.updatedAfter, "2026-06-01T00:00:00Z");
  assert.equal(calls[0]?.pageSize, 100);
});

// ---------------------------------------------------------------------------
// assertTeamCoverage — fail loudly on empty-scope snapshots
// ---------------------------------------------------------------------------

test("assertTeamCoverage passes when every requested team was scanned", () => {
  assert.doesNotThrow(() =>
    assertTeamCoverage({ items: [], teamsSeen: ["PAR", "ENG"] }, { teamKeys: ["PAR", "ENG"] }),
  );
});

test("assertTeamCoverage passes an all-teams sweep that resolved at least one team", () => {
  assert.doesNotThrow(() => assertTeamCoverage({ items: [], teamsSeen: ["PAR"] }, {}));
});

test("assertTeamCoverage throws listing the unmatched --team keys (requested minus scanned)", () => {
  assert.throws(
    () => assertTeamCoverage({ items: [], teamsSeen: ["PAR"] }, { teamKeys: ["PAR", "GHOST"] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /matched no live team for: GHOST/);
      assert.doesNotMatch(message, /for: PAR/);
      assert.match(message, /TRIAGE_OK/);
      return true;
    },
  );
});

test("assertTeamCoverage throws when a --team filter matches no team at all", () => {
  assert.throws(
    () => assertTeamCoverage({ items: [], teamsSeen: [] }, { teamKeys: ["GHOST"] }),
    /matched no live team for: GHOST/,
  );
});

test("assertTeamCoverage flags an empty teamsSeen even when no --team was requested", () => {
  assert.throws(
    () => assertTeamCoverage({ items: [], teamsSeen: [] }, {}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /No teams resolved from the Linear workspace/);
      assert.match(message, /TRIAGE_OK/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

test("buildSnapshot wraps items in the schema envelope with a stable generatedAt", () => {
  const collected = { items: [makeWorkspaceItemRecord()], teamsSeen: ["PAR"] };
  const snapshot = buildSnapshot(collected, {
    generatedAt: "2026-06-22T00:00:00Z",
    teamKeys: ["PAR"],
    updatedAfter: "2026-06-01T00:00:00Z",
  });

  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
  assert.equal(snapshot.generatedAt, "2026-06-22T00:00:00Z");
  assert.equal(snapshot.source.provider, "linear");
  assert.equal(snapshot.source.reviewOnly, true);
  assert.deepEqual(snapshot.source.teamsRequested, ["PAR"]);
  assert.deepEqual(snapshot.source.teamsScanned, ["PAR"]);
  assert.equal(snapshot.source.updatedAfter, "2026-06-01T00:00:00Z");
  assert.equal(snapshot.source.itemCount, 1);
  assert.equal(snapshot.items.length, 1);
});

test("buildSnapshot never embeds a token and defaults updatedAfter to null", () => {
  const snapshot = buildSnapshot(
    { items: [], teamsSeen: [] },
    { generatedAt: "2026-06-22T00:00:00Z" },
  );
  assert.equal(snapshot.source.updatedAfter, null);
  assert.equal(snapshot.source.itemCount, 0);
  assert.ok(!JSON.stringify(snapshot).toLowerCase().includes("lin_"));
});

function makeWorkspaceItemRecord() {
  return { team: makeTeam(), project: makeProject(), issue: makeIssue() };
}
