/**
 * Linear review SCOPE resolution — "which issues does a run operate on?" (read-only).
 *
 * ClawSweeper's per-item review pipeline (fetch → classify → plan → authorize → upsert)
 * is identical no matter how many issues it runs over. This module is the one seam that
 * decouples *which issues* from *what is done per issue*, so the same pipeline can serve a
 * single item, an explicit set (e.g. a Command Central ledger), a Linear project, or a
 * whole team. Single-item is just scope-of-one.
 *
 * Two halves, deliberately split for testability:
 *   - `extractIdentifiers` / `matchIdentifier` are PURE and offline — they turn a parsed
 *     JSON value (a list file, a ledger, an array of keys) into a clean identifier set.
 *   - `resolveScope` is the only async part; it consults a read-only `ScopeSource` for
 *     project/team scopes. It performs reads only — never a mutation, never a clock read.
 *
 * Precise extraction, never a greedy scan:
 *   A ledger entry routinely carries nested reference arrays (`blocks_active`,
 *   `depends_on_*`, `related`) full of identifier-shaped strings that are NOT the item
 *   itself. `extractIdentifiers` therefore reads a record's identifier only from its own
 *   scalar id fields (identifier/key/id) and only descends one level into a designated
 *   container list — it never recurses into a record's nested arrays. This is the whole
 *   reason it is safe to point at an arbitrary ledger.
 */

import type { LinearIssue, LinearProject, LinearTeam, ListIssuesOptions } from "./types.js";

/** A Linear human identifier: an uppercase-able team key, a hyphen, and a positive number. */
const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** Container keys whose array value is treated as the record list, in priority order. */
export const DEFAULT_LIST_FIELDS: readonly string[] = [
  "order",
  "items",
  "entries",
  "issues",
  "records",
  "list",
  "ledger",
];

/** Scalar fields a record's own identifier may live under, in priority order. */
export const DEFAULT_ID_FIELDS: readonly string[] = ["identifier", "key", "id"];

/**
 * Returns the canonical identifier ("PAR-244") for a string that is a Linear identifier,
 * or null otherwise. Trims surrounding whitespace, upper-cases the team key, and strips
 * any leading zeros from the number so equal issues canonicalize identically.
 */
export function matchIdentifier(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = IDENTIFIER_RE.exec(raw.trim());
  if (m === null) return null;
  const key = m[1];
  const num = m[2];
  if (key === undefined || num === undefined) return null;
  return `${key.toUpperCase()}-${Number(num)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExtractOptions {
  idFields?: readonly string[]; // scalar id fields on a record (default identifier/key/id)
  listFields?: readonly string[]; // candidate container keys (default DEFAULT_LIST_FIELDS)
  listField?: string; // explicit container key override (must be an array in the input)
}

/**
 * Extracts a clean, de-duplicated, order-preserving identifier list from a parsed JSON
 * value. Accepts the common shapes a caller might point `--from-file` at:
 *
 *   - a string                         → [that identifier] if it is one
 *   - an array of strings              → the identifier-shaped ones
 *   - an array of records              → each record's first matching id field
 *   - an object with a list field      → that array (first of listFields present, or the
 *                                        explicit `listField`), treated as above
 *   - a single record object           → its first matching id field
 *   - an identifier-keyed map          → its keys
 *
 * Non-identifier strings are silently dropped. Nested reference arrays inside a record are
 * never descended into. Throws only when an explicit `listField` is given but is not an
 * array (a caller asked for a container that isn't one).
 */
export function extractIdentifiers(value: unknown, options: ExtractOptions = {}): string[] {
  const idFields = options.idFields ?? DEFAULT_ID_FIELDS;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null): void => {
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };

  const fromElement = (el: unknown): string | null => {
    const direct = matchIdentifier(el);
    if (direct !== null) return direct;
    if (isRecord(el)) {
      for (const field of idFields) {
        const found = matchIdentifier(el[field]);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const fromArray = (arr: readonly unknown[]): void => {
    for (const el of arr) push(fromElement(el));
  };

  if (typeof value === "string") {
    push(matchIdentifier(value));
    return out;
  }
  if (Array.isArray(value)) {
    fromArray(value);
    return out;
  }
  if (isRecord(value)) {
    if (options.listField !== undefined) {
      const container = value[options.listField];
      if (!Array.isArray(container)) {
        throw new Error(`list field "${options.listField}" is not an array in the input`);
      }
      fromArray(container);
      return out;
    }
    for (const key of options.listFields ?? DEFAULT_LIST_FIELDS) {
      const container = value[key];
      if (Array.isArray(container)) {
        fromArray(container);
        return out;
      }
    }
    // No container list — treat the object as a single record, else as an id-keyed map.
    const single = fromElement(value);
    if (single !== null) {
      push(single);
      return out;
    }
    for (const key of Object.keys(value)) push(matchIdentifier(key));
    return out;
  }
  return out;
}

/** Read-only subset of LinearItemSource sufficient to resolve project/team scopes. */
export interface ScopeSource {
  listTeams(pageSize?: number): Promise<LinearTeam[]>;
  listProjects(teamId: string, pageSize?: number): Promise<LinearProject[]>;
  listIssues(options: ListIssuesOptions): Promise<LinearIssue[]>;
}

/** A resolved description of which issues a run targets. */
export type ScopeSpec =
  | { kind: "identifiers"; identifiers: string[] } // an explicit set (single item is length 1)
  | { kind: "project"; project: string } // a Linear project by id or (case-insensitive) name
  | { kind: "team"; teamKey: string }; // every issue in a team

export interface MatchedProject {
  id: string;
  name: string;
  teamKey: string;
}

export interface ScopeResolution {
  kind: ScopeSpec["kind"];
  identifiers: string[]; // canonical, de-duplicated, order-preserving
  matchedTeam?: string; // team key, for team scope
  matchedProjects?: MatchedProject[]; // matched projects, for project scope
}

/**
 * Builds a ScopeSpec from the at-most-one scope input a CLI provides. Exactly one of the
 * inputs must be non-empty; zero or more-than-one is a usage error. `identifiers` are
 * canonicalized and de-duplicated here so an invalid one fails fast, before any network.
 */
export function chooseScope(inputs: {
  identifiers?: string[];
  project?: string;
  team?: string;
}): ScopeSpec {
  const ids = (inputs.identifiers ?? []).filter((s) => s.trim() !== "");
  const project = (inputs.project ?? "").trim();
  const team = (inputs.team ?? "").trim();
  const provided = [ids.length > 0, project !== "", team !== ""].filter(Boolean).length;
  if (provided === 0) {
    throw new Error("no scope given — provide identifiers, a --project, or a --team");
  }
  if (provided > 1) {
    throw new Error("provide exactly one scope — identifiers, --project, or --team (not several)");
  }
  if (ids.length > 0) {
    return { kind: "identifiers", identifiers: canonicalizeIdentifiers(ids) };
  }
  if (project !== "") return { kind: "project", project };
  return { kind: "team", teamKey: team.toUpperCase() };
}

/** Canonicalizes and de-duplicates an identifier list; throws on the first invalid one. */
export function canonicalizeIdentifiers(identifiers: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of identifiers) {
    const id = matchIdentifier(raw);
    if (id === null) {
      throw new Error(`not a Linear identifier: "${raw}" (expected like "PAR-244")`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Resolves a ScopeSpec to a concrete identifier set using read-only source calls. Pure of
 * mutations and clock reads. Throws a helpful, enumerated error when a team/project name
 * does not match, so a typo lists the real options rather than silently returning nothing.
 */
export async function resolveScope(source: ScopeSource, spec: ScopeSpec): Promise<ScopeResolution> {
  if (spec.kind === "identifiers") {
    return { kind: "identifiers", identifiers: canonicalizeIdentifiers(spec.identifiers) };
  }

  const teams = await source.listTeams();

  if (spec.kind === "team") {
    const wanted = spec.teamKey.toUpperCase();
    const team = teams.find((t) => t.key.toUpperCase() === wanted);
    if (team === undefined) {
      throw new Error(
        `team "${spec.teamKey}" not found — available: ${teams.map((t) => t.key).join(", ") || "(none)"}`,
      );
    }
    const issues = await source.listIssues({ teamId: team.id });
    return {
      kind: "team",
      matchedTeam: team.key,
      identifiers: dedupe(issues.map((i) => i.identifier)),
    };
  }

  // project scope: match by exact id or case-insensitive name across every team.
  const wantedName = spec.project.trim().toLowerCase();
  const matched: Array<MatchedProject & { teamId: string }> = [];
  const allNames: string[] = [];
  for (const team of teams) {
    const projects = await source.listProjects(team.id);
    for (const project of projects) {
      allNames.push(project.name);
      if (project.id === spec.project || project.name.trim().toLowerCase() === wantedName) {
        matched.push({ id: project.id, name: project.name, teamKey: team.key, teamId: team.id });
      }
    }
  }
  if (matched.length === 0) {
    throw new Error(
      `project "${spec.project}" not found — available: ${allNames.join(", ") || "(none)"}`,
    );
  }

  // Refuse a name that resolves into more than one team. A same-named project across teams
  // would silently expand a run's scope to every matching team — a real hazard for a live
  // --apply (the operator means one team's project). A project id is globally unique, so
  // disambiguating by id (or a name unique to one team) is always available.
  const distinctTeams = [...new Set(matched.map((m) => m.teamKey))];
  if (distinctTeams.length > 1) {
    throw new Error(
      `project "${spec.project}" matches projects in multiple teams (${distinctTeams.join(", ")}) — ` +
        `pass the project id, or a name unique to one team, to disambiguate`,
    );
  }

  const identifiers: string[] = [];
  for (const project of matched) {
    const issues = await source.listIssues({ teamId: project.teamId });
    for (const issue of issues) {
      if (issue.projectId === project.id) identifiers.push(issue.identifier);
    }
  }
  return {
    kind: "project",
    matchedProjects: matched.map(({ id, name, teamKey }) => ({ id, name, teamKey })),
    identifiers: dedupe(identifiers),
  };
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
