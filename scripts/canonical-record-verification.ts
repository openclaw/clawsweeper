import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { signedRequest } from "./worker-records.ts";

const SECTIONS = ["items", "closed", "plans", "decision-packets"] as const;
const RESPONSE_BYTES = 16 * 1024 * 1024;
const PHASE_MS = 10 * 60_000;
const ATTEMPT_MS = 30_000;
type Section = (typeof SECTIONS)[number];
type Row = {
  section: Section;
  id: string;
  revision: number;
  digest: string | null;
  bytes: number;
  deleted: boolean;
};
type Sample = Row & { coverage: "canonical" | "export-only" };
type Baseline = {
  version: 1;
  repoSlug: string;
  deploymentSha: string;
  operatorSha: string;
  planSha256: string;
  records: Sample[];
};
type Options = {
  baseUrl: string;
  webhookSecret: string;
  repoSlug: string;
  deploymentSha: string;
  operatorSha: string;
  planSha256: string;
  baselineJson?: string;
  fetch?: typeof globalThis.fetch;
  attemptMs?: number;
};

const RECOVERY = {
  invalid_input:
    "Correct the workflow inputs and use the exact saved baseline; do not repeat migration.",
  plan_mismatch:
    "Stop and obtain a newly reviewed execution plan; preserve the baseline and migration checkpoint.",
  record_mismatch:
    "Stop migration and investigate record preservation; preserve the baseline and migration checkpoint.",
  read_limit:
    "Stop and review the bounded read plan; preserve the baseline and migration checkpoint.",
  request_failed:
    "Stop and check service access, availability and response validity; preserve the baseline and migration checkpoint.",
} as const;
type FailureCategory = keyof typeof RECOVERY;
type RequestDiagnostics = {
  stage: "health" | "admission" | "export" | "point";
  status: number | null;
  attempts: number;
  failureKind:
    | "http_status"
    | "transport"
    | "timeout"
    | "redirect"
    | "invalid_json"
    | "invalid_response"
    | "read_limit";
};

class VerificationError extends Error {
  readonly category: FailureCategory;
  diagnostics?: RequestDiagnostics;
  constructor(message: string, category: FailureCategory) {
    super(message);
    this.category = category;
  }
}

function requireThat(
  value: unknown,
  message: string,
  category: FailureCategory = "record_mismatch",
): asserts value {
  if (!value) throw new VerificationError(message, category);
}

function object(value: unknown): Record<string, unknown> {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "invalid object");
  return value as Record<string, unknown>;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function row(value: unknown, section: Section, id?: string, metadata = false): Row {
  const input = object(value);
  const recordId = id ?? input.id;
  requireThat(
    typeof recordId === "string" &&
      /^[1-9]\d*$/.test(recordId) &&
      Number.isSafeInteger(Number(recordId)),
    "invalid record identity",
  );
  requireThat(
    Number.isSafeInteger(input.revision) && Number(input.revision) >= 0,
    "invalid revision",
  );
  const deleted = input.deleted === true;
  let bytes = 0;
  if (deleted) {
    requireThat(input.digest === null && (metadata || input.content === null), "invalid tombstone");
  } else {
    requireThat(
      typeof input.digest === "string" && /^[a-f0-9]{64}$/.test(input.digest),
      "invalid digest",
    );
    if (!metadata) {
      requireThat(
        typeof input.content === "string" && hash(input.content) === input.digest,
        "body digest mismatch",
      );
      bytes = Buffer.byteLength(input.content);
    } else {
      requireThat(
        Number.isSafeInteger(input.bytes) && Number(input.bytes) >= 0,
        "invalid body length",
      );
      bytes = Number(input.bytes);
    }
  }
  return {
    section,
    id: recordId,
    revision: Number(input.revision),
    digest: input.digest as string | null,
    bytes,
    deleted,
  };
}

function compare(before: Row, after: Row) {
  requireThat(after.revision >= before.revision, "record revision regressed");
  if (after.revision === before.revision) {
    requireThat(
      after.digest === before.digest &&
        after.bytes === before.bytes &&
        after.deleted === before.deleted,
      "record changed without a revision",
    );
  }
}

function parseBaseline(json: string, options: Options): Baseline {
  requireThat(Buffer.byteLength(json) <= 64 * 1024, "baseline exceeds 64 KiB");
  const envelope = object(JSON.parse(json));
  const input = object(envelope.baseline);
  requireThat(
    input.version === 1 && Array.isArray(input.records) && input.records.length <= 128,
    "invalid baseline",
  );
  requireThat(
    input.repoSlug === options.repoSlug &&
      input.deploymentSha === options.deploymentSha &&
      input.operatorSha === options.operatorSha &&
      input.planSha256 === options.planSha256,
    "baseline identity mismatch",
    "plan_mismatch",
  );
  const seen = new Set<string>();
  const records = input.records.map((value: unknown) => {
    const entry = object(value);
    requireThat(SECTIONS.includes(entry.section as Section), "invalid baseline section");
    requireThat(
      entry.coverage === "canonical" || entry.coverage === "export-only",
      "invalid baseline coverage",
    );
    const record = row(entry, entry.section as Section, undefined, true);
    const key = `${record.section}/${record.id}`;
    requireThat(!seen.has(key), "duplicate baseline identity");
    seen.add(key);
    return { ...record, coverage: entry.coverage } as Sample;
  });
  const baseline: Baseline = {
    version: 1,
    repoSlug: options.repoSlug,
    deploymentSha: options.deploymentSha,
    operatorSha: options.operatorSha,
    planSha256: options.planSha256,
    records,
  };
  requireThat(hash(JSON.stringify(baseline)) === envelope.sha256, "baseline checksum mismatch");
  return baseline;
}

export async function verifyCanonicalRecords(options: Options) {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new VerificationError("invalid Worker origin", "invalid_input");
  }
  requireThat(
    base.origin === options.baseUrl &&
      !base.username &&
      !base.password &&
      (base.protocol === "https:" || (base.protocol === "http:" && base.hostname === "127.0.0.1")),
    "invalid Worker origin",
    "invalid_input",
  );
  requireThat(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(options.repoSlug),
    "invalid repository slug",
    "invalid_input",
  );
  requireThat(
    /^[a-f0-9]{40}$/.test(options.deploymentSha) &&
      /^[a-f0-9]{40}$/.test(options.operatorSha) &&
      /^[a-f0-9]{64}$/.test(options.planSha256) &&
      options.webhookSecret,
    "missing verification identity",
    "invalid_input",
  );
  let prior: Baseline | undefined;
  try {
    prior = options.baselineJson ? parseBaseline(options.baselineJson, options) : undefined;
  } catch (error) {
    if (error instanceof VerificationError && error.category === "plan_mismatch") throw error;
    throw new VerificationError(
      error instanceof VerificationError ? error.message : "invalid baseline",
      "invalid_input",
    );
  }
  const deadline = Date.now() + PHASE_MS;
  const attemptMs = Math.min(options.attemptMs ?? ATTEMPT_MS, ATTEMPT_MS);
  requireThat(attemptMs > 0, "invalid request deadline", "invalid_input");
  let attempts = 0;
  let logicalRequests = 0;
  // signedRequest owns the three-attempt policy. Buffer here so its timeout
  // includes streamed bodies, and neither redirects nor error bodies leak data.
  async function boundedFetch(
    diagnostics: RequestDiagnostics,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) {
    // A retry must not attribute a previous response status to a transport failure.
    diagnostics.status = null;
    diagnostics.failureKind = "read_limit";
    requireThat(
      ++attempts <= 408 && Date.now() < deadline,
      "verification request budget exceeded",
      "read_limit",
    );
    diagnostics.attempts++;
    diagnostics.failureKind = "transport";
    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("request deadline exceeded")),
        { once: true },
      );
    });
    const timer = setTimeout(() => controller.abort(), Math.min(attemptMs, deadline - Date.now()));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([
        (options.fetch ?? globalThis.fetch)(input, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        }),
        aborted,
      ]);
      diagnostics.status = response.status;
      diagnostics.failureKind = "redirect";
      requireThat(response.status < 300 || response.status >= 400, "redirect refused");
      diagnostics.failureKind = "transport";
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (reader) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) break;
        bytes += next.value.byteLength;
        requireThat(bytes <= RESPONSE_BYTES, "response exceeds 16 MiB", "read_limit");
        chunks.push(next.value);
      }
      requireThat(!controller.signal.aborted, "request deadline exceeded");
      diagnostics.failureKind = "invalid_response";
      return new Response(Buffer.concat(chunks), { status: response.status });
    } catch (error) {
      if (controller.signal.aborted) diagnostics.failureKind = "timeout";
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  async function request(stage: RequestDiagnostics["stage"], endpoint: string, body?: unknown) {
    const diagnostics: RequestDiagnostics = {
      stage,
      status: null,
      attempts: 0,
      failureKind: "read_limit",
    };
    try {
      requireThat(
        ++logicalRequests <= 136 && Date.now() < deadline,
        "verification request budget exceeded",
        "read_limit",
      );
      const response =
        endpoint === "/api/health"
          ? await boundedFetch(diagnostics, `${base.origin}${endpoint}`, { method: "GET" })
          : await signedRequest({
              baseUrl: base.origin,
              path: endpoint,
              webhookSecret: options.webhookSecret,
              method: body === undefined ? "GET" : "POST",
              body,
              fetch: (input, init) => boundedFetch(diagnostics, input, init),
            });
      diagnostics.failureKind = "http_status";
      requireThat(
        response.ok || response.status === 404,
        `verification HTTP ${response.status}`,
        "request_failed",
      );
      diagnostics.failureKind = "invalid_json";
      const value = await response.json();
      diagnostics.failureKind = "invalid_response";
      return { status: response.status, value: object(value) };
    } catch (error) {
      const failure =
        error instanceof VerificationError
          ? error
          : new VerificationError("verification request failed", "request_failed");
      if (failure.category === "read_limit") diagnostics.failureKind = "read_limit";
      failure.diagnostics = { ...diagnostics };
      throw failure;
    }
  }
  async function identity() {
    for (const endpoint of ["/api/health", "/internal/exact-review/admission-capabilities"]) {
      const { status, value } = await request(
        endpoint === "/api/health" ? "health" : "admission",
        endpoint,
        endpoint === "/api/health" ? undefined : {},
      );
      requireThat(
        status === 200 &&
          value.deployment_sha === options.deploymentSha &&
          (endpoint !== "/api/health" || value.ok === true),
        "deployment identity mismatch",
        "plan_mismatch",
      );
    }
  }
  await identity();
  const exported = new Map<string, Row>();
  const completeSections = new Set<Section>();
  for (const section of SECTIONS) {
    const { status, value } = await request("export", "/internal/state/records/export", {
      repoSlug: options.repoSlug,
      sections: [section],
      sinceRevision: 0,
      cursor: 0,
      limit: 32,
    });
    requireThat(
      status === 200 &&
        value.repoSlug === options.repoSlug &&
        Array.isArray(value.sections) &&
        value.sections.length === 1 &&
        value.sections[0] === section &&
        Array.isArray(value.records) &&
        value.records.length <= 32 &&
        (value.nextCursor === null ||
          (Number.isSafeInteger(value.nextCursor) && Number(value.nextCursor) > 0)),
      "invalid export page",
    );
    if (value.nextCursor === null) completeSections.add(section);
    requireThat(
      value.records.length > 0 || !prior?.records.some((record) => record.section === section),
      "previously populated export section is empty",
    );
    for (const entry of value.records) {
      requireThat(object(entry).section === section, "wrong export section");
      const record = row(entry, section);
      const key = `${section}/${record.id}`;
      requireThat(!exported.has(key), "duplicate export identity");
      exported.set(key, record);
    }
  }
  const records: Sample[] = [];
  let changed = 0;
  for (const selected of prior?.records ?? exported.values()) {
    const witness = exported.get(`${selected.section}/${selected.id}`);
    if (prior) {
      requireThat(
        witness || !completeSections.has(selected.section),
        "record missing from complete export",
      );
      if (witness) compare(selected, witness);
    }
    if ("coverage" in selected && selected.coverage === "export-only") {
      records.push(selected);
      continue;
    }
    const { section, id } = selected;
    const { status, value } = await request(
      "point",
      `/internal/state/records/${options.repoSlug}/${section}/${id}`,
    );
    // Export also contains backfill rows; the point reader only owns canonical
    // rows. Record an initial gap explicitly, never reinterpret later loss.
    if (
      !prior &&
      status === 404 &&
      value.error === "record_not_found" &&
      value.deleted === undefined &&
      value.revision === undefined
    ) {
      records.push({ ...selected, coverage: "export-only" });
      continue;
    }
    requireThat(
      (status === 200 && value.deleted !== true) ||
        (status === 404 && value.error === "record_not_found" && value.deleted === true),
      "canonical record missing",
    );
    const current = row(status === 404 ? { ...value, content: null } : value, section, id);
    compare(selected, current);
    if (witness) compare(witness, current);
    // Changed identities move beyond the first export page. The canonical
    // point reader's explicit newer tombstone is authoritative even there.
    if (current.revision > selected.revision) changed++;
    records.push({ ...current, coverage: "canonical" });
  }
  requireThat(
    records.some((record) => record.coverage === "canonical"),
    "no canonical records verified",
  );
  await identity();
  const baseline: Baseline = {
    version: 1,
    repoSlug: options.repoSlug,
    deploymentSha: options.deploymentSha,
    operatorSha: options.operatorSha,
    planSha256: options.planSha256,
    records,
  };
  return {
    baseline,
    sha256: hash(JSON.stringify(baseline)),
    phase: prior ? "recheck" : "baseline",
    canonicalVerified: records.filter((record) => record.coverage === "canonical").length,
    exportOnly: records.filter((record) => record.coverage === "export-only").length,
    exportedVerified: exported.size,
    changed,
    logicalRequests,
    attempts,
  };
}

async function main() {
  const env = process.env;
  requireThat(
    env.VERIFICATION_EXECUTE === "true",
    "execute is required: reads run existing Worker initialization and legacy cleanup",
    "invalid_input",
  );
  const phase = env.VERIFICATION_PHASE;
  requireThat(
    phase === "baseline" || phase === "recheck",
    "invalid verification phase",
    "invalid_input",
  );
  requireThat(
    phase === "baseline" ? !env.VERIFICATION_BASELINE : !!env.VERIFICATION_BASELINE,
    "baseline does not match phase",
    "invalid_input",
  );
  const result = await verifyCanonicalRecords({
    baseUrl: env.EXACT_REVIEW_QUEUE_URL ?? "https://clawsweeper.openclaw.ai",
    webhookSecret: env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
    repoSlug: env.VERIFICATION_REPO_SLUG ?? "",
    deploymentSha: env.EXPECTED_DEPLOYMENT_SHA ?? "",
    operatorSha: env.GITHUB_SHA ?? "",
    planSha256: env.REVIEWED_PLAN_SHA256 ?? "",
    ...(phase === "recheck" ? { baselineJson: env.VERIFICATION_BASELINE! } : {}),
  });
  // Only normalized metadata reaches logs or the summary; bodies stay in memory.
  const output = JSON.stringify(result);
  process.stdout.write(`${output}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${output}\n\`\`\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Only local categories, bounded diagnostics and fixed recovery text are printable.
    // Transport errors can contain response bodies, URLs or credentials.
    const category = error instanceof VerificationError ? error.category : "request_failed";
    process.stderr.write(
      `[canonical-record-verification] ${category}: ${RECOVERY[category]} No activation requested.\n` +
        (error instanceof VerificationError && error.diagnostics
          ? `[canonical-record-verification] request ${JSON.stringify(error.diagnostics)}\n`
          : "") +
        "[canonical-record-verification] FAILED (exit 1)\n",
    );
    process.exitCode = 1;
  });
}
