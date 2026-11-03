// Build-only authority boundary. Never bundled into the browser or called by an
// anonymous Worker read. One fresh owner listing per build, same GITHUB_TOKEN
// owner as before; no persisted visibility/TTL or shared App quota admission.
import { createHmac } from "node:crypto";
import { combineCorpus, type CorpusCache } from "./records.ts";
import { validatedLiveCoverage } from "../../dashboard/public-live-coverage.ts";

type Json = Record<string, any>;
const purpose = '{"purpose":"dashboard-site-coverage-v1"}';
const repoName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const validRepoName = (value: string) =>
  repoName.test(value) && value.split("/").every((part) => part !== "." && part !== "..");

export async function readCoverageForBuild(
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  origin = "https://clawsweeper.openclaw.ai",
): Promise<Json> {
  if (!secret) throw new Error("coverage_build_secret_required");
  try {
    const response = await fetchImpl(origin + "/internal/review-coverage/build", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" +
          createHmac("sha256", secret)
            .update("coverage-build-read-v1\nPOST\n/internal/review-coverage/build\n" + purpose)
            .digest("hex"),
      },
      body: purpose,
    });
    if (!response.ok) throw new Error("coverage_build_read_failed");
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      (data as Json).scope !== "authenticated-coverage-candidates" ||
      !Array.isArray((data as Json).fleets)
    )
      throw new Error("coverage_build_read_failed");
    return data as Json;
  } catch {
    // No upstream body, identity, URL or secret may reach public build logs.
    throw new Error("coverage_build_read_failed");
  }
}

function metadata(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("coverage_visibility_unverified");
  const row = value as Json;
  if (
    typeof row.full_name !== "string" ||
    !validRepoName(row.full_name) ||
    !["public", "private", "internal"].includes(row.visibility) ||
    (row.private !== undefined && typeof row.private !== "boolean") ||
    (row.visibility === "public" && row.private === true) ||
    ["archived", "fork"].some((k) => row[k] !== undefined && typeof row[k] !== "boolean")
  )
    throw new Error("coverage_visibility_unverified");
  return row;
}

export async function verifyPublicRepositories(
  names: string[],
  github: (path: string) => Promise<Response>,
): Promise<{ names: Set<string>; states: Record<string, string> }> {
  const requested = [...new Set(names.map((name) => name.toLowerCase()))];
  if (requested.some((name) => !validRepoName(name)))
    throw new Error("coverage_visibility_unverified");
  const observed = new Map<string, Json>(),
    seen = new Set<string>();
  const visible = new Set<string>(),
    states: Record<string, string> = {};
  const keep = (name: string, value: Json) => {
    // Redirect/rename/transfer is NOT proof of the requested identity.
    if (value.visibility !== "public" || value.full_name.toLowerCase() !== name) return;
    visible.add(name);
    states[name] =
      value.archived === true
        ? "Archived public repository; historical only"
        : value.fork === true
          ? "Public fork; eligibility not inferred"
          : "Public metadata observed; eligibility not inferred";
  };
  try {
    for (const owner of new Set(requested.map((name) => name.split("/")[0]))) {
      for (let page = 1; ; page++) {
        const response = await github(
          "users/" + owner + "/repos?type=owner&per_page=100&page=" + page,
        );
        if (!response.ok) throw new Error("coverage_visibility_unverified");
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("coverage_visibility_unverified");
        for (const raw of rows) {
          const row = metadata(raw),
            name = row.full_name.toLowerCase();
          if (seen.has(name)) throw new Error("coverage_visibility_unverified");
          seen.add(name);
          observed.set(name, row);
        }
        if (rows.length < 100) break;
      }
    }
    for (const name of requested) {
      const listed = observed.get(name);
      if (listed) {
        keep(name, listed);
        continue;
      }
      const response = await github("repos/" + name);
      if (response.status === 404) continue;
      if (!response.ok) throw new Error("coverage_visibility_unverified");
      keep(name, metadata(await response.json()));
    }
    return { names: visible, states };
  } catch {
    throw new Error("coverage_visibility_unverified");
  }
}

export function publicCoverageForBuild(source: Json, currentPublicNames: Set<string>) {
  if (source.scope !== "authenticated-coverage-candidates" || !Array.isArray(source.fleets))
    throw new Error("coverage_build_read_failed");
  // Drop revoked identities BEFORE recomputing every public-cohort total.
  const result = validatedLiveCoverage(
    { ...source, fleets: source.fleets.filter((row: Json) => currentPublicNames.has(row.repo)) },
    source.generated_at,
    source.inventory_generated_at,
    source.window_days,
  );
  if (!result) throw new Error("coverage_build_read_failed");
  return result;
}

export async function publicDashboardInputs(
  cache: CorpusCache,
  candidates: Json,
  github: (path: string) => Promise<Response>,
) {
  const verified = await verifyPublicRepositories(
    [
      ...cache.repositories.map((part) => part.stats.repo),
      ...candidates.fleets.map((row: Json) => row.repo),
    ],
    github,
  );
  return {
    corpus: combineCorpus(cache, (repo) => verified.names.has(repo.toLowerCase())),
    coverage: publicCoverageForBuild(candidates, verified.names),
    repositoryStates: verified.states,
  };
}
