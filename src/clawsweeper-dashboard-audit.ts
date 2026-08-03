import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  boolArg,
  itemNumbersArg,
  numberArg,
  optionalNumberArg,
  stringArg,
  type Args,
} from "./clawsweeper-args.js";
import { createAuditEngine } from "./clawsweeper-audit.js";
import { closeReasonText } from "./clawsweeper-close-reasons.js";
import { createDashboardPresentation } from "./clawsweeper-dashboard.js";
import {
  DAILY_REVIEW_DAYS,
  DAY_MS,
  HOT_REVIEW_DAYS,
  RECENT_ISSUE_DAYS,
} from "./clawsweeper-policy.js";
import { escapeRegExp } from "./clawsweeper-text.js";
import type {
  AuditRecord,
  AuditRecordLocation,
  AuditResult,
  DashboardActivityBucket,
  DashboardActivityStats,
  DashboardCadenceBucket,
  DashboardClosedItem,
  DashboardItem,
  DashboardKindStats,
  DashboardStats,
  Item,
  ItemKind,
  OpenItemCounts,
  ReconcileResult,
  RepoDashboardSnapshot,
  ReportEntry,
  WorkflowStatusSummary,
} from "./clawsweeper-types.js";
import { syncDecisionPacketRecord, type DecisionPacketSubjectState } from "./decision-packets.js";
import { isGitHubNotFoundError } from "./github-retry.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
import {
  REPOSITORY_PROFILES,
  repositoryProfileFor,
  type RepositoryProfile,
} from "./repository-profiles.js";
import { WEEKLY_COVERAGE_REVIEW_DAYS } from "./scheduler-policy.js";

interface CreateDashboardAuditDependencies {
  addDashboardCadenceBucket: (
    target: DashboardCadenceBucket,
    source: DashboardCadenceBucket,
  ) => void;
  applyBlockingProtectedLabels: (labels: readonly string[], closeReason: unknown) => string[];
  applyHealthStatusArg: (args: Args) => Record<string, unknown> | undefined;
  auditStatePath: (profile?: RepositoryProfile) => string;
  capDashboardCadenceBucket: (
    bucket: DashboardCadenceBucket,
    totalLimit: number,
  ) => DashboardCadenceBucket;
  currentWorkflowStatusBlock: (readme: string, profile?: RepositoryProfile) => string;
  dashboardMarkdownWithFailedReviewRetryState: (
    markdown: string,
    number: number,
    stateDir: string,
  ) => string;
  decisionPacketsDirFromArgs: (args: Args, itemsDir: string, closedDir: string) => string;
  defaultClosedDir: (profile?: RepositoryProfile) => string;
  defaultFailedReviewRetryStateDir: (profile?: RepositoryProfile) => string;
  defaultItemsDir: (profile?: RepositoryProfile) => string;
  defaultPlansDir: (profile?: RepositoryProfile) => string;
  displayTitle: (title: string) => string;
  effectiveReviewStatus: (markdown: string) => string;
  emptyDashboardActivityStats: () => DashboardActivityStats;
  emptyDashboardCadenceBucket: () => DashboardCadenceBucket;
  emptyDashboardKindStats: () => DashboardKindStats;
  ensureDir: (path: string) => void;
  fetchItem: (number: number) => { item: Item; state: string };
  fetchOpenItemCounts: () => OpenItemCounts;
  fetchOpenItemNumbers: (maxPages: number) => { numbers: Set<number>; pagesScanned: number };
  fetchOpenItems: (maxPages: number) => { items: Item[]; pagesScanned: number; complete: boolean };
  formatActivityRow: (label: string, bucket: DashboardActivityBucket) => string;
  formatCadenceBucket: (bucket: DashboardCadenceBucket) => string;
  formatOperationActivityRow: (label: string, bucket: DashboardActivityBucket) => string;
  formatPercent: (numerator: number, denominator: number) => string;
  formatStatusNumber: (value: number | undefined) => string;
  formatTimestamp: (iso: string | undefined) => string;
  frontMatterStringArray: (markdown: string, key: string) => string[];
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  ghJson: <T>(args: string[]) => T;
  isCurrentForCadence: (options: {
    reviewedAt: string | undefined;
    reviewStatus: string | undefined;
    cadenceMs: number;
    now: number;
  }) => boolean;
  isFresh: (
    review: { reviewedAt: string | undefined; reviewStatus: string | undefined } | null,
  ) => boolean;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isMarkdownForActiveRepo: (markdown: string, file?: string) => boolean;
  isProtectedItem: (item: Pick<Item, "labels">) => boolean;
  itemUrlFor: (repo: string, number: number, kind?: ItemKind) => string;
  latestTimestamp: (
    current: string | undefined,
    candidate: string | undefined,
  ) => string | undefined;
  markdownFiles: (dir: string) => string[];
  markdownLink: (label: string, url: string) => string;
  markdownRepository: (markdown: string, file?: string) => string;
  numberForMarkdownFile: (file: string) => number;
  profileAuditEnd: (profile?: RepositoryProfile) => string;
  profileAuditStart: (profile?: RepositoryProfile) => string;
  recordDashboardActivity: (
    markdown: string,
    activity: DashboardActivityStats,
    now: number,
  ) => void;
  replaceFrontMatterValue: (markdown: string, key: string, value: string) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  repoRelativePath: (path: string) => string;
  reportEntriesForDir: (dir: string, itemNumbers?: ReadonlySet<number>) => ReportEntry[];
  reportFileUrl: (number: number, path?: string) => string;
  repoUrlFor: (repo: string, path?: string) => string;
  ROOT: string;
  shouldPlanItem: (item: Pick<Item, "authorAssociation" | "labels">) => boolean;
  sweepStatusRelativePath: (profile?: RepositoryProfile) => string;
  syncWorkPlanFromReport: (options: {
    markdown: string;
    reportPath: string;
    plansDir: string;
    dryRun?: boolean;
  }) => boolean;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
  timestampMs: (iso: string | undefined) => number | null;
  withTargetProfile: <T>(profile: RepositoryProfile, fn: () => T) => T;
  workflowStatusSummary: (block: string) => WorkflowStatusSummary;
  workPlanPathForReport: (file: string, plansDir?: string) => string;
  writeSweepStatus: (options: {
    state: string;
    detail: string;
    runUrl?: string;
    profile?: RepositoryProfile;
    plannedCount?: number;
    plannedCapacity?: number;
    plannedShards?: number;
    activeCodex?: number;
    dueBacklog?: number;
    oldestUnreviewedAt?: string;
    capacityReason?: string;
    inheritedLabelCleanups?: number;
    selfHealConflictRepairs?: number;
    failedReviewRetries?: number;
    failedReviewRetryExhaustions?: number;
    botOwnedProofDecisionsRequested?: number;
    botOwnedProofDispatches?: number;
    applyHealth?: Record<string, unknown> | null;
  }) => void;
}

export function createDashboardAudit(dependencies: CreateDashboardAuditDependencies) {
  const {
    addDashboardCadenceBucket,
    applyBlockingProtectedLabels,
    applyHealthStatusArg,
    auditStatePath,
    capDashboardCadenceBucket,
    currentWorkflowStatusBlock,
    dashboardMarkdownWithFailedReviewRetryState,
    decisionPacketsDirFromArgs,
    defaultClosedDir,
    defaultFailedReviewRetryStateDir,
    defaultItemsDir,
    defaultPlansDir,
    displayTitle,
    effectiveReviewStatus,
    emptyDashboardActivityStats,
    emptyDashboardCadenceBucket,
    emptyDashboardKindStats,
    ensureDir,
    fetchItem,
    fetchOpenItemCounts,
    fetchOpenItemNumbers,
    fetchOpenItems,
    formatActivityRow,
    formatCadenceBucket,
    formatOperationActivityRow,
    formatPercent,
    formatStatusNumber,
    formatTimestamp,
    frontMatterStringArray,
    frontMatterValue,
    ghJson,
    isCurrentForCadence,
    isFresh,
    isMaintainerAuthored,
    isMarkdownForActiveRepo,
    isProtectedItem,
    itemUrlFor,
    latestTimestamp,
    markdownFiles,
    markdownLink,
    markdownRepository,
    numberForMarkdownFile,
    profileAuditEnd,
    profileAuditStart,
    recordDashboardActivity,
    replaceFrontMatterValue,
    repoFromArgs,
    repoRelativePath,
    reportEntriesForDir,
    reportFileUrl,
    repoUrlFor,
    ROOT,
    shouldPlanItem,
    sweepStatusRelativePath,
    syncWorkPlanFromReport,
    targetProfile,
    targetRepo,
    timestampMs,
    withTargetProfile,
    workflowStatusSummary,
    workPlanPathForReport,
    writeSweepStatus,
  } = dependencies;

  function markdownAuditRecord(
    location: AuditRecordLocation,
    dir: string,
    file: string,
  ): AuditRecord {
    const path = join(dir, file);
    const markdown = readFileSync(path, "utf8");
    const repo = markdownRepository(markdown, file);
    return {
      repo,
      number: numberForMarkdownFile(file),
      location,
      path: repoRelativePath(path),
      kind: frontMatterValue(markdown, "type") as ItemKind | undefined,
      title: frontMatterValue(markdown, "title") ?? "",
      labels: frontMatterStringArray(markdown, "labels"),
      decision: frontMatterValue(markdown, "decision"),
      closeReason: frontMatterValue(markdown, "close_reason"),
      confidence: frontMatterValue(markdown, "confidence"),
      reviewedAt: frontMatterValue(markdown, "reviewed_at"),
      action: frontMatterValue(markdown, "action_taken"),
      reviewStatus: effectiveReviewStatus(markdown),
      currentState: frontMatterValue(markdown, "current_state"),
    };
  }

  function auditRecords(location: AuditRecordLocation, dir: string): AuditRecord[] {
    return markdownFiles(dir)
      .map((file) => markdownAuditRecord(location, dir, file))
      .filter((record) => record.repo === targetRepo());
  }

  const auditEngine = createAuditEngine({
    applyBlockingProtectedLabels,
    displayTitle,
    formatTimestamp,
    isMaintainerAuthored,
    isProtectedItem,
    itemUrlFor,
    markdownLink,
    profileAuditEnd,
    profileAuditStart,
    repoUrlFor,
    shouldPlanItem,
    targetProfile,
    targetRepo,
  });

  const { auditFromSnapshot, auditHasStrictFailures, auditHealthSection } = auditEngine;

  const { limitAuditFindings } = auditEngine;

  function currentAuditHealthSection(readme: string, profile = targetProfile()): string {
    const profileMatch = readme.match(
      new RegExp(
        `### Audit Health\\n\\n${escapeRegExp(profileAuditStart(profile))}[\\s\\S]*?${escapeRegExp(profileAuditEnd(profile))}`,
      ),
    );
    if (profileMatch?.[0]) return profileMatch[0];
    return withTargetProfile(profile, () => auditHealthSection(null));
  }

  function updateAuditHealthDashboard(result: AuditResult): void {
    const profile = repositoryProfileFor(result.targetRepo);
    const outputPath = auditStatePath(profile);
    ensureDir(dirname(outputPath));
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  function markReconciledState(
    markdown: string,
    state: "open" | "closed",
    options: { closedAt?: string | null | undefined } = {},
  ): string {
    let nextMarkdown = replaceFrontMatterValue(markdown, "current_state", state);
    nextMarkdown = replaceFrontMatterValue(nextMarkdown, "reconciled_at", new Date().toISOString());
    if (state === "closed" && options.closedAt) {
      nextMarkdown = replaceFrontMatterValue(
        nextMarkdown,
        "current_item_closed_at",
        options.closedAt,
      );
    }
    if (state === "open") {
      nextMarkdown = replaceFrontMatterValue(nextMarkdown, "review_status", "stale_reopened");
      nextMarkdown = replaceFrontMatterValue(nextMarkdown, "action_taken", "kept_open");
    }
    return nextMarkdown;
  }

  function moveMarkdownFile(options: {
    sourcePath: string;
    destinationPath: string;
    markdown: string;
    dryRun: boolean;
  }): void {
    if (options.dryRun) return;
    ensureDir(dirname(options.destinationPath));
    writeFileSync(options.sourcePath, options.markdown, "utf8");
    if (existsSync(options.destinationPath)) unlinkSync(options.destinationPath);
    renameSync(options.sourcePath, options.destinationPath);
  }

  function reconcileFolders(options: {
    itemsDir: string;
    closedDir: string;
    plansDir?: string;
    decisionPacketsDir?: string;
    canonicalBaselineDir?: string;
    repositorySlug?: string;
    maxPages?: number;
    dryRun?: boolean;
    fetchClosedAt?: boolean;
    preserveItemNumbers?: readonly number[];
    onlyItemNumbers?: boolean;
  }): ReconcileResult {
    const maxPages = options.maxPages ?? 250;
    const dryRun = options.dryRun ?? false;
    const fetchClosedAt = options.fetchClosedAt ?? true;
    const plansDir = options.plansDir ?? defaultPlansDir();
    if (options.canonicalBaselineDir && !options.repositorySlug) {
      throw new Error("canonical reconciliation baseline requires a repository slug");
    }
    const capturedBaselines = new Set<number>();
    const captureCanonicalBaseline = (number: number, file: string): void => {
      if (
        dryRun ||
        !options.canonicalBaselineDir ||
        !options.repositorySlug ||
        capturedBaselines.has(number)
      ) {
        return;
      }
      const packetName = `${number}.json`;
      captureCanonicalRecordBaseline({
        baselineRoot: options.canonicalBaselineDir,
        repositorySlug: options.repositorySlug,
        itemNumber: number,
        sources: [
          { section: "items" as const, name: file, path: join(options.itemsDir, file) },
          { section: "closed" as const, name: file, path: join(options.closedDir, file) },
          { section: "plans" as const, name: file, path: join(plansDir, file) },
          ...(options.decisionPacketsDir
            ? [
                {
                  section: "decision-packets" as const,
                  name: packetName,
                  path: join(options.decisionPacketsDir, packetName),
                },
              ]
            : []),
        ],
      });
      capturedBaselines.add(number);
    };
    const syncReconciledDecisionPacket = (
      markdown: string,
      reportPath: string,
      subjectState: DecisionPacketSubjectState,
    ): string => {
      if (dryRun || !options.decisionPacketsDir) return markdown;
      return syncDecisionPacketRecord({
        markdown,
        reportPath,
        packetsDir: options.decisionPacketsDir,
        repoRoot: ROOT,
        subjectState,
      }).markdown;
    };
    ensureDir(options.itemsDir);
    ensureDir(options.closedDir);
    const scopedItemNumbers = options.onlyItemNumbers
      ? new Set(options.preserveItemNumbers ?? [])
      : null;
    if (scopedItemNumbers?.size === 0) {
      throw new Error("scoped reconciliation requires at least one item number");
    }
    const { numbers: openNumbers, pagesScanned } = scopedItemNumbers
      ? { numbers: new Set<number>(), pagesScanned: 0 }
      : fetchOpenItemNumbers(maxPages);
    for (const number of options.preserveItemNumbers ?? []) {
      try {
        const { state } = fetchItem(number);
        if (state === "open") openNumbers.add(number);
      } catch (error) {
        if (!scopedItemNumbers || !isGitHubNotFoundError(error)) throw error;
        ghJson<unknown>(["api", `repos/${targetRepo()}`]);
      }
    }
    let movedToClosed = 0;
    let movedToItems = 0;
    let removedStaleClosedCopies = 0;
    let fetchedClosedAt = 0;
    const changedItemNumbers = new Set<number>();
    const changedRecordFiles = new Set<string>();
    const markRecordChanged = (number: number, file: string): void => {
      changedItemNumbers.add(number);
      changedRecordFiles.add(file);
    };

    const cleanAlreadyClosedSidecars = (
      number: number,
      file: string,
      reportPath: string,
      markdown: string,
    ): void => {
      const planPath = workPlanPathForReport(reportPath, plansDir);
      let changed = existsSync(planPath);
      let nextMarkdown = markdown;

      const packetPath = options.decisionPacketsDir
        ? join(options.decisionPacketsDir, `${number}.json`)
        : undefined;
      const packetReference = frontMatterValue(markdown, "decision_packet_path");
      const packetSha = frontMatterValue(markdown, "decision_packet_sha256");
      const hasPacketReference = (value: string | undefined): boolean =>
        Boolean(value && value !== "none" && value !== "unknown");
      const shouldSyncPacket = Boolean(
        packetPath &&
        (existsSync(packetPath) ||
          hasPacketReference(packetReference) ||
          hasPacketReference(packetSha)),
      );
      if (changed || shouldSyncPacket) captureCanonicalBaseline(number, file);
      if (!dryRun && existsSync(planPath)) unlinkSync(planPath);
      if (shouldSyncPacket && packetPath) {
        if (dryRun) {
          changed = true;
        } else {
          const packetBefore = existsSync(packetPath) ? readFileSync(packetPath, "utf8") : null;
          nextMarkdown = syncReconciledDecisionPacket(markdown, reportPath, "closed");
          const packetAfter = existsSync(packetPath) ? readFileSync(packetPath, "utf8") : null;
          changed ||= nextMarkdown !== markdown || packetAfter !== packetBefore;
        }
      }

      if (changed) {
        if (!dryRun) {
          // Sidecar cleanup is an atomic tuple mutation. Stamp the primary so
          // tuple publication can order this deterministic repair against the
          // hydrated state instead of rejecting equal version vectors.
          writeFileSync(reportPath, markReconciledState(nextMarkdown, "closed"), "utf8");
        }
        markRecordChanged(number, file);
      }
    };

    for (const file of markdownFiles(options.itemsDir)) {
      const number = numberForMarkdownFile(file);
      if (scopedItemNumbers && !scopedItemNumbers.has(number)) continue;
      const sourcePath = join(options.itemsDir, file);
      const sourceMarkdown = readFileSync(sourcePath, "utf8");
      if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
      if (openNumbers.has(number)) continue;
      const destinationPath = join(options.closedDir, file);
      let closedAt: string | null | undefined;
      if (fetchClosedAt) {
        try {
          const fetched = fetchItem(number);
          if (fetched.state !== "open") closedAt = fetched.item.closedAt;
          fetchedClosedAt += 1;
        } catch (error) {
          console.error(
            `[reconcile] failed to fetch closed_at for #${number}; using reconciled_at fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      captureCanonicalBaseline(number, file);
      const markdown = syncReconciledDecisionPacket(
        markReconciledState(sourceMarkdown, "closed", { closedAt }),
        destinationPath,
        "closed",
      );
      moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
      if (!dryRun) {
        const planPath = workPlanPathForReport(sourcePath, plansDir);
        if (existsSync(planPath)) unlinkSync(planPath);
      }
      markRecordChanged(number, file);
      movedToClosed += 1;
    }

    for (const file of markdownFiles(options.closedDir)) {
      const number = numberForMarkdownFile(file);
      if (scopedItemNumbers && !scopedItemNumbers.has(number)) continue;
      const sourcePath = join(options.closedDir, file);
      const sourceMarkdown = readFileSync(sourcePath, "utf8");
      if (!isMarkdownForActiveRepo(sourceMarkdown, file)) continue;
      if (!openNumbers.has(number)) {
        cleanAlreadyClosedSidecars(number, file, sourcePath, sourceMarkdown);
        continue;
      }
      captureCanonicalBaseline(number, file);
      const destinationPath = join(options.itemsDir, file);
      if (existsSync(destinationPath)) {
        if (!dryRun) {
          const destinationMarkdown = readFileSync(destinationPath, "utf8");
          const syncedDestinationMarkdown = syncReconciledDecisionPacket(
            destinationMarkdown,
            destinationPath,
            "open",
          );
          if (syncedDestinationMarkdown !== destinationMarkdown) {
            writeFileSync(destinationPath, syncedDestinationMarkdown, "utf8");
          }
          unlinkSync(sourcePath);
        }
        markRecordChanged(number, file);
        removedStaleClosedCopies += 1;
        continue;
      }
      const markdown = syncReconciledDecisionPacket(
        markReconciledState(sourceMarkdown, "open"),
        destinationPath,
        "open",
      );
      moveMarkdownFile({ sourcePath, destinationPath, markdown, dryRun });
      syncWorkPlanFromReport({ markdown, reportPath: destinationPath, plansDir, dryRun });
      markRecordChanged(number, file);
      movedToItems += 1;
    }

    return {
      openItemsSeen: openNumbers.size,
      pagesScanned,
      movedToClosed,
      movedToItems,
      removedStaleClosedCopies,
      fetchedClosedAt,
      changedItemNumbers: [...changedItemNumbers].sort((left, right) => left - right),
      changedRecordFiles: [...changedRecordFiles].sort(),
    };
  }

  function reconcileCommand(args: Args): void {
    const profile = repoFromArgs(args);
    const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
    const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
    const plansDir = resolve(stringArg(args.plans_dir, defaultPlansDir()));
    const decisionPacketsDir = decisionPacketsDirFromArgs(args, itemsDir, closedDir);
    const maxPages = numberArg(args.max_pages, 250);
    const dryRun = boolArg(args.dry_run);
    const fetchClosedAt = !boolArg(args.skip_closed_at);
    const preserveItemNumbers = itemNumbersArg(args.item_numbers, args.item_number);
    const canonicalBaselineDir = stringArg(args.canonical_record_baseline_dir, "").trim();
    const result = reconcileFolders({
      itemsDir,
      closedDir,
      plansDir,
      decisionPacketsDir,
      ...(canonicalBaselineDir
        ? { canonicalBaselineDir: resolve(canonicalBaselineDir), repositorySlug: profile.slug }
        : {}),
      maxPages,
      dryRun,
      fetchClosedAt,
      preserveItemNumbers,
      onlyItemNumbers: boolArg(args.only_item_numbers),
    });
    console.log(JSON.stringify(result, null, 2));
  }

  function auditCommand(args: Args): void {
    repoFromArgs(args);
    const itemsDir = resolve(stringArg(args.items_dir, defaultItemsDir()));
    const closedDir = resolve(stringArg(args.closed_dir, defaultClosedDir()));
    const maxPages = numberArg(args.max_pages, 250);
    const sampleLimit = numberArg(args.sample_limit, 25);
    const output = typeof args.output === "string" ? resolve(args.output) : undefined;
    const strict = boolArg(args.strict);
    const updateDashboard = boolArg(args.update_dashboard);
    const openItems = fetchOpenItems(maxPages);
    const result = auditFromSnapshot({
      openItems: openItems.items,
      itemRecords: auditRecords("items", itemsDir),
      closedRecords: auditRecords("closed", closedDir),
      scanComplete: openItems.complete,
      pagesScanned: openItems.pagesScanned,
    });
    if (output) {
      ensureDir(dirname(output));
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    if (updateDashboard) updateAuditHealthDashboard(result);
    console.log(JSON.stringify(limitAuditFindings(result, sampleLimit), null, 2));
    if (strict && auditHasStrictFailures(result)) process.exit(1);
  }

  function cadenceBucketForReview(
    markdown: string,
    now: number,
  ): {
    bucket: "hourlyHotItems" | "dailyPullRequests" | "dailyNewIssues" | "weeklyOlderIssues";
    cadenceMs: number;
  } {
    const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
    const createdAt = Date.parse(frontMatterValue(markdown, "item_created_at") ?? "");
    if (Number.isFinite(createdAt) && now - createdAt < HOT_REVIEW_DAYS * DAY_MS) {
      return { bucket: "hourlyHotItems", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
    }
    if (kind === "pull_request") {
      return { bucket: "dailyPullRequests", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
    }

    if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
      return { bucket: "dailyNewIssues", cadenceMs: DAILY_REVIEW_DAYS * DAY_MS };
    }

    return {
      bucket: "weeklyOlderIssues",
      cadenceMs: WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS,
    };
  }

  function dashboardStats(
    itemsDir: string,
    closedDir = defaultClosedDir(),
    profile = targetProfile(),
  ): DashboardStats {
    const entries = reportEntriesForDir(itemsDir).filter(
      (entry) => entry.repo === profile.targetRepo,
    );
    const closedEntries = reportEntriesForDir(closedDir).filter(
      (entry) => entry.repo === profile.targetRepo,
    );
    const plansDir = defaultPlansDir(profile);
    const now = Date.now();
    let fresh = 0;
    let proposedClose = 0;
    let closed = 0;
    let failed = 0;
    let stale = 0;
    let workCandidates = 0;
    const byKind: Record<ItemKind, DashboardKindStats> = {
      issue: emptyDashboardKindStats(),
      pull_request: emptyDashboardKindStats(),
    };
    const hourlyHotItems = emptyDashboardCadenceBucket();
    const dailyPullRequests = emptyDashboardCadenceBucket();
    const dailyNewIssues = emptyDashboardCadenceBucket();
    const weeklyOlderIssues = emptyDashboardCadenceBucket();
    const activity = emptyDashboardActivityStats();
    const recent: DashboardItem[] = [];
    const workQueue: DashboardItem[] = [];
    const recentClosed: DashboardClosedItem[] = [];
    const failedReviewRetryStateDir = defaultFailedReviewRetryStateDir(profile);
    for (const entry of entries) {
      const markdown = dashboardMarkdownWithFailedReviewRetryState(
        entry.markdown,
        entry.number,
        failedReviewRetryStateDir,
      );
      const repo = entry.repo;
      const number = entry.number;
      const reviewedAt = frontMatterValue(markdown, "reviewed_at");
      const reviewStatus = effectiveReviewStatus(markdown);
      const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const decision = frontMatterValue(markdown, "decision") ?? "unknown";
      const workCandidate = frontMatterValue(markdown, "work_candidate") ?? "none";
      const workPriority = frontMatterValue(markdown, "work_priority") ?? "low";
      const workStatus = frontMatterValue(markdown, "work_status") ?? "none";
      const kind = (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue";
      const freshReview = isFresh({ reviewedAt, reviewStatus });
      byKind[kind].total += 1;
      if (freshReview) fresh += 1;
      if (freshReview) byKind[kind].fresh += 1;
      if (freshReview && decision === "close" && action === "proposed_close") proposedClose += 1;
      if (freshReview && decision === "close" && action === "proposed_close")
        byKind[kind].proposedClose += 1;
      if (action === "closed") closed += 1;
      if (reviewStatus === "failed") failed += 1;
      if (reviewStatus.startsWith("stale_")) stale += 1;
      if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
        workCandidates += 1;
      }
      recordDashboardActivity(markdown, activity, now);
      const cadence = cadenceBucketForReview(markdown, now);
      const cadenceBucket =
        cadence.bucket === "hourlyHotItems"
          ? hourlyHotItems
          : cadence.bucket === "dailyPullRequests"
            ? dailyPullRequests
            : cadence.bucket === "dailyNewIssues"
              ? dailyNewIssues
              : weeklyOlderIssues;
      cadenceBucket.total += 1;
      if (isCurrentForCadence({ reviewedAt, reviewStatus, cadenceMs: cadence.cadenceMs, now })) {
        cadenceBucket.current += 1;
      }
      if (decision === "close" && action === "proposed_close") cadenceBucket.proposedClose += 1;
      const dashboardItem = {
        repo,
        number,
        kind,
        title: frontMatterValue(markdown, "title") ?? "",
        reviewedAt,
        decision,
        action,
        reviewStatus,
        reportPath: repoRelativePath(entry.path),
        planPath: existsSync(join(plansDir, entry.name))
          ? repoRelativePath(join(plansDir, entry.name))
          : undefined,
        workCandidate,
        workPriority,
        workStatus,
      };
      recent.push(dashboardItem);
      if (freshReview && workCandidate === "queue_fix_pr" && workStatus === "candidate") {
        workQueue.push(dashboardItem);
      }
    }
    for (const entry of closedEntries) {
      const markdown = dashboardMarkdownWithFailedReviewRetryState(
        entry.markdown,
        entry.number,
        failedReviewRetryStateDir,
      );
      const repo = entry.repo;
      const action = frontMatterValue(markdown, "action_taken") ?? "unknown";
      const closedAt = dashboardClosedAt(markdown);
      if (action === "closed") {
        closed += 1;
      }
      if (closedAt) {
        recentClosed.push({
          repo,
          number: entry.number,
          kind: (frontMatterValue(markdown, "type") as ItemKind | undefined) ?? "issue",
          title: frontMatterValue(markdown, "title") ?? "",
          closedAt,
          appliedAt: frontMatterValue(markdown, "applied_at"),
          closeReason: dashboardCloseReason(markdown),
          reportPath: repoRelativePath(entry.path),
        });
      }
      recordDashboardActivity(markdown, activity, now);
    }
    recent.sort((a, b) => Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""));
    workQueue.sort(
      (a, b) =>
        workPriorityScore(b.workPriority) - workPriorityScore(a.workPriority) ||
        Date.parse(b.reviewedAt ?? "") - Date.parse(a.reviewedAt ?? ""),
    );
    recentClosed.sort(
      (a, b) =>
        (timestampMs(b.closedAt ?? b.appliedAt) ?? Number.NEGATIVE_INFINITY) -
          (timestampMs(a.closedAt ?? a.appliedAt) ?? Number.NEGATIVE_INFINITY) ||
        b.number - a.number,
    );
    const open = fetchDashboardOpenItemCounts(profile, {
      issues: byKind.issue.total,
      pullRequests: byKind.pull_request.total,
      total: byKind.issue.total + byKind.pull_request.total,
    });
    const hourly = emptyDashboardCadenceBucket();
    const daily = emptyDashboardCadenceBucket();
    addDashboardCadenceBucket(daily, hourlyHotItems);
    const cappedDailyPullRequests = capDashboardCadenceBucket(dailyPullRequests, open.pullRequests);
    addDashboardCadenceBucket(daily, cappedDailyPullRequests);
    addDashboardCadenceBucket(daily, dailyNewIssues);
    const weekly = emptyDashboardCadenceBucket();
    addDashboardCadenceBucket(weekly, weeklyOlderIssues);
    const unreviewedOpen =
      Math.max(0, open.issues - byKind.issue.total) +
      Math.max(0, open.pullRequests - byKind.pull_request.total);
    const cadenceDue =
      hourly.total -
      hourly.current +
      (daily.total - daily.current) +
      (weekly.total - weekly.current) +
      unreviewedOpen;
    return {
      open,
      fresh,
      todo: cadenceDue,
      files: entries.length,
      proposedClose,
      closed,
      archivedFiles: closedEntries.length,
      failed,
      stale,
      workCandidates,
      byKind,
      cadence: {
        hourlyHotItems,
        dailyPullRequests: cappedDailyPullRequests,
        dailyNewIssues,
        weeklyOlderIssues,
        hourly,
        daily,
        weekly,
        unreviewedOpen,
        due: cadenceDue,
      },
      activity,
      recent,
      workQueue,
      recentClosed,
    };
  }

  const dashboardPresentation = createDashboardPresentation({
    closeReasonText,
    displayTitle,
    emptyDashboardActivityStats,
    formatActivityRow,
    formatCadenceBucket,
    formatOperationActivityRow,
    formatPercent,
    formatStatusNumber,
    formatTimestamp,
    frontMatterValue,
    itemUrlFor,
    latestTimestamp,
    markdownLink,
    repoUrlFor,
    reportFileUrl,
    targetRepo,
    timestampMs,
  });

  const { dashboardClosedAt, formatRecentClosedRows } = dashboardPresentation;

  const {
    dashboardCloseReason,
    jsonFrontMatterValue,
    renderDashboard,
    workPriorityScore,
    workStatusForDecision,
  } = dashboardPresentation;

  function fetchDashboardOpenItemCounts(
    profile: RepositoryProfile,
    fallback: OpenItemCounts,
  ): OpenItemCounts {
    try {
      return withTargetProfile(profile, () => fetchOpenItemCounts());
    } catch (error) {
      console.error(
        `[dashboard] failed to fetch open item counts for ${profile.targetRepo}; using local record counts: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  function buildRepoDashboardSnapshot(
    profile: RepositoryProfile,
    readme: string,
    options: { itemsDir?: string; closedDir?: string } = {},
  ): RepoDashboardSnapshot {
    const stats = withTargetProfile(profile, () =>
      dashboardStats(
        options.itemsDir ?? defaultItemsDir(profile),
        options.closedDir ?? defaultClosedDir(profile),
        profile,
      ),
    );
    const status = currentWorkflowStatusBlock(readme, profile);
    return {
      profile,
      stats,
      status,
      statusSummary: workflowStatusSummary(status),
      auditHealth: currentAuditHealthSection(readme, profile),
    };
  }

  function dashboardSnapshots(
    readme: string,
    itemsDir: string,
    closedDir: string,
  ): RepoDashboardSnapshot[] {
    const scopedDirs = itemsDir !== defaultItemsDir() || closedDir !== defaultClosedDir();
    if (scopedDirs) {
      return [buildRepoDashboardSnapshot(targetProfile(), readme, { itemsDir, closedDir })];
    }
    return REPOSITORY_PROFILES.map((profile) => buildRepoDashboardSnapshot(profile, readme));
  }

  function updateDashboard(itemsDir = defaultItemsDir(), closedDir = defaultClosedDir()): void {
    const readmePath = join(ROOT, "README.md");
    const readme = readFileSync(readmePath, "utf8");
    const dashboard = renderDashboard(dashboardSnapshots(readme, itemsDir, closedDir));
    const updated = readme.replace(
      /## Dashboard[\s\S]*?## How It Works/,
      `${dashboard}\n\n## How It Works`,
    );
    writeFileSync(readmePath, updated, "utf8");
  }

  function statusCommand(args: Args): void {
    const profile = repoFromArgs(args);
    const state = stringArg(args.state, "Working");
    const detail = stringArg(args.detail, "Workflow is running.");
    const runUrl = stringArg(args.run_url, "");
    const plannedCount = optionalNumberArg(args.planned_count);
    const plannedCapacity = optionalNumberArg(args.planned_capacity);
    const plannedShards = optionalNumberArg(args.planned_shards);
    const activeCodex = optionalNumberArg(args.active_codex);
    const dueBacklog = optionalNumberArg(args.due_backlog);
    const oldestUnreviewedAt = stringArg(args.oldest_unreviewed_at, "");
    const capacityReason = stringArg(args.capacity_reason, "");
    const inheritedLabelCleanups = optionalNumberArg(args.inherited_label_cleanups);
    const selfHealConflictRepairs = optionalNumberArg(args.self_heal_conflict_repairs);
    const failedReviewRetries = optionalNumberArg(args.failed_review_retries);
    const failedReviewRetryExhaustions = optionalNumberArg(args.failed_review_retry_exhaustions);
    const botOwnedProofDecisionsRequested = optionalNumberArg(
      args.bot_owned_proof_decisions_requested,
    );
    const botOwnedProofDispatches = optionalNumberArg(args.bot_owned_proof_dispatches);
    const applyHealthArg = applyHealthStatusArg(args);
    const applyHealth =
      applyHealthArg === undefined && state.startsWith("Apply ") ? null : applyHealthArg;
    const statusOptions: Parameters<typeof writeSweepStatus>[0] = {
      state,
      detail,
      profile,
    };
    if (runUrl) statusOptions.runUrl = runUrl;
    if (plannedCount !== undefined) statusOptions.plannedCount = plannedCount;
    if (plannedCapacity !== undefined) statusOptions.plannedCapacity = plannedCapacity;
    if (plannedShards !== undefined) statusOptions.plannedShards = plannedShards;
    if (activeCodex !== undefined) statusOptions.activeCodex = activeCodex;
    if (dueBacklog !== undefined) statusOptions.dueBacklog = dueBacklog;
    if (oldestUnreviewedAt) statusOptions.oldestUnreviewedAt = oldestUnreviewedAt;
    if (capacityReason) statusOptions.capacityReason = capacityReason;
    if (inheritedLabelCleanups !== undefined)
      statusOptions.inheritedLabelCleanups = inheritedLabelCleanups;
    if (selfHealConflictRepairs !== undefined)
      statusOptions.selfHealConflictRepairs = selfHealConflictRepairs;
    if (failedReviewRetries !== undefined) statusOptions.failedReviewRetries = failedReviewRetries;
    if (failedReviewRetryExhaustions !== undefined)
      statusOptions.failedReviewRetryExhaustions = failedReviewRetryExhaustions;
    if (botOwnedProofDecisionsRequested !== undefined)
      statusOptions.botOwnedProofDecisionsRequested = botOwnedProofDecisionsRequested;
    if (botOwnedProofDispatches !== undefined)
      statusOptions.botOwnedProofDispatches = botOwnedProofDispatches;
    if (applyHealth !== undefined) statusOptions.applyHealth = applyHealth;
    writeSweepStatus(statusOptions);
    console.log(JSON.stringify({ status_path: sweepStatusRelativePath(profile), state, detail }));
  }

  return {
    auditCommand,
    auditFromSnapshot,
    auditHasStrictFailures,
    auditHealthSection,
    dashboardClosedAt,
    formatRecentClosedRows,
    jsonFrontMatterValue,
    reconcileCommand,
    reconcileFolders,
    statusCommand,
    updateDashboard,
    workStatusForDecision,
  };
}
