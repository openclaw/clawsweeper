import { createHmac, randomUUID } from "node:crypto";
import {
  censusDiagnostic,
  censusFailureCategory,
  type CensusDiagnostic,
  type CensusPhase,
} from "../coverage-census-diagnostics.js";

export interface CensusProgressDiagnostic extends CensusDiagnostic {
  queries: number;
  accepted: number;
  failed: number;
}
// Diagnostics are observational metadata, never a change to a caller-owned throw.
const failureDiagnostics = new WeakMap<object, CensusDiagnostic>();
function failureKey(error: unknown): object | null {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? error
    : null;
}
function failureDiagnostic(error: unknown): CensusDiagnostic | null {
  const key = failureKey(error);
  return key ? (failureDiagnostics.get(key) ?? null) : null;
}
function associateDiagnostic(error: unknown, diagnostic: CensusDiagnostic | null): void {
  const key = failureKey(error);
  if (key && diagnostic) failureDiagnostics.set(key, diagnostic);
}
export function censusOperationalFailure(error: unknown): string {
  const diagnostic = failureDiagnostic(error);
  return diagnostic
    ? `census_failed phase=${diagnostic.phase} category=${diagnostic.category}`
    : "census_failed category=unclassified";
}
function diagnosticError(diagnostic: CensusDiagnostic, cause: unknown): Error {
  const error = new Error(
    `census_failed phase=${diagnostic.phase} category=${diagnostic.category}`,
    {
      cause,
    },
  );
  associateDiagnostic(error, diagnostic);
  return error;
}
import {
  CENSUS,
  censusBytes,
  censusCursor,
  censusRecord,
  censusObservationWindow,
  type CensusObservationWindow,
  censusSignatureInput,
  censusToken,
  type CensusPage,
  type CensusRepository,
  type CensusWork,
} from "../review-coverage-census.js";
import type { ReviewCoverageOpenItem } from "../review-coverage.js";

export function censusQuery(work: CensusWork[]): string {
  return (
    "query ResumableCoverage { " +
    work
      .map((w, i) => {
        const [owner, name] = w.repo.split("/"),
          connection = w.kind === "issue" ? "issues" : "pullRequests";
        return (
          "r" +
          i +
          ":repository(owner:" +
          JSON.stringify(owner) +
          ",name:" +
          JSON.stringify(name) +
          ") { id nameWithOwner " +
          connection +
          "(states:OPEN,orderBy:{field:CREATED_AT,direction:ASC},first:100,after:" +
          JSON.stringify(w.cursor) +
          ") { totalCount pageInfo { hasNextPage endCursor } nodes { number updatedAt " +
          (w.kind === "pull_request" ? "headRefOid" : "") +
          " labels(first:100) { nodes { name } pageInfo { hasNextPage } } timelineItems(last:1,itemTypes:[REOPENED_EVENT]) { nodes { ... on ReopenedEvent { createdAt } } } } } }"
        );
      })
      .join(" ") +
    " }"
  );
}
export function censusQueryPages(
  value: unknown,
  work: CensusWork[],
  observedAt: string,
): CensusPage[] {
  const root = censusRecord(value);
  if (root.errors) throw new Error("census GraphQL errors");
  const data = censusRecord(root.data);
  return work.map((w, i) => {
    const repo = censusRecord(data["r" + i]);
    if (
      repo.id !== w.id ||
      typeof repo.nameWithOwner !== "string" ||
      repo.nameWithOwner.toLowerCase() !== w.repo
    )
      throw new Error("census repository identity changed");
    const connection = censusRecord(repo[w.kind === "issue" ? "issues" : "pullRequests"]),
      info = censusRecord(connection.pageInfo);
    if (!Array.isArray(connection.nodes)) throw new Error("incomplete census nodes");
    if (typeof info.hasNextPage !== "boolean") throw new Error("incomplete census pagination");
    const sourcePageInfo = {
      hasNextPage: info.hasNextPage,
      endCursor: censusCursor(info.endCursor),
    };
    const items: ReviewCoverageOpenItem[] = connection.nodes.map((value) => {
      const n = censusRecord(value),
        labels = censusRecord(n.labels),
        labelInfo = censusRecord(labels.pageInfo),
        timeline = censusRecord(n.timelineItems);
      if (
        labelInfo.hasNextPage !== false ||
        !Array.isArray(labels.nodes) ||
        !Array.isArray(timeline.nodes) ||
        timeline.nodes.length > 1
      )
        throw new Error("incomplete census metadata");
      const reopened =
        timeline.nodes[0] === undefined ? null : censusRecord(timeline.nodes[0]).createdAt;
      return {
        number: n.number as number,
        kind: w.kind,
        updated_at: n.updatedAt as string,
        reopened_at: reopened as string | null,
        labels: labels.nodes.map((x) => censusRecord(x).name as string),
        ...(w.kind === "pull_request" ? { head_sha: n.headRefOid as string } : {}),
      };
    });
    return {
      ...w,
      items,
      total: connection.totalCount as number,
      next: sourcePageInfo.hasNextPage ? sourcePageInfo.endCursor : null,
      hasNext: sourcePageInfo.hasNextPage,
      sourcePageInfo,
      observedAt: w.observationWindow ? null : observedAt,
    };
  });
}
export type PreparedCensusObservation = {
  attempt: string;
  observationWindow: CensusObservationWindow;
};
// MUST precede the source count read. A 404 alone negotiates safe legacy fallback;
// an advertised/prepared window is never silently downgraded after an error.
export async function prepareCensusObservation(
  options: Parameters<typeof censusHttpControl>[0],
): Promise<PreparedCensusObservation | null> {
  let unsupported = false;
  const request = options.fetchImpl ?? fetch;
  const control = censusHttpControl({
    ...options,
    fetchImpl: async (url, init) => {
      const response = await request(url, init);
      unsupported = response.status === 404;
      return response;
    },
  });
  const attempt = randomUUID();
  try {
    const result = await control("/internal/review-coverage/census/prepare", {
      version: CENSUS.version,
      attempt,
    });
    if (result.clock !== "server-query-window-v1")
      throw new Error("invalid census observation clock");
    return { attempt, observationWindow: censusObservationWindow(result.observationWindow) };
  } catch (error) {
    if (unsupported) return null;
    throw error;
  }
}
export async function runReviewCoverageCensus(options: {
  repositories: CensusRepository[];
  control: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  query: (query: string) => unknown | Promise<unknown>;
  now?: () => number;
  attempt?: string;
  observation?: PreparedCensusObservation | null;
  onDiagnostic?: (diagnostic: CensusProgressDiagnostic) => void;
}) {
  const attempt = options.observation?.attempt ?? options.attempt ?? randomUUID(),
    now = options.now ?? Date.now;
  let queries = 0,
    accepted = 0,
    failed = 0;
  const report = (diagnostic: CensusDiagnostic) => {
    try {
      options.onDiagnostic?.({ ...diagnostic, queries, accepted, failed });
    } catch {
      // Observability must not alter collection or replace its original failure.
    }
  };
  const call = async (suffix: Exclude<CensusPhase, "query">, body: Record<string, unknown>) => {
    try {
      return await options.control("/internal/review-coverage/census/" + suffix, {
        version: CENSUS.version,
        attempt,
        ...body,
      });
    } catch (error) {
      const observed = failureDiagnostic(error);
      const diagnostic =
        observed?.phase === suffix
          ? observed
          : { phase: suffix, category: censusFailureCategory(error) };
      associateDiagnostic(error, diagnostic);
      report(diagnostic);
      // Observing a control failure must not change its exception identity.
      throw error;
    }
  };
  const started = await call("start", {
    repositories: options.observation
      ? options.repositories.map((repository) => ({
          ...repository,
          countsAt: options.observation!.observationWindow.startedAt,
        }))
      : options.repositories,
    observedAt: options.observation?.observationWindow.startedAt ?? new Date(now()).toISOString(),
    ...(options.observation ? { observationWindow: options.observation.observationWindow } : {}),
  });
  if (started.capacityBlocked === true || started.metadataAccepted === false) {
    return {
      queries: 0,
      accepted: 0,
      failed: 0,
      trace: [],
      observational: true,
      capacityBlocked: started.capacityBlocked === true,
      metadataAccepted: started.metadataAccepted === true,
      stale: started.stale === true,
    };
  }
  const counts = new Map<string, number>(),
    trace: { repo: string; kind: string; cursor: string | null; pass: number }[] = [];
  let controlSteps = 0;
  while (queries < CENSUS.queries && controlSteps++ < CENSUS.controlSteps) {
    const excluded = [...counts]
      .filter(([, n]) => n >= CENSUS.pagesPerConnection)
      .map(([key]) => key);
    const response = await call("next", { excluded });
    if (!Array.isArray(response.work)) throw new Error("invalid census work response");
    if (!response.work.length) {
      if (response.pending === true) continue;
      break;
    }
    const work = response.work as CensusWork[];
    if (work.length > 10) throw new Error("census assignment bound");
    for (const w of work) {
      censusToken(w.repo);
      const key = w.repo + ":" + w.kind;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      trace.push({ repo: w.repo, kind: w.kind, cursor: w.cursor, pass: w.pass });
    }
    queries++;
    let pages: CensusPage[];
    let reading = true;
    try {
      const value = await options.query(censusQuery(work));
      reading = false;
      if (censusBytes(value) > CENSUS.wireBytes) throw new Error("census query byte bound");
      pages = censusQueryPages(value, work, new Date(now()).toISOString());
    } catch (error) {
      const diagnostic: CensusDiagnostic = {
        phase: "query",
        category: reading
          ? error instanceof SyntaxError
            ? "json"
            : "read_failed"
          : error instanceof Error && error.message === "census GraphQL errors"
            ? "graphql"
            : "schema",
      };
      report(diagnostic);
      failed++;
      try {
        await call("fail", { work });
      } catch {
        // A reporting rejection must not replace the original read failure.
        throw diagnosticError(diagnostic, error);
      }
      continue;
    }
    const requestId = randomUUID(),
      body = { requestId, pages };
    try {
      await call("accept", body);
    } catch {
      // An uncertain acceptance is observed before a retry or another query.
      // Replaying the exact request cannot append identities or advance twice.
      const observation = await call("next", { observe: true });
      const found =
        Array.isArray(observation.receipts) &&
        observation.receipts.some((x) => censusRecord(x).id === requestId);
      if (!found) {
        try {
          await call("accept", body);
        } catch {
          await call("fail", { work });
          failed++;
          continue;
        }
      }
    }
    accepted += work.length;
  }
  return {
    queries,
    accepted,
    failed,
    trace,
    observational: true,
    capacityBlocked: false,
    metadataAccepted: true,
    stale: false,
  };
}
export function censusHttpControl(options: {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}) {
  const base = options.baseUrl.replace(/\/$/, "");
  if (!base.startsWith("https://") || !options.secret)
    throw new Error("census control configuration missing");
  const request = options.fetchImpl ?? fetch;
  return async (path: string, value: Record<string, unknown>) => {
    const expected = censusDiagnostic({
      phase: path.endsWith("/prepare") ? "start" : path.split("/").at(-1),
      category: "unclassified",
    });
    try {
      const body = JSON.stringify(value);
      if (censusBytes(value) > CENSUS.wireBytes) throw new Error("census control byte bound");
      const signature =
        "sha256=" +
        createHmac("sha256", options.secret).update(censusSignatureInput(path, body)).digest("hex");
      const response = await request(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("census control response missing");
      const decoder = new TextDecoder();
      let bytes = 0,
        text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > CENSUS.wireBytes) {
          await reader.cancel();
          throw new Error("census control response bound");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch (error) {
        associateDiagnostic(error, expected ? { ...expected, category: "json" } : null);
        throw error;
      }
      const result = censusRecord(decoded);
      if (!response.ok || result.ok !== true) {
        const received = censusDiagnostic(result.diagnostic);
        const diagnostic = received?.phase === expected?.phase ? received : expected;
        const error = new Error(String(result.error ?? "census control failed"));
        associateDiagnostic(error, diagnostic);
        throw error;
      }
      return result;
    } catch (error) {
      const observed = failureDiagnostic(error);
      associateDiagnostic(error, observed?.phase === expected?.phase ? observed : expected);
      throw error;
    }
  };
}
