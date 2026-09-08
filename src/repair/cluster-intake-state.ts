import { isRecord } from "../value-coerce.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseSimpleYaml, validateJob } from "./lib.js";

export const CLUSTER_INTAKE_SCHEMA = "clawsweeper-cluster-intake-intent-v1";
export const CLUSTER_INTAKE_LEDGER_SCHEMA = "clawsweeper-cluster-repair-intake-v2";
export const CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA = "clawsweeper-cluster-selector-decisions-v1";
const CLUSTER_INTAKE_MAX_RECORD_BYTES = 240 * 1024;
export const CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES = 65_535;
const GITHUB_REF_MAX_BYTES = 255;
const CLUSTER_DISPATCH_AUTH_DOMAIN = "clawsweeper-cluster-dispatch-v1";
const CLUSTER_ACCEPTED_INTENT_AUTH_DOMAIN = "clawsweeper-cluster-accepted-intent-v1";

export type ClusterIntakeJobProposal = {
  cluster_id: number;
  path: string;
  content: string;
  digest: string;
  dispatch_key: string;
};

export type ClusterIntakeJob = ClusterIntakeJobProposal & {
  accepted_intent_digest: string;
  accepted_intent_receipt: string;
};

export type ClusterSelectorDecision = {
  rationale: string;
  assessments: Array<{
    cluster_id: number;
    decision: "selected" | "rejected";
    rationale: string;
    candidate_refs: number[];
    cluster_refs: number[];
  }>;
};

export type ClusterIntakeProposal = {
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
  selector_decision: ClusterSelectorDecision | null;
  jobs: ClusterIntakeJobProposal[];
};

export type ClusterIntakeIntent = Omit<ClusterIntakeProposal, "jobs"> & {
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
  store_sha256: string;
  store_exported_at: string;
  manifest_path: string;
  run_url: string;
  accepted_intent_digest: string;
  accepted_intent_receipt: string;
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

type ClusterSelectorDecisionLedgerEntry = {
  store_sha256: string;
  store_exported_at: string;
  accepted_at: string;
  run_url: string;
  selector_summary: ClusterIntakeIntent["selector_summary"];
  selector_decision: ClusterSelectorDecision;
};

export type ClusterSelectorDecisionLedger = {
  schema: typeof CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA;
  target_repo: string;
  stores: ClusterSelectorDecisionLedgerEntry[];
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

export type ClusterAcceptedIntentFields = {
  target_repo: string;
  store_sha256: string;
  store_exported_at: string;
  manifest_path: string;
  run_url: string;
  accepted_at: string;
  runner: string;
  execution_runner: string;
  model: string;
  cluster_id: number;
  path: string;
  digest: string;
  dispatch_key: string;
};

export function clusterWorkflowDispatchInputs(
  job: ClusterIntakeJobProposal,
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

export function clusterIntakeProposal(value: unknown): ClusterIntakeProposal {
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
  const jobReferences = new Map<number, { candidates: string[]; clusterRefs: string[] }>();
  const jobs = value.jobs.map((raw): ClusterIntakeJobProposal => {
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
    jobReferences.set(clusterId, validateClusterJobContent(content, targetRepo, clusterId));
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
  const selectorDecision = selectorDecisionFrom(
    value.selector_decision,
    selectorSummary,
    jobs.map((job) => job.cluster_id),
  );
  for (const assessment of selectorDecision?.assessments ?? []) {
    if (assessment.decision !== "selected") continue;
    const references = jobReferences.get(assessment.cluster_id);
    if (
      !references ||
      !sameStringSet(
        references.candidates,
        assessment.candidate_refs.map((number) => `#${number}`),
      ) ||
      !sameStringSet(
        references.clusterRefs,
        assessment.cluster_refs.map((number) => `#${number}`),
      )
    ) {
      throw new Error("cluster selector decision does not match selected job references");
    }
  }
  const intent: ClusterIntakeProposal = {
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
    selector_decision: selectorDecision,
    jobs,
  };
  if (Buffer.byteLength(JSON.stringify(intent)) > CLUSTER_INTAKE_MAX_RECORD_BYTES) {
    throw new Error("cluster intake intent exceeds durable queue record limit");
  }
  return intent;
}

export function acceptClusterIntakeIntent(value: unknown, secret: string): ClusterIntakeIntent {
  if (!secret) throw new Error("cluster accepted-intent secret is required");
  const proposal = clusterIntakeProposal(value);
  return {
    ...proposal,
    jobs: proposal.jobs.map((job) => {
      const fields = clusterAcceptedIntentFields(proposal, job);
      const acceptedIntentDigest = clusterAcceptedIntentDigest(fields);
      return {
        ...job,
        accepted_intent_digest: acceptedIntentDigest,
        accepted_intent_receipt: clusterAcceptedIntentReceipt(secret, acceptedIntentDigest),
      };
    }),
  };
}

export function clusterAcceptedIntentDigest(fields: ClusterAcceptedIntentFields): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target_repo: fields.target_repo,
        store_sha256: fields.store_sha256,
        store_exported_at: fields.store_exported_at,
        manifest_path: fields.manifest_path,
        run_url: fields.run_url,
        accepted_at: fields.accepted_at,
        runner: fields.runner,
        execution_runner: fields.execution_runner,
        model: fields.model,
        cluster_id: fields.cluster_id,
        path: fields.path,
        digest: fields.digest,
        dispatch_key: fields.dispatch_key,
      }),
    )
    .digest("hex");
}

export function verifyClusterAcceptedIntentReceipt(
  secret: string,
  fields: ClusterAcceptedIntentFields,
  suppliedDigest: string,
  suppliedReceipt: string,
): void {
  if (!secret) throw new Error("cluster accepted-intent secret is required");
  const expectedDigest = clusterAcceptedIntentDigest(fields);
  if (suppliedDigest !== expectedDigest) {
    throw new Error("cluster accepted-intent digest verification failed");
  }
  const expected = Buffer.from(clusterAcceptedIntentReceipt(secret, expectedDigest));
  const supplied = Buffer.from(suppliedReceipt);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("cluster accepted-intent receipt verification failed");
  }
}

export function verifyClusterLedgerEntryAcceptedIntent(
  secret: string,
  targetRepo: string,
  entry: ClusterLedgerEntry,
): void {
  verifyClusterAcceptedIntentReceipt(
    secret,
    {
      target_repo: targetRepo,
      store_sha256: entry.store_sha256,
      store_exported_at: entry.store_exported_at,
      manifest_path: entry.manifest_path,
      run_url: entry.run_url,
      accepted_at: entry.accepted_at,
      runner: entry.runner,
      execution_runner: entry.execution_runner,
      model: entry.model,
      cluster_id: entry.cluster_id,
      path: entry.job,
      digest: entry.digest,
      dispatch_key: entry.dispatch_key,
    },
    entry.accepted_intent_digest,
    entry.accepted_intent_receipt,
  );
}

function clusterAcceptedIntentReceipt(secret: string, digest: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${CLUSTER_ACCEPTED_INTENT_AUTH_DOMAIN}\n${digest}`)
    .digest("hex")}`;
}

function clusterAcceptedIntentFields(
  intent: Omit<ClusterIntakeProposal, "jobs">,
  job: ClusterIntakeJobProposal,
): ClusterAcceptedIntentFields {
  return {
    target_repo: intent.target_repo,
    store_sha256: intent.store_sha256,
    store_exported_at: intent.store_exported_at,
    manifest_path: intent.manifest_path,
    run_url: intent.run_url,
    accepted_at: intent.accepted_at,
    runner: intent.runner,
    execution_runner: intent.execution_runner,
    model: intent.model,
    cluster_id: job.cluster_id,
    path: job.path,
    digest: job.digest,
    dispatch_key: job.dispatch_key,
  };
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
        store_sha256: intent.store_sha256,
        store_exported_at: intent.store_exported_at,
        manifest_path: intent.manifest_path,
        run_url: intent.run_url,
        accepted_intent_digest: job.accepted_intent_digest,
        accepted_intent_receipt: job.accepted_intent_receipt,
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

export function mergeClusterSelectorDecisionLedger(
  currentText: string | undefined,
  intents: readonly ClusterIntakeIntent[],
): ClusterSelectorDecisionLedger | undefined {
  const first = intents[0];
  if (!first) throw new Error("cluster selector decision merge requires an intent");
  const current = parseClusterSelectorDecisionLedger(currentText, first.target_repo);
  const stores = new Map(current.stores.map((entry) => [entry.store_sha256, entry]));
  for (const intent of intents) {
    if (intent.target_repo !== first.target_repo) {
      throw new Error("mixed cluster selector decision repositories");
    }
    if (!intent.selector_decision || stores.has(intent.store_sha256)) continue;
    stores.set(intent.store_sha256, {
      store_sha256: intent.store_sha256,
      store_exported_at: intent.store_exported_at,
      accepted_at: intent.accepted_at,
      run_url: intent.run_url,
      selector_summary: intent.selector_summary,
      selector_decision: intent.selector_decision,
    });
  }
  if (stores.size === 0) return undefined;
  return {
    schema: CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA,
    target_repo: first.target_repo,
    stores: [...stores.values()]
      .sort((left, right) => left.accepted_at.localeCompare(right.accepted_at))
      .slice(-90),
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
): { candidates: string[]; clusterRefs: string[] } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("cluster intake job is missing YAML frontmatter");
  let frontmatter: ReturnType<typeof parseSimpleYaml>;
  try {
    frontmatter = parseSimpleYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid cluster intake job frontmatter: ${String(error)}`, { cause: error });
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
  const clusterRefs = new Set<string>(
    Array.isArray(frontmatter.cluster_refs) ? frontmatter.cluster_refs.map(String) : [],
  );
  const canonical = Array.isArray(frontmatter.canonical) ? frontmatter.canonical.map(String) : [];
  if (
    candidates.length === 0 ||
    canonical.length !== 1 ||
    [...canonical, ...candidates].some((ref) => !clusterRefs.has(ref))
  ) {
    throw new Error("cluster intake job reference policy mismatch");
  }
  return { candidates, clusterRefs: [...clusterRefs] };
}

export function clusterJobTargetRepository(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("cluster intake job is missing YAML frontmatter");
  let frontmatter: ReturnType<typeof parseSimpleYaml>;
  try {
    frontmatter = parseSimpleYaml(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid cluster intake job frontmatter: ${String(error)}`, { cause: error });
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

export function clusterIntakeLedger(
  value: unknown,
  expectedTargetRepo?: string,
): ClusterIntakeLedger {
  if (!isRecord(value)) throw new Error("cluster intake ledger must be an object");
  exactKeys(
    value,
    [
      "schema",
      "target_repo",
      "last_processed_store_sha256",
      "last_processed_store_exported_at",
      "generated_count",
      "generated_jobs",
      "run_url",
      "updated_at",
      "stores",
      "clusters",
    ],
    "cluster intake ledger",
  );
  if (value.schema !== CLUSTER_INTAKE_LEDGER_SCHEMA) {
    throw new Error("invalid cluster intake ledger schema");
  }
  const targetRepo = strictRepository(value.target_repo, "cluster intake ledger target");
  if (expectedTargetRepo && targetRepo !== expectedTargetRepo) {
    throw new Error("cluster intake ledger target mismatch");
  }
  const lastProcessedStoreSha = strictDigestOrEmpty(
    value.last_processed_store_sha256,
    "last processed store SHA",
  );
  const lastProcessedStoreExportedAt = strictIsoOrEmpty(
    value.last_processed_store_exported_at,
    "last processed store exported_at",
  );
  const generatedJobs = strictJobPaths(value.generated_jobs, targetRepo, "generated jobs");
  const generatedCount = strictNonnegativeInteger(value.generated_count, "generated count");
  if (generatedCount !== generatedJobs.length) {
    throw new Error("cluster intake ledger generated count mismatch");
  }
  const runUrl = strictGithubUrlOrEmpty(value.run_url, "cluster intake ledger run URL");
  const updatedAt = strictIsoOrEmpty(value.updated_at, "cluster intake ledger updated_at");
  if (!Array.isArray(value.stores) || value.stores.length > 90) {
    throw new Error("invalid cluster intake ledger stores");
  }
  const stores = value.stores.map((entry) => strictStoreLedgerEntry(entry, targetRepo));
  if (new Set(stores.map((entry) => entry.store_sha256)).size !== stores.length) {
    throw new Error("duplicate cluster intake ledger store");
  }
  if (!isRecord(value.clusters) || Object.keys(value.clusters).length > 10_000) {
    throw new Error("invalid cluster intake ledger clusters");
  }
  const clusters = Object.fromEntries(
    Object.entries(value.clusters).map(([key, entry]) => {
      const normalized = strictClusterLedgerEntry(entry, targetRepo);
      if (key !== String(normalized.cluster_id)) {
        throw new Error("cluster intake ledger cluster key mismatch");
      }
      return [key, normalized];
    }),
  );
  const clusterJobs = new Set(Object.values(clusters).map((entry) => entry.job));
  if (stores.some((store) => store.generated_jobs.some((job) => !clusterJobs.has(job)))) {
    throw new Error("cluster intake ledger store references an unknown job");
  }
  return {
    schema: CLUSTER_INTAKE_LEDGER_SCHEMA,
    target_repo: targetRepo,
    last_processed_store_sha256: lastProcessedStoreSha,
    last_processed_store_exported_at: lastProcessedStoreExportedAt,
    generated_count: generatedCount,
    generated_jobs: generatedJobs,
    run_url: runUrl,
    updated_at: updatedAt,
    stores,
    clusters,
  };
}

function strictStoreLedgerEntry(value: unknown, targetRepo: string): StoreLedgerEntry {
  if (!isRecord(value)) throw new Error("cluster intake ledger store must be an object");
  exactKeys(
    value,
    [
      "store_sha256",
      "store_exported_at",
      "accepted_at",
      "run_url",
      "outcome",
      "generated_jobs",
      "selector_summary",
    ],
    "cluster intake ledger store",
  );
  const outcomes = new Set<StoreLedgerEntry["outcome"]>([
    "selector_rejected",
    "duplicate_skipped",
    "dispatch_pending",
    "dispatch_claimed",
    "dispatched",
  ]);
  if (!outcomes.has(value.outcome as StoreLedgerEntry["outcome"])) {
    throw new Error("invalid cluster intake ledger store outcome");
  }
  const generatedJobs = strictJobPaths(
    value.generated_jobs,
    targetRepo,
    "cluster intake ledger store generated jobs",
  );
  const selectorSummary = strictSelectorSummary(value.selector_summary);
  return {
    store_sha256: strictDigest(value.store_sha256, "cluster intake ledger store SHA"),
    store_exported_at: strictIso(
      value.store_exported_at,
      "cluster intake ledger store exported_at",
    ),
    accepted_at: strictIso(value.accepted_at, "cluster intake ledger store accepted_at"),
    run_url: strictGithubUrl(value.run_url, "cluster intake ledger store run URL"),
    outcome: value.outcome as StoreLedgerEntry["outcome"],
    generated_jobs: generatedJobs,
    selector_summary: selectorSummary,
  };
}

function strictClusterLedgerEntry(value: unknown, targetRepo: string): ClusterLedgerEntry {
  if (!isRecord(value)) throw new Error("cluster intake ledger cluster must be an object");
  exactKeys(
    value,
    [
      "cluster_id",
      "job",
      "dispatch_key",
      "digest",
      "runner",
      "execution_runner",
      "model",
      "store_sha256",
      "store_exported_at",
      "manifest_path",
      "run_url",
      "accepted_intent_digest",
      "accepted_intent_receipt",
      "status",
      "accepted_at",
      "dispatch_claimed_at",
      "dispatched_at",
      "dispatch_run_id",
      "dispatch_run_url",
    ],
    "cluster intake ledger cluster",
  );
  const clusterId = strictPositiveInteger(value.cluster_id, "cluster intake ledger cluster id");
  const job = strictJobPath(value.job, targetRepo, "cluster intake ledger cluster job");
  const repoSlug = targetRepo.replace("/", "-");
  const dispatchKey = strictString(value.dispatch_key, "cluster intake ledger dispatch key");
  if (dispatchKey !== `cluster-intake:${repoSlug}:${clusterId}`) {
    throw new Error("cluster intake ledger dispatch key mismatch");
  }
  const digest = strictDigest(value.digest, "cluster intake ledger job digest");
  const runner = workerSetting(value.runner, "ledger runner");
  const executionRunner = workerSetting(value.execution_runner, "ledger execution_runner");
  const model = workerSetting(value.model, "ledger model");
  const storeSha = strictDigest(value.store_sha256, "cluster intake ledger accepted store SHA");
  const storeExportedAt = strictIso(
    value.store_exported_at,
    "cluster intake ledger accepted store exported_at",
  );
  const manifestPath = strictString(value.manifest_path, "cluster intake ledger manifest path");
  const runUrl = strictGithubUrl(value.run_url, "cluster intake ledger accepted run URL");
  const acceptedAt = strictIso(value.accepted_at, "cluster intake ledger accepted_at");
  const acceptedIntentDigest = strictDigest(
    value.accepted_intent_digest,
    "cluster intake ledger accepted-intent digest",
  );
  const acceptedIntentReceipt = strictReceipt(
    value.accepted_intent_receipt,
    "cluster intake ledger accepted-intent receipt",
  );
  const expectedAcceptedDigest = clusterAcceptedIntentDigest({
    target_repo: targetRepo,
    store_sha256: storeSha,
    store_exported_at: storeExportedAt,
    manifest_path: manifestPath,
    run_url: runUrl,
    accepted_at: acceptedAt,
    runner,
    execution_runner: executionRunner,
    model,
    cluster_id: clusterId,
    path: job,
    digest,
    dispatch_key: dispatchKey,
  });
  if (acceptedIntentDigest !== expectedAcceptedDigest) {
    throw new Error("cluster intake ledger accepted-intent digest mismatch");
  }
  if (
    typeof value.status !== "string" ||
    !new Set(["dispatch_pending", "dispatch_claimed", "dispatched"]).has(value.status)
  ) {
    throw new Error("invalid cluster intake ledger cluster status");
  }
  const status = value.status as ClusterLedgerEntry["status"];
  const dispatchClaimedAt = optionalStrictIso(
    value.dispatch_claimed_at,
    "cluster intake ledger dispatch_claimed_at",
  );
  const dispatchedAt = optionalStrictIso(
    value.dispatched_at,
    "cluster intake ledger dispatched_at",
  );
  const dispatchRunId = optionalPositiveInteger(
    value.dispatch_run_id,
    "cluster intake ledger dispatch run id",
  );
  const dispatchRunUrl = optionalGithubUrl(
    value.dispatch_run_url,
    "cluster intake ledger dispatch run URL",
  );
  if (
    status === "dispatch_pending" &&
    (dispatchClaimedAt || dispatchedAt || dispatchRunId || dispatchRunUrl)
  ) {
    throw new Error("pending cluster intake ledger entry has dispatch outcome fields");
  }
  if (
    status === "dispatch_claimed" &&
    (!dispatchClaimedAt || dispatchedAt || dispatchRunId || dispatchRunUrl)
  ) {
    throw new Error("claimed cluster intake ledger entry has invalid dispatch outcome fields");
  }
  if (status === "dispatched" && !dispatchedAt) {
    throw new Error("dispatched cluster intake ledger entry has no dispatched_at");
  }
  return {
    cluster_id: clusterId,
    job,
    dispatch_key: dispatchKey,
    digest,
    runner,
    execution_runner: executionRunner,
    model,
    store_sha256: storeSha,
    store_exported_at: storeExportedAt,
    manifest_path: manifestPath,
    run_url: runUrl,
    accepted_intent_digest: acceptedIntentDigest,
    accepted_intent_receipt: acceptedIntentReceipt,
    status,
    accepted_at: acceptedAt,
    ...(dispatchClaimedAt ? { dispatch_claimed_at: dispatchClaimedAt } : {}),
    ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
    ...(dispatchRunId ? { dispatch_run_id: dispatchRunId } : {}),
    ...(dispatchRunUrl ? { dispatch_run_url: dispatchRunUrl } : {}),
  };
}

function parseLedger(text: string | undefined, targetRepo: string): ClusterIntakeLedger {
  if (!text) return emptyLedger(targetRepo);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.target_repo !== targetRepo) {
    throw new Error("cluster intake ledger target mismatch");
  }
  if (parsed.schema === CLUSTER_INTAKE_LEDGER_SCHEMA) {
    return clusterIntakeLedger(parsed, targetRepo);
  }
  if (parsed.schema !== "clawsweeper-cluster-repair-intake-v1") {
    throw new Error("invalid cluster intake ledger schema");
  }
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

function parseClusterSelectorDecisionLedger(
  text: string | undefined,
  targetRepo: string,
): ClusterSelectorDecisionLedger {
  if (!text) {
    return { schema: CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA, target_repo: targetRepo, stores: [] };
  }
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.schema !== CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA) {
    throw new Error("invalid cluster selector decision ledger schema");
  }
  exactKeys(value, ["schema", "target_repo", "stores"], "cluster selector decision ledger");
  if (
    strictRepository(value.target_repo, "cluster selector decision ledger target") !== targetRepo
  ) {
    throw new Error("cluster selector decision ledger target mismatch");
  }
  if (!Array.isArray(value.stores) || value.stores.length > 90) {
    throw new Error("invalid cluster selector decision ledger stores");
  }
  const stores = value.stores.map((entry): ClusterSelectorDecisionLedgerEntry => {
    if (!isRecord(entry)) throw new Error("invalid cluster selector decision ledger store");
    exactKeys(
      entry,
      [
        "store_sha256",
        "store_exported_at",
        "accepted_at",
        "run_url",
        "selector_summary",
        "selector_decision",
      ],
      "cluster selector decision ledger store",
    );
    const selectorSummary = strictSelectorSummary(entry.selector_summary);
    const selectorDecision = selectorDecisionFrom(entry.selector_decision, selectorSummary);
    if (!selectorDecision) throw new Error("cluster selector decision ledger omitted decision");
    return {
      store_sha256: strictDigest(entry.store_sha256, "cluster selector decision store SHA"),
      store_exported_at: strictIso(
        entry.store_exported_at,
        "cluster selector decision store exported_at",
      ),
      accepted_at: strictIso(entry.accepted_at, "cluster selector decision accepted_at"),
      run_url: strictGithubUrl(entry.run_url, "cluster selector decision run URL"),
      selector_summary: selectorSummary,
      selector_decision: selectorDecision,
    };
  });
  if (new Set(stores.map((entry) => entry.store_sha256)).size !== stores.length) {
    throw new Error("duplicate cluster selector decision store");
  }
  return {
    schema: CLUSTER_SELECTOR_DECISION_LEDGER_SCHEMA,
    target_repo: targetRepo,
    stores,
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

function selectorDecisionFrom(
  value: unknown,
  summary: ClusterIntakeIntent["selector_summary"],
  selectedClusterIds?: readonly number[],
): ClusterSelectorDecision | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.assessments)) {
    throw new Error("invalid cluster selector decision");
  }
  exactKeys(value, ["rationale", "assessments"], "cluster selector decision");
  const assessments = value.assessments.map(
    (entry): ClusterSelectorDecision["assessments"][number] => {
      if (!isRecord(entry)) throw new Error("invalid cluster selector assessment");
      exactKeys(
        entry,
        ["cluster_id", "decision", "rationale", "candidate_refs", "cluster_refs"],
        "cluster selector assessment",
      );
      const clusterId = strictPositiveInteger(entry.cluster_id, "cluster selector cluster ID");
      const decision = entry.decision;
      if (decision !== "selected" && decision !== "rejected") {
        throw new Error("invalid cluster selector assessment decision");
      }
      const candidateRefs = strictPositiveIntegerList(
        entry.candidate_refs,
        "cluster selector candidate refs",
      );
      const clusterRefs = strictPositiveIntegerList(
        entry.cluster_refs,
        "cluster selector cluster refs",
      );
      if (
        candidateRefs.length === 0 ||
        candidateRefs.some((candidate) => !clusterRefs.includes(candidate))
      ) {
        throw new Error("cluster selector assessment reference mismatch");
      }
      return {
        cluster_id: clusterId,
        decision,
        rationale: strictString(entry.rationale, "cluster selector assessment rationale"),
        candidate_refs: candidateRefs,
        cluster_refs: clusterRefs,
      };
    },
  );
  if (
    assessments.length !== summary.evaluated ||
    new Set(assessments.map((entry) => entry.cluster_id)).size !== assessments.length ||
    assessments.filter((entry) => entry.decision === "rejected").length !== summary.rejected
  ) {
    throw new Error("cluster selector decision count mismatch");
  }
  if (selectedClusterIds) {
    const selected = assessments
      .filter((entry) => entry.decision === "selected")
      .map((entry) => entry.cluster_id)
      .sort((left, right) => left - right);
    const expectedSelected = [...selectedClusterIds].sort((left, right) => left - right);
    if (
      selected.length !== expectedSelected.length ||
      selected.some((clusterId, index) => clusterId !== expectedSelected[index])
    ) {
      throw new Error("cluster selector decision does not match selected jobs");
    }
  }
  return {
    rationale: strictString(value.rationale, "cluster selector rationale"),
    assessments,
  };
}

function strictSelectorSummary(value: unknown): ClusterIntakeIntent["selector_summary"] {
  if (!isRecord(value) || !isRecord(value.reason_counts)) {
    throw new Error("invalid cluster intake ledger selector summary");
  }
  exactKeys(
    value,
    ["evaluated", "rejected", "reason_counts"],
    "cluster intake ledger selector summary",
  );
  const evaluated = strictNonnegativeInteger(value.evaluated, "selector evaluated count");
  const rejected = strictNonnegativeInteger(value.rejected, "selector rejected count");
  if (rejected > evaluated) throw new Error("invalid cluster intake ledger selector counts");
  const reasonCounts = Object.fromEntries(
    Object.entries(value.reason_counts).map(([key, count]) => {
      if (!key.trim() || key.length > 200) {
        throw new Error("invalid cluster intake ledger selector reason");
      }
      return [key, strictNonnegativeInteger(count, "selector reason count")];
    }),
  );
  return { evaluated, rejected, reason_counts: reasonCounts };
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown[0]}`);
}

function strictString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function strictRepository(value: unknown, label: string): string {
  const repository = strictString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid ${label}`);
  }
  return repository;
}

function strictDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function strictDigestOrEmpty(value: unknown, label: string): string {
  return value === "" ? "" : strictDigest(value, label);
}

function strictReceipt(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256=[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function strictIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function strictIsoOrEmpty(value: unknown, label: string): string {
  return value === "" ? "" : strictIso(value, label);
}

function optionalStrictIso(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : strictIso(value, label);
}

function strictGithubUrl(value: unknown, label: string): string {
  const url = strictString(value, label);
  if (!url.startsWith("https://github.com/")) throw new Error(`invalid ${label}`);
  return url;
}

function strictGithubUrlOrEmpty(value: unknown, label: string): string {
  return value === "" ? "" : strictGithubUrl(value, label);
}

function optionalGithubUrl(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : strictGithubUrl(value, label);
}

function strictNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function strictPositiveInteger(value: unknown, label: string): number {
  const integer = strictNonnegativeInteger(value, label);
  if (integer < 1) throw new Error(`invalid ${label}`);
  return integer;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : strictPositiveInteger(value, label);
}

function strictPositiveIntegerList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  const integers = value.map((entry) => strictPositiveInteger(entry, label));
  if (new Set(integers).size !== integers.length) throw new Error(`duplicate ${label}`);
  return integers;
}

function strictJobPaths(value: unknown, targetRepo: string, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  const paths = value.map((entry) => strictJobPath(entry, targetRepo, label));
  if (new Set(paths).size !== paths.length) throw new Error(`duplicate ${label}`);
  return paths;
}

function strictJobPath(value: unknown, targetRepo: string, label: string): string {
  const path = strictString(value, label);
  const owner = escapeRegex(targetRepo.split("/")[0]!);
  if (!new RegExp(`^jobs/${owner}/inbox/gitcrawl-[1-9][0-9]*-[^/]+\\.md$`).test(path)) {
    throw new Error(`invalid ${label}`);
  }
  return path;
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
