#!/usr/bin/env node
import { requireRecord as record, errorSummary as errorMessage } from "../value-coerce.js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommand } from "../command.js";
import {
  fetchDurableCursor,
  putDurableCursor,
  type DurableCursorSnapshot,
  type DurableCursorStoreOptions,
} from "../durable-cursor-store.js";
import {
  hostedTargetPolicyFromRegistry,
  isHostedTargetEligible,
  probeHostedPublicTarget,
  type HostedTargetAdmission,
  type HostedTargetPolicy,
} from "../hosted-target-admission.js";
import { fetchExactReviewQueuePressure } from "../queue-pressure.js";
import { coverageTrackedCountsFromManifest } from "../review-coverage-manifest.js";
import { parseArgs, repoRoot } from "./lib.js";

export type FanoutMode = "hot-intake" | "normal-review" | "audit";

export interface InventoryConfig {
  owners: readonly string[];
  denyRepositories: readonly string[];
  hostedTargetPolicy: HostedTargetPolicy;
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

export interface ReviewCoverageInventorySnapshot {
  generated_at: string;
  repositories: Array<{
    repo: string;
    repo_slug: string;
    open_issues: number;
    open_pull_requests: number;
  }>;
}

export interface ReviewPlanningRepository extends SelectedRepository {
  openItems: number;
  trackedRecords: number;
  untrackedOpen: number;
}

interface SelectionResult<RepositoryT extends SelectedRepository = SelectedRepository> {
  repositories: RepositoryT[];
  cursor: number;
  total: number;
}

export interface ReviewFanoutRepository extends ReviewPlanningRepository {
  candidateCapacity: number;
}

export type FanoutCursorSnapshot = DurableCursorSnapshot<FanoutMode>;
export type FanoutCursorStoreOptions = DurableCursorStoreOptions<FanoutMode>;

interface FanoutOptions {
  mode: FanoutMode;
  limit: number;
  cursorStoreUrl: string;
  dispatchRepo: string;
  workflow: string;
  ref: string;
  dryRun: boolean;
  owners: readonly string[] | undefined;
}

interface InventoryAccess {
  env: NodeJS.ProcessEnv;
  kind: "installation" | "public";
}

const PUBLIC_INVENTORY_TOKEN = "__public__";
export const SCHEDULED_REVIEW_PLAN_BATCH_SIZE = 50;

export async function runTargetFanout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const mode = fanoutMode(stringArg(args.mode, "hot-intake"));
  const config = readInventoryConfig();
  const options: FanoutOptions = {
    mode,
    limit: positiveNumber(stringArg(args.limit, defaultLimit(mode)), "limit"),
    cursorStoreUrl: stringArg(
      args["cursor-store-url"],
      process.env.CLAWSWEEPER_CURSOR_STORE_URL ?? stringArg(args["publish-url"], ""),
    ),
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
    const now = Date.now();
    const coverage = summarizeFleetReviewCoverage({ repositories, openCounts, windowDays, now });
    const publishUrl = stringArg(args["publish-url"], "");
    if (publishUrl) {
      try {
        await publishReviewCoverageInventory({
          baseUrl: publishUrl,
          webhookSecret: stringValue(
            process.env.CLAWSWEEPER_WEBHOOK_SECRET,
            "CLAWSWEEPER_WEBHOOK_SECRET",
          ),
          snapshot: reviewCoverageInventorySnapshot(repositories, openCounts, now),
        });
      } catch (error) {
        console.error(
          `[target-fanout] WARNING: live review inventory did not publish; continuing without blocking scheduled fanout work: ${errorMessage(error)}`,
        );
      }
    }
    process.stdout.write(renderFleetReviewCoverage(coverage));
    return;
  }

  if (args._[0] === "list") {
    process.stdout.write(
      `${JSON.stringify({ total: repositories.length, repositories }, null, 2)}\n`,
    );
    return;
  }

  let planningRepositories: readonly SelectedRepository[] = repositories;
  let reviewCandidateCapacity: number | null = null;
  if (mode === "normal-review" || mode === "hot-intake") {
    const openCounts = loadRepositoryOpenCounts(repositories);
    const now = Date.now();
    if (mode === "normal-review") {
      const publishUrl = stringArg(args["publish-url"], "");
      if (publishUrl) {
        try {
          await publishReviewCoverageInventory({
            baseUrl: publishUrl,
            webhookSecret: stringValue(
              process.env.CLAWSWEEPER_WEBHOOK_SECRET,
              "CLAWSWEEPER_WEBHOOK_SECRET",
            ),
            snapshot: reviewCoverageInventorySnapshot(repositories, openCounts, now),
          });
        } catch (error) {
          console.error(
            `[target-fanout] WARNING: live review inventory did not publish; continuing without blocking scheduled fanout work: ${errorMessage(error)}`,
          );
        }
      }
      const coverageManifestPath = stringArg(args["coverage-tracked-items-manifest"], "");
      const coverageTrackedCounts = coverageManifestPath
        ? coverageTrackedCountsFromManifest(coverageManifestPath)
        : undefined;
      planningRepositories = reviewPlanningRepositories({
        repositories,
        openCounts,
        ...(coverageTrackedCounts ? { coverageTrackedCounts } : {}),
      });
    } else {
      planningRepositories = repositoriesWithOpenItems(repositories, openCounts);
    }
  }
  const cursor = await loadFanoutCursor({
    baseUrl: options.cursorStoreUrl,
    webhookSecret: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
    mode,
  });
  let selection: SelectionResult;
  if (mode === "normal-review") {
    const fallbackCapacity =
      SCHEDULED_REVIEW_PLAN_BATCH_SIZE * Math.min(options.limit, planningRepositories.length);
    const pressure = await fetchExactReviewQueuePressure({ queueUrl: options.cursorStoreUrl });
    reviewCandidateCapacity =
      pressure.ok && pressure.availableCandidateCapacity !== undefined
        ? pressure.availableCandidateCapacity
        : fallbackCapacity;
    selection = planReviewFanout(planningRepositories as readonly ReviewPlanningRepository[], {
      limit: options.limit,
      cursor: cursor.nextCursor,
      candidateCapacity: reviewCandidateCapacity,
    });
  } else {
    selection = selectRepositories(planningRepositories, {
      limit: options.limit,
      cursor: cursor.nextCursor,
    });
  }

  selection = {
    ...selection,
    repositories: await admitSelectedRepositories(selection.repositories, {
      policy: config.hostedTargetPolicy,
    }),
  };
  const commands = selection.repositories.map((repository) =>
    workflowDispatchArgs(repository, options, candidateCapacityFor(repository)),
  );

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

  const cursorPersisted = options.dryRun
    ? false
    : await persistFanoutCursorFailOpen(
        {
          baseUrl: options.cursorStoreUrl,
          webhookSecret: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
          mode,
        },
        selection.cursor,
        cursor.revision,
      );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.mode,
        total: selection.total,
        dispatched,
        next_cursor: selection.cursor,
        dry_run: options.dryRun,
        cursor_loaded: cursor.loaded,
        cursor_persisted: cursorPersisted,
        review_candidate_capacity: reviewCandidateCapacity,
        candidate_batches: Object.fromEntries(
          selection.repositories.flatMap((repository) =>
            candidateCapacityFor(repository) === undefined
              ? []
              : [[repository.targetRepo, candidateCapacityFor(repository)] as const],
          ),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function candidateCapacityFor(repository: SelectedRepository): number | undefined {
  if (!("candidateCapacity" in repository)) return undefined;
  return typeof repository.candidateCapacity === "number"
    ? repository.candidateCapacity
    : undefined;
}

export function readInventoryConfig(
  filePath = join(repoRoot(), "config", "target-repositories.json"),
): InventoryConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const config = record(parsed, "target repository config");
  const inventory = record(config.target_inventory, "target_inventory");
  const hostedTargetPolicy = hostedTargetPolicyFromRegistry(parsed);
  if (!hostedTargetPolicy) throw new Error("target repository config has invalid hosted policy");
  return {
    owners: stringArray(inventory.owners, "target_inventory.owners").map((owner) =>
      owner.toLowerCase(),
    ),
    denyRepositories: stringArray(
      inventory.deny_repositories,
      "target_inventory.deny_repositories",
    ).map((repo) => repo.toLowerCase()),
    hostedTargetPolicy,
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
  const configuredOwners = new Set(config.owners.map((owner) => owner.toLowerCase()));
  const selectedOwners = [...new Set(owners.map((owner) => owner.trim().toLowerCase()))];
  const unsupportedOwner = selectedOwners.find((owner) => !configuredOwners.has(owner));
  if (unsupportedOwner) {
    throw new Error(`target fanout owner is not configured: ${unsupportedOwner}`);
  }
  const repositories: ListedRepository[] = [];
  for (const owner of selectedOwners) {
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
    .filter((repository) =>
      isHostedTargetEligible(repository.nameWithOwner, config.hostedTargetPolicy),
    )
    .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner))
    .map((repository) => ({
      targetRepo: repository.nameWithOwner.toLowerCase(),
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
    }));
}

export function selectRepositories<RepositoryT extends SelectedRepository>(
  repositories: readonly RepositoryT[],
  options: { limit: number; cursor: number },
): SelectionResult<RepositoryT> {
  if (repositories.length === 0) return { repositories: [], cursor: 0, total: 0 };
  const limit = Math.max(1, Math.min(options.limit, repositories.length));
  const start = normalizeCursor(options.cursor, repositories.length);
  const selected: RepositoryT[] = [];
  for (let offset = 0; offset < limit; offset += 1) {
    selected.push(repositories[(start + offset) % repositories.length] as RepositoryT);
  }
  return {
    repositories: selected,
    cursor: (start + limit) % repositories.length,
    total: repositories.length,
  };
}

export function repositoriesWithOpenItems<RepositoryT extends SelectedRepository>(
  repositories: readonly RepositoryT[],
  openCounts: ReadonlyMap<string, RepositoryOpenCounts>,
): RepositoryT[] {
  return repositories.filter((repository) => {
    const counts = openCounts.get(repository.targetRepo);
    return Boolean(counts && counts.issues + counts.pullRequests > 0);
  });
}

export function reviewPlanningRepositories(options: {
  repositories: readonly SelectedRepository[];
  openCounts: ReadonlyMap<string, RepositoryOpenCounts>;
  recordsRoot?: string;
  coverageTrackedCounts?: ReadonlyMap<string, number>;
}): ReviewPlanningRepository[] {
  const recordsRoot = options.recordsRoot ?? join(repoRoot(), "records");
  return options.repositories
    .map((repository) => {
      const counts = options.openCounts.get(repository.targetRepo) ?? {
        issues: 0,
        pullRequests: 0,
      };
      const openItems = counts.issues + counts.pullRequests;
      const itemsDir = join(
        recordsRoot,
        repository.targetRepo.toLowerCase().replace("/", "-"),
        "items",
      );
      const repoSlug = repository.targetRepo.toLowerCase().replace("/", "-");
      const trackedRecords = options.coverageTrackedCounts
        ? (options.coverageTrackedCounts.get(repoSlug) ?? 0)
        : existsSync(itemsDir)
          ? readdirSync(itemsDir, { withFileTypes: true }).filter(
              (entry) => entry.isFile() && entry.name.endsWith(".md"),
            ).length
          : 0;
      return {
        ...repository,
        openItems,
        trackedRecords,
        untrackedOpen: Math.max(0, openItems - trackedRecords),
      };
    })
    .filter((repository) => repository.openItems > 0)
    .sort(
      (left, right) =>
        Number(right.untrackedOpen > 0) - Number(left.untrackedOpen > 0) ||
        left.targetRepo.localeCompare(right.targetRepo),
    );
}

export function planReviewFanout(
  repositories: readonly ReviewPlanningRepository[],
  options: { limit: number; cursor: number; candidateCapacity: number },
): SelectionResult<ReviewFanoutRepository> {
  if (repositories.length === 0) return { repositories: [], cursor: 0, total: 0 };
  const limit = Math.max(1, Math.min(options.limit, repositories.length));
  const dominant = repositories.reduce<ReviewPlanningRepository | null>((largest, repository) => {
    if (repository.untrackedOpen < 1) return largest;
    if (!largest || repository.untrackedOpen > largest.untrackedOpen) return repository;
    if (
      repository.untrackedOpen === largest.untrackedOpen &&
      repository.targetRepo.localeCompare(largest.targetRepo) < 0
    ) {
      return repository;
    }
    return largest;
  }, null);
  const fairnessPool = dominant
    ? repositories.filter((repository) => repository.targetRepo !== dominant.targetRepo)
    : repositories;
  const fairnessLimit = dominant ? limit - 1 : limit;
  const fairness =
    fairnessLimit > 0 && fairnessPool.length > 0
      ? selectRepositories(fairnessPool, { limit: fairnessLimit, cursor: options.cursor })
      : { repositories: [] as ReviewPlanningRepository[], cursor: 0, total: fairnessPool.length };
  // Dispatch the rotating fairness slice first so a dominant repository cannot
  // consume every scheduled-feed token before smaller planners reach enqueue.
  const selected = dominant ? [...fairness.repositories, dominant] : fairness.repositories;
  const allocations = allocateReviewCandidateCapacity(selected, options.candidateCapacity);
  return {
    repositories: selected.map((repository) => ({
      ...repository,
      candidateCapacity: allocations.get(repository.targetRepo) ?? 1,
    })),
    cursor: fairness.cursor,
    total: repositories.length,
  };
}

export function allocateReviewCandidateCapacity(
  repositories: readonly ReviewPlanningRepository[],
  candidateCapacity: number,
): Map<string, number> {
  if (repositories.length === 0) return new Map();
  // One candidate per selected repository is the fairness reservation. If the
  // live queue has fewer free slots, the bounded over-offer is intentional: the
  // Worker remains the final admission owner and the cursor still makes progress.
  const budget = Math.max(repositories.length, Math.floor(Math.max(0, candidateCapacity)));
  const allocations = new Map(repositories.map((repository) => [repository.targetRepo, 1]));
  const remainingDemand = new Map(
    repositories.map((repository) => [
      repository.targetRepo,
      Math.max(0, Math.max(1, repository.untrackedOpen) - 1),
    ]),
  );
  let available = budget - repositories.length;
  while (available > 0) {
    const active = repositories.filter(
      (repository) => (remainingDemand.get(repository.targetRepo) ?? 0) > 0,
    );
    if (active.length === 0) break;
    const totalDemand = active.reduce(
      (total, repository) => total + (remainingDemand.get(repository.targetRepo) ?? 0),
      0,
    );
    const roundCapacity = available;
    const remainders: Array<{ repository: ReviewPlanningRepository; remainder: number }> = [];
    let assigned = 0;
    for (const repository of active) {
      const demand = remainingDemand.get(repository.targetRepo) ?? 0;
      const quota = (roundCapacity * demand) / totalDemand;
      const extra = Math.min(demand, Math.floor(quota));
      if (extra > 0) {
        allocations.set(
          repository.targetRepo,
          (allocations.get(repository.targetRepo) ?? 0) + extra,
        );
        remainingDemand.set(repository.targetRepo, demand - extra);
        assigned += extra;
      }
      remainders.push({ repository, remainder: quota - Math.floor(quota) });
    }
    available -= assigned;
    if (available <= 0) break;
    remainders.sort(
      (left, right) =>
        right.remainder - left.remainder ||
        right.repository.untrackedOpen - left.repository.untrackedOpen ||
        left.repository.targetRepo.localeCompare(right.repository.targetRepo),
    );
    let remainderAssigned = 0;
    for (const { repository } of remainders) {
      if (available <= 0) break;
      const demand = remainingDemand.get(repository.targetRepo) ?? 0;
      if (demand <= 0) continue;
      allocations.set(repository.targetRepo, (allocations.get(repository.targetRepo) ?? 0) + 1);
      remainingDemand.set(repository.targetRepo, demand - 1);
      available -= 1;
      remainderAssigned += 1;
    }
    if (assigned === 0 && remainderAssigned === 0) break;
  }
  return allocations;
}

function listOwnerRepositories(owner: string): ListedRepository[] {
  const access = inventoryAccess(owner);
  if (!access) {
    console.error(`[target-fanout] skipping ${owner}: missing inventory token`);
    return [];
  }
  if (access.kind === "installation") {
    return listInstallationRepositories(owner, access.env);
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
    access.env,
  );
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`gh repo list ${owner} did not return an array`);
  return parsed.map((entry, index) => listedRepository(entry, `${owner}[${index}]`));
}

function listInstallationRepositories(owner: string, env: NodeJS.ProcessEnv): ListedRepository[] {
  const output = runGh(
    [
      "api",
      "--paginate",
      "-H",
      "Accept: application/vnd.github+json",
      "--jq",
      'if (.repositories | type) != "array" then error("repositories must be an array") else .repositories[] end',
      "/installation/repositories?per_page=100",
    ],
    env,
  );
  const ownerPrefix = `${owner.toLowerCase()}/`;
  return (output === "" ? [] : output.split(/\r?\n/))
    .map((entry, index) =>
      listedInstallationRepository(JSON.parse(entry), `${owner}.repositories[${index}]`),
    )
    .filter((repository) => repository.nameWithOwner.toLowerCase().startsWith(ownerPrefix));
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

function listedInstallationRepository(value: unknown, label: string): ListedRepository {
  const repo = record(value, label);
  return {
    nameWithOwner: stringValue(repo.full_name, `${label}.full_name`),
    isArchived: booleanValue(repo.archived, false),
    isDisabled: booleanValue(repo.disabled, false),
    isFork: booleanValue(repo.fork, false),
    hasIssuesEnabled: booleanValue(repo.has_issues, false),
    visibility: stringValue(repo.visibility, `${label}.visibility`).toUpperCase(),
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "",
  };
}

export async function admitSelectedRepositories<RepositoryT extends SelectedRepository>(
  repositories: readonly RepositoryT[],
  options: {
    policy: HostedTargetPolicy;
    token?: string;
    reader?: typeof fetch;
  },
): Promise<RepositoryT[]> {
  const token = options.token ?? hostedTargetMetadataToken();
  const reader = options.reader ?? fetch;
  const eligible = repositories.filter((repository) =>
    isHostedTargetEligible(repository.targetRepo, options.policy),
  );
  const admissions = await Promise.all(
    eligible.map(
      async (repository) =>
        [repository, await probeHostedPublicTarget(repository.targetRepo, token, reader)] as const,
    ),
  );
  const retryable = admissions.find(([, admission]) => admission.outcome === "retryable");
  if (retryable) {
    throw new Error(
      `target fanout visibility probe is retryable for ${retryable[0].targetRepo}; no dispatches were sent and the cursor was not advanced`,
    );
  }
  return admissions
    .filter(
      (entry): entry is readonly [RepositoryT, HostedTargetAdmission & { outcome: "public" }] =>
        entry[1].outcome === "public",
    )
    .map(([repository]) => repository);
}

function workflowDispatchArgs(
  repository: SelectedRepository,
  options: FanoutOptions,
  candidateCapacity = SCHEDULED_REVIEW_PLAN_BATCH_SIZE,
): string[] {
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
      `client_payload[batch_size]=${candidateCapacity}`,
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

export async function fetchFanoutCursor(
  options: FanoutCursorStoreOptions,
): Promise<FanoutCursorSnapshot> {
  return fetchDurableCursor(options);
}

export async function putFanoutCursor(
  options: FanoutCursorStoreOptions,
  nextCursor: number,
  expectedRevision: number,
): Promise<FanoutCursorSnapshot> {
  return putDurableCursor(options, nextCursor, expectedRevision);
}

export async function loadFanoutCursor(
  options: FanoutCursorStoreOptions,
): Promise<FanoutCursorSnapshot & { loaded: boolean }> {
  try {
    return { ...(await fetchFanoutCursor(options)), loaded: true };
  } catch (error) {
    console.error(
      `[target-fanout] WARNING: canonical ${options.mode} cursor is unavailable; continuing dispatch from cursor 0 without blocking productive work: ${errorMessage(error)}`,
    );
    return { mode: options.mode, nextCursor: 0, revision: 0, updatedAt: null, loaded: false };
  }
}

export async function persistFanoutCursorFailOpen(
  options: FanoutCursorStoreOptions,
  nextCursor: number,
  expectedRevision: number,
): Promise<boolean> {
  try {
    await putFanoutCursor(options, nextCursor, expectedRevision);
    return true;
  } catch (error) {
    console.error(
      `[target-fanout] WARNING: canonical ${options.mode} cursor did not persist after dispatch; dispatched work remains valid and the next cycle will retry: ${errorMessage(error)}`,
    );
    return false;
  }
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

function inventoryAccess(owner: string): InventoryAccess | null {
  const key = `CLAWSWEEPER_INVENTORY_TOKEN_${owner.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const token = process.env[key] || process.env.CLAWSWEEPER_INVENTORY_TOKEN;
  if (token === PUBLIC_INVENTORY_TOKEN) {
    return { env: publicInventoryEnv(), kind: "public" };
  }
  if (token) {
    return { env: { GH_TOKEN: token, GITHUB_TOKEN: token }, kind: "installation" };
  }
  if (process.env.GITHUB_ACTIONS === "true") return null;
  return { env: publicInventoryEnv(), kind: "public" };
}

function publicInventoryEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.CLAWSWEEPER_PUBLIC_INVENTORY_TOKEN ||
    process.env.CLAWSWEEPER_DISPATCH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}

function hostedTargetMetadataToken(): string {
  const explicit =
    process.env.CLAWSWEEPER_HOSTED_TARGET_METADATA_TOKEN ||
    process.env.CLAWSWEEPER_PUBLIC_INVENTORY_TOKEN ||
    "";
  if (explicit || process.env.GITHUB_ACTIONS === "true") return explicit;
  return (
    process.env.CLAWSWEEPER_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
  );
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

export function reviewCoverageInventorySnapshot(
  repositories: readonly SelectedRepository[],
  openCounts: ReadonlyMap<string, RepositoryOpenCounts>,
  now = Date.now(),
): ReviewCoverageInventorySnapshot {
  return {
    generated_at: new Date(now).toISOString(),
    repositories: repositories.map((repository) => {
      const counts = openCounts.get(repository.targetRepo) ?? { issues: 0, pullRequests: 0 };
      return {
        repo: repository.targetRepo,
        repo_slug: repository.targetRepo.toLowerCase().replace("/", "-"),
        open_issues: counts.issues,
        open_pull_requests: counts.pullRequests,
      };
    }),
  };
}

export async function publishReviewCoverageInventory(options: {
  baseUrl: string;
  webhookSecret: string;
  snapshot: ReviewCoverageInventorySnapshot;
  attempts?: number;
  fetchImpl?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) {
    throw new Error("Review coverage inventory URL must use HTTPS");
  }
  const body = JSON.stringify(options.snapshot);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret).update(body).digest("hex")}`;
  const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 3)));
  const request = options.fetchImpl ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastFailure = "review coverage inventory publication failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(`${baseUrl}/internal/review-coverage/inventory`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok && payload.ok === true) return;
      lastFailure = String(payload.error || `http_${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(attempt * 5_000);
  }
  throw new Error(`Review coverage inventory publication failed: ${lastFailure}`);
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTargetFanout(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
