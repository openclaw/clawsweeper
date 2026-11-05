import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { coverageCliFixture } from "./review-coverage-cli.ts";
export const COVERAGE_FAILURE_PRIVATE_MARKER =
  "SYNTHETIC_PRIVATE_ERROR_ID_secret_candidate ghp_never_echo private/secret-repo";
export type CoverageFailureStage = "count" | "start" | "next" | "page";
export type CoverageFailureKind = "http503" | "network" | "malformed" | "lease409";
// Only controlled upstream fault inputs. The actual producer, count projection,
// signed HTTP path and anonymous Worker report owners remain unchanged.
export function installCoverageFailure(
  f: Awaited<ReturnType<typeof coverageCliFixture>>,
  stage: CoverageFailureStage,
  kind: CoverageFailureKind = "http503",
) {
  const spawn = childProcess.spawnSync,
    transport = globalThis.fetch,
    query = f.model.query,
    original = new Error(COVERAGE_FAILURE_PRIVATE_MARKER);
  let counts = 0,
    identities = 0,
    pageOutage = false;
  const requests: { method: string; path: string; signaturePresent: boolean }[] = [];
  childProcess.spawnSync = ((command: unknown, args: readonly string[], options: unknown) => {
    if (
      command === "gh" &&
      args[0] === "api" &&
      args[1] === "graphql" &&
      args.some((a) => a.startsWith("query=") && a.includes("query FleetCoverage"))
    ) {
      counts++;
      if (stage === "count") throw original;
    }
    return (spawn as (...args: unknown[]) => unknown)(command, args, options);
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  f.model.query = (q) => {
    identities++;
    return query(q);
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    const census = url.pathname.includes("/review-coverage/census/");
    const selected = url.pathname.endsWith("/" + (stage === "page" ? "accept" : stage));
    // Page publication uses accept. A terminal control outage also rejects the
    // existing ACK-observation read; recovered ACKs keep the unchanged policy.
    if (census && stage === "page" && selected) pageOutage = true;
    if (census && (selected || pageOutage)) {
      requests.push({
        method: request.method,
        path: url.pathname,
        signaturePresent: request.headers.has("x-clawsweeper-exact-review-signature"),
      });
      if (kind === "network") throw original;
      if (kind === "malformed")
        return new Response(COVERAGE_FAILURE_PRIVATE_MARKER, { status: 200 });
      return Response.json(
        { ok: false, error: COVERAGE_FAILURE_PRIVATE_MARKER },
        { status: kind === "lease409" ? 409 : 503 },
      );
    }
    return transport(input, init);
  };
  return {
    original,
    requests,
    get countQueries() {
      return counts;
    },
    get identityQueries() {
      return identities;
    },
    restore() {
      globalThis.fetch = transport;
      childProcess.spawnSync = spawn;
      syncBuiltinESMExports();
      f.model.query = query;
    },
  };
}
