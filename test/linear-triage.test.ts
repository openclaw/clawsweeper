import assert from "node:assert/strict";
import test from "node:test";

import { buildDigest, formatDigest, loadSnapshot, parseArgs } from "../scripts/linear-triage.mjs";
import type { LinearIssue, LinearLabel, LinearTeam, WorkspaceItem } from "../dist/linear/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: Partial<LinearTeam> = {}): LinearTeam {
  return { id: "team-1", key: "ENG", name: "Engineering", ...overrides };
}

function makeLabels(...names: string[]): LinearLabel[] {
  return names.map((name, i) => ({ id: `lbl-${i}`, name }));
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Example issue",
    url: "https://linear.app/eng/issue/ENG-1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-08-20T00:00:00Z", // ~12 days before NOW_ISO: recent, not stale
    teamId: "team-1",
    projectId: "proj-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    labels: [],
    ...overrides,
  };
}

function makeWorkspaceItem(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    team: makeTeam(),
    project: { id: "proj-1", name: "Platform", teamId: "team-1", state: "started" },
    issue: makeIssue(),
    ...overrides,
  };
}

// Fixed reference clock — never use system clock in tests
const NOW_ISO = "2024-09-01T00:00:00Z";

// ---------------------------------------------------------------------------
// parseArgs: defaults
// ---------------------------------------------------------------------------

test("parseArgs defaults: no args → reviewOnly true, json false, snapshot empty, staleDays 60, empty label arrays, help false", () => {
  const opts = parseArgs([]);
  assert.equal(opts.reviewOnly, true);
  assert.equal(opts.json, false);
  assert.equal(opts.snapshot, "");
  assert.equal(opts.staleDays, 60);
  assert.deepEqual(opts.requiredLabels, []);
  assert.deepEqual(opts.exclusionLabels, []);
  assert.deepEqual(opts.protectedLabels, []);
  assert.equal(opts.help, false);
});

// ---------------------------------------------------------------------------
// parseArgs: flags
// ---------------------------------------------------------------------------

test("parseArgs flags: recognized flags populate options correctly", () => {
  const opts = parseArgs([
    "--review-only",
    "--json",
    "--snapshot",
    "x.json",
    "--now",
    "2024-09-01T00:00:00Z",
    "--stale-days",
    "30",
  ]);
  assert.equal(opts.reviewOnly, true);
  assert.equal(opts.json, true);
  assert.equal(opts.snapshot, "x.json");
  assert.equal(opts.nowIso, "2024-09-01T00:00:00Z");
  assert.equal(opts.staleDays, 30);
});

test("parseArgs flags: --required-label, --exclusion-label, --protected-label accumulate into arrays", () => {
  const opts = parseArgs([
    "--required-label",
    "triaged",
    "--required-label",
    "ready",
    "--exclusion-label",
    "wont-fix",
    "--exclusion-label",
    "spam",
    "--protected-label",
    "Pinned",
    "--protected-label",
    "Do Not Close",
  ]);
  assert.deepEqual(opts.requiredLabels, ["triaged", "ready"]);
  assert.deepEqual(opts.exclusionLabels, ["wont-fix", "spam"]);
  assert.deepEqual(opts.protectedLabels, ["Pinned", "Do Not Close"]);
});

test("parseArgs flags: --help and -h set help true", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

// ---------------------------------------------------------------------------
// parseArgs: leading -- separator
// ---------------------------------------------------------------------------

test("parseArgs tolerates a leading -- separator (like openclaw-dispatch)", () => {
  const opts = parseArgs(["--", "--json", "--snapshot", "snap.json"]);
  assert.equal(opts.json, true);
  assert.equal(opts.snapshot, "snap.json");
});

// ---------------------------------------------------------------------------
// parseArgs: review-only invariant
// ---------------------------------------------------------------------------

test("parseArgs: --apply throws /mutations are not supported/", () => {
  assert.throws(() => parseArgs(["--apply"]), /mutations are not supported/);
});

test("parseArgs: --mutate throws /mutations are not supported/", () => {
  assert.throws(() => parseArgs(["--mutate"]), /mutations are not supported/);
});

test("parseArgs: --no-review-only throws /mutations are not supported/", () => {
  assert.throws(() => parseArgs(["--no-review-only"]), /mutations are not supported/);
});

// ---------------------------------------------------------------------------
// parseArgs: rejections
// ---------------------------------------------------------------------------

test("parseArgs: unknown arg throws /unknown argument/", () => {
  assert.throws(() => parseArgs(["--unknown-flag"]), /unknown argument/);
});

test("parseArgs: --stale-days 0 throws /positive integer/", () => {
  assert.throws(() => parseArgs(["--stale-days", "0"]), /positive integer/);
});

test("parseArgs: --stale-days abc throws /positive integer/", () => {
  assert.throws(() => parseArgs(["--stale-days", "abc"]), /positive integer/);
});

test("parseArgs: value-flag missing its value throws /requires a value/", () => {
  assert.throws(() => parseArgs(["--snapshot"]), /requires a value/);
  assert.throws(() => parseArgs(["--now"]), /requires a value/);
  assert.throws(() => parseArgs(["--stale-days"]), /requires a value/);
  assert.throws(() => parseArgs(["--required-label"]), /requires a value/);
  assert.throws(() => parseArgs(["--exclusion-label"]), /requires a value/);
  assert.throws(() => parseArgs(["--protected-label"]), /requires a value/);
});

// ---------------------------------------------------------------------------
// loadSnapshot
// ---------------------------------------------------------------------------

test("loadSnapshot: accepts a bare WorkspaceItem array", () => {
  const item = makeWorkspaceItem();
  const items = loadSnapshot(JSON.stringify([item]));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], item);
});

test("loadSnapshot: accepts { items: [...] } envelope and returns the inner array", () => {
  const item = makeWorkspaceItem();
  const items = loadSnapshot(JSON.stringify({ items: [item] }));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], item);
});

test("loadSnapshot: throws /not valid JSON/ on invalid JSON", () => {
  assert.throws(() => loadSnapshot("not json {{{"), /not valid JSON/);
});

test("loadSnapshot: throws on a non-array non-object value (null)", () => {
  assert.throws(() => loadSnapshot(JSON.stringify(null)));
});

test("loadSnapshot: throws on a non-array/non-items object (plain string value)", () => {
  assert.throws(() => loadSnapshot(JSON.stringify("hello")));
});

test("loadSnapshot: throws on object without items array ({ foo: 1 })", () => {
  assert.throws(() => loadSnapshot(JSON.stringify({ foo: 1 })));
});

test("loadSnapshot: throws on item missing team object", () => {
  const item = { issue: makeIssue() };
  assert.throws(() => loadSnapshot(JSON.stringify([item])), /missing a team object/);
});

test("loadSnapshot: throws on item missing issue object", () => {
  const item = { team: makeTeam() };
  assert.throws(() => loadSnapshot(JSON.stringify([item])), /missing an issue object/);
});

// ---------------------------------------------------------------------------
// buildDigest: happy path
// ---------------------------------------------------------------------------

const REVIEW_ITEM = makeWorkspaceItem({
  issue: makeIssue({ id: "i-1", identifier: "ENG-1", updatedAt: "2024-08-20T00:00:00Z" }),
});
const STALE_ITEM = makeWorkspaceItem({
  issue: makeIssue({
    id: "i-2",
    identifier: "ENG-2",
    updatedAt: "2024-06-03T00:00:00Z", // ~90 days before NOW_ISO → stale
  }),
});
const CLOSED_ITEM = makeWorkspaceItem({
  issue: makeIssue({ id: "i-3", identifier: "ENG-3", stateType: "completed" }),
});
const PROTECTED_ITEM = makeWorkspaceItem({
  issue: makeIssue({ id: "i-4", identifier: "ENG-4", labels: makeLabels("Pinned") }),
});
const FIXTURE_ITEMS = [REVIEW_ITEM, STALE_ITEM, CLOSED_ITEM, PROTECTED_ITEM];
const FIXTURE_OPTS = { nowIso: NOW_ISO, protectedLabels: ["Pinned"] };

test("buildDigest happy path: totals count all dispositions correctly", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  assert.equal(digest.totals.items, 4);
  assert.equal(digest.totals.review, 1);
  assert.equal(digest.totals.staleCandidates, 1);
  assert.equal(digest.totals.closed, 1);
  assert.equal(digest.totals.protected, 1);
  assert.equal(digest.totals.excluded, 0);
  assert.equal(digest.totals.notReady, 0);
});

test("buildDigest happy path: byDisposition has all six keys, zero-filled where empty", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  const bd = digest.byDisposition;
  assert.equal(typeof bd["review"], "number");
  assert.equal(typeof bd["stale-candidate"], "number");
  assert.equal(typeof bd["protected"], "number");
  assert.equal(typeof bd["excluded"], "number");
  assert.equal(typeof bd["not-ready"], "number");
  assert.equal(typeof bd["closed"], "number");
  assert.equal(bd["review"], 1);
  assert.equal(bd["stale-candidate"], 1);
  assert.equal(bd["protected"], 1);
  assert.equal(bd["excluded"], 0);
  assert.equal(bd["not-ready"], 0);
  assert.equal(bd["closed"], 1);
});

test("buildDigest happy path: generatedAt equals nowIso and staleDays is echoed", () => {
  const digest = buildDigest(FIXTURE_ITEMS, { nowIso: NOW_ISO, staleDays: 45 });
  assert.equal(digest.generatedAt, NOW_ISO);
  assert.equal(digest.staleDays, 45);
});

test("buildDigest happy path: byCategory and byPriority have non-zero counts", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  const catTotal = Object.values(digest.byCategory).reduce((s, n) => s + n, 0);
  const priTotal = Object.values(digest.byPriority).reduce((s, n) => s + n, 0);
  assert.equal(catTotal, FIXTURE_ITEMS.length);
  assert.equal(priTotal, FIXTURE_ITEMS.length);
});

test("buildDigest happy path: staleCandidates lists stale item with non-empty reasons", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  assert.equal(digest.staleCandidates.length, 1);
  const sc = digest.staleCandidates[0];
  assert.equal(sc.identifier, "ENG-2");
  assert.ok(Array.isArray(sc.reasons));
  assert.ok(sc.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// buildDigest: review-only invariants
// ---------------------------------------------------------------------------

test("buildDigest invariants: ok === true, reviewOnly === true, proposesClose === false, sentinel === TRIAGE_OK", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  assert.equal(digest.ok, true);
  assert.equal(digest.reviewOnly, true);
  assert.equal(digest.proposesClose, false);
  assert.equal(digest.sentinel, "TRIAGE_OK");
});

test("buildDigest invariants hold for a single stale item", () => {
  const digest = buildDigest([STALE_ITEM], { nowIso: NOW_ISO });
  assert.equal(digest.ok, true);
  assert.equal(digest.reviewOnly, true);
  assert.equal(digest.proposesClose, false);
  assert.equal(digest.sentinel, "TRIAGE_OK");
});

// ---------------------------------------------------------------------------
// buildDigest: requires nowIso
// ---------------------------------------------------------------------------

test("buildDigest: omitting nowIso throws /requires options.nowIso/", () => {
  assert.throws(() => buildDigest([], {} as { nowIso: string }), /requires options.nowIso/);
});

test("buildDigest: is clock-free — identical inputs+nowIso give identical digests", () => {
  const opts = { nowIso: NOW_ISO };
  const d1 = buildDigest([REVIEW_ITEM, STALE_ITEM], opts);
  const d2 = buildDigest([REVIEW_ITEM, STALE_ITEM], opts);
  assert.deepEqual(d1, d2);
});

// ---------------------------------------------------------------------------
// buildDigest: empty snapshot
// ---------------------------------------------------------------------------

test("buildDigest empty snapshot: all totals 0, byDisposition all zero, sentinel TRIAGE_OK", () => {
  const digest = buildDigest([], { nowIso: NOW_ISO });
  assert.equal(digest.totals.items, 0);
  assert.equal(digest.totals.eligible, 0);
  assert.equal(digest.totals.review, 0);
  assert.equal(digest.totals.staleCandidates, 0);
  assert.equal(digest.totals.protected, 0);
  assert.equal(digest.totals.excluded, 0);
  assert.equal(digest.totals.notReady, 0);
  assert.equal(digest.totals.closed, 0);
  assert.equal(digest.byDisposition["review"], 0);
  assert.equal(digest.byDisposition["stale-candidate"], 0);
  assert.equal(digest.byDisposition["protected"], 0);
  assert.equal(digest.byDisposition["excluded"], 0);
  assert.equal(digest.byDisposition["not-ready"], 0);
  assert.equal(digest.byDisposition["closed"], 0);
  assert.deepEqual(digest.byCategory, {});
  assert.deepEqual(digest.byPriority, {});
  assert.equal(digest.sentinel, "TRIAGE_OK");
});

// ---------------------------------------------------------------------------
// formatDigest
// ---------------------------------------------------------------------------

test("formatDigest: final line is exactly TRIAGE_OK", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  const output = formatDigest(digest);
  const lines = output.split("\n");
  assert.equal(lines[lines.length - 1], "TRIAGE_OK");
});

test("formatDigest: output is a string containing totals", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  const output = formatDigest(digest);
  assert.equal(typeof output, "string");
  assert.ok(output.includes("Totals:"));
  assert.ok(output.includes("items:"));
});

test("formatDigest: stale-candidate identifiers appear in output", () => {
  const digest = buildDigest(FIXTURE_ITEMS, FIXTURE_OPTS);
  const output = formatDigest(digest);
  assert.ok(output.includes("ENG-2"), `expected ENG-2 in output:\n${output}`);
});

test("formatDigest: empty snapshot output ends with TRIAGE_OK", () => {
  const digest = buildDigest([], { nowIso: NOW_ISO });
  const output = formatDigest(digest);
  const lines = output.split("\n");
  assert.equal(lines[lines.length - 1], "TRIAGE_OK");
});
