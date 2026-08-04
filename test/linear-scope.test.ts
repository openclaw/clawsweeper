import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeIdentifiers,
  chooseScope,
  extractIdentifiers,
  matchIdentifier,
  resolveScope,
} from "../dist/linear/scope.js";
import type { ScopeSource } from "../dist/linear/scope.js";
import type { LinearIssue, LinearProject, LinearTeam } from "../dist/linear/types.js";

// ---------------------------------------------------------------------------
// Fixtures + a fake read-only source (no network, no clock)
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<LinearTeam> = {}): LinearTeam {
  return { id: "team-1", key: "PAR", name: "PartnerAI", ...overrides };
}

function makeProject(overrides: Partial<LinearProject> = {}): LinearProject {
  return {
    id: "proj-1",
    name: "Command Central",
    teamId: "team-1",
    state: "started",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "PAR-1",
    title: "x",
    url: "https://linear.app/partnerai/issue/PAR-1",
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

function fakeSource(data: {
  teams: LinearTeam[];
  projects: LinearProject[];
  issues: LinearIssue[];
}): ScopeSource {
  return {
    async listTeams() {
      return data.teams;
    },
    async listProjects(teamId: string) {
      return data.projects.filter((p) => p.teamId === teamId);
    },
    async listIssues(options: { teamId: string }) {
      return data.issues.filter((i) => i.teamId === options.teamId);
    },
  };
}

// ---------------------------------------------------------------------------
// matchIdentifier
// ---------------------------------------------------------------------------

test("matchIdentifier canonicalizes valid identifiers", () => {
  assert.equal(matchIdentifier("PAR-244"), "PAR-244");
  assert.equal(matchIdentifier("  par-244  "), "PAR-244"); // trim + upper
  assert.equal(matchIdentifier("PAR-007"), "PAR-7"); // strip leading zeros
  assert.equal(matchIdentifier("eng-12"), "ENG-12");
});

test("matchIdentifier rejects non-identifiers", () => {
  assert.equal(matchIdentifier("not-an-id"), null);
  assert.equal(matchIdentifier("ABC123"), null);
  assert.equal(matchIdentifier(""), null);
  assert.equal(matchIdentifier("PAR-"), null);
  assert.equal(matchIdentifier(123), null);
  assert.equal(matchIdentifier(null), null);
  assert.equal(matchIdentifier(undefined), null);
});

// ---------------------------------------------------------------------------
// extractIdentifiers
// ---------------------------------------------------------------------------

test("extractIdentifiers reads an array of strings, dropping non-identifiers", () => {
  assert.deepEqual(extractIdentifiers(["PAR-1", "ENG-2", "garbage", ""]), ["PAR-1", "ENG-2"]);
});

test("extractIdentifiers reads records via identifier/key/id fields", () => {
  const value = [{ identifier: "PAR-1" }, { key: "ENG-2" }, { id: "OPS-3" }, { nope: "x" }];
  assert.deepEqual(extractIdentifiers(value), ["PAR-1", "ENG-2", "OPS-3"]);
});

test("extractIdentifiers uses the first present list field (order) and IGNORES nested reference arrays", () => {
  // This is the load-bearing safety property: a ledger entry's blocks_active / depends_on
  // arrays are full of identifier-shaped strings that are NOT the item — they must not leak.
  const ledger = {
    project: "Command Central",
    order: [
      { identifier: "PAR-226", blocks_active: ["PAR-228", "PAR-227"], depends_on_done: ["PAR-9"] },
      { identifier: "PAR-100", related: ["PAR-500"] },
    ],
    linear_done: ["PAR-154", "PAR-189"],
  };
  assert.deepEqual(extractIdentifiers(ledger), ["PAR-226", "PAR-100"]);
});

test("extractIdentifiers honors an explicit list field", () => {
  const ledger = { order: [{ identifier: "PAR-226" }], linear_done: ["PAR-154", "PAR-189"] };
  assert.deepEqual(extractIdentifiers(ledger, { listField: "linear_done" }), [
    "PAR-154",
    "PAR-189",
  ]);
});

test("extractIdentifiers throws when an explicit list field is not an array", () => {
  assert.throws(
    () => extractIdentifiers({ order: { not: "an array" } }, { listField: "order" }),
    /list field "order" is not an array/,
  );
});

test("extractIdentifiers dedupes and preserves order", () => {
  assert.deepEqual(extractIdentifiers([{ identifier: "PAR-1" }, { identifier: "PAR-1" }]), [
    "PAR-1",
  ]);
});

test("extractIdentifiers reads a single-record object", () => {
  assert.deepEqual(extractIdentifiers({ identifier: "PAR-9" }), ["PAR-9"]);
});

test("extractIdentifiers reads an identifier-keyed map", () => {
  const map = { "PAR-1": { done: true }, "PAR-2": { done: false }, notes: { x: 1 } };
  assert.deepEqual(extractIdentifiers(map), ["PAR-1", "PAR-2"]);
});

test("extractIdentifiers returns empty for unusable input", () => {
  assert.deepEqual(extractIdentifiers(42), []);
  assert.deepEqual(extractIdentifiers([]), []);
});

// ---------------------------------------------------------------------------
// chooseScope + canonicalizeIdentifiers
// ---------------------------------------------------------------------------

test("chooseScope builds the right spec for each single input", () => {
  assert.deepEqual(chooseScope({ identifiers: ["PAR-1"] }), {
    kind: "identifiers",
    identifiers: ["PAR-1"],
  });
  assert.deepEqual(chooseScope({ project: "Command Central" }), {
    kind: "project",
    project: "Command Central",
  });
  assert.deepEqual(chooseScope({ team: "par" }), { kind: "team", teamKey: "PAR" });
});

test("chooseScope canonicalizes + dedupes identifiers", () => {
  assert.deepEqual(chooseScope({ identifiers: ["par-1", "PAR-1", "ENG-2"] }).kind, "identifiers");
  assert.deepEqual(
    (chooseScope({ identifiers: ["par-1", "PAR-1", "ENG-2"] }) as { identifiers: string[] })
      .identifiers,
    ["PAR-1", "ENG-2"],
  );
});

test("chooseScope rejects zero or multiple scopes", () => {
  assert.throws(() => chooseScope({}), /no scope given/);
  assert.throws(() => chooseScope({ identifiers: ["PAR-1"], team: "PAR" }), /exactly one scope/);
});

test("canonicalizeIdentifiers throws on the first invalid identifier", () => {
  assert.throws(
    () => canonicalizeIdentifiers(["PAR-1", "nope"]),
    /not a Linear identifier: "nope"/,
  );
});

// ---------------------------------------------------------------------------
// resolveScope
// ---------------------------------------------------------------------------

test("resolveScope passes identifiers through canonicalized", async () => {
  const source = fakeSource({ teams: [], projects: [], issues: [] });
  const res = await resolveScope(source, { kind: "identifiers", identifiers: ["par-1", "PAR-1"] });
  assert.deepEqual(res.identifiers, ["PAR-1"]);
});

test("resolveScope resolves a team to its issue identifiers (case-insensitive)", async () => {
  const source = fakeSource({
    teams: [makeTeam(), makeTeam({ id: "team-2", key: "ENG", name: "Eng" })],
    projects: [],
    issues: [
      makeIssue({ identifier: "PAR-1", teamId: "team-1" }),
      makeIssue({ identifier: "PAR-2", teamId: "team-1" }),
      makeIssue({ identifier: "ENG-9", teamId: "team-2" }),
    ],
  });
  const res = await resolveScope(source, { kind: "team", teamKey: "par" });
  assert.equal(res.matchedTeam, "PAR");
  assert.deepEqual(res.identifiers, ["PAR-1", "PAR-2"]);
});

test("resolveScope throws an enumerated error for an unknown team", async () => {
  const source = fakeSource({ teams: [makeTeam()], projects: [], issues: [] });
  await assert.rejects(
    () => resolveScope(source, { kind: "team", teamKey: "NOPE" }),
    /team "NOPE" not found — available: PAR/,
  );
});

test("resolveScope resolves a project by name to issues with that projectId", async () => {
  const source = fakeSource({
    teams: [makeTeam()],
    projects: [
      makeProject({ id: "proj-1", name: "Command Central" }),
      makeProject({ id: "proj-2", name: "Other" }),
    ],
    issues: [
      makeIssue({ identifier: "PAR-1", projectId: "proj-1" }),
      makeIssue({ identifier: "PAR-2", projectId: "proj-2" }),
      makeIssue({ identifier: "PAR-3", projectId: "proj-1" }),
      makeIssue({ identifier: "PAR-4", projectId: null }),
    ],
  });
  const res = await resolveScope(source, { kind: "project", project: "command central" });
  assert.deepEqual(
    res.matchedProjects?.map((p) => p.id),
    ["proj-1"],
  );
  assert.deepEqual(res.identifiers, ["PAR-1", "PAR-3"]);
});

test("resolveScope matches a project by exact id too", async () => {
  const source = fakeSource({
    teams: [makeTeam()],
    projects: [makeProject({ id: "proj-xyz", name: "Whatever" })],
    issues: [makeIssue({ identifier: "PAR-1", projectId: "proj-xyz" })],
  });
  const res = await resolveScope(source, { kind: "project", project: "proj-xyz" });
  assert.deepEqual(res.identifiers, ["PAR-1"]);
});

test("resolveScope refuses a project name that spans multiple teams (no silent scope expansion)", async () => {
  const source = fakeSource({
    teams: [makeTeam(), makeTeam({ id: "team-2", key: "ENG", name: "Eng" })],
    projects: [
      makeProject({ id: "proj-1", name: "Closeout", teamId: "team-1" }),
      makeProject({ id: "proj-2", name: "Closeout", teamId: "team-2" }),
    ],
    issues: [
      makeIssue({ identifier: "PAR-1", teamId: "team-1", projectId: "proj-1" }),
      makeIssue({ identifier: "ENG-1", teamId: "team-2", projectId: "proj-2" }),
    ],
  });
  await assert.rejects(
    () => resolveScope(source, { kind: "project", project: "Closeout" }),
    /matches projects in multiple teams \(PAR, ENG\)/,
  );
});

test("resolveScope throws an enumerated error for an unknown project", async () => {
  const source = fakeSource({
    teams: [makeTeam()],
    projects: [makeProject({ name: "Command Central" })],
    issues: [],
  });
  await assert.rejects(
    () => resolveScope(source, { kind: "project", project: "Ghost" }),
    /project "Ghost" not found — available: Command Central/,
  );
});
