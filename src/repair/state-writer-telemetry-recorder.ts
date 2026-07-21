import {
  normalizeStateWriterOperation,
  type StateWriterOperation,
  type StateWriterOutcome,
  type StateWriterPhase,
  type StateWriterProgress,
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

export class StateWriterTelemetryRecorder {
  private readonly now;
  private readonly startedAtMs;
  private readonly operationId;
  private readonly mode;
  private readonly configuredBatchSize;
  private actualBatchSize;
  private readonly batchWaitMs;
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
  private terminal: StateWriterOperation | null = null;

  constructor(private readonly options: StateWriterTelemetryRecorderOptions = {}) {
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
    if (!this.terminal) this.acquireAttempts += 1;
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
    if (this.acquired && !this.terminal) this.renewals += 1;
  }

  recordGitProcess() {
    if (!this.terminal) this.gitProcesses += 1;
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

  finalize(outcome: StateWriterOutcome): StateWriterOperation {
    if (this.terminal) return this.terminal;
    const finishedAtMs = this.now();
    if (this.waitStartedAtMs !== null && !this.acquired) {
      this.waitMs = Math.max(0, finishedAtMs - this.waitStartedAtMs);
    }
    if (this.acquired && this.holdMs === null) {
      this.holdMs = Math.max(0, finishedAtMs - (this.holdStartedAtMs ?? finishedAtMs));
    }
    this.outcome = outcome;
    this.emit("finished");
    const candidate = {
      schema_version: STATE_WRITER_SCHEMA_VERSION,
      operation_id: this.operationId,
      mode: this.mode,
      started_at: new Date(this.startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      wait_ms: this.waitMs,
      acquire_attempts: this.acquireAttempts,
      acquired: this.acquired,
      hold_ms: this.acquired ? this.holdMs : null,
      renewals: this.acquired ? this.renewals : 0,
      released: this.acquired ? this.released : null,
      git_duration_ms: Math.max(0, finishedAtMs - this.startedAtMs),
      git_processes: this.gitProcesses,
      commit_count: this.commitCount,
      materialized_items: this.materializedItems,
      configured_batch_size: this.configuredBatchSize,
      actual_batch_size: this.actualBatchSize,
      batch_wait_ms: this.batchWaitMs,
      outcome: this.outcome,
    };
    this.terminal = normalizeStateWriterOperation(candidate) ?? {
      ...candidate,
      actual_batch_size: this.mode === "single_item" ? 1 : Math.max(1, this.actualBatchSize),
      materialized_items: this.commitCount ? Math.max(1, this.materializedItems) : 0,
    };
    return this.terminal;
  }

  toTerminalObject(): StateWriterOperation | null {
    return this.terminal;
  }

  private emit(phase: StateWriterPhase) {
    try {
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
