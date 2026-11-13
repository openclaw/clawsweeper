const PROFILE = "gitcrawl.public-durable-cluster-context/v1";
const VIEW = "durable-active/v1";
const BINDING_COLUMNS =
  "profile archive binding_id snapshot_id manifest_sha256 inventory_sha256 repository github_repo_id view captured_at scope_status selection_source selection_run_id provider_complete full_native_scope_complete selected_input_complete retained_prior_memberships identity_reconciliation_complete publication_status analysis_status analysis_run_id analysis_publication_status structural_complete source_through source_observed_at analysis_source_through analysis_source_observed_at".split(
    " ",
  );
const RELATED_COLUMNS =
  "cluster_id member_count representative_number representative_kind representative_state representative_title number kind state title body labels_json updated_at scope_status structural_complete".split(
    " ",
  );

export interface GitcrawlClusterServiceConfig {
  endpoint: string;
  archive: string;
  token: string;
}

export interface GitcrawlClusterServiceRow {
  clusterId: string;
  memberCount: string;
  representative: {
    number: number | null;
    kind: string | null;
    state: string | null;
    title: string | null;
  };
  number: number;
  kind: "issue";
  state: string;
  title: string;
  body: string;
  labels: unknown[];
  updatedAt: string | null;
}

export interface GitcrawlClusterServiceResult {
  snapshotId: string;
  capturedAt: string;
  scopeStatus: string;
  structuralComplete: boolean;
  sourceThrough: string | null;
  sourceObservedAt: string | null;
  analysisSourceThrough: string | null;
  analysisSourceObservedAt: string | null;
  rows: GitcrawlClusterServiceRow[];
}

const unavailable = () => new Error("Gitcrawl cluster service is unavailable or unqualified");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:0|[1-9]\d{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const positive = (value: unknown): value is string => decimal(value) && value !== "0";
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const nullableBoolean = (value: unknown): value is boolean | null =>
  value === null || typeof value === "boolean";

function number(value: unknown): number {
  if (!positive(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return Number(value);
}

// Synchronous mutation guards cannot await this source yet. Refuse before any
// apply or review-start effect, including incomplete service configuration.
export function assertGitcrawlClusterMutationSupported(): void {
  if (
    process.env.CLAWSWEEPER_GITCRAWL_ENDPOINT !== undefined ||
    process.env.CLAWSWEEPER_GITCRAWL_ARCHIVE !== undefined
  ) {
    throw new Error(
      "Gitcrawl cluster service mode does not support apply or review-start publication yet",
    );
  }
}

// The explicit service selector replaces SQLite discovery. A token alone may
// belong to another consumer and does not select this source.
export function configuredGitcrawlClusterService(): GitcrawlClusterServiceConfig | null {
  const endpoint = process.env.CLAWSWEEPER_GITCRAWL_ENDPOINT;
  const archive = process.env.CLAWSWEEPER_GITCRAWL_ARCHIVE;
  if (endpoint === undefined && archive === undefined) return null;
  const token = process.env.CLAWSWEEPER_GITCRAWL_READER_TOKEN;
  if (
    typeof endpoint !== "string" ||
    typeof archive !== "string" ||
    typeof token !== "string" ||
    process.env.CLAWSWEEPER_GITCRAWL_DB !== undefined
  )
    throw unavailable();
  return { endpoint, archive, token };
}

export async function readGitcrawlClusterService(
  config: GitcrawlClusterServiceConfig,
  repository: string,
  itemNumber: number,
): Promise<GitcrawlClusterServiceResult> {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw unavailable();
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
      )) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/.test(config.archive) ||
    config.archive.split("/").some((part) => part === "." || part === ".." || part === "") ||
    !config.token ||
    Buffer.byteLength(config.token) > 16 * 1024 ||
    /[\s\x00-\x1f\x7f]/.test(config.token) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1
  )
    throw unavailable();
  const signal = AbortSignal.timeout(10_000);
  const route = new URL(
    `/v1/apps/gitcrawl/archives/${encodeURIComponent(config.archive)}/query`,
    endpoint,
  );
  const query = async (
    body: Record<string, unknown>,
    columns: string[],
    limit: number,
    pin?: string,
  ): Promise<{ rows: unknown[][]; snapshotId: string }> => {
    let response: Response | undefined;
    try {
      response = await fetch(route, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (
        !response.ok ||
        response.redirected ||
        response.headers.get("Cache-Control") !== "no-store" ||
        !response.body
      )
        throw unavailable();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) throw unavailable();
        chunks.push(chunk);
      }
      const page: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        !record(page) ||
        JSON.stringify(page.columns) !== JSON.stringify(columns) ||
        !Array.isArray(page.rows) ||
        page.rows.length > limit ||
        page.rows.some((row) => !Array.isArray(row) || row.length !== columns.length) ||
        page.cursor !== undefined ||
        !record(page.stats) ||
        page.stats.schema_version !== 1 ||
        typeof page.stats.snapshot_id !== "string" ||
        !/^pg-gitcrawl-clusters-v1:[a-f0-9]{32}:[1-9]\d{0,18}$/.test(page.stats.snapshot_id) ||
        !positive(page.stats.snapshot_id.split(":")[2]) ||
        (pin !== undefined && page.stats.snapshot_id !== pin)
      )
        throw unavailable();
      return { rows: page.rows as unknown[][], snapshotId: page.stats.snapshot_id };
    } catch {
      throw unavailable();
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  };

  const binding = await query({ name: "gitcrawl.clusters.binding", limit: 1 }, BINDING_COLUMNS, 1);
  if (binding.rows.length !== 1) throw unavailable();
  const values = binding.rows[0];
  if (!values) throw unavailable();
  const row = Object.fromEntries(BINDING_COLUMNS.map((column, i) => [column, values[i]]));
  if (
    row.profile !== PROFILE ||
    row.archive !== config.archive ||
    typeof row.binding_id !== "string" ||
    !row.binding_id ||
    row.snapshot_id !== binding.snapshotId ||
    !hash(row.manifest_sha256) ||
    !hash(row.inventory_sha256) ||
    row.repository !== repository ||
    !positive(row.github_repo_id) ||
    row.view !== VIEW ||
    typeof row.captured_at !== "string" ||
    !row.captured_at.endsWith("Z") ||
    !Number.isFinite(Date.parse(row.captured_at)) ||
    Date.parse(row.captured_at) > Date.now() ||
    typeof row.scope_status !== "string" ||
    row.selection_source !== "durable_cluster" ||
    typeof row.structural_complete !== "boolean" ||
    ["selection_run_id", "analysis_run_id"].some(
      (key) => row[key] !== null && !positive(row[key]),
    ) ||
    ["publication_status", "analysis_status", "analysis_publication_status"].some(
      (key) => !nullableText(row[key]),
    ) ||
    [
      "provider_complete",
      "full_native_scope_complete",
      "selected_input_complete",
      "identity_reconciliation_complete",
    ].some((key) => !nullableBoolean(row[key])) ||
    (row.retained_prior_memberships !== null && !decimal(row.retained_prior_memberships)) ||
    [
      "source_through",
      "source_observed_at",
      "analysis_source_through",
      "analysis_source_observed_at",
    ].some((key) => !nullableText(row[key]))
  )
    throw unavailable();
  const related = await query(
    {
      name: "gitcrawl.clusters.related-issues",
      args: { repository, number: String(itemNumber) },
      snapshot_id: binding.snapshotId,
      limit: 6,
    },
    RELATED_COLUMNS,
    6,
    binding.snapshotId,
  );
  const rows = related.rows.map((values) => {
    const item = Object.fromEntries(RELATED_COLUMNS.map((column, i) => [column, values[i]]));
    if (
      !positive(item.cluster_id) ||
      !decimal(item.member_count) ||
      item.kind !== "issue" ||
      !["open", "closed"].includes(String(item.state)) ||
      typeof item.title !== "string" ||
      !nullableText(item.body) ||
      typeof item.labels_json !== "string" ||
      !nullableText(item.updated_at) ||
      !["representative_kind", "representative_state", "representative_title"].every((key) =>
        nullableText(item[key]),
      ) ||
      item.scope_status !== row.scope_status ||
      item.structural_complete !== row.structural_complete ||
      (item.body !== null && Array.from(item.body).length > 800)
    )
      throw unavailable();
    let labels: unknown;
    try {
      labels = JSON.parse(item.labels_json);
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(labels)) throw unavailable();
    const issue = number(item.number);
    if (issue === itemNumber) throw unavailable();
    return {
      clusterId: item.cluster_id,
      memberCount: item.member_count,
      representative: {
        number: item.representative_number === null ? null : number(item.representative_number),
        kind: item.representative_kind as string | null,
        state: item.representative_state as string | null,
        title: item.representative_title as string | null,
      },
      number: issue,
      kind: "issue" as const,
      state: String(item.state),
      title: item.title,
      body: item.body ?? "",
      labels,
      updatedAt: item.updated_at,
    };
  });
  return {
    snapshotId: binding.snapshotId,
    capturedAt: row.captured_at,
    scopeStatus: row.scope_status,
    structuralComplete: row.structural_complete,
    sourceThrough: row.source_through as string | null,
    sourceObservedAt: row.source_observed_at as string | null,
    analysisSourceThrough: row.analysis_source_through as string | null,
    analysisSourceObservedAt: row.analysis_source_observed_at as string | null,
    rows,
  };
}
