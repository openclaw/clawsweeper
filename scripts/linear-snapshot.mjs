#!/usr/bin/env node

/**
 * Read-only Linear workspace snapshot fetcher.
 *
 * This is the live-board half of the on-demand / weekly review flow. It drives the
 * read-only `LinearItemSource` (teams -> projects -> issues, cursor-paginated) and
 * emits a `WorkspaceItem[]` snapshot that feeds directly into the review-only triage
 * runner:
 *
 *   node scripts/linear-snapshot.mjs --team PAR | node scripts/linear-triage.mjs --review-only --json
 *
 * Doctrine: this fetcher only ever issues the three read queries exported from the
 * Linear barrel (`TEAMS_QUERY` / `PROJECTS_QUERY` / `ISSUES_QUERY`). It holds no
 * mutation surface — there is no flag, code path, or transport call here that can
 * write to Linear. Mutations are gated separately in `src/linear/authority.ts` and
 * are never reachable from this script.
 *
 * Auth: the token is resolved from `LINEAR_API_KEY` / `LINEAR_TOKEN` in the
 * environment, and — on the hub, where no env token is set — from the macOS Keychain
 * generic password (service `openclaw-linear-api-key`, account `partnerai-config`),
 * the same credential the sibling `linear-board-triage` / `openclaw-linear-intake`
 * skills use. The header is the raw token (no `Bearer`); `createLinearTransport`
 * handles that. The token is never logged or written to the snapshot.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createLinearTransport, LinearItemSource } from "../dist/linear/index.js";

/** Default macOS Keychain generic-password coordinates for the hub Linear key. */
export const DEFAULT_KEYCHAIN_SERVICE = "openclaw-linear-api-key";
export const DEFAULT_KEYCHAIN_ACCOUNT = "partnerai-config";

/** Snapshot schema tag, mirroring the `*_v1` convention of the sibling skills. */
export const SNAPSHOT_SCHEMA = "linear_workspace_snapshot_v1";

export function parseArgs(argv) {
  const options = {
    teamKeys: [],
    updatedAfter: undefined,
    pageSize: undefined,
    out: "",
    keychainService: DEFAULT_KEYCHAIN_SERVICE,
    keychainAccount: DEFAULT_KEYCHAIN_ACCOUNT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--team":
        options.teamKeys.push(requireValue(argv, ++index, arg));
        break;
      case "--updated-after":
        options.updatedAfter = requireValue(argv, ++index, arg);
        break;
      case "--page-size":
        options.pageSize = positiveInt(requireValue(argv, ++index, arg), "--page-size");
        break;
      case "--out":
        options.out = requireValue(argv, ++index, arg);
        break;
      case "--keychain-service":
        options.keychainService = requireValue(argv, ++index, arg);
        break;
      case "--keychain-account":
        options.keychainAccount = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Resolves the Linear API token. Prefers an explicit env token
 * (`LINEAR_API_KEY` then `LINEAR_TOKEN`); falls back to the macOS Keychain generic
 * password. `env` and `runKeychain` are injectable for testing. Throws a clear,
 * token-free error when nothing resolves.
 */
export function resolveToken(options = {}) {
  const env = options.env ?? process.env;
  const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runKeychain = options.runKeychain ?? defaultKeychainLookup;

  const envToken = env["LINEAR_API_KEY"] ?? env["LINEAR_TOKEN"];
  if (envToken && envToken.trim() !== "") return envToken.trim();

  const keychainToken = runKeychain(service, account);
  if (keychainToken && keychainToken.trim() !== "") return keychainToken.trim();

  throw new Error(
    `No Linear API token found. Set LINEAR_API_KEY or LINEAR_TOKEN, or store a generic ` +
      `password in the macOS Keychain (service "${service}", account "${account}").`,
  );
}

// Reads the token from the macOS Keychain without a shell. Returns "" on any miss
// (missing item, non-macOS, locked keychain) so resolveToken can fall through to its
// own error rather than leak a `security` stack trace.
function defaultKeychainLookup(service, account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Collects workspace items via the read-only source. Iterates teams (optionally
 * filtered to `teamKeys`), then for each team maps its projects and issues into
 * `{ team, project, issue }` records. `updatedAfter` scopes the issue sweep to what
 * changed since a prior run, keeping the request/complexity budget low.
 */
export async function collectWorkspaceItems(source, options = {}) {
  const { teamKeys = [], updatedAfter, pageSize } = options;
  const wanted = new Set(teamKeys);

  const teams = (await source.listTeams(pageSize)).filter(
    (team) => wanted.size === 0 || wanted.has(team.key),
  );

  const items = [];
  const teamsSeen = [];
  for (const team of teams) {
    teamsSeen.push(team.key);
    const projects = await source.listProjects(team.id, pageSize);
    const projectMap = new Map(projects.map((project) => [project.id, project]));

    const issueOptions = { teamId: team.id };
    if (updatedAfter !== undefined) issueOptions.updatedAfter = updatedAfter;
    if (pageSize !== undefined) issueOptions.pageSize = pageSize;

    for (const issue of await source.listIssues(issueOptions)) {
      const project = issue.projectId != null ? (projectMap.get(issue.projectId) ?? null) : null;
      items.push({ team, project, issue });
    }
  }

  return { items, teamsSeen };
}

/**
 * Guards against silent visibility loss. A `--team` filter that matches no live team
 * yields an empty snapshot that the downstream triage step would report as a healthy
 * `TRIAGE_OK` board — hiding the fact that the requested scope never resolved. This
 * fails loudly instead.
 *
 * Two conditions throw:
 *   1. Any requested team key that never appears in `teamsSeen` (requested minus
 *      scanned) — the caller asked for teams that do not exist or were not returned.
 *   2. `teamsSeen` is empty even when no `--team` was requested — an all-teams sweep
 *      that resolved zero teams is a fetch/auth/scope failure, not a clean board.
 */
export function assertTeamCoverage(collected, meta = {}) {
  const teamsSeen = collected.teamsSeen ?? [];
  const teamKeys = meta.teamKeys ?? [];
  const scanned = new Set(teamsSeen);
  const unmatched = teamKeys.filter((key) => !scanned.has(key));

  if (unmatched.length > 0) {
    throw new Error(
      `--team filter matched no live team for: ${unmatched.join(", ")}. ` +
        `Requested [${teamKeys.join(", ")}], scanned [${teamsSeen.join(", ")}]. ` +
        `Refusing to emit an empty-scope snapshot that would triage as TRIAGE_OK.`,
    );
  }

  if (teamsSeen.length === 0) {
    throw new Error(
      `No teams resolved from the Linear workspace (teamsScanned is empty). ` +
        `An all-teams sweep that sees zero teams is a fetch/auth/scope failure, not a ` +
        `healthy board. Refusing to emit an empty snapshot that would triage as TRIAGE_OK.`,
    );
  }
}

/** Wraps collected items in the snapshot envelope. The token is never included. */
export function buildSnapshot(collected, meta = {}) {
  const { items, teamsSeen } = collected;
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    source: {
      provider: "linear",
      reviewOnly: true,
      teamsRequested: meta.teamKeys ?? [],
      teamsScanned: teamsSeen,
      updatedAfter: meta.updatedAfter ?? null,
      itemCount: items.length,
    },
    items,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  let token;
  try {
    token = resolveToken({ service: options.keychainService, account: options.keychainAccount });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let snapshot;
  try {
    const transport = createLinearTransport({ token });
    const source = new LinearItemSource(transport);
    const collected = await collectWorkspaceItems(source, {
      teamKeys: options.teamKeys,
      updatedAfter: options.updatedAfter,
      pageSize: options.pageSize,
    });
    assertTeamCoverage(collected, { teamKeys: options.teamKeys });
    snapshot = buildSnapshot(collected, {
      teamKeys: options.teamKeys,
      updatedAfter: options.updatedAfter,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const serialized = JSON.stringify(snapshot, null, 2);
  if (options.out) {
    writeFileSync(options.out, serialized + "\n");
    console.error(
      `wrote ${snapshot.source.itemCount} item(s) from team(s) [${snapshot.source.teamsScanned.join(", ")}] to ${options.out}`,
    );
  } else {
    // JSON on stdout so the snapshot pipes straight into linear-triage.mjs;
    // progress goes to stderr to keep stdout a clean JSON stream.
    console.log(serialized);
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/linear-snapshot.mjs [options]

Read-only Linear workspace snapshot fetcher. Pages teams, projects, and issues via
the Linear GraphQL read API and emits a WorkspaceItem[] snapshot. Never mutates
anything. Pipe the output into scripts/linear-triage.mjs for a review digest.

Options:
  --team <KEY>               Restrict to this team key (repeatable; default: all teams)
  --updated-after <iso>      Only issues updated after this ISO 8601 timestamp
  --page-size <n>            GraphQL page size (default: source default of 250)
  --out <path>              Write snapshot to a file instead of stdout
  --keychain-service <s>     Keychain service for the token (default: ${DEFAULT_KEYCHAIN_SERVICE})
  --keychain-account <a>     Keychain account for the token (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --help, -h                 Show this help message

Auth: LINEAR_API_KEY or LINEAR_TOKEN in the environment, else the macOS Keychain
generic password (service ${DEFAULT_KEYCHAIN_SERVICE}, account ${DEFAULT_KEYCHAIN_ACCOUNT}).

Examples:
  node scripts/linear-snapshot.mjs --team PAR --out snapshot.json
  node scripts/linear-snapshot.mjs --team PAR | node scripts/linear-triage.mjs --review-only --json
  node scripts/linear-snapshot.mjs --updated-after 2026-06-01T00:00:00Z --team PAR`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
