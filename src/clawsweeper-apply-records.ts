import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type { ApplyKind, ReportEntry } from "./clawsweeper-types.js";
import { syncDecisionPacketRecord, type DecisionPacketSubjectState } from "./decision-packets.js";
import { captureCanonicalRecordBaseline } from "./repair/canonical-record-baseline.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { applyQueueSortFields } from "./clawsweeper-record-metadata.js";
import { numberForMarkdownFile } from "./clawsweeper-repository-paths.js";
import { ReviewRecordFormatError } from "./review-record.js";

type ApplyRecordDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  "reportEntriesForDir" | "targetRepo"
> & {
  applyKind: ApplyKind;
  canonicalBaselineDir: string;
  closedDir: string;
  decisionPacketsDir: string;
  dryRun: boolean;
  itemsDir: string;
  plansDir: string;
  profile: RepositoryProfile;
  recordRoot: string;
  requestedItemNumberSet: ReadonlySet<number>;
  syncCommentsOnly: boolean;
};

export function createApplyRecordOperations({
  applyKind,
  canonicalBaselineDir,
  closedDir,
  decisionPacketsDir,
  dryRun,
  itemsDir,
  plansDir,
  profile,
  recordRoot,
  reportEntriesForDir,
  requestedItemNumberSet,
  syncCommentsOnly,
  targetRepo,
}: ApplyRecordDependencies) {
  const applyReportEntriesForDir = (
    dir: string,
    location: "items" | "closed",
  ): Array<
    ReportEntry & {
      location: "items" | "closed";
      priority: number;
      applyCheckedAt: number;
    }
  > =>
    reportEntriesForDir(dir, requestedItemNumberSet.size > 0 ? requestedItemNumberSet : undefined)
      .filter(
        (entry) =>
          entry.repo === targetRepo() &&
          (requestedItemNumberSet.size === 0 || requestedItemNumberSet.has(entry.number)),
      )
      .map((entry) => {
        let sortFields;
        try {
          sortFields = applyQueueSortFields(entry.markdown, syncCommentsOnly, applyKind);
        } catch (error) {
          if (!(error instanceof ReviewRecordFormatError)) throw error;
          // Keep unreadable records in the queue for the per-item fresh-review skip.
          // Only host scheduling metadata is safe to read; never rank their decision.
          sortFields = {
            ...applyQueueSortFields(entry.markdown, true, applyKind),
            priority: syncCommentsOnly ? 0 : 2,
          };
        }
        return { ...entry, location, ...sortFields };
      });

  const createOpenReportLookup = (entries: readonly ReportEntry[], selectedOnly: boolean) => {
    const byNumber = new Map<number, ReportEntry | undefined>(
      entries.map((entry) => [entry.number, entry]),
    );
    return (number: number): ReportEntry | undefined => {
      if (!byNumber.has(number) && !selectedOnly) {
        // Paired-close guards need independent evidence, not the entire open corpus.
        byNumber.set(
          number,
          reportEntriesForDir(itemsDir, new Set([number])).find(
            (entry) => entry.repo === targetRepo(),
          ),
        );
      }
      return byNumber.get(number);
    };
  };

  const captureApplyCanonicalBaseline = (reportPath: string): void => {
    if (dryRun || !canonicalBaselineDir) return;
    const file = basename(reportPath);
    const number = numberForMarkdownFile(file);
    const packetName = `${number}.json`;
    captureCanonicalRecordBaseline({
      baselineRoot: canonicalBaselineDir,
      repositorySlug: profile.slug,
      itemNumber: number,
      sources: [
        { section: "items", name: file, path: join(itemsDir, file) },
        { section: "closed", name: file, path: join(closedDir, file) },
        { section: "plans", name: file, path: join(plansDir, file) },
        {
          section: "decision-packets",
          name: packetName,
          path: join(decisionPacketsDir, packetName),
        },
      ],
    });
  };

  const syncDecisionPacketMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): string =>
    syncDecisionPacketRecord({
      markdown: nextMarkdown,
      reportPath,
      packetsDir: decisionPacketsDir,
      repoRoot: recordRoot,
      subjectState,
    }).markdown;

  const writeReportMarkdown = (
    reportPath: string,
    nextMarkdown: string,
    subjectState: DecisionPacketSubjectState = "open",
  ): void => {
    captureApplyCanonicalBaseline(reportPath);
    writeFileSync(
      reportPath,
      syncDecisionPacketMarkdown(reportPath, nextMarkdown, subjectState),
      "utf8",
    );
  };

  return {
    applyReportEntriesForDir,
    createOpenReportLookup,
    captureApplyCanonicalBaseline,
    syncDecisionPacketMarkdown,
    writeReportMarkdown,
  };
}
