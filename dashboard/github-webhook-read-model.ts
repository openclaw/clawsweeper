import { stableJson } from "../src/stable-json.ts";
import { sqlColumnNames } from "./durable-storage.ts";

export const GITHUB_WEBHOOK_READ_MODEL_ITEM_TTL_MS = 15 * 60_000;
export const GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS = 30 * 60_000;
export const GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS = 5 * 60_000;
export const GITHUB_WEBHOOK_READ_MODEL_PLACEHOLDER_REPAIR_TTL_MS = 6 * 60 * 60_000;
export const GITHUB_WEBHOOK_READ_MODEL_PROBE_WINDOW_MS = 30 * 60_000;
export const GITHUB_WEBHOOK_READ_MODEL_MAX_ITEM_COMMENTS = 500;
export const GITHUB_WEBHOOK_READ_MODEL_MAX_ITEM_ACTIVITY = 500;
export const GITHUB_WEBHOOK_READ_MODEL_MAX_WORKFLOW_OBJECTS = 1_000;
export const GITHUB_WEBHOOK_READ_MODEL_MAX_COMMENT_BODY_BYTES = 64 * 1_024;
// Retain a whole active family for the longest ordinary reader TTL. Older
// members can still belong to a fresh, complete comment or review collection.
export const GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS =
  GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS;
export const GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_PRUNE_LIMIT = 64;

const PAYLOAD_TABLES = [
  "github_webhook_read_model_items_v1",
  "github_webhook_read_model_comments_v1",
  "github_webhook_read_model_activity_v1",
] as const;
const REVIEW_PLACEHOLDER_MARKER = "ClawSweeper status: review started.";

type JsonRecord = Record<string, unknown>;
type SqlRow = Record<string, unknown>;
type ReadModelStorage = {
  sql: { exec: (query: string, ...bindings: unknown[]) => Iterable<SqlRow> };
  transactionSync: <T>(callback: () => T) => T;
};

export type GithubWebhookReadModelEventClass =
  | "issues"
  | "pull_requests"
  | "issue_comments"
  | "pull_request_reviews"
  | "pull_request_review_comments"
  | "workflow_runs"
  | "workflow_jobs"
  | "checks";

export type GithubWebhookReadModelItem = {
  readonly kind: "item";
  readonly repository: string;
  readonly number: number;
  readonly itemKind: "issue" | "pull_request";
  readonly sourceUpdatedAt: string;
  readonly snapshot: JsonRecord;
};

export type GithubWebhookReadModelComment = {
  readonly kind: "comment";
  readonly repository: string;
  readonly number: number;
  readonly id: number;
  readonly sourceUpdatedAt: string;
  readonly tombstone: boolean;
  readonly snapshot: JsonRecord;
};

export type GithubWebhookReadModelActivity = {
  readonly kind: "review" | "review_comment";
  readonly repository: string;
  readonly number: number;
  readonly id: number;
  readonly sourceUpdatedAt: string;
  readonly tombstone: boolean;
  readonly snapshot: JsonRecord;
};

export type GithubWebhookReadModelWorkflow = {
  readonly kind: "workflow_run" | "workflow_job" | "check_run" | "check_suite";
  readonly repository: string;
  readonly id: number;
  readonly runId: number | null;
  readonly sourceUpdatedAt: string;
  readonly snapshot: JsonRecord;
};

export type GithubWebhookReadModelObject =
  | GithubWebhookReadModelItem
  | GithubWebhookReadModelComment
  | GithubWebhookReadModelActivity
  | GithubWebhookReadModelWorkflow;

export type GithubWebhookReadModelDelivery = {
  readonly version: 1;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string;
  readonly receivedAt: string;
  readonly eventClasses: readonly GithubWebhookReadModelEventClass[];
  readonly objects: readonly GithubWebhookReadModelObject[];
};

export function githubWebhookReadModelDeliveryFromWebhook(input: {
  readonly event: string;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}): GithubWebhookReadModelDelivery | null {
  const payload = record(input.payload);
  const repositoryPayload = record(payload.repository);
  const repository = normalizedRepository(repositoryPayload.full_name);
  const action = stringValue(payload.action);
  const receivedAt = timestamp(input.receivedAt);
  if (!repository || !input.deliveryId || !receivedAt) return null;

  const objects: GithubWebhookReadModelObject[] = [];
  const eventClasses = new Set<GithubWebhookReadModelEventClass>();
  const issue = record(payload.issue);
  const pullRequest = record(payload.pull_request);
  const itemSource = input.event === "pull_request" ? pullRequest : issue;
  if (
    input.event === "issues" ||
    input.event === "pull_request" ||
    input.event === "issue_comment" ||
    input.event === "pull_request_review" ||
    input.event === "pull_request_review_comment"
  ) {
    const itemKind =
      input.event === "pull_request" ||
      input.event === "pull_request_review" ||
      input.event === "pull_request_review_comment" ||
      Boolean(issue.pull_request)
        ? "pull_request"
        : "issue";
    const source = itemSource.number ? itemSource : pullRequest.number ? pullRequest : issue;
    const number = positiveInteger(source.number);
    const sourceUpdatedAt = sourceTimestamp(source, receivedAt);
    if (number) {
      objects.push({
        kind: "item",
        repository,
        number,
        itemKind,
        sourceUpdatedAt,
        snapshot: normalizedItemSnapshot(source, itemKind),
      });
      if (input.event === "issues") eventClasses.add("issues");
      if (input.event === "pull_request") eventClasses.add("pull_requests");
    }
  }

  if (input.event === "issue_comment") {
    const comment = record(payload.comment);
    const number = positiveInteger(issue.number);
    const id = positiveInteger(comment.id);
    if (number && id) {
      objects.push({
        kind: "comment",
        repository,
        number,
        id,
        sourceUpdatedAt: sourceTimestamp(comment, receivedAt),
        tombstone: action === "deleted",
        snapshot: normalizedCommentSnapshot(comment, action === "deleted"),
      });
      eventClasses.add("issue_comments");
    }
  }

  if (input.event === "pull_request_review") {
    const review = record(payload.review);
    const number = positiveInteger(pullRequest.number);
    const id = positiveInteger(review.id);
    if (number && id) {
      objects.push({
        kind: "review",
        repository,
        number,
        id,
        sourceUpdatedAt: sourceTimestamp(review, receivedAt),
        tombstone: false,
        snapshot: boundedSnapshot(review) ?? {},
      });
      eventClasses.add("pull_request_reviews");
    }
  }

  if (input.event === "pull_request_review_comment") {
    const comment = record(payload.comment);
    const number = positiveInteger(pullRequest.number);
    const id = positiveInteger(comment.id);
    if (number && id) {
      objects.push({
        kind: "review_comment",
        repository,
        number,
        id,
        sourceUpdatedAt: sourceTimestamp(comment, receivedAt),
        tombstone: action === "deleted",
        snapshot: normalizedCommentSnapshot(comment, action === "deleted"),
      });
      eventClasses.add("pull_request_review_comments");
    }
  }

  const workflowKind = workflowObjectKind(input.event);
  if (workflowKind) {
    const source = record(payload[workflowKind]);
    const id = positiveInteger(source.id);
    if (id) {
      const workflowRun = record(payload.workflow_run);
      const runId =
        workflowKind === "workflow_run"
          ? id
          : (positiveInteger(source.run_id) ?? positiveInteger(workflowRun.id));
      objects.push({
        kind: workflowKind,
        repository,
        id,
        runId,
        sourceUpdatedAt: sourceTimestamp(source, receivedAt),
        snapshot: boundedSnapshot(source) ?? {},
      });
      eventClasses.add(
        workflowKind === "workflow_run"
          ? "workflow_runs"
          : workflowKind === "workflow_job"
            ? "workflow_jobs"
            : "checks",
      );
    }
  }

  if (eventClasses.size === 0) return null;
  return {
    version: 1,
    deliveryId: input.deliveryId,
    event: input.event,
    action,
    receivedAt,
    eventClasses: [...eventClasses],
    objects,
  };
}

export type GithubWebhookReadModelFreshness = {
  readonly stale: boolean;
  readonly age_ms: number | null;
  readonly ttl_ms: number;
  readonly source_updated_at: string | null;
};

export type GithubWebhookReadModelClassState = {
  readonly event_class: GithubWebhookReadModelEventClass;
  readonly available: boolean;
  readonly reason: "observed" | "never_observed";
  readonly probe_window_elapsed: boolean;
  readonly delivery_count: number;
  readonly last_delivery_at: string | null;
};

export class GithubWebhookReadModelStore {
  private readonly storage: ReadModelStorage;

  constructor(storage: ReadModelStorage) {
    this.storage = storage;
  }

  ensureSchemaSync(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_meta_v1 (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         watermark INTEGER NOT NULL CHECK (watermark >= 0),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO github_webhook_read_model_meta_v1
       (singleton_id, watermark, created_at, updated_at) VALUES (1, 0, ?, ?)`,
      Date.now(),
      Date.now(),
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_deliveries_v1 (
         delivery_id TEXT PRIMARY KEY,
         event TEXT NOT NULL,
         action TEXT NOT NULL,
         received_at INTEGER NOT NULL,
         watermark INTEGER NOT NULL UNIQUE
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_webhook_read_model_deliveries_received_at_v1
         ON github_webhook_read_model_deliveries_v1 (received_at)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_classes_v1 (
         event_class TEXT PRIMARY KEY,
         delivery_count INTEGER NOT NULL CHECK (delivery_count > 0),
         first_delivery_at INTEGER NOT NULL,
         last_delivery_at INTEGER NOT NULL,
         watermark INTEGER NOT NULL
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_items_v1 (
         repository TEXT NOT NULL,
         number INTEGER NOT NULL CHECK (number > 0),
         item_kind TEXT NOT NULL,
         source_updated_at INTEGER NOT NULL,
         snapshot_json TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         watermark INTEGER NOT NULL,
         received_at INTEGER NOT NULL,
         PRIMARY KEY (repository, number)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_comments_v1 (
         repository TEXT NOT NULL,
         number INTEGER NOT NULL CHECK (number > 0),
         comment_id INTEGER NOT NULL CHECK (comment_id > 0),
         source_updated_at INTEGER NOT NULL,
         tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
         snapshot_json TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         watermark INTEGER NOT NULL,
         received_at INTEGER NOT NULL,
         PRIMARY KEY (repository, number, comment_id)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_webhook_read_model_comments_item_v1
         ON github_webhook_read_model_comments_v1
         (repository, number, source_updated_at DESC, comment_id DESC)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_activity_v1 (
         repository TEXT NOT NULL,
         number INTEGER NOT NULL CHECK (number > 0),
         activity_kind TEXT NOT NULL,
         activity_id INTEGER NOT NULL CHECK (activity_id > 0),
         source_updated_at INTEGER NOT NULL,
         tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
         snapshot_json TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         watermark INTEGER NOT NULL,
         received_at INTEGER NOT NULL,
         PRIMARY KEY (repository, number, activity_kind, activity_id)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_webhook_read_model_activity_item_v1
         ON github_webhook_read_model_activity_v1
         (repository, number, source_updated_at DESC, activity_id DESC)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_workflows_v1 (
         repository TEXT NOT NULL,
         object_kind TEXT NOT NULL,
         object_id INTEGER NOT NULL CHECK (object_id > 0),
         run_id INTEGER,
         source_updated_at INTEGER NOT NULL,
         snapshot_json TEXT NOT NULL,
         delivery_id TEXT NOT NULL,
         watermark INTEGER NOT NULL,
         received_at INTEGER NOT NULL,
         PRIMARY KEY (repository, object_kind, object_id)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS github_webhook_read_model_workflows_repo_v1
         ON github_webhook_read_model_workflows_v1
         (repository, source_updated_at DESC, object_id DESC)`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_repairs_v1 (
         repository TEXT NOT NULL,
         repair_kind TEXT NOT NULL,
         repaired_at INTEGER NOT NULL,
         watermark INTEGER NOT NULL,
         PRIMARY KEY (repository, repair_kind)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_collections_v1 (
         repository TEXT NOT NULL,
         number INTEGER NOT NULL CHECK (number > 0),
         collection_kind TEXT NOT NULL,
         repaired_at INTEGER NOT NULL,
         watermark INTEGER NOT NULL,
         PRIMARY KEY (repository, number, collection_kind)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS github_webhook_read_model_workflow_coverage_v1 (
         repository TEXT NOT NULL,
         coverage_kind TEXT NOT NULL,
         run_id INTEGER NOT NULL CHECK (run_id >= 0),
         repaired_at INTEGER NOT NULL,
         watermark INTEGER NOT NULL,
         PRIMARY KEY (repository, coverage_kind, run_id)
       ) STRICT`,
    );
    if (!sqlColumnNames(this.storage, "github_webhook_read_model_collections_v1").has("complete")) {
      // Older receipts can describe a capped result. Only a new complete repair
      // can certify that all returned comments still fit in storage.
      this.storage.sql.exec(
        `ALTER TABLE github_webhook_read_model_collections_v1 ADD COLUMN complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))`,
      );
    }
    for (const table of PAYLOAD_TABLES) {
      const columns = sqlColumnNames(this.storage, table);
      for (const column of ["payload_pruned", "payload_retire_at"]) {
        if (!columns.has(column)) {
          this.storage.sql.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0
               CHECK (${column === "payload_pruned" ? `${column} IN (0, 1)` : `${column} >= -1`})`,
          );
        }
      }
      this.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_payload_retention
           ON ${table} (payload_retire_at) WHERE payload_pruned = 0 AND payload_retire_at >= 0
             ${table.endsWith("items_v1") ? "" : "AND tombstone = 0"}`,
      );
    }
  }

  ingest(
    value: unknown,
    now = Date.now(),
  ): { accepted: boolean; deduped: boolean; watermark: number } {
    const delivery = githubWebhookReadModelDeliveryFromValue(value);
    if (!delivery) throw new Error("invalid_github_webhook_read_model_delivery");
    const existing = firstRow(
      this.storage.sql.exec(
        `SELECT watermark FROM github_webhook_read_model_deliveries_v1 WHERE delivery_id = ?`,
        delivery.deliveryId,
      ),
    );
    if (existing) {
      return { accepted: true, deduped: true, watermark: Number(existing.watermark) };
    }
    const receivedAt = timestampMs(delivery.receivedAt) ?? now;
    return this.storage.transactionSync(() => {
      const race = firstRow(
        this.storage.sql.exec(
          `SELECT watermark FROM github_webhook_read_model_deliveries_v1 WHERE delivery_id = ?`,
          delivery.deliveryId,
        ),
      );
      if (race) return { accepted: true, deduped: true, watermark: Number(race.watermark) };
      const watermark = this.watermarkSync() + 1;
      this.storage.sql.exec(
        `UPDATE github_webhook_read_model_meta_v1 SET watermark = ?, updated_at = ? WHERE singleton_id = 1`,
        watermark,
        now,
      );
      this.storage.sql.exec(
        `INSERT INTO github_webhook_read_model_deliveries_v1
         (delivery_id, event, action, received_at, watermark) VALUES (?, ?, ?, ?, ?)`,
        delivery.deliveryId,
        delivery.event,
        delivery.action,
        receivedAt,
        watermark,
      );
      for (const eventClass of delivery.eventClasses) {
        this.storage.sql.exec(
          `INSERT INTO github_webhook_read_model_classes_v1
           (event_class, delivery_count, first_delivery_at, last_delivery_at, watermark)
           VALUES (?, 1, ?, ?, ?)
           ON CONFLICT (event_class) DO UPDATE SET
             delivery_count = delivery_count + 1,
             last_delivery_at = MAX(last_delivery_at, excluded.last_delivery_at),
             watermark = MAX(watermark, excluded.watermark)`,
          eventClass,
          receivedAt,
          receivedAt,
          watermark,
        );
      }
      for (const object of delivery.objects) {
        this.upsertObjectSync(object, delivery.deliveryId, watermark, receivedAt);
      }
      this.pruneSync(now);
      return { accepted: true, deduped: false, watermark };
    });
  }

  repair(
    value: unknown,
    now = Date.now(),
  ): { accepted: boolean; watermark: number; evicted_workflow_runs: number } {
    const body = record(value);
    const repository = normalizedRepository(body.repository);
    const repairKind = stringValue(body.repair_kind);
    const objects = Array.isArray(body.objects)
      ? body.objects.map(githubWebhookReadModelObjectFromValue).filter(nonNullable)
      : [];
    const completeCommentItems = Array.isArray(body.complete_comment_items)
      ? body.complete_comment_items.map(positiveInteger).filter(nonNullable)
      : [];
    const workflowRunCensusStartedAt = timestampMs(body.workflow_run_census_started_at);
    const workflowRunCensusComplete =
      repairKind === "workflows" &&
      body.workflow_run_census_complete === true &&
      workflowRunCensusStartedAt !== null;
    const workflowJobCensusStartedAt = strictTimestampMs(body.workflow_job_census_started_at);
    const workflowJobCensusRunValues = Array.isArray(body.complete_workflow_job_runs)
      ? body.complete_workflow_job_runs
      : null;
    const strictWorkflowJobRunIds = workflowJobCensusRunValues?.every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    )
      ? (workflowJobCensusRunValues as number[])
      : null;
    const completeWorkflowJobRuns =
      repairKind === "workflows" &&
      workflowJobCensusStartedAt !== null &&
      body.workflow_job_census_version === 2 &&
      strictWorkflowJobRunIds !== null &&
      strictWorkflowJobRunIds.length <= 100 &&
      new Set(strictWorkflowJobRunIds).size === strictWorkflowJobRunIds.length
        ? strictWorkflowJobRunIds
        : [];
    const workflowJobCensusBoundary = workflowJobCensusStartedAt ?? 0;
    const workflowRunVerificationStartedAt = timestampMs(body.workflow_run_verification_started_at);
    const evictWorkflowRunIds = Array.isArray(body.evict_workflow_run_ids)
      ? body.evict_workflow_run_ids.map(positiveInteger).filter(nonNullable)
      : [];
    if (
      !repository ||
      !new Set(["items", "comments", "placeholders", "workflows"]).has(repairKind)
    ) {
      throw new Error("invalid_github_webhook_read_model_repair");
    }
    if (objects.some((object) => object.repository !== repository)) {
      throw new Error("github_webhook_read_model_repair_repository_mismatch");
    }
    if (
      evictWorkflowRunIds.length > 0 &&
      (repairKind !== "workflows" || workflowRunVerificationStartedAt === null)
    ) {
      throw new Error("invalid_github_webhook_read_model_workflow_eviction");
    }
    return this.storage.transactionSync(() => {
      const watermark = this.watermarkSync() + 1;
      let evictedWorkflowRuns = 0;
      this.storage.sql.exec(
        `UPDATE github_webhook_read_model_meta_v1 SET watermark = ?, updated_at = ? WHERE singleton_id = 1`,
        watermark,
        now,
      );
      const deliveryId = `repair:${repairKind}:${repository}:${watermark}`;
      for (const runId of new Set(evictWorkflowRunIds)) {
        const row = firstRow(
          this.storage.sql.exec(
            `SELECT received_at FROM github_webhook_read_model_workflows_v1
              WHERE repository = ? AND object_kind = 'workflow_run' AND object_id = ?`,
            repository,
            runId,
          ),
        );
        if (!row || Number(row.received_at) > workflowRunVerificationStartedAt!) continue;
        this.storage.sql.exec(
          `DELETE FROM github_webhook_read_model_workflows_v1
            WHERE repository = ? AND object_kind = 'workflow_run' AND object_id = ?
              AND received_at <= ?`,
          repository,
          runId,
          workflowRunVerificationStartedAt,
        );
        this.storage.sql.exec(
          `DELETE FROM github_webhook_read_model_workflows_v1
            WHERE repository = ? AND run_id = ? AND object_kind <> 'workflow_run'
              AND received_at <= ?`,
          repository,
          runId,
          workflowRunVerificationStartedAt,
        );
        this.storage.sql.exec(
          `DELETE FROM github_webhook_read_model_workflow_coverage_v1
            WHERE repository = ? AND coverage_kind IN ('run_jobs', 'run_jobs_v2') AND run_id = ?`,
          repository,
          runId,
        );
        evictedWorkflowRuns += 1;
      }
      if (workflowRunCensusComplete) {
        const liveRunIds = new Set(
          objects
            .filter(
              (object): object is GithubWebhookReadModelWorkflow => object.kind === "workflow_run",
            )
            .map((object) => object.id),
        );
        const existingRuns = Array.from(
          this.storage.sql.exec(
            `SELECT object_id, received_at FROM github_webhook_read_model_workflows_v1
              WHERE repository = ? AND object_kind = 'workflow_run'`,
            repository,
          ),
        );
        for (const row of existingRuns) {
          const id = Number(row.object_id);
          if (liveRunIds.has(id) || Number(row.received_at) > workflowRunCensusStartedAt) continue;
          this.storage.sql.exec(
            `DELETE FROM github_webhook_read_model_workflows_v1
              WHERE repository = ? AND object_kind = 'workflow_run' AND object_id = ?`,
            repository,
            id,
          );
        }
        this.upsertWorkflowCoverageSync(repository, "run_census", 0, now, watermark);
      }
      for (const runId of completeWorkflowJobRuns) {
        const liveJobIds = new Set(
          objects
            .filter(
              (object): object is GithubWebhookReadModelWorkflow =>
                object.kind === "workflow_job" && object.runId === runId,
            )
            .map((object) => object.id),
        );
        const existingJobs = Array.from(
          this.storage.sql.exec(
            `SELECT object_id, received_at FROM github_webhook_read_model_workflows_v1
              WHERE repository = ? AND object_kind = 'workflow_job' AND run_id = ?`,
            repository,
            runId,
          ),
        );
        for (const row of existingJobs) {
          const id = Number(row.object_id);
          if (liveJobIds.has(id) || Number(row.received_at) > workflowJobCensusBoundary) continue;
          this.storage.sql.exec(
            `DELETE FROM github_webhook_read_model_workflows_v1
              WHERE repository = ? AND object_kind = 'workflow_job' AND object_id = ?`,
            repository,
            id,
          );
        }
        this.upsertWorkflowCoverageSync(repository, "run_jobs_v2", runId, now, watermark);
      }
      for (const number of completeCommentItems) {
        this.recheckItemProtectionSync(repository, number);
        const liveIds = new Set(
          objects
            .filter(
              (object): object is GithubWebhookReadModelComment =>
                object.kind === "comment" && object.number === number,
            )
            .map((object) => object.id),
        );
        const existingRows = Array.from(
          this.storage.sql.exec(
            `SELECT comment_id FROM github_webhook_read_model_comments_v1
              WHERE repository = ? AND number = ? AND tombstone = 0`,
            repository,
            number,
          ),
        );
        for (const row of existingRows) {
          const id = Number(row.comment_id);
          if (liveIds.has(id)) continue;
          this.storage.sql.exec(
            `UPDATE github_webhook_read_model_comments_v1
                SET source_updated_at = ?, tombstone = 1, snapshot_json = ?, payload_pruned = 0, payload_retire_at = 0,
                    delivery_id = ?, watermark = ?, received_at = ?
              WHERE repository = ? AND number = ? AND comment_id = ?`,
            now,
            JSON.stringify({ id, body: null, tombstone: true }),
            deliveryId,
            watermark,
            now,
            repository,
            number,
            id,
          );
        }
        this.storage.sql.exec(
          `INSERT INTO github_webhook_read_model_collections_v1
           (repository, number, collection_kind, repaired_at, watermark, complete)
           VALUES (?, ?, 'comments', ?, ?, 1)
           ON CONFLICT (repository, number, collection_kind) DO UPDATE SET
             repaired_at = excluded.repaired_at, watermark = excluded.watermark, complete = 1`,
          repository,
          number,
          now,
          watermark,
        );
      }
      for (const object of objects) this.upsertObjectSync(object, deliveryId, watermark, now, true);
      this.storage.sql.exec(
        `INSERT INTO github_webhook_read_model_repairs_v1
         (repository, repair_kind, repaired_at, watermark) VALUES (?, ?, ?, ?)
         ON CONFLICT (repository, repair_kind) DO UPDATE SET
           repaired_at = excluded.repaired_at, watermark = excluded.watermark`,
        repository,
        repairKind,
        now,
        watermark,
      );
      this.pruneSync(now);
      return { accepted: true, watermark, evicted_workflow_runs: evictedWorkflowRuns };
    });
  }

  async readItem(value: unknown, now = Date.now()): Promise<JsonRecord> {
    const body = record(value);
    const repository = normalizedRepository(body.repository);
    const number = positiveInteger(body.number);
    if (!repository || !number) throw new Error("invalid_github_webhook_read_model_item_request");
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT item_kind, snapshot_json, source_updated_at, delivery_id, watermark, received_at, payload_pruned
           FROM github_webhook_read_model_items_v1 WHERE repository = ? AND number = ?`,
        repository,
        number,
      ),
    );
    const classState = this.classState(
      row?.item_kind === "pull_request" ? "pull_requests" : "issues",
      now,
    );
    return {
      ok: true,
      watermark: this.watermarkSync(),
      class_state: classState,
      hit: Boolean(row) && !row?.payload_pruned,
      usable:
        Boolean(row) &&
        !row?.payload_pruned &&
        classState.available &&
        !freshness(row, GITHUB_WEBHOOK_READ_MODEL_ITEM_TTL_MS, now).stale,
      freshness: freshness(row, GITHUB_WEBHOOK_READ_MODEL_ITEM_TTL_MS, now),
      ...(row && !row.payload_pruned
        ? {
            delivery_id: String(row.delivery_id),
            object_watermark: Number(row.watermark),
            item: itemSnapshotWithKind(parseJsonRecord(String(row.snapshot_json)), row.item_kind),
          }
        : {}),
    };
  }

  async readComments(value: unknown, now = Date.now()): Promise<JsonRecord> {
    const body = record(value);
    const repository = normalizedRepository(body.repository);
    const number = positiveInteger(body.number);
    if (!repository || !number)
      throw new Error("invalid_github_webhook_read_model_comments_request");
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT snapshot_json, tombstone, source_updated_at, delivery_id, watermark, received_at, payload_pruned
           FROM github_webhook_read_model_comments_v1
          WHERE repository = ? AND number = ?
          ORDER BY comment_id ASC`,
        repository,
        number,
      ),
    );
    const collection = firstRow(
      this.storage.sql.exec(
        `SELECT repaired_at, watermark, complete FROM github_webhook_read_model_collections_v1
          WHERE repository = ? AND number = ? AND collection_kind = 'comments'`,
        repository,
        number,
      ),
    );
    const latest = rows.reduce<SqlRow | undefined>(
      (value, row) => (!value || Number(row.received_at) > Number(value.received_at) ? row : value),
      undefined,
    );
    const freshnessRow =
      collection && (!latest || Number(collection.repaired_at) > Number(latest.received_at))
        ? { received_at: collection.repaired_at, source_updated_at: collection.repaired_at }
        : latest;
    const classState = this.classState("issue_comments", now);
    const commentFreshness = freshness(freshnessRow, GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS, now);
    const comments = rows
      .filter((row) => Number(row.tombstone) === 0 && !row.payload_pruned)
      .map((row) => parseJsonRecord(String(row.snapshot_json)));
    const tombstones = rows
      .filter((row) => Number(row.tombstone) === 1)
      .map((row) => Number(parseJsonRecord(String(row.snapshot_json)).id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const itemRow = firstRow(
      this.storage.sql.exec(
        `SELECT snapshot_json, payload_pruned, watermark FROM github_webhook_read_model_items_v1
          WHERE repository = ? AND number = ?`,
        repository,
        number,
      ),
    );
    const collectionCoversParent =
      Boolean(collection) && Number(collection?.watermark) > Number(itemRow?.watermark ?? 0);
    const expectedCommentCountValue =
      itemRow && !collectionCoversParent
        ? parseJsonRecord(String(itemRow.snapshot_json)).comments
        : undefined;
    const expectedCommentCount =
      typeof expectedCommentCountValue === "number" ? expectedCommentCountValue : Number.NaN;
    const gapDetected =
      Number.isSafeInteger(expectedCommentCount) &&
      expectedCommentCount >= 0 &&
      expectedCommentCount !== comments.length;
    // A complete comment repair owns its collection even without an item body.
    // A later partial item observation can reveal a gap, so it fences that proof.
    const parentCovered = !itemRow?.payload_pruned || collectionCoversParent;
    return {
      ok: true,
      watermark: this.watermarkSync(),
      class_state: classState,
      hit: rows.length > 0 || Boolean(collection),
      usable:
        (rows.length > 0 || Boolean(collection)) &&
        !rows.some((row) => row.payload_pruned) &&
        (!collection || Number(collection.complete) === 1) &&
        parentCovered &&
        classState.available &&
        !commentFreshness.stale &&
        !gapDetected,
      freshness: commentFreshness,
      gap_detected: gapDetected,
      expected_count: Number.isSafeInteger(expectedCommentCount) ? expectedCommentCount : null,
      comments,
      tombstones,
      activity_digest: await sha256Text(stableJson({ comments, tombstones })),
    };
  }

  async readActivity(value: unknown, now = Date.now()): Promise<JsonRecord> {
    const body = record(value);
    const repository = normalizedRepository(body.repository);
    const number = positiveInteger(body.number);
    if (!repository || !number)
      throw new Error("invalid_github_webhook_read_model_activity_request");
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT activity_kind, snapshot_json, tombstone, source_updated_at, received_at, payload_pruned
           FROM github_webhook_read_model_activity_v1
          WHERE repository = ? AND number = ?
          ORDER BY activity_kind ASC, activity_id ASC`,
        repository,
        number,
      ),
    );
    const latest = rows.reduce<SqlRow | undefined>(
      (value, row) => (!value || Number(row.received_at) > Number(value.received_at) ? row : value),
      undefined,
    );
    const reviewsClassState = this.classState("pull_request_reviews", now);
    const commentsClassState = this.classState("pull_request_review_comments", now);
    const activityFreshness = freshness(latest, GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS, now);
    const reviews = rows
      .filter(
        (row) =>
          row.activity_kind === "review" && Number(row.tombstone) === 0 && !row.payload_pruned,
      )
      .map((row) => parseJsonRecord(String(row.snapshot_json)));
    const reviewComments = rows
      .filter(
        (row) =>
          row.activity_kind === "review_comment" &&
          Number(row.tombstone) === 0 &&
          !row.payload_pruned,
      )
      .map((row) => parseJsonRecord(String(row.snapshot_json)));
    const tombstones = rows
      .filter((row) => Number(row.tombstone) === 1)
      .map((row) => parseJsonRecord(String(row.snapshot_json)));
    const itemRow = firstRow(
      this.storage.sql.exec(
        `SELECT snapshot_json, payload_pruned FROM github_webhook_read_model_items_v1
          WHERE repository = ? AND number = ?`,
        repository,
        number,
      ),
    );
    const expectedReviewCommentCountValue = itemRow
      ? parseJsonRecord(String(itemRow.snapshot_json)).review_comments
      : undefined;
    const expectedReviewCommentCount =
      typeof expectedReviewCommentCountValue === "number"
        ? expectedReviewCommentCountValue
        : Number.NaN;
    const gapDetected =
      Number.isSafeInteger(expectedReviewCommentCount) &&
      expectedReviewCommentCount >= 0 &&
      expectedReviewCommentCount !== reviewComments.length;
    return {
      ok: true,
      watermark: this.watermarkSync(),
      class_state: reviewsClassState,
      review_comment_class_state: commentsClassState,
      hit: rows.length > 0,
      usable:
        rows.length > 0 &&
        !rows.some((row) => row.payload_pruned) &&
        !itemRow?.payload_pruned &&
        reviewsClassState.available &&
        commentsClassState.available &&
        !activityFreshness.stale &&
        !gapDetected,
      freshness: activityFreshness,
      gap_detected: gapDetected,
      counts: { reviews: reviews.length, review_comments: reviewComments.length },
      activity_digest: await sha256Text(
        stableJson({ reviews, review_comments: reviewComments, tombstones }),
      ),
      reviews,
      review_comments: reviewComments,
      tombstones,
    };
  }

  async readWorkflows(value: unknown, now = Date.now()): Promise<JsonRecord> {
    const repository = normalizedRepository(record(value).repository);
    if (!repository) throw new Error("invalid_github_webhook_read_model_workflows_request");
    const rows = Array.from(
      this.storage.sql.exec(
        `SELECT object_kind, object_id, run_id, snapshot_json, source_updated_at, received_at
           FROM github_webhook_read_model_workflows_v1
          WHERE repository = ? ORDER BY source_updated_at DESC, object_id DESC`,
        repository,
      ),
    );
    const latestRun = rows.find((row) => row.object_kind === "workflow_run");
    const latestJob = rows.find((row) => row.object_kind === "workflow_job");
    const runCensus = firstRow(
      this.storage.sql.exec(
        `SELECT repaired_at, watermark FROM github_webhook_read_model_workflow_coverage_v1
          WHERE repository = ? AND coverage_kind = 'run_census' AND run_id = 0`,
        repository,
      ),
    );
    const coveredJobRuns = Array.from(
      this.storage.sql.exec(
        `SELECT run_id FROM github_webhook_read_model_workflow_coverage_v1
          WHERE repository = ? AND coverage_kind = 'run_jobs_v2' AND repaired_at > ?
          ORDER BY run_id`,
        repository,
        now - GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS,
      ),
    ).map((row) => Number(row.run_id));
    const classState = this.classState("workflow_runs", now);
    const jobsClassState = this.classState("workflow_jobs", now);
    const workflowFreshness = freshness(
      runCensus
        ? { received_at: runCensus.repaired_at, source_updated_at: runCensus.repaired_at }
        : latestRun,
      GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS,
      now,
    );
    const jobFreshness = freshness(latestJob, GITHUB_WEBHOOK_READ_MODEL_WORKFLOW_TTL_MS, now);
    const values = rows.map((row) => ({
      kind: String(row.object_kind),
      run_id: row.run_id === null ? null : Number(row.run_id),
      value: parseJsonRecord(String(row.snapshot_json)),
    }));
    return {
      ok: true,
      watermark: this.watermarkSync(),
      class_state: classState,
      jobs_class_state: jobsClassState,
      jobs_freshness: jobFreshness,
      hit: rows.length > 0 || Boolean(runCensus),
      usable: Boolean(runCensus) && classState.available && !workflowFreshness.stale,
      freshness: workflowFreshness,
      runs: values.filter((entry) => entry.kind === "workflow_run").map((entry) => entry.value),
      run_observations: rows
        .filter((row) => row.object_kind === "workflow_run")
        .map((row) => ({
          run_id: Number(row.object_id),
          source_updated_at: new Date(Number(row.source_updated_at)).toISOString(),
          confirmed_at: new Date(Number(row.received_at)).toISOString(),
        })),
      jobs: values.filter((entry) => entry.kind === "workflow_job").map((entry) => entry.value),
      checks: values
        .filter((entry) => entry.kind === "check_run" || entry.kind === "check_suite")
        .map((entry) => entry.value),
      jobs_usable: Boolean(latestJob) && jobsClassState.available && !jobFreshness.stale,
      job_coverage_run_ids: jobsClassState.available ? coveredJobRuns : [],
    };
  }

  async readPlaceholders(value: unknown, now = Date.now()): Promise<JsonRecord> {
    const body = record(value);
    const repository = normalizedRepository(body.repository);
    const state = stringValue(body.state);
    const limit = Math.min(1_000, positiveInteger(body.limit) ?? 100);
    if (!repository || !new Set(["open", "closed", "all"]).has(state)) {
      throw new Error("invalid_github_webhook_read_model_placeholders_request");
    }
    const repair = firstRow(
      this.storage.sql.exec(
        `SELECT repaired_at, watermark FROM github_webhook_read_model_repairs_v1
          WHERE repository = ? AND repair_kind = 'placeholders'`,
        repository,
      ),
    );
    const repairFreshness = freshness(
      repair
        ? { received_at: repair.repaired_at, source_updated_at: repair.repaired_at }
        : undefined,
      GITHUB_WEBHOOK_READ_MODEL_PLACEHOLDER_REPAIR_TTL_MS,
      now,
    );
    const comments = this.storage.sql.exec(
      `SELECT c.number, c.snapshot_json, c.source_updated_at, i.number AS item_number,
              i.item_kind, i.snapshot_json AS item_json, i.payload_pruned AS item_pruned
           FROM github_webhook_read_model_comments_v1 c
           LEFT JOIN github_webhook_read_model_items_v1 i
             ON i.repository = c.repository AND i.number = c.number
          WHERE c.repository = ? AND c.tombstone = 0
            AND c.payload_pruned = 0
          ORDER BY c.source_updated_at ASC, c.comment_id ASC`,
      repository,
    );
    const byNumber = new Map<number, { item: JsonRecord; comments: JsonRecord[] }>();
    let gapDetected = false;
    // Keep only selected groups, but drain the cursor: later comments can change
    // the selected placeholder or expose a retired parent that requires repair.
    for (const row of comments) {
      const comment = parseJsonRecord(String(row.snapshot_json));
      if (!String(comment.body || "").includes(REVIEW_PLACEHOLDER_MARKER)) continue;
      // A new placeholder can arrive after its parent was retired. A partial
      // census must not hide that gap and suppress the live recovery path.
      if (!row.item_number || row.item_pruned) {
        gapDetected = true;
        continue;
      }
      const number = Number(row.number);
      const entry = byNumber.get(number);
      if (entry) {
        entry.comments.push(comment);
        continue;
      }
      if (byNumber.size >= limit) continue;
      const item = itemSnapshotWithKind(parseJsonRecord(String(row.item_json)), row.item_kind);
      if (state !== "all" && String(item.state || "").toLowerCase() !== state) continue;
      byNumber.set(number, { item, comments: [comment] });
    }
    const classState = this.classState("issue_comments", now);
    return {
      ok: true,
      watermark: this.watermarkSync(),
      class_state: classState,
      usable: classState.available && Boolean(repair) && !repairFreshness.stale && !gapDetected,
      gap_detected: gapDetected,
      freshness: repairFreshness,
      candidates: [...byNumber.entries()].map(([number, entry]) => ({
        number,
        item: entry.item,
        comments: entry.comments,
      })),
    };
  }

  classState(
    eventClass: GithubWebhookReadModelEventClass,
    now = Date.now(),
  ): GithubWebhookReadModelClassState {
    const meta = firstRow(
      this.storage.sql.exec(
        `SELECT created_at FROM github_webhook_read_model_meta_v1 WHERE singleton_id = 1`,
      ),
    );
    const row = firstRow(
      this.storage.sql.exec(
        `SELECT delivery_count, last_delivery_at FROM github_webhook_read_model_classes_v1
          WHERE event_class = ?`,
        eventClass,
      ),
    );
    return {
      event_class: eventClass,
      available: Boolean(row),
      reason: row ? "observed" : "never_observed",
      probe_window_elapsed:
        Boolean(meta) &&
        now - Number(meta?.created_at) >= GITHUB_WEBHOOK_READ_MODEL_PROBE_WINDOW_MS,
      delivery_count: Number(row?.delivery_count || 0),
      last_delivery_at: row ? new Date(Number(row.last_delivery_at)).toISOString() : null,
    };
  }

  private upsertObjectSync(
    object: GithubWebhookReadModelObject,
    deliveryId: string,
    watermark: number,
    receivedAt: number,
    confirmed = false,
  ): void {
    const sourceUpdatedAt = timestampMs(object.sourceUpdatedAt);
    if (sourceUpdatedAt === null) return;
    const snapshotJson = JSON.stringify(object.snapshot);
    if (object.kind === "item") {
      const previous = firstRow(
        this.storage.sql.exec(
          `SELECT source_updated_at, snapshot_json, payload_pruned FROM github_webhook_read_model_items_v1
            WHERE repository = ? AND number = ?`,
          object.repository,
          object.number,
        ),
      );
      if (previous && Number(previous.source_updated_at) > sourceUpdatedAt) return;
      if (previous && Number(previous.source_updated_at) === sourceUpdatedAt && !confirmed) return;
      const mergedSnapshot = previous
        ? { ...parseJsonRecord(String(previous.snapshot_json)), ...object.snapshot }
        : object.snapshot;
      // A newer webhook may contain only part of an item. Once retired, only an
      // authoritative repair can restore the full snapshot and its count guards.
      const remainsPruned = Boolean(previous?.payload_pruned) && !confirmed;
      this.storage.sql.exec(
        `INSERT INTO github_webhook_read_model_items_v1
         (repository, number, item_kind, source_updated_at, snapshot_json, delivery_id, watermark, received_at, payload_pruned, payload_retire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository, number) DO UPDATE SET
           item_kind = excluded.item_kind,
           source_updated_at = excluded.source_updated_at,
           snapshot_json = excluded.snapshot_json,
           payload_pruned = excluded.payload_pruned,
           payload_retire_at = excluded.payload_retire_at,
           delivery_id = excluded.delivery_id,
           watermark = excluded.watermark,
           received_at = excluded.received_at
         WHERE excluded.source_updated_at >= github_webhook_read_model_items_v1.source_updated_at`,
        object.repository,
        object.number,
        object.itemKind,
        sourceUpdatedAt,
        remainsPruned
          ? "{}"
          : JSON.stringify(itemSnapshotWithKind(mergedSnapshot, object.itemKind)),
        deliveryId,
        watermark,
        receivedAt,
        remainsPruned ? 1 : 0,
        receivedAt + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
      );
      return;
    }
    if (object.kind === "comment") {
      const accepted = firstRow(
        this.storage.sql.exec(
          `INSERT INTO github_webhook_read_model_comments_v1
         (repository, number, comment_id, source_updated_at, tombstone, snapshot_json,
          delivery_id, watermark, received_at, payload_retire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository, number, comment_id) DO UPDATE SET
           source_updated_at = excluded.source_updated_at,
           tombstone = excluded.tombstone,
           snapshot_json = excluded.snapshot_json,
           payload_pruned = 0,
           payload_retire_at = excluded.payload_retire_at,
           delivery_id = excluded.delivery_id,
           watermark = excluded.watermark,
           received_at = excluded.received_at
         WHERE excluded.source_updated_at > github_webhook_read_model_comments_v1.source_updated_at
            OR (? AND excluded.source_updated_at = github_webhook_read_model_comments_v1.source_updated_at
                AND github_webhook_read_model_comments_v1.tombstone = 0)
         RETURNING comment_id`,
          object.repository,
          object.number,
          object.id,
          sourceUpdatedAt,
          object.tombstone ? 1 : 0,
          snapshotJson,
          deliveryId,
          watermark,
          receivedAt,
          receivedAt + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
          confirmed ? 1 : 0,
        ),
      );
      if (accepted) this.recheckItemProtectionSync(object.repository, object.number);
      this.pruneItemRowsSync(
        "github_webhook_read_model_comments_v1",
        "comment_id",
        object.repository,
        object.number,
        GITHUB_WEBHOOK_READ_MODEL_MAX_ITEM_COMMENTS,
      );
      return;
    }
    if (object.kind === "review" || object.kind === "review_comment") {
      this.storage.sql.exec(
        `INSERT INTO github_webhook_read_model_activity_v1
         (repository, number, activity_kind, activity_id, source_updated_at, tombstone,
          snapshot_json, delivery_id, watermark, received_at, payload_retire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository, number, activity_kind, activity_id) DO UPDATE SET
           source_updated_at = excluded.source_updated_at,
           tombstone = excluded.tombstone,
           snapshot_json = excluded.snapshot_json,
           payload_pruned = 0,
           payload_retire_at = excluded.payload_retire_at,
           delivery_id = excluded.delivery_id,
           watermark = excluded.watermark,
           received_at = excluded.received_at
         WHERE excluded.source_updated_at > github_webhook_read_model_activity_v1.source_updated_at
            OR (? AND excluded.source_updated_at = github_webhook_read_model_activity_v1.source_updated_at
                AND github_webhook_read_model_activity_v1.tombstone = 0)`,
        object.repository,
        object.number,
        object.kind,
        object.id,
        sourceUpdatedAt,
        object.tombstone ? 1 : 0,
        snapshotJson,
        deliveryId,
        watermark,
        receivedAt,
        receivedAt + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
        confirmed ? 1 : 0,
      );
      this.pruneItemRowsSync(
        "github_webhook_read_model_activity_v1",
        "activity_id",
        object.repository,
        object.number,
        GITHUB_WEBHOOK_READ_MODEL_MAX_ITEM_ACTIVITY,
      );
      return;
    }
    if (!("runId" in object)) return;
    this.storage.sql.exec(
      `INSERT INTO github_webhook_read_model_workflows_v1
       (repository, object_kind, object_id, run_id, source_updated_at, snapshot_json,
        delivery_id, watermark, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repository, object_kind, object_id) DO UPDATE SET
         run_id = CASE
           WHEN excluded.source_updated_at >= github_webhook_read_model_workflows_v1.source_updated_at
             THEN excluded.run_id
           ELSE github_webhook_read_model_workflows_v1.run_id
         END,
         source_updated_at = MAX(
           github_webhook_read_model_workflows_v1.source_updated_at,
           excluded.source_updated_at
         ),
         snapshot_json = CASE
           WHEN excluded.source_updated_at >= github_webhook_read_model_workflows_v1.source_updated_at
             THEN excluded.snapshot_json
           ELSE github_webhook_read_model_workflows_v1.snapshot_json
         END,
         delivery_id = excluded.delivery_id,
         watermark = excluded.watermark,
         received_at = MAX(github_webhook_read_model_workflows_v1.received_at, excluded.received_at)
       WHERE excluded.source_updated_at >= github_webhook_read_model_workflows_v1.source_updated_at`,
      object.repository,
      object.kind,
      object.id,
      object.runId,
      sourceUpdatedAt,
      snapshotJson,
      deliveryId,
      watermark,
      receivedAt,
    );
  }

  private upsertWorkflowCoverageSync(
    repository: string,
    coverageKind: "run_census" | "run_jobs" | "run_jobs_v2",
    runId: number,
    repairedAt: number,
    watermark: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO github_webhook_read_model_workflow_coverage_v1
       (repository, coverage_kind, run_id, repaired_at, watermark)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repository, coverage_kind, run_id) DO UPDATE SET
         repaired_at = excluded.repaired_at, watermark = excluded.watermark`,
      repository,
      coverageKind,
      runId,
      repairedAt,
      watermark,
    );
  }

  private pruneItemRowsSync(
    table: string,
    idColumn: string,
    repository: string,
    number: number,
    limit: number,
  ): void {
    const boundary = firstRow(
      this.storage.sql.exec(
        `SELECT source_updated_at, ${idColumn} AS id FROM ${table}
          WHERE repository = ? AND number = ?
          ORDER BY source_updated_at DESC, ${idColumn} DESC LIMIT 1 OFFSET ?`,
        repository,
        number,
        limit,
      ),
    );
    if (!boundary) return;
    if (table === "github_webhook_read_model_comments_v1") {
      // A full upstream census is not a complete cache once its row cap drops
      // members. Preserve that fact until another complete repair replaces it.
      this.storage.sql.exec(
        `INSERT INTO github_webhook_read_model_collections_v1
         (repository, number, collection_kind, repaired_at, watermark, complete)
         VALUES (?, ?, 'comments', 0, 0, 0)
         ON CONFLICT (repository, number, collection_kind) DO UPDATE SET complete = 0`,
        repository,
        number,
      );
    }
    // Activity kinds may share an ID: retain every row whose ID is in the top set,
    // even when another row with that ID is older than the overflow boundary.
    this.storage.sql.exec(
      `DELETE FROM ${table}
        WHERE repository = ? AND number = ?
          AND (source_updated_at, ${idColumn}) <= (?, ?)
          AND ${idColumn} NOT IN (
            SELECT ${idColumn} FROM ${table}
             WHERE repository = ? AND number = ?
             ORDER BY source_updated_at DESC, ${idColumn} DESC LIMIT ?
          )`,
      repository,
      number,
      boundary.source_updated_at,
      boundary.id,
      repository,
      number,
      limit,
    );
  }

  nextPayloadMaintenanceAtSync(): number | null {
    let next: number | null = null;
    for (const table of PAYLOAD_TABLES) {
      const row = firstRow(
        this.storage.sql.exec(
          `SELECT MIN(payload_retire_at) AS next_at FROM ${table}
            WHERE payload_pruned = 0 AND payload_retire_at >= 0
              ${table.endsWith("items_v1") ? "" : "AND tombstone = 0"}`,
        ),
      );
      // MIN over an empty eligible index is NULL, not a due timestamp.
      if (row?.next_at !== null && row?.next_at !== undefined) {
        const deadline = Number(row.next_at);
        next = next === null ? deadline : Math.min(next, deadline);
      }
    }
    return next;
  }

  prunePayloadsSync(now: number) {
    const result = { scanned: 0, retired: 0, retired_bytes: 0, deferred: 0, protected: 0 };
    const familyDeadlines = new Map<string, number>();
    // Retain ordering facts and real tombstones: an old unseen delivery must not
    // resurrect a deleted comment or replace a newer, retired payload.
    for (const table of PAYLOAD_TABLES) {
      // Classify at most one bounded candidate batch. Remember protected rows so
      // an expired placeholder prefix cannot be rescanned on every invocation.
      const protectedExpression = table.endsWith("items_v1")
        ? `EXISTS (
             SELECT 1 FROM github_webhook_read_model_comments_v1 c
              WHERE c.repository = ${table}.repository AND c.number = ${table}.number
                AND c.tombstone = 0 AND instr(c.snapshot_json, ?) > 0
           )`
        : table.endsWith("comments_v1")
          ? "instr(snapshot_json, ?) > 0"
          : "0";
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT rowid, repository, number, ${protectedExpression} AS protected,
                  length(CAST(snapshot_json AS BLOB)) AS payload_bytes
             FROM ${table}
            WHERE payload_pruned = 0 AND payload_retire_at >= 0 AND payload_retire_at < ?
              ${table.endsWith("items_v1") ? "" : "AND tombstone = 0"}
            ORDER BY payload_retire_at LIMIT ?`,
          ...(protectedExpression === "0" ? [] : [REVIEW_PLACEHOLDER_MARKER]),
          now,
          GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_PRUNE_LIMIT - result.scanned,
        ),
      );
      for (const row of rows) {
        result.scanned += 1;
        if (row.protected) {
          // Recovery's bounded repair is not a full census. Preserve unresolved
          // placeholder bodies and their parent item snapshots until they change.
          this.storage.sql.exec(
            `UPDATE ${table} SET payload_retire_at = -1 WHERE rowid = ?`,
            row.rowid,
          );
          result.protected += 1;
          continue;
        }
        const familyKey = `${row.repository}#${row.number}`;
        let deadline = familyDeadlines.get(familyKey);
        if (deadline === undefined) {
          const latest = firstRow(
            this.storage.sql.exec(
              `SELECT MAX(received_at) AS received_at FROM (
                 SELECT received_at FROM github_webhook_read_model_items_v1 WHERE repository = ? AND number = ?
                 UNION ALL
                 SELECT received_at FROM github_webhook_read_model_comments_v1 WHERE repository = ? AND number = ?
                 UNION ALL
                 SELECT received_at FROM github_webhook_read_model_activity_v1 WHERE repository = ? AND number = ?
                 UNION ALL
                 SELECT repaired_at FROM github_webhook_read_model_collections_v1 WHERE repository = ? AND number = ?
               )`,
              row.repository,
              row.number,
              row.repository,
              row.number,
              row.repository,
              row.number,
              row.repository,
              row.number,
            ),
          );
          deadline = Number(latest?.received_at) + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS;
          familyDeadlines.set(familyKey, deadline);
        }
        if (deadline >= now) {
          // Persist deferral so a hot prefix cannot consume every bounded pass.
          // Each lookup is scoped to one item and its capped child collections.
          this.storage.sql.exec(
            `UPDATE ${table} SET payload_retire_at = ? WHERE rowid = ?`,
            deadline,
            row.rowid,
          );
          result.deferred += 1;
          continue;
        }
        this.storage.sql.exec(
          `UPDATE ${table} SET snapshot_json = '{}', payload_pruned = 1 WHERE rowid = ?`,
          row.rowid,
        );
        // Only ordinary payloads retire; protected placeholder candidates and
        // their parents survive, so their repository census remains valid.
        this.storage.sql.exec(
          `UPDATE github_webhook_read_model_collections_v1 SET complete = 0
            WHERE repository = ? AND number = ? AND collection_kind = 'comments'`,
          row.repository,
          row.number,
        );
        result.retired += 1;
        result.retired_bytes += Math.max(0, Number(row.payload_bytes) - 2);
      }
      if (result.scanned === GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_PRUNE_LIMIT) break;
    }
    return result;
  }

  private recheckItemProtectionSync(repository: string, number: number): void {
    // Comment replacement, deletion, or a complete repair can remove the last
    // placeholder. Reconsider its parent once, without scanning all history.
    this.storage.sql.exec(
      `UPDATE github_webhook_read_model_items_v1 SET payload_retire_at = 0
        WHERE repository = ? AND number = ? AND payload_retire_at = -1`,
      repository,
      number,
    );
  }

  private pruneSync(now: number): void {
    // Payload maintenance belongs to the queue alarm, not webhook request
    // transactions. Accepted writes arm its persisted deadline after commit.
    this.storage.sql.exec(
      `DELETE FROM github_webhook_read_model_deliveries_v1 WHERE delivery_id IN (
         SELECT delivery_id FROM github_webhook_read_model_deliveries_v1
          WHERE received_at < ? ORDER BY received_at ASC LIMIT 256
       )`,
      now - 30 * 24 * 60 * 60_000,
    );
    // The repository-leading index cannot supply global timestamp order. Avoid
    // sorting at all unless this bounded probe finds an actual overflow.
    if (
      !firstRow(
        this.storage.sql.exec(
          `SELECT rowid FROM github_webhook_read_model_workflows_v1 LIMIT 1 OFFSET ?`,
          GITHUB_WEBHOOK_READ_MODEL_MAX_WORKFLOW_OBJECTS,
        ),
      )
    ) {
      return;
    }
    this.storage.sql.exec(
      `DELETE FROM github_webhook_read_model_workflows_v1 WHERE rowid IN (
         SELECT rowid FROM github_webhook_read_model_workflows_v1
          ORDER BY source_updated_at DESC LIMIT -1 OFFSET ?
       )`,
      GITHUB_WEBHOOK_READ_MODEL_MAX_WORKFLOW_OBJECTS,
    );
  }

  private watermarkSync(): number {
    return Number(
      firstRow(
        this.storage.sql.exec(
          `SELECT watermark FROM github_webhook_read_model_meta_v1 WHERE singleton_id = 1`,
        ),
      )?.watermark || 0,
    );
  }
}

export function githubWebhookReadModelDeliveryFromValue(
  value: unknown,
): GithubWebhookReadModelDelivery | null {
  const body = record(value);
  if (body.version !== 1) return null;
  const deliveryId = stringValue(body.deliveryId);
  const event = stringValue(body.event);
  const action = stringValue(body.action);
  const receivedAt = timestamp(stringValue(body.receivedAt));
  const eventClasses = Array.isArray(body.eventClasses)
    ? body.eventClasses.filter(isEventClass)
    : [];
  const objects = Array.isArray(body.objects)
    ? body.objects.map(githubWebhookReadModelObjectFromValue).filter(nonNullable)
    : [];
  if (
    !deliveryId ||
    deliveryId.length > 200 ||
    !event ||
    !receivedAt ||
    eventClasses.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    deliveryId,
    event,
    action,
    receivedAt,
    eventClasses: [...new Set(eventClasses)],
    objects,
  };
}

export function githubWebhookReadModelObjectFromValue(
  value: unknown,
): GithubWebhookReadModelObject | null {
  const body = record(value);
  const kind = stringValue(body.kind);
  const repository = normalizedRepository(body.repository);
  const sourceUpdatedAt = timestamp(stringValue(body.sourceUpdatedAt));
  const snapshot = boundedSnapshot(body.snapshot);
  if (!repository || !sourceUpdatedAt || !snapshot) return null;
  if (kind === "item") {
    const number = positiveInteger(body.number);
    const itemKind =
      body.itemKind === "pull_request"
        ? "pull_request"
        : body.itemKind === "issue"
          ? "issue"
          : null;
    return number && itemKind
      ? { kind, repository, number, itemKind, sourceUpdatedAt, snapshot }
      : null;
  }
  if (kind === "comment" || kind === "review" || kind === "review_comment") {
    const number = positiveInteger(body.number);
    const id = positiveInteger(body.id);
    return number && id
      ? {
          kind,
          repository,
          number,
          id,
          sourceUpdatedAt,
          tombstone: body.tombstone === true,
          snapshot,
        }
      : null;
  }
  if (
    kind === "workflow_run" ||
    kind === "workflow_job" ||
    kind === "check_run" ||
    kind === "check_suite"
  ) {
    const id = positiveInteger(body.id);
    const runId =
      body.runId === null || body.runId === undefined ? null : positiveInteger(body.runId);
    return id && (runId !== null || body.runId === null || body.runId === undefined)
      ? { kind, repository, id, runId, sourceUpdatedAt, snapshot }
      : null;
  }
  return null;
}

function freshness(
  row: SqlRow | undefined,
  ttlMs: number,
  now: number,
): GithubWebhookReadModelFreshness {
  if (!row) return { stale: true, age_ms: null, ttl_ms: ttlMs, source_updated_at: null };
  const receivedAt = Number(row.received_at);
  const sourceUpdatedAt = Number(row.source_updated_at);
  const age = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : null;
  return {
    stale: age === null || age > ttlMs,
    age_ms: age,
    ttl_ms: ttlMs,
    source_updated_at: Number.isFinite(sourceUpdatedAt)
      ? new Date(sourceUpdatedAt).toISOString()
      : null,
  };
}

function boundedSnapshot(value: unknown): JsonRecord | null {
  const snapshot = record(value);
  const copy = { ...snapshot };
  if (typeof copy.body === "string") {
    const bytes = new TextEncoder().encode(copy.body);
    if (bytes.byteLength > GITHUB_WEBHOOK_READ_MODEL_MAX_COMMENT_BODY_BYTES) {
      copy.body = new TextDecoder().decode(
        bytes.slice(0, GITHUB_WEBHOOK_READ_MODEL_MAX_COMMENT_BODY_BYTES),
      );
      copy.body_truncated = true;
    }
  }
  return JSON.stringify(copy).length <= 256 * 1_024 ? copy : null;
}

function itemSnapshotWithKind(snapshot: JsonRecord, itemKind: unknown): JsonRecord {
  // Raw PR webhooks lack the Issues API marker. Preserve the recorded kind for
  // every consumer, including rows stored before normalization added the marker.
  return itemKind === "pull_request"
    ? { ...snapshot, pull_request: record(snapshot.pull_request) }
    : snapshot;
}

function normalizedItemSnapshot(
  source: JsonRecord,
  itemKind: "issue" | "pull_request",
): JsonRecord {
  const user = record(source.user);
  const labels = Array.isArray(source.labels)
    ? source.labels.flatMap((value) => {
        if (typeof value === "string") return [{ name: value }];
        const label = record(value);
        return typeof label.name === "string" ? [{ name: label.name }] : [];
      })
    : [];
  const snapshot: JsonRecord = {
    number: positiveInteger(source.number),
    title: typeof source.title === "string" ? source.title : "",
    body: typeof source.body === "string" || source.body === null ? source.body : null,
    html_url: typeof source.html_url === "string" ? source.html_url : "",
    created_at: timestamp(stringValue(source.created_at)),
    updated_at: sourceTimestamp(source, new Date(0).toISOString()),
    closed_at: timestamp(stringValue(source.closed_at)),
    state: stringValue(source.state).toLowerCase() || "unknown",
    state_reason: source.state_reason ?? null,
    locked: source.locked === true,
    active_lock_reason: source.active_lock_reason ?? null,
    author_association: stringValue(source.author_association),
    user: {
      login: stringValue(user.login),
      type: stringValue(user.type),
    },
    labels,
    comments: Number.isFinite(Number(source.comments)) ? Number(source.comments) : null,
  };
  if (itemKind === "pull_request") {
    if (source.pull_request) snapshot.pull_request = record(source.pull_request);
    if (typeof source.draft === "boolean") snapshot.draft = source.draft;
    if (Object.keys(record(source.head)).length > 0)
      snapshot.head = boundedSnapshot(source.head) ?? {};
    if (Object.keys(record(source.base)).length > 0)
      snapshot.base = boundedSnapshot(source.base) ?? {};
    if (Number.isFinite(Number(source.review_comments))) {
      snapshot.review_comments = Number(source.review_comments);
    }
    if (Number.isFinite(Number(source.commits))) snapshot.commits = Number(source.commits);
  }
  return boundedSnapshot(snapshot) ?? {};
}

function normalizedCommentSnapshot(source: JsonRecord, tombstone: boolean): JsonRecord {
  const user = record(source.user);
  return (
    boundedSnapshot({
      id: positiveInteger(source.id),
      body: tombstone ? null : typeof source.body === "string" ? source.body : "",
      created_at: timestamp(stringValue(source.created_at)),
      updated_at: sourceTimestamp(source, new Date(0).toISOString()),
      html_url: typeof source.html_url === "string" ? source.html_url : "",
      author_association: stringValue(source.author_association),
      user: { login: stringValue(user.login), type: stringValue(user.type) },
      tombstone,
    }) ?? { id: positiveInteger(source.id), tombstone }
  );
}

function sourceTimestamp(source: JsonRecord, fallback: string): string {
  for (const value of [
    source.updated_at,
    source.submitted_at,
    source.completed_at,
    source.started_at,
    source.created_at,
    fallback,
  ]) {
    const normalized = timestamp(stringValue(value));
    if (normalized) return normalized;
  }
  return new Date(0).toISOString();
}

function workflowObjectKind(
  event: string,
): "workflow_run" | "workflow_job" | "check_run" | "check_suite" | null {
  if (event === "workflow_run") return "workflow_run";
  if (event === "workflow_job") return "workflow_job";
  if (event === "check_run") return "check_run";
  if (event === "check_suite") return "check_suite";
  return null;
}

function isEventClass(value: unknown): value is GithubWebhookReadModelEventClass {
  return (
    value === "issues" ||
    value === "pull_requests" ||
    value === "issue_comments" ||
    value === "pull_request_reviews" ||
    value === "pull_request_review_comments" ||
    value === "workflow_runs" ||
    value === "workflow_jobs" ||
    value === "checks"
  );
}

function normalizedRepository(value: unknown): string | null {
  const repository = stringValue(value).toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ? repository : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function timestamp(value: string): string | null {
  return timestampMs(value) === null ? null : new Date(Date.parse(value)).toISOString();
}

function timestampMs(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function strictTimestampMs(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseJsonRecord(value: string): JsonRecord {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function firstRow(rows: Iterable<SqlRow>): SqlRow | undefined {
  return Array.from(rows)[0];
}

function nonNullable<T>(value: T | null): value is T {
  return value !== null;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
