import {
  normalizeStateWriterOperation,
  type StateWriterOperation,
  type StateWriterOutcome,
  type StateWriterPhase,
  type StateWriterProgress,
  STATE_WRITER_MAX_COUNT,
  STATE_WRITER_MAX_DURATION_MS,
  STATE_WRITER_SCHEMA_VERSION,
} from "../state-writer-telemetry.js";

export type StateWriterTelemetryObserver = {
  progress?: (progress: StateWriterProgress) => void;
};

export type StateWriterTelemetryRecorderOptions = {
  mode?: "single_item" | "batch";
  operationId?: string;
  runId?: string;
  runAttempt?: string | number;
  configuredBatchSize?: number;
  actualBatchSize?: number;
  batchWaitMs?: number | null;
  observer?: StateWriterTelemetryObserver;
  now?: () => number;
};

const PROGRESS_REFRESH_MS = 30_000;

export class StateWriterTelemetryRecorder {
  private readonly options: StateWriterTelemetryRecorderOptions;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly operationId: string;
  private readonly mode: "single_item" | "batch";
  private readonly configuredBatchSize: number;
  private actualBatchSize: number;
  private readonly batchWaitMs: number | null;
  private waitStartedAtMs: number | null = null;
  private holdStartedAtMs: number | null = null;
  private acquired = false;
  private acquireAttempts = 0;
  private waitMs = 0;
  private holdMs: number | null = null;
  private renewals = 0;
  private released: boolean | null = null;
  private gitProcesses = 0;
  private commitCount: 0 | 1 = 0;
  private materializedItems = 0;
  private outcome: StateWriterOutcome | null = null;
  private sequence = 0;
  private lastProgressPhase: StateWriterPhase | null = null;
  private lastProgressAtMs = 0;
  private terminal: StateWriterOperation | null = null;

  constructor(options: StateWriterTelemetryRecorderOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.mode = options.mode ?? "single_item";
    this.configuredBatchSize = options.configuredBatchSize ?? 1;
    this.actualBatchSize = options.actualBatchSize ?? (this.mode === "single_item" ? 1 : 0);
    this.batchWaitMs = options.batchWaitMs ?? (this.mode === "single_item" ? null : 0);
    this.operationId =
      options.operationId ??
      (options.runId && options.runAttempt
        ? `single:${options.runId}:${options.runAttempt}`
        : `single:local:${this.startedAtMs}`);
  }

  enteredWaiting() {
    if (this.waitStartedAtMs !== null || this.terminal) return;
    this.waitStartedAtMs = this.now();
    this.emit("waiting");
  }

  recordAcquireAttempt() {
    if (this.terminal) return;
    this.acquireAttempts += 1;
    if (!this.acquired) this.refreshProgress("waiting");
  }

  acquiredLease() {
    if (this.acquired || this.terminal) return;
    const now = this.now();
    this.acquired = true;
    this.waitMs = Math.max(0, now - (this.waitStartedAtMs ?? now));
    this.holdStartedAtMs = now;
    this.emit("holding");
  }

  recordRenewal() {
    if (this.acquired && !this.terminal) {
      this.renewals += 1;
      this.refreshProgress("holding");
    }
  }

  recordGitProcess() {
    if (this.terminal) return;
    this.gitProcesses += 1;
    if (this.acquired) this.refreshProgress("holding");
  }

  recordMaterializedCommit(itemCount: number) {
    if (!this.acquired || this.terminal || !Number.isSafeInteger(itemCount) || itemCount < 1)
      return;
    this.commitCount = 1;
    this.materializedItems = itemCount;
    if (this.mode === "single_item") this.actualBatchSize = 1;
  }

  enteredReleasing() {
    if (this.acquired && !this.terminal) this.emit("releasing");
  }

  finished() {
    if (!this.terminal) this.emit("finished");
  }

  releasedLease(released: boolean) {
    if (!this.acquired || this.terminal) return;
    this.released = released;
    this.holdMs = Math.max(0, this.now() - (this.holdStartedAtMs ?? this.now()));
  }

  finalize(outcome: StateWriterOutcome): StateWriterOperation | null {
    if (this.terminal) return this.terminal;
    const finishedAtMs = this.now();
    if (this.waitStartedAtMs !== null && !this.acquired) {
      this.waitMs = Math.max(0, finishedAtMs - this.waitStartedAtMs);
    }
    if (this.acquired && this.holdMs === null) {
      this.holdMs = Math.max(0, finishedAtMs - (this.holdStartedAtMs ?? finishedAtMs));
    }
    const safeOutcome =
      (!this.acquired && outcome !== "contention_timeout" && outcome !== "failed") ||
      (this.acquired && outcome === "contention_timeout")
        ? "failed"
        : outcome;
    this.outcome = safeOutcome;
    this.emit("finished");
    const candidate = {
      schema_version: STATE_WRITER_SCHEMA_VERSION,
      operation_id: this.operationId,
      mode: this.mode,
      started_at: new Date(this.startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      wait_ms: clampDuration(this.waitMs),
      acquire_attempts: clampCount(this.acquireAttempts),
      acquired: this.acquired,
      hold_ms: this.acquired ? clampDuration(this.holdMs ?? 0) : null,
      renewals: this.acquired ? clampCount(this.renewals) : 0,
      released: this.acquired ? (this.released ?? false) : null,
      git_duration_ms: clampDuration(Math.max(0, finishedAtMs - this.startedAtMs)),
      git_processes: clampCount(this.gitProcesses),
      commit_count: this.commitCount,
      materialized_items: clampCount(this.materializedItems),
      configured_batch_size: this.configuredBatchSize,
      actual_batch_size:
        this.mode === "single_item"
          ? 1
          : Math.max(1, this.actualBatchSize || this.configuredBatchSize),
      batch_wait_ms: this.mode === "single_item" ? null : clampDuration(this.batchWaitMs ?? 0),
      outcome: safeOutcome,
    };
    const normalized = normalizeStateWriterOperation(candidate);
    if (normalized) {
      this.terminal = normalized;
      return this.terminal;
    }
    // Keep publication authoritative: omit malformed optional telemetry rather
    // than throwing into the lease/publication path.
    this.terminal = normalizeStateWriterOperation({
      schema_version: STATE_WRITER_SCHEMA_VERSION,
      operation_id: this.operationId.slice(0, 200) || `single:local:${this.startedAtMs}`,
      mode: "single_item",
      started_at: new Date(this.startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      wait_ms: 0,
      acquire_attempts: 0,
      acquired: false,
      hold_ms: null,
      renewals: 0,
      released: null,
      git_duration_ms: 0,
      git_processes: 0,
      commit_count: 0,
      materialized_items: 0,
      configured_batch_size: 1,
      actual_batch_size: 1,
      batch_wait_ms: null,
      outcome: "failed",
    });
    return this.terminal;
  }

  toTerminalObject(): StateWriterOperation | null {
    return this.terminal;
  }

  private refreshProgress(phase: StateWriterPhase) {
    if (this.terminal) return;
    if (this.lastProgressPhase !== phase) {
      this.emit(phase);
      return;
    }
    if (this.now() - this.lastProgressAtMs < PROGRESS_REFRESH_MS) return;
    this.emit(phase);
  }

  private emit(phase: StateWriterPhase) {
    try {
      this.lastProgressPhase = phase;
      this.lastProgressAtMs = this.now();
      this.options.observer?.progress?.({
        schema_version: STATE_WRITER_SCHEMA_VERSION,
        operation_id: this.operationId,
        mode: this.mode,
        phase,
        sequence: ++this.sequence,
        observed_at: new Date(this.now()).toISOString(),
        configured_batch_size: this.configuredBatchSize,
        actual_batch_size: this.mode === "single_item" ? 1 : Math.max(1, this.actualBatchSize),
      });
    } catch {
      // Telemetry observers are always best effort.
    }
  }
}

function clampDuration(value: number): number {
  return Math.min(STATE_WRITER_MAX_DURATION_MS, Math.max(0, value));
}

function clampCount(value: number): number {
  return Math.min(STATE_WRITER_MAX_COUNT, Math.max(0, value));
}
