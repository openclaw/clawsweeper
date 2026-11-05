import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CensusWork } from "../review-coverage-census.js";
import { censusQuery, censusQueryPages } from "./review-coverage-census.js";

// No endpoint, repository, query, cursor, or credential-source overrides.
const work: CensusWork[] = (["issue", "pull_request"] as const).map((kind) => ({
  repo: "openclaw/openclaw",
  id: "", // Real returned ID is used only inside the parser, never emitted.
  revision: "probe",
  generation: "probe",
  revisionNumber: 0,
  pass: 0,
  kind,
  cursor: null,
}));
export const PROBE_QUERY = censusQuery(work);
export const PROBE_LIMITS = Object.freeze({ bytes: 1_900_000, timeoutMs: 15_000 });
export const RESULT_FILE = "coverage-credential-probe.json";
const endpoint = "https://api.github.com/graphql";
type Category =
  | "none"
  | "access"
  | "rate"
  | "schema"
  | "graphql"
  | "http"
  | "transport"
  | "timeout"
  | "body_oversize"
  | "missing_role";
type Rate = { cost: number; remaining: number; reset: string };
export type Observation = {
  role: "A" | "B";
  phase:
    | "parsed"
    | "http"
    | "graphql"
    | "parser"
    | "transport"
    | "timeout"
    | "body_oversize"
    | "missing_role";
  httpStatus: number | null;
  category: Category;
  parserItemCount: number | null;
  rate: Rate | null;
  elapsedMs: number;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function rate(value: unknown): Rate | null {
  const r = record(record(record(value).data).rateLimit);
  return Number.isSafeInteger(r.cost) &&
    (r.cost as number) >= 0 &&
    Number.isSafeInteger(r.remaining) &&
    (r.remaining as number) >= 0 &&
    typeof r.resetAt === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.resetAt) &&
    Number.isFinite(Date.parse(r.resetAt))
    ? { cost: r.cost as number, remaining: r.remaining as number, reset: r.resetAt }
    : null;
}
function errorCategory(errors: unknown[]): Category {
  // Never serialize messages, paths, extensions, or arbitrary error types.
  const types = errors.map((error) => record(error).type);
  const known = [
    "RATE_LIMITED",
    "FORBIDDEN",
    "UNAUTHORIZED",
    "NOT_FOUND",
    "GRAPHQL_VALIDATION_FAILED",
  ];
  if (types.some((type) => typeof type !== "string" || !known.includes(type))) return "graphql";
  if (types.includes("GRAPHQL_VALIDATION_FAILED")) return "schema";
  if (types.includes("RATE_LIMITED")) return "rate";
  return "access";
}
async function observe(role: "A" | "B", token: string | undefined): Promise<Observation> {
  const start = performance.now();
  const result: Observation = {
    role,
    phase: "missing_role",
    httpStatus: null,
    category: "missing_role",
    parserItemCount: null,
    rate: null,
    elapsedMs: 0,
  };
  if (!token) return result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_LIMITS.timeoutMs);
  let response: Response | undefined;
  try {
    result.phase = "transport";
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "user-agent": "clawsweeper-coverage-credential-probe",
      },
      body: JSON.stringify({ query: PROBE_QUERY }),
    });
    result.httpStatus = response.status;
    // Stream under the same deadline; Content-Length is not trusted.
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > PROBE_LIMITS.bytes) {
          result.phase = "body_oversize";
          result.category = "body_oversize";
          controller.abort();
          return result;
        }
        chunks.push(chunk);
      }
    }
    if (response.status !== 200) {
      result.phase = "http";
      result.category =
        response.status === 401 || response.status === 403
          ? "access"
          : response.status === 429
            ? "rate"
            : "http";
      return result;
    }
    result.phase = "parser";
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      result.category = "schema";
      return result;
    }
    result.rate = rate(value);
    const errors = record(value).errors;
    if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
      result.phase = "graphql";
      result.category = Array.isArray(errors) ? errorCategory(errors) : "schema";
      return result;
    }
    try {
      const data = record(record(value).data);
      const actualWork = work.map((w, i) => ({ ...w, id: record(data["r" + i]).id as string }));
      if (actualWork.some((w) => typeof w.id !== "string" || !w.id)) throw new Error();
      const pages = censusQueryPages(value, actualWork, new Date().toISOString());
      if (
        pages.length !== 2 ||
        pages.some(
          (p) =>
            !Number.isSafeInteger(p.total) ||
            p.total < p.items.length ||
            p.items.length > 100 ||
            p.items.some(
              (n) =>
                !Number.isSafeInteger(n.number) ||
                n.number < 1 ||
                typeof n.updated_at !== "string" ||
                n.labels.some((label) => typeof label !== "string"),
            ),
        )
      )
        throw new Error();
      result.parserItemCount = pages.reduce((sum, p) => sum + p.items.length, 0);
      result.phase = "parsed";
      result.category = "none";
    } catch {
      result.category = "schema";
    }
    return result;
  } catch {
    if (result.phase === "body_oversize") return result;
    result.phase = controller.signal.aborted ? "timeout" : "transport";
    result.category = result.phase;
    return result;
  } finally {
    clearTimeout(timer);
    result.elapsedMs = Math.max(0, Math.round(performance.now() - start));
  }
}

export async function runProbe(
  env: Partial<Record<"COVERAGE_PROBE_TOKEN_A" | "COVERAGE_PROBE_TOKEN_B" | "GITHUB_SHA", string>>,
) {
  // Deliberately serial: the very same generated query, A then B, no retries.
  const observations = [
    await observe("A", env.COVERAGE_PROBE_TOKEN_A),
    await observe("B", env.COVERAGE_PROBE_TOKEN_B),
  ];
  return {
    sourceSHA: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : null,
    querySHA: createHash("sha256").update(PROBE_QUERY).digest("hex"),
    publicTarget: "openclaw/openclaw" as const,
    observations,
  };
}
export function probeExitCode(result: Awaited<ReturnType<typeof runProbe>>): number {
  // Expected access/GraphQL/rate observations are not healthy-production claims.
  // Missing roles, transport, redirects/HTTP infrastructure and invalid parsing fail the job.
  return result.observations.some(
    (r) =>
      r.category === "missing_role" ||
      r.category === "transport" ||
      r.category === "timeout" ||
      r.category === "body_oversize" ||
      r.category === "schema" ||
      r.category === "graphql" ||
      r.category === "http",
  )
    ? 1
    : 0;
}
async function main() {
  const result = await runProbe(process.env);
  const json = JSON.stringify(result, null, 2) + "\n";
  writeFileSync(RESULT_FILE, json, { mode: 0o600 });
  process.stdout.write(json);
  process.exitCode = probeExitCode(result);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Fixed diagnostic only: no stack, exception text, env, or raw response.
    process.stderr.write("Coverage credential probe infrastructure failure.\n");
    process.exitCode = 1;
  });
}
