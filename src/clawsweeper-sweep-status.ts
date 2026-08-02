import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowStatusSummary } from "./clawsweeper-types.js";
import { type RepositoryProfile } from "./repository-profiles.js";

interface CreateSweepStatusDependencies {
  ensureDir: (path: string) => void;
  readSweepStatusSummary: (profile?: RepositoryProfile) => WorkflowStatusSummary | null;
  ROOT: string;
  targetProfile: () => RepositoryProfile;
}

export function createSweepStatus(dependencies: CreateSweepStatusDependencies) {
  const { ensureDir, readSweepStatusSummary, ROOT, targetProfile } = dependencies;

  function profileStatusStart(profile = targetProfile()): string {
    return `<!-- clawsweeper-status:${profile.slug}:start -->`;
  }

  function profileStatusEnd(profile = targetProfile()): string {
    return `<!-- clawsweeper-status:${profile.slug}:end -->`;
  }

  function profileAuditStart(profile = targetProfile()): string {
    return `<!-- clawsweeper-audit:${profile.slug}:start -->`;
  }

  function profileAuditEnd(profile = targetProfile()): string {
    return `<!-- clawsweeper-audit:${profile.slug}:end -->`;
  }

  function sweepStatusPath(profile = targetProfile()): string {
    return join(ROOT, "results", "sweep-status", `${profile.slug}.json`);
  }

  function sweepStatusRelativePath(profile = targetProfile()): string {
    return join("results", "sweep-status", `${profile.slug}.json`);
  }

  function auditStatePath(profile = targetProfile()): string {
    return join(ROOT, "results", "audit", `${profile.slug}.json`);
  }

  function sweepStatusApplyHealth(options: {
    previousApplyHealth?: Record<string, unknown> | undefined;
    requestedApplyHealth?: Record<string, unknown> | null | undefined;
    runUrl?: string | undefined;
  }): Record<string, unknown> | null | undefined {
    const applyHealth =
      options.requestedApplyHealth === undefined
        ? options.previousApplyHealth
        : options.requestedApplyHealth;
    return options.requestedApplyHealth !== undefined && applyHealth && options.runUrl
      ? { ...applyHealth, run_url: options.runUrl }
      : applyHealth;
  }

  function sweepStatusApplyHealthForTest(options: {
    previousApplyHealth?: Record<string, unknown> | undefined;
    requestedApplyHealth?: Record<string, unknown> | null | undefined;
    runUrl?: string | undefined;
  }): Record<string, unknown> | null | undefined {
    return sweepStatusApplyHealth(options);
  }

  function writeSweepStatus(options: {
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
  }): void {
    const profile = options.profile ?? targetProfile();
    const updatedAt = new Date().toISOString();
    const previousStatus = readSweepStatusSummary(profile);
    const applyHealth = sweepStatusApplyHealth({
      previousApplyHealth: previousStatus?.applyHealth,
      requestedApplyHealth: options.applyHealth,
      runUrl: options.runUrl,
    });
    const previousCloseApplyHealth =
      previousStatus?.lastCloseApplyHealth ??
      (previousStatus?.applyHealth?.mode === "close" ? previousStatus.applyHealth : undefined);
    const lastCloseApplyHealth =
      applyHealth && applyHealth.mode === "close" ? applyHealth : previousCloseApplyHealth;
    const payload = {
      schema_version: 1,
      slug: profile.slug,
      display_name: profile.displayName,
      target_repo: profile.targetRepo,
      state: options.state,
      detail: options.detail,
      run_url: options.runUrl ?? null,
      planned_count: options.plannedCount ?? null,
      planned_capacity: options.plannedCapacity ?? null,
      planned_shards: options.plannedShards ?? null,
      active_codex: options.activeCodex ?? null,
      due_backlog: options.dueBacklog ?? null,
      oldest_unreviewed_at: options.oldestUnreviewedAt ?? null,
      capacity_reason: options.capacityReason ?? null,
      inherited_label_cleanups: options.inheritedLabelCleanups ?? null,
      self_heal_conflict_repairs: options.selfHealConflictRepairs ?? null,
      failed_review_retries: options.failedReviewRetries ?? null,
      failed_review_retry_exhaustions: options.failedReviewRetryExhaustions ?? null,
      bot_owned_proof_decisions_requested: options.botOwnedProofDecisionsRequested ?? null,
      bot_owned_proof_dispatches: options.botOwnedProofDispatches ?? null,
      apply_health: applyHealth ?? null,
      last_close_apply_health: lastCloseApplyHealth ?? null,
      updated_at: updatedAt,
    };
    const outputPath = sweepStatusPath(profile);
    ensureDir(dirname(outputPath));
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return {
    auditStatePath,
    profileAuditEnd,
    profileAuditStart,
    profileStatusEnd,
    profileStatusStart,
    sweepStatusApplyHealthForTest,
    sweepStatusPath,
    sweepStatusRelativePath,
    writeSweepStatus,
  };
}
