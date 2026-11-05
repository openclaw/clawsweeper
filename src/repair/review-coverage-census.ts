import { createHmac, randomUUID } from "node:crypto";
import {
  CENSUS,
  censusBytes,
  censusCursor,
  censusRecord,
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
      observedAt,
    };
  });
}
export async function runReviewCoverageCensus(options: {
  repositories: CensusRepository[];
  control: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  query: (query: string) => unknown | Promise<unknown>;
  now?: () => number;
  attempt?: string;
}) {
  const attempt = options.attempt ?? randomUUID(),
    now = options.now ?? Date.now;
  const call = (suffix: string, body: Record<string, unknown>) =>
    options.control("/internal/review-coverage/census/" + suffix, {
      version: CENSUS.version,
      attempt,
      ...body,
    });
  const started = await call("start", {
    repositories: options.repositories,
    observedAt: new Date(now()).toISOString(),
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
  let queries = 0,
    accepted = 0,
    failed = 0;
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
    try {
      const value = await options.query(censusQuery(work));
      if (censusBytes(value) > CENSUS.wireBytes) throw new Error("census query byte bound");
      pages = censusQueryPages(value, work, new Date(now()).toISOString());
    } catch {
      failed++;
      await call("fail", { work });
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
    const result = censusRecord(JSON.parse(text));
    if (!response.ok || result.ok !== true)
      throw new Error(String(result.error ?? "census control failed"));
    return result;
  };
}
