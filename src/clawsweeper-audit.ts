import { RECENT_MISSING_OPEN_MS } from "./clawsweeper-policy.js";
import {
  isAutoCloseAllowed,
  repositoryProfileFor,
  type RepositoryProfile,
} from "./repository-profiles.js";
import type {
  AuditFinding,
  AuditRecord,
  AuditResult,
  CloseReason,
  Item,
  ItemKind,
  MissingOpenReason,
} from "./clawsweeper-types.js";

interface AuditDependencies {
  applyBlockingProtectedLabels: (labels: readonly string[], closeReason: unknown) => string[];
  displayTitle: (title: string) => string;
  formatTimestamp: (iso: string | undefined) => string;
  isMaintainerAuthored: (item: Pick<Item, "authorAssociation">) => boolean;
  isProtectedItem: (item: Pick<Item, "labels">) => boolean;
  itemUrlFor: (repo: string, number: number, kind?: ItemKind) => string;
  markdownLink: (label: string, url: string) => string;
  profileAuditEnd: (profile: RepositoryProfile) => string;
  profileAuditStart: (profile: RepositoryProfile) => string;
  repoUrlFor: (repo: string) => string;
  shouldPlanItem: (item: Pick<Item, "authorAssociation" | "labels">) => boolean;
  targetProfile: () => RepositoryProfile;
  targetRepo: () => string;
}

export function createAuditEngine({
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
}: AuditDependencies) {
  function openItemFinding(item: Item, extra: Partial<AuditFinding> = {}): AuditFinding {
    return {
      number: item.number,
      kind: item.kind,
      title: item.title,
      labels: item.labels,
      authorAssociation: item.authorAssociation,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...extra,
    };
  }

  function isRecentlyCreatedMissingOpen(item: Item, generatedAtMs: number): boolean {
    const createdAt = Date.parse(item.createdAt);
    return Number.isFinite(createdAt) && generatedAtMs - createdAt < RECENT_MISSING_OPEN_MS;
  }

  function missingOpenReason(item: Item, generatedAtMs: number): MissingOpenReason {
    if (!shouldPlanItem(item)) {
      if (isProtectedItem(item)) return "protected_label";
      if (isMaintainerAuthored(item)) return "maintainer_authored";
    }
    if (isRecentlyCreatedMissingOpen(item, generatedAtMs)) return "recently_created";
    return "eligible";
  }

  function recordFinding(record: AuditRecord, extra: Partial<AuditFinding> = {}): AuditFinding {
    return {
      number: record.number,
      ...(record.kind ? { kind: record.kind } : {}),
      title: displayTitle(record.title),
      labels: record.labels,
      ...(record.action ? { action: record.action } : {}),
      ...(record.decision ? { decision: record.decision } : {}),
      ...(record.closeReason ? { closeReason: record.closeReason } : {}),
      ...(record.confidence ? { confidence: record.confidence } : {}),
      ...(record.reviewedAt ? { reviewedAt: record.reviewedAt } : {}),
      reviewStatus: record.reviewStatus,
      ...(record.currentState ? { currentState: record.currentState } : {}),
      ...(record.location === "items" ? { itemPath: record.path } : { closedPath: record.path }),
      ...extra,
    };
  }

  function firstByNumber<T extends { number: number }>(records: T[]): Map<number, T> {
    const map = new Map<number, T>();
    for (const record of records) {
      if (!map.has(record.number)) map.set(record.number, record);
    }
    return map;
  }

  function auditFromSnapshot(options: {
    openItems: Item[];
    itemRecords: AuditRecord[];
    closedRecords: AuditRecord[];
    scanComplete: boolean;
    pagesScanned: number;
    generatedAt?: string;
  }): AuditResult {
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const generatedAtMs = Date.parse(generatedAt);
    const openByNumber = firstByNumber(options.openItems);
    const itemByNumber = firstByNumber(options.itemRecords);
    const closedByNumber = firstByNumber(options.closedRecords);
    const missingOpen: AuditFinding[] = [];
    const missingEligibleOpen: AuditFinding[] = [];
    const missingMaintainerOpen: AuditFinding[] = [];
    const missingProtectedOpen: AuditFinding[] = [];
    const missingRecentOpen: AuditFinding[] = [];
    const openArchived: AuditFinding[] = [];

    for (const item of options.openItems) {
      if (itemByNumber.has(item.number)) continue;
      const closedRecord = closedByNumber.get(item.number);
      if (closedRecord) {
        openArchived.push(openItemFinding(item, { closedPath: closedRecord.path }));
      } else {
        const missingReason = missingOpenReason(item, generatedAtMs);
        const finding = openItemFinding(item, { missingReason });
        missingOpen.push(finding);
        if (missingReason === "maintainer_authored") missingMaintainerOpen.push(finding);
        else if (missingReason === "protected_label") missingProtectedOpen.push(finding);
        else if (missingReason === "recently_created") missingRecentOpen.push(finding);
        else missingEligibleOpen.push(finding);
      }
    }

    const staleItemRecords = options.scanComplete
      ? options.itemRecords
          .filter((record) => !openByNumber.has(record.number))
          .map((record) => recordFinding(record))
      : [];
    const duplicateRecords = options.itemRecords
      .filter((record) => closedByNumber.has(record.number))
      .map((record) => {
        const closedRecord = closedByNumber.get(record.number);
        return recordFinding(record, closedRecord ? { closedPath: closedRecord.path } : {});
      });
    const protectedProposed = options.itemRecords
      .filter(
        (record) =>
          record.action === "proposed_close" &&
          applyBlockingProtectedLabels(record.labels, record.closeReason).length > 0,
      )
      .map((record) => recordFinding(record));
    const autoCloseOpen = options.itemRecords
      .filter((record) => {
        if (
          record.decision !== "close" ||
          record.confidence !== "high" ||
          !record.kind ||
          !record.closeReason ||
          !openByNumber.has(record.number)
        ) {
          return false;
        }
        return isAutoCloseAllowed(
          repositoryProfileFor(record.repo),
          record.kind,
          record.closeReason as CloseReason,
        );
      })
      .map((record) =>
        recordFinding(record, {
          currentState: "open",
          ...(openByNumber.get(record.number)?.updatedAt
            ? { updatedAt: openByNumber.get(record.number)!.updatedAt }
            : {}),
        }),
      );
    const staleReviews = options.itemRecords
      .filter((record) => record.reviewStatus.startsWith("stale_"))
      .map((record) => recordFinding(record));

    return {
      generatedAt,
      targetRepo: targetRepo(),
      scan: {
        complete: options.scanComplete,
        pagesScanned: options.pagesScanned,
        openItemsSeen: options.openItems.length,
      },
      counts: {
        itemRecords: options.itemRecords.length,
        closedRecords: options.closedRecords.length,
        missingOpen: missingOpen.length,
        missingEligibleOpen: missingEligibleOpen.length,
        missingMaintainerOpen: missingMaintainerOpen.length,
        missingProtectedOpen: missingProtectedOpen.length,
        missingRecentOpen: missingRecentOpen.length,
        openArchived: openArchived.length,
        staleItemRecords: staleItemRecords.length,
        duplicateRecords: duplicateRecords.length,
        protectedProposed: protectedProposed.length,
        autoCloseOpen: autoCloseOpen.length,
        staleReviews: staleReviews.length,
      },
      findings: {
        missingOpen,
        missingEligibleOpen,
        missingMaintainerOpen,
        missingProtectedOpen,
        missingRecentOpen,
        openArchived,
        staleItemRecords,
        duplicateRecords,
        protectedProposed,
        autoCloseOpen,
        staleReviews,
      },
    };
  }

  function limitAuditFindings(result: AuditResult, limit: number): AuditResult {
    const boundedLimit = Math.max(0, limit);
    return {
      ...result,
      findings: Object.fromEntries(
        Object.entries(result.findings).map(([key, findings]) => [
          key,
          findings.slice(0, boundedLimit),
        ]),
      ) as AuditResult["findings"],
    };
  }

  function auditHasStrictFailures(result: AuditResult): boolean {
    return (
      !result.scan.complete ||
      result.counts.missingEligibleOpen > 0 ||
      result.counts.openArchived > 0 ||
      result.counts.staleItemRecords > 0 ||
      result.counts.duplicateRecords > 0 ||
      result.counts.protectedProposed > 0
    );
  }

  function auditHealthStatus(result: AuditResult): string {
    return auditHasStrictFailures(result) ? "Action needed" : "Passing";
  }

  function auditFindingCategory(category: keyof AuditResult["findings"]): string {
    switch (category) {
      case "missingEligibleOpen":
        return "Missing eligible open";
      case "openArchived":
        return "Open archived";
      case "staleItemRecords":
        return "Stale item record";
      case "duplicateRecords":
        return "Duplicate record";
      case "protectedProposed":
        return "Protected proposed close";
      case "autoCloseOpen":
        return "Auto-close verdict still open";
      case "staleReviews":
        return "Stale review";
      case "missingOpen":
        return "Missing open";
      case "missingMaintainerOpen":
        return "Missing maintainer open";
      case "missingProtectedOpen":
        return "Missing protected open";
      case "missingRecentOpen":
        return "Missing recent open";
    }
  }

  function auditFindingDetail(finding: AuditFinding): string {
    if (finding.closedPath) return finding.closedPath;
    if (finding.itemPath) return finding.itemPath;
    if (finding.missingReason) return finding.missingReason;
    if (finding.action) return finding.action;
    return "-";
  }

  function auditReviewTargetNumbers(result: AuditResult, limit = 10): number[] {
    const categories: (keyof AuditResult["findings"])[] = [
      "missingEligibleOpen",
      "openArchived",
      "staleReviews",
    ];
    const numbers = new Set<number>();
    for (const category of categories) {
      for (const finding of result.findings[category]) {
        if (category === "staleReviews" && finding.currentState === "closed") continue;
        numbers.add(finding.number);
        if (numbers.size >= limit) return [...numbers];
      }
    }
    return [...numbers];
  }

  function auditReviewTargets(result: AuditResult): string {
    const numbers = auditReviewTargetNumbers(result);
    if (numbers.length === 0) return "Targeted review input: _none_";
    return `Targeted review input: \`${numbers.join(",")}\``;
  }

  function actionableAuditFindings(result: AuditResult, limit = 3): string {
    const categories: (keyof AuditResult["findings"])[] = [
      "missingEligibleOpen",
      "protectedProposed",
      "openArchived",
      "duplicateRecords",
      "staleReviews",
      "staleItemRecords",
    ];
    const rows: string[] = [];
    for (const category of categories) {
      for (const finding of result.findings[category]) {
        rows.push(
          `| ${markdownLink(`#${finding.number}`, itemUrlFor(result.targetRepo, finding.number, finding.kind ?? "issue"))} | ${auditFindingCategory(category)} | ${displayTitle(finding.title ?? "").replaceAll("|", "\\|")} | ${auditFindingDetail(finding).replaceAll("|", "\\|")} |`,
        );
        if (rows.length >= limit) return rows.join("\n");
      }
    }
    return "| _None_ |  |  |  |";
  }

  function auditHealthSection(result: AuditResult | null): string {
    const profile = result ? repositoryProfileFor(result.targetRepo) : targetProfile();
    if (!result) {
      return `### Audit Health

${profileAuditStart(profile)}
No audit has been published yet. Run \`npm run audit -- --update-dashboard\` to refresh audit state.
${profileAuditEnd(profile)}`;
    }
    return `### Audit Health

${profileAuditStart(profile)}
Repository: ${markdownLink(result.targetRepo, repoUrlFor(result.targetRepo))}

Last audit: ${formatTimestamp(result.generatedAt)}

Status: **${auditHealthStatus(result)}**

${auditReviewTargets(result)}

| Metric | Count |
| --- | ---: |
| Scan complete | ${result.scan.complete ? "yes" : "no"} |
| Open items seen | ${result.scan.openItemsSeen} |
| Missing eligible open records | ${result.counts.missingEligibleOpen} |
| Missing maintainer-authored open records | ${result.counts.missingMaintainerOpen} |
| Missing protected open records | ${result.counts.missingProtectedOpen} |
| Missing recently-created open records | ${result.counts.missingRecentOpen} |
| Archived records that are open again | ${result.counts.openArchived} |
| Stale item records | ${result.counts.staleItemRecords} |
| Duplicate records | ${result.counts.duplicateRecords} |
| Protected proposed closes | ${result.counts.protectedProposed} |
| Auto-close verdicts still open | ${result.counts.autoCloseOpen} |
| Stale reviews | ${result.counts.staleReviews} |

| Item | Category | Title | Detail |
| --- | --- | --- | --- |
${actionableAuditFindings(result)}
${profileAuditEnd(profile)}`;
  }

  return { auditFromSnapshot, auditHasStrictFailures, auditHealthSection, limitAuditFindings };
}
