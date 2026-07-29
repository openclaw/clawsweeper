#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommand } from "../command.js";
import { parseArgs, repoRoot } from "./lib.js";

type JsonRecord = Record<string, unknown>;

export type FanoutMode = "hot-intake" | "normal-review" | "audit";

export interface InventoryConfig {
  owners: readonly string[];
  denyRepositories: readonly string[];
  includePrivate: boolean;
  includeArchived: boolean;
  includeForks: boolean;
  requireIssues: boolean;
}

export interface ListedRepository {
  nameWithOwner: string;
  isArchived: boolean;
  isDisabled: boolean;
  isFork: boolean;
  hasIssuesEnabled: boolean;
  visibility: string;
  defaultBranch: string;
}

export interface SelectedRepository {
  targetRepo: string;
  defaultBranch: string;
  visibility: string;
}

export interface RepositoryOpenCounts {
  issues: number;
  pullRequests: number;
}

export interface FleetReviewCoverage {
  generatedAt: string;
  windowDays: number;
  repositoryCount: number;
  repositoriesWithOpenItems: number;
  openIssues: number;
  openPullRequests: number;
  openTotal: number;
  scannedOpenRecords: number;
  remainingOpenItems: number;
  coveragePercent: number;
  requiredItemsPerHourWithHeadroom: number;
}

interface SelectionResult {
  repositories: SelectedRepository[];
  cursor: number;
  total: number;
}

interface FanoutOptions {
  mode: FanoutMode;
  limit: number;
  cursorPath: string;
  dispatchRepo: string;
  workflow: string;
  ref: string;
  dryRun: boolean;
  owners: readonly string[] | undefined;
}

const DEFAULT_CURSOR_DIR = join(repoRoot(), "results", "target-fanout-cursors");
const PUBLIC_INVENTORY_TOKEN = "__public__";

export async function runTargetFanout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const mode = fanoutMode(stringArg(args.mode, "hot-intake"));
  const config = readInventoryConfig();
  const options: FanoutOptions = {
    mode,
    limit: positiveNumber(stringArg(args.limit, defaultLimit(mode)), "limit"),
    cursorPath: stringArg(args["cursor-path"], join(DEFAULT_CURSOR_DIR, `${mode}.json`)),
    dispatchRepo: stringArg(args.repo, process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper"),
    workflow: stringArg(args.workflow, "sweep.yml"),
    ref: stringArg(args.ref, "main"),
    dryRun: Boolean(args["dry-run"]),
    owners: csvArg(args.owners),
  };

  const repositories = await loadEligibleRepositories(config, options.owners);
  if (args._[0] === "coverage") {
    const windowDays = positiveNumber(stringArg(args["window-days"], "7"), "window-days");
    const openCounts = loadRepositoryOpenCounts(repositories);
    const coverage = summarizeFleetReviewCoverage({ repositories, openCounts, windowDays });
    process.stdout.write(renderFleetReviewCoverage(coverage));
    return;
  }
  const selection = selectRepositories(repositories, {
    limit: options.limit,
    cursor: readCursor(options.cursorPath),
  });

  const commands = selection.repositories.map((repository) =>
    workflowDispatchArgs(repository, options),
  );

  if (args._[0] === "list") {
    process.stdout.write(
      `${JSON.stringify({ total: repositories.length, repositories }, null, 2)}\n`,
    );
    return;
  }

  if (args._[0] === "plan") {
    process.stdout.write(`${JSON.stringify({ ...selection, commands }, null, 2)}\n`);
    return;
  }

  const dispatched: string[] = [];
  for (const [index, repository] of selection.repositories.entries()) {
    const commandArgs = commands[index];
    if (!commandArgs) continue;
    if (options.dryRun) {
      console.log(`dry-run ${commandArgs.join(" ")}`);
    } else {
      runGh(commandArgs, dispatchEnv());
    }
    dispatched.push(repository.targetRepo);
  }

  if (!options.dryRun) {
    writeCursor(options.cursorPath, selection.cursor);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.mode,
        total: selection.total,
        dispatched,
        next_cursor: selection.cursor,
        dry_run: options.dryRun,
        cursor_written: !options.dryRun,
      },
      null,
      2,
    )}\n`,
  );
}

export function readInventoryConfig(
  filePath = join(repoRoot(), "config", "target-repositories.json"),
): InventoryConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const config = record(parsed, "target repository config");
  const inventory = record(config.target_inventory, "target_inventory");
  return {
    owners: stringArray(inventory.owners, "target_inventory.owners").map((owner) =>
      owner.toLowerCase(),
    ),
    denyRepositories: stringArray(
      inventory.deny_repositories,
      "target_inventory.deny_repositories",
    ).map((repo) => repo.toLowerCase()),
    includePrivate: booleanValue(inventory.include_private, false),
    includeArchived: booleanValue(inventory.include_archived, false),
    includeForks: booleanValue(inventory.include_forks, false),
    requireIssues: booleanValue(inventory.require_issues, true),
  };
}

export async function loadEligibleRepositories(
  config: InventoryConfig,
  owners = config.owners,
): Promise<SelectedRepository[]> {
  const repositories: ListedRepository[] = [];
  for (const owner of owners) {
    const listed = listOwnerRepositories(owner);
    repositories.push(...listed);
  }
  return filterEligibleRepositories(repositories, config);
}

export function filterEligibleRepositories(
  repositories: readonly ListedRepository[],
  config: InventoryConfig,
): SelectedRepository[] {
  const denied = new Set(config.denyRepositories.map((repo) => repo.toLowerCase()));
  return repositories
    .filter((repository) => !repository.isDisabled)
    .filter((repository) => config.includeArchived || !repository.isArchived)
    .filter((repository) => config.includeForks || !repository.isFork)
    .filter((repository) => config.includePrivate || repository.visibility === "PUBLIC")
    .filter((repository) => !config.requireIssues || repository.hasIssuesEnabled)
    .filter((repository) => repository.defaultBranch !== "")
    .filter((repository) => !denied.has(repository.nameWithOwner.toLowerCase()))
    .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner))
    .map((repository) => ({
      targetRepo: repository.nameWithOwner.toLowerCase(),
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
    }));
}

export function selectRepositories(
  repositories: readonly SelectedRepository[],
  options: { limit: number; cursor: number },
): SelectionResult {
  if (repositories.length === 0) return { repositories: [], cursor: 0, total: 0 };
  const limit = Math.max(1, Math.min(options.limit, repositories.length));
  const start = normalizeCursor(options.cursor, repositories.length);
  const selected: SelectedRepository[] = [];
  for (let offset = 0; offset < limit; offset += 1) {
    selected.push(repositories[(start + offset) % repositories.length] as SelectedRepository);
  }
  return {
    repositories: selected,
    cursor: (start + limit) % repositories.length,
    total: repositories.length,
  };
}

function listOwnerRepositories(owner: string): ListedRepository[] {
  const env = inventoryEnv(owner);
  if (!env) {
    console.error(`[target-fanout] skipping ${owner}: missing inventory token`);
    return [];
  }
  const output = runGh(
    [
      "repo",
      "list",
      owner,
      "--limit",
      "1000",
      "--json",
      "nameWithOwner,isArchived,isFork,hasIssuesEnabled,visibility,defaultBranchRef",
    ],
    env,
  );
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`gh repo list ${owner} did not return an array`);
  return parsed.map((entry, index) => listedRepository(entry, `${owner}[${index}]`));
}

function listedRepository(value: unknown, label: string): ListedRepository {
  const repo = record(value, label);
  const branch =
    repo.defaultBranchRef === null
      ? {}
      : record(repo.defaultBranchRef, `${label}.defaultBranchRef`);
  return {
    nameWithOwner: stringValue(repo.nameWithOwner, `${label}.nameWithOwner`),
    isArchived: booleanValue(repo.isArchived, false),
    isDisabled: false,
    isFork: booleanValue(repo.isFork, false),
    hasIssuesEnabled: booleanValue(repo.hasIssuesEnabled, false),
    visibility: stringValue(repo.visibility, `${label}.visibility`).toUpperCase(),
    defaultBranch: typeof branch.name === "string" ? branch.name : "",
  };
}

function workflowDispatchArgs(repository: SelectedRepository, options: FanoutOptions): string[] {
  if (options.mode !== "audit") {
    return [
      "api",
      `repos/${options.dispatchRepo}/dispatches`,
      "-f",
      "event_type=clawsweeper_target_sweep",
      "-f",
      `client_payload[target_repo]=${repository.targetRepo}`,
      "-f",
      `client_payload[target_branch]=${repository.defaultBranch || "main"}`,
      "-f",
      `client_payload[hot_intake]=${options.mode === "hot-intake" ? "true" : "false"}`,
      "-f",
      "client_payload[batch_size]=1",
      "-f",
      "client_payload[shard_count]=1",
    ];
  }
  const args = [
    "workflow",
    "run",
    options.workflow,
    "--repo",
    options.dispatchRepo,
    "--ref",
    options.ref,
    "-f",
    `target_repo=${repository.targetRepo}`,
  ];
  args.push("-f", "audit_dashboard=true");
  return args;
}

function readCursor(cursorPath: string): number {
  if (!existsSync(cursorPath)) return 0;
  const parsed = JSON.parse(readFileSync(cursorPath, "utf8")) as unknown;
  const cursor = record(parsed, "cursor");
  return typeof cursor.next_cursor === "number" && Number.isInteger(cursor.next_cursor)
    ? cursor.next_cursor
    : 0;
}

function writeCursor(cursorPath: string, cursor: number): void {
  writeFileSyncWithDirs(cursorPath, `${JSON.stringify({ next_cursor: cursor }, null, 2)}\n`);
}

function writeFileSyncWithDirs(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
}

function runGh(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const childEnv = { ...process.env, ...env, NO_COLOR: "1", CLICOLOR: "0" };
  const command = resolveCommand("gh", args, childEnv);
  return execFileSync(command.command, command.args, {
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function inventoryEnv(owner: string): NodeJS.ProcessEnv | null {
  const key = `CLAWSWEEPER_INVENTORY_TOKEN_${owner.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const token = process.env[key] || process.env.CLAWSWEEPER_INVENTORY_TOKEN;
  if (token === PUBLIC_INVENTORY_TOKEN) return publicInventoryEnv();
  if (token) return { GH_TOKEN: token, GITHUB_TOKEN: token };
  if (process.env.GITHUB_ACTIONS === "true") return null;
  return publicInventoryEnv();
}

function publicInventoryEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.CLAWSWEEPER_PUBLIC_INVENTORY_TOKEN ||
    process.env.CLAWSWEEPER_DISPATCH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}

function dispatchEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.CLAWSWEEPER_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { GH_TOKEN: token } : {};
}

function fanoutMode(value: string): FanoutMode {
  if (value === "hot-intake" || value === "normal-review" || value === "audit") return value;
  throw new Error(`unsupported fanout mode: ${value}`);
}

export function defaultLimit(mode: FanoutMode): string {
  if (mode === "hot-intake") return "20";
  if (mode === "normal-review") return "12";
  return "12";
}

function loadRepositoryOpenCounts(
  repositories: readonly SelectedRepository[],
): Map<string, RepositoryOpenCounts> {
  const counts = new Map<string, RepositoryOpenCounts>();
  const batchSize = 25;
  for (let start = 0; start < repositories.length; start += batchSize) {
    const batch = repositories.slice(start, start + batchSize);
    const fields = batch
      .map((repository, index) => {
        const [owner, name] = repository.targetRepo.split("/");
        return `r${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}`;
      })
      .join(" ");
    const output = runGh(
      ["api", "graphql", "-f", `query=query FleetCoverage { ${fields} }`],
      publicInventoryEnv(),
    );
    const data = record(record(JSON.parse(output), "GraphQL response").data, "GraphQL data");
    for (const [index, repository] of batch.entries()) {
      const result = record(data[`r${index}`], `${repository.targetRepo} counts`);
      const issues = record(result.issues, `${repository.targetRepo} issue counts`);
      const pullRequests = record(
        result.pullRequests,
        `${repository.targetRepo} pull request counts`,
      );
      counts.set(repository.targetRepo, {
        issues: nonNegativeNumber(issues.totalCount, "issue totalCount"),
        pullRequests: nonNegativeNumber(pullRequests.totalCount, "pull request totalCount"),
      });
    }
  }
  return counts;
}

export function summarizeFleetReviewCoverage(options: {
  repositories: readonly SelectedRepository[];
  openCounts: ReadonlyMap<string, RepositoryOpenCounts>;
  windowDays: number;
  recordsRoot?: string;
  now?: number;
}): FleetReviewCoverage {
  const now = options.now ?? Date.now();
  const cutoff = now - options.windowDays * 24 * 60 * 60 * 1000;
  const recordsRoot = options.recordsRoot ?? join(repoRoot(), "records");
  let openIssues = 0;
  let openPullRequests = 0;
  let scannedOpenRecords = 0;
  let repositoriesWithOpenItems = 0;
  for (const repository of options.repositories) {
    const counts = options.openCounts.get(repository.targetRepo) ?? {
      issues: 0,
      pullRequests: 0,
    };
    const openTotal = counts.issues + counts.pullRequests;
    openIssues += counts.issues;
    openPullRequests += counts.pullRequests;
    if (openTotal > 0) repositoriesWithOpenItems += 1;
    const repoSlug = repository.targetRepo.toLowerCase().replace("/", "-");
    const itemsDir = join(recordsRoot, repoSlug, "items");
    let freshRecords = 0;
    if (existsSync(itemsDir)) {
      for (const entry of readdirSync(itemsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const markdown = readFileSync(join(itemsDir, entry.name), "utf8");
        if (frontMatterField(markdown, "review_status") !== "complete") continue;
        const reviewedAt = Date.parse(frontMatterField(markdown, "reviewed_at"));
        if (Number.isFinite(reviewedAt) && reviewedAt >= cutoff && reviewedAt <= now) {
          freshRecords += 1;
        }
      }
    }
    // Canonical items are reconciled against live open state on scheduled audits.
    // Cap each repository at its live total so delayed external-close reconciliation
    // cannot make the fleet summary exceed 100%.
    scannedOpenRecords += Math.min(freshRecords, openTotal);
  }
  const openTotal = openIssues + openPullRequests;
  const coveragePercent = openTotal > 0 ? (scannedOpenRecords / openTotal) * 100 : 100;
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: options.windowDays,
    repositoryCount: options.repositories.length,
    repositoriesWithOpenItems,
    openIssues,
    openPullRequests,
    openTotal,
    scannedOpenRecords,
    remainingOpenItems: Math.max(0, openTotal - scannedOpenRecords),
    coveragePercent,
    requiredItemsPerHourWithHeadroom:
      openTotal > 0 ? (openTotal / (options.windowDays * 24)) * 1.3 : 0,
  };
}

export function renderFleetReviewCoverage(coverage: FleetReviewCoverage): string {
  return `## Weekly review coverage

Generated ${coverage.generatedAt}. Canonical open-item records are compared with batched live GitHub totals; repository counts are capped at the live open total while external-close reconciliation catches up.

| Metric | Value |
| --- | ---: |
| Eligible repositories | ${coverage.repositoryCount} |
| Repositories with open items | ${coverage.repositoriesWithOpenItems} |
| Open issues | ${coverage.openIssues} |
| Open pull requests | ${coverage.openPullRequests} |
| Open items total | ${coverage.openTotal} |
| Items scanned in trailing ${coverage.windowDays} days | ${coverage.scannedOpenRecords} |
| Remaining outside trailing window | ${coverage.remainingOpenItems} |
| Trailing coverage | ${coverage.coveragePercent.toFixed(1)}% |
| Required items/hour with 30% headroom | ${coverage.requiredItemsPerHourWithHeadroom.toFixed(1)} |

`;
}

function frontMatterField(markdown: string, key: string): string {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${label} must be positive`);
  return parsed;
}

function normalizeCursor(cursor: number, length: number): number {
  return ((cursor % length) + length) % length;
}

function csvArg(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} must be a non-empty string`);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTargetFanout(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
