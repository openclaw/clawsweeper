export const EXACT_REVIEW_DIRECT_PUBLICATION_TABLE = "exact_review_direct_publication_plans";
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES = 4 * 1024 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_COMMIT_BYTES = 20 * 1024 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_FILE_THRESHOLD = 64;
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILES = 512;
export const EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const EXACT_REVIEW_DIRECT_PUBLICATION_CADENCE_MS = 15_000;
export const EXACT_REVIEW_DIRECT_PUBLICATION_RETRY_LIMIT = 12;

const OID_PATTERN = /^[a-f0-9]{40,64}$/;
const MAX_PATH_BYTES = 1024;

type SqlStorage = {
  exec: (query: string, ...bindings: unknown[]) => Iterable<Record<string, unknown>>;
};

type DurableStorage = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

export type DirectPublicationOperation = {
  path: string;
  expectedOid: string | null;
  targetOid: string | null;
  mode: "100644";
  bytes: number;
  contentBase64?: string;
};

export type DirectPublicationPlan = {
  itemKey: string;
  revision: number;
  identity: { itemKey: string; revision: number; claimGeneration: number };
  operations: DirectPublicationOperation[];
  totalBytes: number;
};

export type DirectPublicationRow = DirectPublicationPlan & {
  state: "pending" | "committing" | "retryable" | "published" | "superseded" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  commitSha: string | null;
  failureReason: string | null;
};

export type DirectPublicationAcceptResult = {
  outcome: "accepted" | "deduped" | "superseded";
  row: DirectPublicationRow;
  supersededRevisions: number[];
};

export type DirectPublicationCommitApi = {
  readHead: () => Promise<{ commitSha: string; treeSha: string; paths: Map<string, string> }>;
  createBlob: (contentBase64: string) => Promise<string>;
  createTree: (
    baseTreeSha: string,
    entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }>,
  ) => Promise<string>;
  createCommit: (message: string, treeSha: string, parentSha: string) => Promise<string>;
  updateRef: (commitSha: string) => Promise<void>;
};

export class DirectPublicationRefRaceError extends Error {
  constructor() {
    super("state ref changed while publishing direct exact-review results");
    this.name = "DirectPublicationRefRaceError";
  }
}

export class ExactReviewDirectPublicationStore {
  private readonly storage: DurableStorage;

  constructor(storage: DurableStorage) {
    this.storage = storage;
  }

  ensureSchemaSync() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} (
         item_key TEXT NOT NULL,
         revision INTEGER NOT NULL CHECK (revision >= 1),
         identity_item_key TEXT NOT NULL,
         identity_revision INTEGER NOT NULL CHECK (identity_revision >= 1),
         claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
         operations_json TEXT NOT NULL,
         total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
         file_count INTEGER NOT NULL CHECK (file_count >= 1),
         state TEXT NOT NULL CHECK (
           state IN ('pending', 'committing', 'retryable', 'published', 'superseded', 'failed')
         ),
         attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         next_attempt_at INTEGER NOT NULL,
         commit_sha TEXT,
         failure_reason TEXT,
         PRIMARY KEY (item_key, revision)
       ) STRICT`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS exact_review_direct_publication_ready
         ON ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
         (state, next_attempt_at, created_at, item_key, revision)`,
    );
  }

  accept(plan: DirectPublicationPlan, now: number): DirectPublicationAcceptResult {
    const validated = validateDirectPublicationPlan(plan);
    return this.storage.transactionSync(() => {
      const existing = this.readSync(validated.itemKey, validated.revision);
      if (existing) {
        if (canonicalPlan(existing) !== canonicalPlan(validated)) {
          throw new Error("conflicting direct publication retry");
        }
        return { outcome: "deduped" as const, row: existing, supersededRevisions: [] };
      }
      const newer = Array.from(
        this.storage.sql.exec(
          `SELECT revision FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            WHERE item_key = ? AND revision > ?
            ORDER BY revision DESC LIMIT 1`,
          validated.itemKey,
          validated.revision,
        ),
      )[0];
      if (newer) {
        const row: DirectPublicationRow = {
          ...validated,
          state: "superseded",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now,
          commitSha: null,
          failureReason: "newer_revision_already_staged",
        };
        this.insertSync(row);
        return { outcome: "superseded" as const, row, supersededRevisions: [] };
      }
      const supersededRevisions = Array.from(
        this.storage.sql.exec(
          `SELECT revision FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            WHERE item_key = ? AND revision < ?
              AND state IN ('pending', 'retryable', 'committing')
            ORDER BY revision`,
          validated.itemKey,
          validated.revision,
        ),
        (row) => Number(row.revision),
      );
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            SET state = 'superseded', updated_at = ?, failure_reason = 'newer_revision_staged'
          WHERE item_key = ? AND revision < ?
            AND state IN ('pending', 'retryable', 'committing')`,
        now,
        validated.itemKey,
        validated.revision,
      );
      const row: DirectPublicationRow = {
        ...validated,
        state: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
        commitSha: null,
        failureReason: null,
      };
      this.insertSync(row);
      return { outcome: "accepted" as const, row, supersededRevisions };
    });
  }

  nextWakeAt(now: number): number | null {
    const summary = Array.from(
      this.storage.sql.exec(
        `SELECT MIN(created_at) AS oldest_at, MIN(next_attempt_at) AS retry_at,
                COALESCE(SUM(CASE WHEN next_attempt_at <= ? THEN file_count ELSE 0 END), 0)
                  AS files
           FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          WHERE state IN ('pending', 'retryable')`,
        now,
      ),
    )[0];
    if (summary?.oldest_at === null || summary?.oldest_at === undefined) return null;
    const retryAt = Number(summary.retry_at);
    const cadenceAt = Number(summary.oldest_at) + EXACT_REVIEW_DIRECT_PUBLICATION_CADENCE_MS;
    return Number(summary.files) >= EXACT_REVIEW_DIRECT_PUBLICATION_FILE_THRESHOLD
      ? Math.max(now, retryAt)
      : Math.max(retryAt, cadenceAt);
  }

  claimCycle(now: number): DirectPublicationRow[] {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            SET state = 'retryable', next_attempt_at = ?, updated_at = ?,
                failure_reason = 'stale_inflight_recovery'
          WHERE state = 'committing' AND updated_at <= ?`,
        now,
        now,
        now - 30 * 60_000,
      );
      const rows = Array.from(
        this.storage.sql.exec(
          `SELECT * FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
            WHERE state IN ('pending', 'retryable') AND next_attempt_at <= ?
            ORDER BY created_at, item_key, revision`,
          now,
        ),
        directPublicationRow,
      );
      const selected: DirectPublicationRow[] = [];
      let stagedBytes = 0;
      for (const row of rows) {
        if (stagedBytes + row.totalBytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_COMMIT_BYTES) break;
        selected.push(row);
        stagedBytes += row.totalBytes;
      }
      for (const row of selected) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              SET state = 'committing', updated_at = ?
            WHERE item_key = ? AND revision = ? AND state IN ('pending', 'retryable')`,
          now,
          row.itemKey,
          row.revision,
        );
        row.state = "committing";
        row.updatedAt = now;
      }
      return selected;
    });
  }

  complete(rows: readonly DirectPublicationRow[], commitSha: string, now: number) {
    this.storage.transactionSync(() => {
      for (const row of rows) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              SET state = 'published', commit_sha = ?, updated_at = ?, failure_reason = NULL
            WHERE item_key = ? AND revision = ? AND state = 'committing'`,
          commitSha,
          now,
          row.itemKey,
          row.revision,
        );
      }
    });
  }

  supersede(rows: readonly DirectPublicationRow[], now: number, reason = "newer_queue_revision") {
    this.storage.transactionSync(() => {
      for (const row of rows) {
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              SET state = 'superseded', updated_at = ?, failure_reason = ?
            WHERE item_key = ? AND revision = ?
              AND state IN ('pending', 'retryable', 'committing')`,
          now,
          reason,
          row.itemKey,
          row.revision,
        );
      }
    });
  }

  retry(rows: readonly DirectPublicationRow[], reason: string, now: number) {
    this.storage.transactionSync(() => {
      for (const row of rows) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= EXACT_REVIEW_DIRECT_PUBLICATION_RETRY_LIMIT;
        this.storage.sql.exec(
          `UPDATE ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
              SET state = ?, attempts = ?, updated_at = ?, next_attempt_at = ?, failure_reason = ?
            WHERE item_key = ? AND revision = ? AND state = 'committing'`,
          exhausted ? "failed" : "retryable",
          attempts,
          now,
          now + directPublicationRetryDelayMs(attempts),
          reason.slice(0, 500),
          row.itemKey,
          row.revision,
        );
      }
    });
  }

  list(): DirectPublicationRow[] {
    return Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE} ORDER BY item_key, revision`,
      ),
      directPublicationRow,
    );
  }

  private readSync(itemKey: string, revision: number) {
    const row = Array.from(
      this.storage.sql.exec(
        `SELECT * FROM ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
          WHERE item_key = ? AND revision = ?`,
        itemKey,
        revision,
      ),
    )[0];
    return row ? directPublicationRow(row) : null;
  }

  private insertSync(row: DirectPublicationRow) {
    this.storage.sql.exec(
      `INSERT INTO ${EXACT_REVIEW_DIRECT_PUBLICATION_TABLE}
       (item_key, revision, identity_item_key, identity_revision, claim_generation,
        operations_json, total_bytes, file_count, state, attempts, created_at, updated_at,
        next_attempt_at, commit_sha, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.itemKey,
      row.revision,
      row.identity.itemKey,
      row.identity.revision,
      row.identity.claimGeneration,
      JSON.stringify(row.operations),
      row.totalBytes,
      row.operations.length,
      row.state,
      row.attempts,
      row.createdAt,
      row.updatedAt,
      row.nextAttemptAt,
      row.commitSha,
      row.failureReason,
    );
  }
}

export async function commitDirectPublicationCycle(options: {
  store: ExactReviewDirectPublicationStore;
  api: DirectPublicationCommitApi;
  now: number;
  message?: string;
}): Promise<{
  commitSha: string | null;
  published: DirectPublicationRow[];
  retryable: DirectPublicationRow[];
}> {
  const claimed = options.store.claimCycle(options.now);
  if (!claimed.length) return { commitSha: null, published: [], retryable: [] };
  let remaining = claimed;
  const published: DirectPublicationRow[] = [];
  try {
    for (let refAttempt = 1; refAttempt <= 3; refAttempt += 1) {
      let head = await options.api.readHead();
      const alreadyApplied = remaining.filter((row) => targetOidsMatch(row, head.paths));
      if (alreadyApplied.length) {
        options.store.complete(alreadyApplied, head.commitSha, options.now);
        published.push(...alreadyApplied);
        const appliedKeys = new Set(alreadyApplied.map((row) => `${row.itemKey}\0${row.revision}`));
        remaining = remaining.filter((row) => !appliedKeys.has(`${row.itemKey}\0${row.revision}`));
      }
      if (!remaining.length) {
        return { commitSha: head.commitSha, published, retryable: [] };
      }
      let conflicts = remaining.filter((row) => !expectedOidsMatch(row, head.paths));
      if (conflicts.length) {
        // A materializer may have advanced the state ref between producer
        // preparation and this alarm. Re-read once before spending a retry.
        head = await options.api.readHead();
        conflicts = remaining.filter((row) => !expectedOidsMatch(row, head.paths));
      }
      if (conflicts.length) {
        options.store.retry(conflicts, "expected_oid_conflict", options.now);
        const conflictKeys = new Set(conflicts.map((row) => `${row.itemKey}\0${row.revision}`));
        remaining = remaining.filter((row) => !conflictKeys.has(`${row.itemKey}\0${row.revision}`));
      }
      if (!remaining.length)
        return {
          commitSha: published.length ? head.commitSha : null,
          published,
          retryable: claimed.filter((row) => !published.includes(row)),
        };
      const compatibility = compatibleDirectPublicationPlans(remaining);
      if (compatibility.conflicts.length) {
        options.store.retry(
          compatibility.conflicts,
          "incompatible_same_path_mutation",
          options.now,
        );
        remaining = compatibility.plans;
      }
      if (!remaining.length)
        return {
          commitSha: published.length ? head.commitSha : null,
          published,
          retryable: claimed.filter((row) => !published.includes(row)),
        };

      const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
      for (const row of remaining) {
        for (const operation of row.operations) {
          if (operation.targetOid === null) {
            entries.push({ path: operation.path, mode: operation.mode, type: "blob", sha: null });
            continue;
          }
          const oid = await options.api.createBlob(operation.contentBase64!);
          if (oid !== operation.targetOid) {
            options.store.retry([row], "prepared_blob_oid_mismatch", options.now);
            const rowKey = `${row.itemKey}\0${row.revision}`;
            remaining = remaining.filter(
              (candidate) => `${candidate.itemKey}\0${candidate.revision}` !== rowKey,
            );
            break;
          }
          entries.push({ path: operation.path, mode: operation.mode, type: "blob", sha: oid });
        }
      }
      if (!remaining.length)
        return {
          commitSha: published.length ? head.commitSha : null,
          published,
          retryable: claimed.filter((row) => !published.includes(row)),
        };
      const remainingPaths = new Set(
        remaining.flatMap((row) => row.operations.map((op) => op.path)),
      );
      const filteredEntries = [
        ...new Map(
          entries
            .filter((entry) => remainingPaths.has(entry.path))
            .map((entry) => [entry.path, entry] as const),
        ).values(),
      ];
      const treeSha = await options.api.createTree(head.treeSha, filteredEntries);
      const commitSha = await options.api.createCommit(
        options.message ?? `chore(state): publish ${remaining.length} exact-review result(s)`,
        treeSha,
        head.commitSha,
      );
      try {
        await options.api.updateRef(commitSha);
        options.store.complete(remaining, commitSha, options.now);
        published.push(...remaining);
        return {
          commitSha,
          published,
          retryable: claimed.filter((row) => !published.includes(row)),
        };
      } catch (error) {
        if (!(error instanceof DirectPublicationRefRaceError) || refAttempt === 3) {
          options.store.retry(remaining, errorMessage(error), options.now);
          return { commitSha: null, published: [], retryable: claimed };
        }
      }
    }
  } catch (error) {
    options.store.retry(remaining, errorMessage(error), options.now);
    return { commitSha: null, published: [], retryable: claimed };
  }
  options.store.retry(remaining, "state_ref_race", options.now);
  return { commitSha: null, published: [], retryable: claimed };
}

export function validateDirectPublicationPlan(value: DirectPublicationPlan): DirectPublicationPlan {
  const plan = value && typeof value === "object" ? value : ({} as DirectPublicationPlan);
  const itemKey = boundedItemKey(plan.itemKey);
  if (!itemKey) throw new Error("invalid direct publication item key");
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error("invalid direct publication revision");
  }
  const identity = plan.identity;
  if (
    !identity ||
    !boundedItemKey(identity.itemKey) ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 1 ||
    !Number.isSafeInteger(identity.claimGeneration) ||
    identity.claimGeneration < 1
  ) {
    throw new Error("invalid direct publication identity");
  }
  if (!Array.isArray(plan.operations) || !plan.operations.length) {
    throw new Error("a direct publication plan must change a path");
  }
  if (plan.operations.length > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILES) {
    throw new Error("a direct publication plan exceeds the exact-review file limit");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const operations = plan.operations.map((raw): DirectPublicationOperation => {
    const operation = raw && typeof raw === "object" ? raw : ({} as DirectPublicationOperation);
    const path = canonicalPath(operation.path);
    if (path !== operation.path || paths.has(path)) {
      throw new Error(`invalid or repeated direct publication path: ${String(operation.path)}`);
    }
    paths.add(path);
    if (operation.expectedOid !== null && !OID_PATTERN.test(String(operation.expectedOid))) {
      throw new Error(`invalid expected object id for ${path}`);
    }
    if (operation.targetOid !== null && !OID_PATTERN.test(String(operation.targetOid))) {
      throw new Error(`invalid target object id for ${path}`);
    }
    if (operation.mode !== "100644") throw new Error(`invalid mutation mode for ${path}`);
    if (
      !Number.isSafeInteger(operation.bytes) ||
      operation.bytes < 0 ||
      operation.bytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES
    ) {
      throw new Error(`invalid mutation byte count for ${path}`);
    }
    if (operation.targetOid === null) {
      if (operation.bytes !== 0 || operation.contentBase64 !== undefined) {
        throw new Error(`deleted mutation paths must not carry content: ${path}`);
      }
      return {
        path,
        expectedOid: operation.expectedOid,
        targetOid: null,
        mode: "100644",
        bytes: 0,
      };
    }
    const contentBase64 = operation.contentBase64;
    if (
      typeof contentBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
    ) {
      throw new Error(`missing or invalid mutation content for ${path}`);
    }
    const decodedBytes = base64DecodedBytes(contentBase64);
    if (decodedBytes !== operation.bytes) {
      throw new Error(`mutation byte count does not match content for ${path}`);
    }
    totalBytes += decodedBytes;
    return {
      path,
      expectedOid: operation.expectedOid,
      targetOid: operation.targetOid,
      mode: "100644",
      bytes: decodedBytes,
      contentBase64,
    };
  });
  if (!Number.isSafeInteger(plan.totalBytes) || plan.totalBytes !== totalBytes) {
    throw new Error("direct publication total does not match its operations");
  }
  if (totalBytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_POST_BYTES) {
    throw new Error("direct publication plan exceeds the per-POST byte limit");
  }
  return {
    itemKey,
    revision: plan.revision,
    identity: { ...identity, itemKey: identity.itemKey.trim() },
    operations,
    totalBytes,
  };
}

export async function validateDirectPublicationBlobOids(value: DirectPublicationPlan) {
  const plan = validateDirectPublicationPlan(value);
  for (const operation of plan.operations) {
    if (operation.targetOid === null) continue;
    const content = base64Bytes(operation.contentBase64!);
    const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
    const input = new Uint8Array(header.byteLength + content.byteLength);
    input.set(header);
    input.set(content, header.byteLength);
    const algorithm = operation.targetOid.length === 64 ? "SHA-256" : "SHA-1";
    const digest = new Uint8Array(await crypto.subtle.digest(algorithm, input));
    const oid = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (oid !== operation.targetOid) {
      throw new Error(`prepared mutation target does not match content for ${operation.path}`);
    }
  }
  return plan;
}

function directPublicationRow(row: Record<string, unknown>): DirectPublicationRow {
  return {
    itemKey: String(row.item_key),
    revision: Number(row.revision),
    identity: {
      itemKey: String(row.identity_item_key),
      revision: Number(row.identity_revision),
      claimGeneration: Number(row.claim_generation),
    },
    operations: JSON.parse(String(row.operations_json)) as DirectPublicationOperation[],
    totalBytes: Number(row.total_bytes),
    state: row.state as DirectPublicationRow["state"],
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextAttemptAt: Number(row.next_attempt_at),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
  };
}

function canonicalPlan(plan: DirectPublicationPlan) {
  return JSON.stringify({
    itemKey: plan.itemKey,
    revision: plan.revision,
    identity: plan.identity,
    operations: plan.operations,
    totalBytes: plan.totalBytes,
  });
}

function expectedOidsMatch(row: DirectPublicationRow, paths: ReadonlyMap<string, string>) {
  return row.operations.every(
    (operation) => (paths.get(operation.path) ?? null) === operation.expectedOid,
  );
}

function targetOidsMatch(row: DirectPublicationRow, paths: ReadonlyMap<string, string>) {
  return row.operations.every(
    (operation) => (paths.get(operation.path) ?? null) === operation.targetOid,
  );
}

function compatibleDirectPublicationPlans(rows: readonly DirectPublicationRow[]) {
  const byPath = new Map<string, DirectPublicationOperation>();
  const plans: DirectPublicationRow[] = [];
  const conflicts: DirectPublicationRow[] = [];
  for (const row of rows) {
    const incompatible = row.operations.some((operation) => {
      const existing = byPath.get(operation.path);
      return Boolean(
        existing &&
        (existing.expectedOid !== operation.expectedOid ||
          existing.targetOid !== operation.targetOid ||
          existing.mode !== operation.mode ||
          existing.bytes !== operation.bytes ||
          existing.contentBase64 !== operation.contentBase64),
      );
    });
    if (incompatible) {
      conflicts.push(row);
      continue;
    }
    plans.push(row);
    for (const operation of row.operations) byPath.set(operation.path, operation);
  }
  return { plans, conflicts };
}

function boundedItemKey(value: unknown) {
  const text = String(value || "").trim();
  return text && text.length <= 500 && !/[\0\r\n]/.test(text) ? text : "";
}

function canonicalPath(value: unknown) {
  const path = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    /[\0\r\n]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
    new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES
  ) {
    throw new Error(`invalid bounded state mutation path: ${String(value)}`);
  }
  return path;
}

function base64DecodedBytes(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function directPublicationRetryDelayMs(attempt: number) {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
