import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseSimpleYaml, validateJob } from "./lib.js";

export const CLUSTER_INTAKE_SCHEMA = "clawsweeper-cluster-intake-intent-v1";
export const CLUSTER_INTAKE_LEDGER_SCHEMA = "clawsweeper-cluster-repair-intake-v2";
const CLUSTER_INTAKE_MAX_RECORD_BYTES = 240 * 1024;
export const CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES = 65_535;
const GITHUB_REF_MAX_BYTES = 255;
const CLUSTER_DISPATCH_AUTH_DOMAIN = "clawsweeper-cluster-dispatch-v1";

export type ClusterIntakeJob = {
  cluster_id: number;
  path: string;
  content: string;
  digest: string;
  dispatch_key: string;
};

export type ClusterIntakeIntent = {
  schema: typeof CLUSTER_INTAKE_SCHEMA;
  target_repo: string;
  repo_slug: string;
  store_sha256: string;
  store_exported_at: string;
  manifest_path: string;
  run_url: string;
  accepted_at: string;
  runner: string;
  execution_runner: string;
  model: string;
  selector_summary: { evaluated: number; rejected: number; reason_counts: Record<string, number> };
  jobs: ClusterIntakeJob[];
};

export type ClusterLedgerEntry = {
  cluster_id: number;
  job: string;
  dispatch_key: string;
  digest: string;
  runner: string;
  execution_runner: string;
  model: string;
  status: "dispatch_pending" | "dispatch_claimed" | "dispatched";
  accepted_at: string;
  dispatch_claimed_at?: string;
  dispatched_at?: string;
  dispatch_run_id?: number;
  dispatch_run_url?: string;
};

type StoreLedgerEntry = {
  store_sha256: string;
  store_exported_at: string;
  accepted_at: string;
  run_url: string;
  outcome:
    | "selector_rejected"
    | "duplicate_skipped"
    | "dispatch_pending"
    | "dispatch_claimed"
    | "dispatched";
  generated_jobs: string[];
  selector_summary: ClusterIntakeIntent["selector_summary"];
};

export type ClusterIntakeLedger = {
  schema: typeof CLUSTER_INTAKE_LEDGER_SCHEMA;
  target_repo: string;
  last_processed_store_sha256: string;
  last_processed_store_exported_at: string;
  generated_count: number;
  generated_jobs: string[];
  run_url: string;
  updated_at: string;
  stores: StoreLedgerEntry[];
  clusters: Record<string, ClusterLedgerEntry>;
};

export type ClusterDispatchAuthenticationFields = {
  jobPath: string;
  jobDigest: string;
  dispatchKey: string;
  mode: string;
  runner: string;
  executionRunner: string;
  plannerSandbox: string;
  model: string;
  dryRun: string;
};

export type ClusterWorkflowDispatchPolicy = {
  runner: string;
  executionRunner: string;
  model: string;
  jobAuth: string;
};

export function clusterWorkflowDispatchInputs(
  job: ClusterIntakeJob,
  policy: ClusterWorkflowDispatchPolicy,
): Record<string, string> {
  const inputs = {
    job: job.path,
    dispatch_key: job.dispatch_key,
    mode: "autonomous",
    runner: policy.runner,
    execution_runner: policy.executionRunner,
    model: policy.model,
    planner_sandbox: "read-only",
    dry_run: "false",
    job_payload: Buffer.from(job.content).toString("base64"),
    job_digest: job.digest,
    job_auth: policy.jobAuth,
  };
  // GitHub caps the workflow_dispatch payload at 65,535 bytes. Validate every
  // durable job against the full request shape, reserving the maximum ref size,
  // so a successfully appended intent can never be permanently undispatchable.
  const requestBytes = Buffer.byteLength(
    JSON.stringify({ ref: "r".repeat(GITHUB_REF_MAX_BYTES), inputs }),
  );
  if (requestBytes > CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `cluster intake job exceeds workflow dispatch input limit (${requestBytes} > ${CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES})`,
    );
  }
  return inputs;
}

export function clusterDispatchAuthenticationTag(
  secret: string,
  fields: ClusterDispatchAuthenticationFields,
): string {
  if (!secret) throw new Error("cluster dispatch authentication secret is required");
  const message = [
    CLUSTER_DISPATCH_AUTH_DOMAIN,
    fields.jobPath,
    fields.jobDigest,
    fields.dispatchKey,
    fields.mode,
    fields.runner,
    fields.executionRunner,
    fields.plannerSandbox,
    fields.model,
    fields.dryRun,
  ].join("\n");
  return `sha256=${createHmac("sha256", secret).update(message).digest("hex")}`;
}

export function verifyClusterDispatchAuthenticationTag(
  secret: string,
  fields: ClusterDispatchAuthenticationFields,
  suppliedTag: string,
): void {
  const expected = Buffer.from(clusterDispatchAuthenticationTag(secret, fields));
  const supplied = Buffer.from(suppliedTag);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("cluster dispatch authentication failed");
  }
}

export function clusterIntakeIntent(value: unknown): ClusterIntakeIntent {
  if (!isRecord(value) || value.schema !== CLUSTER_INTAKE_SCHEMA) {
    throw new Error("invalid cluster intake schema");
  }
  const targetRepo = String(value.target_repo || "").trim();
  const repoSlug = String(value.repo_slug || "").trim();
  const expectedSlug = targetRepo.replace("/", "-");
  const storeSha = String(value.store_sha256 || "")
    .trim()
    .toLowerCase();
  const exportedAt = isoDate(value.store_exported_at, "store_exported_at");
  const acceptedAt = isoDate(value.accepted_at, "accepted_at");
  const manifestPath = String(value.manifest_path || "").trim();
  const runUrl = String(value.run_url || "").trim();
  const runner = workerSetting(value.runner, "runner");
  const executionRunner = workerSetting(value.execution_runner, "execution_runner");
  const model = workerSetting(value.model, "model");
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(targetRepo) || repoSlug !== expectedSlug) {
    throw new Error("cluster intake target repository fence mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(storeSha)) throw new Error("invalid cluster intake store SHA");
  if (!manifestPath || !runUrl.startsWith("https://github.com/")) {
    throw new Error("invalid cluster intake provenance");
  }
  const selectorSummary = selectorSummaryFrom(value.selector_summary);
  if (!Array.isArray(value.jobs) || value.jobs.length > 2) {
    throw new Error("invalid cluster intake jobs");
  }
  const seenClusters = new Set<number>();
  const seenPaths = new Set<string>();
  const jobs = value.jobs.map((raw): ClusterIntakeJob => {
    if (!isRecord(raw)) throw new Error("cluster intake job must be an object");
    const clusterId = Number(raw.cluster_id);
    const path = String(raw.path || "").trim();
    const content = String(raw.content ?? "");
    const digest = String(raw.digest || "")
      .trim()
      .toLowerCase();
    const dispatchKey = String(raw.dispatch_key || "").trim();
    const pathPattern = new RegExp(
      `^jobs/${escapeRegex(targetRepo.split("/")[0]!)}/inbox/gitcrawl-${clusterId}-[^/]+\\.md$`,
    );
    if (
      !Number.isSafeInteger(clusterId) ||
      clusterId < 1 ||
      !pathPattern.test(path) ||
      seenClusters.has(clusterId) ||
      seenPaths.has(path) ||
      content.length === 0 ||
      // workflow_dispatch inputs share a 65,535-character payload budget. Keep
      // the raw job below 32 KiB so its base64 form and the other inputs fit.
      Buffer.byteLength(content) > 32 * 1024 ||
      createHash("sha256").update(content).digest("hex") !== digest ||
      dispatchKey !== `cluster-intake:${repoSlug}:${clusterId}`
    ) {
      throw new Error(`invalid cluster intake job fence: ${path || clusterId}`);
    }
    validateClusterJobContent(content, targetRepo, clusterId);
    seenClusters.add(clusterId);
    seenPaths.add(path);
    const job = { cluster_id: clusterId, path, content, digest, dispatch_key: dispatchKey };
    clusterWorkflowDispatchInputs(job, {
      runner,
      executionRunner,
      model,
      jobAuth: `sha256=${"0".repeat(64)}`,
    });
    return job;
  });
  const intent: ClusterIntakeIntent = {
    schema: CLUSTER_INTAKE_SCHEMA,
    target_repo: targetRepo,
    repo_slug: repoSlug,
    store_sha256: storeSha,
    store_exported_at: exportedAt,
    manifest_path: manifestPath,
    run_url: runUrl,
    accepted_at: acceptedAt,
    runner,
    execution_runner: executionRunner,
    model,
    selector_summary: selectorSummary,
    jobs,
  };
  if (Buffer.byteLength(JSON.stringify(intent)) > CLUSTER_INTAKE_MAX_RECORD_BYTES) {
    throw new Error("cluster intake intent exceeds durable queue record limit");
  }
  return intent;
}

export function mergeClusterIntakeLedger(
  currentText: string | undefined,
  intents: readonly ClusterIntakeIntent[],
): ClusterIntakeLedger {
  const first = intents[0];
  if (!first) throw new Error("cluster intake ledger merge requires an intent");
  const current = parseLedger(currentText, first.target_repo);
  const stores = new Map(current.stores.map((entry) => [entry.store_sha256, entry]));
  const clusters = { ...current.clusters };
  for (const intent of intents) {
    if (intent.target_repo !== first.target_repo)
      throw new Error("mixed cluster intake repositories");
    const existingStore = stores.get(intent.store_sha256);
    if (existingStore) continue;
    const generatedJobs: string[] = [];
    for (const job of intent.jobs) {
      const key = String(job.cluster_id);
      const existing = clusters[key];
      if (existing) continue;
      clusters[key] = {
        cluster_id: job.cluster_id,
        job: job.path,
        dispatch_key: job.dispatch_key,
        digest: job.digest,
        runner: intent.runner,
        execution_runner: intent.execution_runner,
        model: intent.model,
        status: "dispatch_pending",
        accepted_at: intent.accepted_at,
      };
      generatedJobs.push(job.path);
    }
    const outcome =
      intent.jobs.length === 0
        ? "selector_rejected"
        : generatedJobs.length === 0
          ? "duplicate_skipped"
          : "dispatch_pending";
    stores.set(intent.store_sha256, {
      store_sha256: intent.store_sha256,
      store_exported_at: intent.store_exported_at,
      accepted_at: intent.accepted_at,
      run_url: intent.run_url,
      outcome,
      generated_jobs: generatedJobs,
      selector_summary: intent.selector_summary,
    });
  }
  const latestStore = [...stores.values()]
    .sort(
      (left, right) =>
        left.store_exported_at.localeCompare(right.store_exported_at) ||
        left.accepted_at.localeCompare(right.accepted_at) ||
        left.store_sha256.localeCompare(right.store_sha256),
    )
    .at(-1)!;
  return {
    schema: CLUSTER_INTAKE_LEDGER_SCHEMA,
    target_repo: first.target_repo,
    last_processed_store_sha256: latestStore.store_sha256,
    last_processed_store_exported_at: latestStore.store_exported_at,
    generated_count: latestStore.generated_jobs.length,
    generated_jobs: latestStore.generated_jobs,
    run_url: latestStore.run_url,
    updated_at: [current.updated_at, ...[...stores.values()].map((store) => store.accepted_at)]
      .filter(Boolean)
      .sort()
      .at(-1)!,
    stores: [...stores.values()]
      .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at))
      .slice(-90),
    clusters,
  };
}

export function markClusterIntakeDispatched(
  ledger: ClusterIntakeLedger,
  jobs: readonly ClusterIntakeJob[],
  dispatchedAt: string,
  run?: { id?: number; url?: string },
): ClusterIntakeLedger {
  const clusters = { ...ledger.clusters };
  for (const job of jobs) {
    const entry = clusters[String(job.cluster_id)];
    if (
      !entry ||
      entry.dispatch_key !== job.dispatch_key ||
      entry.job !== job.path ||
      entry.digest !== job.digest
    ) {
      throw new Error(`cluster dispatch is absent from ledger: ${job.cluster_id}`);
    }
    clusters[String(job.cluster_id)] = {
      ...entry,
      status: "dispatched",
      dispatched_at: dispatchedAt,
      ...(run?.id ? { dispatch_run_id: run.id } : {}),
      ...(run?.url ? { dispatch_run_url: run.url } : {}),
    };
  }
  const stores = ledger.stores.map((store) => ({
    ...store,
    outcome:
      store.generated_jobs.length > 0 &&
      store.generated_jobs.every((path) =>
        Object.values(clusters).some(
          (cluster) => cluster.job === path && cluster.status === "dispatched",
        ),
      )
        ? ("dispatched" as const)
        : store.outcome,
  }));
  return { ...ledger, clusters, stores, updated_at: dispatchedAt };
}

export function markClusterIntakeDispatchClaimed(
  ledger: ClusterIntakeLedger,
  jobs: readonly ClusterIntakeJob[],
  claimedAt: string,
): ClusterIntakeLedger {
  const clusters = { ...ledger.clusters };
  for (const job of jobs) {
    const entry = clusters[String(job.cluster_id)];
    if (
      !entry ||
      entry.dispatch_key !== job.dispatch_key ||
      entry.job !== job.path ||
      entry.digest !== job.digest ||
      entry.status === "dispatched"
    ) {
      throw new Error(`cluster dispatch cannot be claimed: ${job.cluster_id}`);
    }
    clusters[String(job.cluster_id)] = {
      ...entry,
      status: "dispatch_claimed",
      dispatch_claimed_at: claimedAt,
    };
  }
  const stores = ledger.stores.map((store) => ({
    ...store,
    outcome:
      store.generated_jobs.length > 0 &&
      store.generated_jobs.every((path) =>
        Object.values(clusters).some(
          (cluster) => cluster.job === path && cluster.status === "dispatched",
        ),
      )
        ? ("dispatched" as const)
        : store.generated_jobs.length > 0 &&
            store.generated_jobs.every((path) =>
              Object.values(clusters).some(
                (cluster) => cluster.job === path && cluster.status !== "dispatch_pending",
              ),
            )
          ? ("dispatch_claimed" as const)
          : store.outcome,
  }));
  return { ...ledger, clusters, stores, updated_at: claimedAt };
}

export function validateClusterJobContent(
  content: string,
  targetRepo: string,
  clusterId: number,
): void {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("cluster intake job is missing YAML frontmatter");
  let frontmatter: ReturnType<typeof parseSimpleYaml>;
  try {
    frontmatter = parseSimpleYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid cluster intake job frontmatter: ${String(error)}`);
  }
  const validationErrors = validateJob({ frontmatter });
  if (validationErrors.length > 0) {
    throw new Error(`invalid cluster intake job contract: ${validationErrors.join("; ")}`);
  }
  const expectedLists = {
    allowed_actions: ["comment", "label", "close", "fix", "raise_pr"],
    blocked_actions: ["force_push", "bypass_checks", "merge"],
    require_human_for: [
      "security_sensitive",
      "failing_checks",
      "conflicting_prs",
      "unclear_canonical",
      "broad_code_delta",
    ],
  } as const;
  for (const [key, expected] of Object.entries(expectedLists)) {
    const actual = Array.isArray(frontmatter[key]) ? frontmatter[key].map(String) : [];
    if (!sameStringSet(actual, expected)) {
      throw new Error(`cluster intake job ${key} policy mismatch`);
    }
  }
  const clusterName = String(frontmatter.cluster_id || "");
  if (
    frontmatter.repo !== targetRepo ||
    frontmatter.mode !== "autonomous" ||
    frontmatter.job_intent !== "repair_cluster" ||
    !new RegExp(`^gitcrawl-${clusterId}(?:-|$)`).test(clusterName) ||
    frontmatter.security_policy !== "central_security_only" ||
    frontmatter.security_sensitive !== false ||
    frontmatter.allow_instant_close !== false ||
    frontmatter.allow_fix_pr !== true ||
    frontmatter.allow_merge !== false ||
    frontmatter.allow_post_merge_close !== true ||
    frontmatter.require_fix_before_close !== true
  ) {
    throw new Error("cluster intake job semantic policy mismatch");
  }
  const candidates = Array.isArray(frontmatter.candidates)
    ? frontmatter.candidates.map(String)
    : [];
  const clusterRefs = new Set(
    Array.isArray(frontmatter.cluster_refs) ? frontmatter.cluster_refs.map(String) : [],
  );
  const canonical = Array.isArray(frontmatter.canonical) ? frontmatter.canonical.map(String) : [];
  if (
    candidates.length < 2 ||
    canonical.length !== 1 ||
    [...canonical, ...candidates].some((ref) => !clusterRefs.has(ref))
  ) {
    throw new Error("cluster intake job reference policy mismatch");
  }
}

export function clusterJobTargetRepository(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("cluster intake job is missing YAML frontmatter");
  let frontmatter: ReturnType<typeof parseSimpleYaml>;
  try {
    frontmatter = parseSimpleYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid cluster intake job frontmatter: ${String(error)}`);
  }
  const targetRepo = String(frontmatter.repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    throw new Error("cluster intake job target repository is invalid");
  }
  return targetRepo;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((entry) => expected.includes(entry)) &&
    new Set(actual).size === actual.length
  );
}

function workerSetting(value: unknown, name: string): string {
  const setting = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(setting)) {
    throw new Error(`invalid cluster intake ${name}`);
  }
  return setting;
}

function parseLedger(text: string | undefined, targetRepo: string): ClusterIntakeLedger {
  if (!text) return emptyLedger(targetRepo);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.target_repo !== targetRepo) {
    throw new Error("cluster intake ledger target mismatch");
  }
  if (parsed.schema === CLUSTER_INTAKE_LEDGER_SCHEMA) return parsed as ClusterIntakeLedger;
  // Preserve the last v1 marker during the one-way migration. Historical job
  // IDs are recovered separately from durable result records by the importer.
  return {
    ...emptyLedger(targetRepo),
    last_processed_store_sha256: String(parsed.last_processed_store_sha256 || ""),
    last_processed_store_exported_at: String(parsed.last_processed_store_exported_at || ""),
    generated_count: Number(parsed.generated_count || 0),
    generated_jobs: Array.isArray(parsed.generated_jobs) ? parsed.generated_jobs.map(String) : [],
    run_url: String(parsed.run_url || ""),
    updated_at: String(parsed.updated_at || ""),
  };
}

function emptyLedger(targetRepo: string): ClusterIntakeLedger {
  return {
    schema: CLUSTER_INTAKE_LEDGER_SCHEMA,
    target_repo: targetRepo,
    last_processed_store_sha256: "",
    last_processed_store_exported_at: "",
    generated_count: 0,
    generated_jobs: [],
    run_url: "",
    updated_at: "",
    stores: [],
    clusters: {},
  };
}

function selectorSummaryFrom(value: unknown): ClusterIntakeIntent["selector_summary"] {
  if (!isRecord(value) || !isRecord(value.reason_counts))
    throw new Error("invalid selector summary");
  const evaluated = Number(value.evaluated);
  const rejected = Number(value.rejected);
  if (
    !Number.isSafeInteger(evaluated) ||
    !Number.isSafeInteger(rejected) ||
    evaluated < rejected ||
    rejected < 0
  ) {
    throw new Error("invalid selector summary counts");
  }
  const reasonCounts = Object.fromEntries(
    Object.entries(value.reason_counts).map(([key, count]) => {
      const numeric = Number(count);
      if (!key.trim() || !Number.isSafeInteger(numeric) || numeric < 0) {
        throw new Error("invalid selector summary reason count");
      }
      return [key, numeric];
    }),
  );
  return {
    evaluated,
    rejected,
    reason_counts: reasonCounts,
  };
}

function isoDate(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text || !Number.isFinite(Date.parse(text)))
    throw new Error(`invalid cluster intake ${label}`);
  return text;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
