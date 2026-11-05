import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import worker from "../../dashboard/worker.ts";
import { ReviewCoverageCensusStore } from "../../dashboard/review-coverage-census.ts";
import { runTargetFanout } from "../../dist/repair/target-fanout.js";
import { censusHttpControl } from "../../dist/repair/review-coverage-census.js";
import { authorityFixture } from "../../docs/proof/ui-live-coverage/coverage-authority-fixture.mjs";
import { withReplayClock } from "../../docs/proof/ui-live-coverage/replay-clock.mjs";
import { readCoverageForBuild } from "../../dashboard-site/scripts/coverage.ts";
import { censusFixture } from "./review-coverage-census.ts";

// Executes the real CLI-mode owner. Only GH process/network boundaries and wall
// clock are controlled. Unknown subprocesses/mutations are rejected, never run.
export async function coverageCliFixture(
  specs: { name: string; issues: number; pulls: number }[],
  epoch = Date.now(),
) {
  const authority = await authorityFixture(),
    model = censusFixture(specs, "openclaw");
  model.restart(epoch - model.time);
  for (const repository of model.members.values())
    repository.updated = new Date(epoch - 1000).toISOString();
  const env = {
    ...authority.env,
    EXACT_REVIEW_QUEUE: { idFromName: (v: string) => v, get: () => authority.queue },
  };
  const originalFetch = globalThis.fetch,
    originalSpawn = childProcess.spawnSync,
    originalLog = console.log,
    originalError = console.error;
  const keys = [
    "CLAWSWEEPER_WEBHOOK_SECRET",
    "CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW",
    "CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE",
    "CLAWSWEEPER_HOSTED_TARGET_METADATA_TOKEN",
  ];
  const countWitnesses = new Map<string, { issues: number; pulls: number }>();
  const responses: { path: string; status: number; body: Record<string, unknown> }[] = [];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = authority.secret;
  process.env.CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW = "__public__";
  process.env.CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE = "__public__";
  process.env.CLAWSWEEPER_HOSTED_TARGET_METADATA_TOKEN = "synthetic-cli-metadata";
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [],
    logs: string[] = [],
    queries: { inventory: number; counts: number; legacy: number }[] = [];
  let currentMode = "normal-review",
    inventory = 0,
    counts = 0,
    legacy = 0,
    lastQuery = "";
  let observer: ((event: { path: string; body?: Record<string, unknown> }) => void) | undefined;
  let controlFailure = false;
  childProcess.spawnSync = ((command: unknown, args: readonly string[]) => {
    let value: unknown;
    if (args[0] === "repo" && args[1] === "list")
      value =
        args[2] === "openclaw"
          ? specs.map((s) => ({
              nameWithOwner: "openclaw/" + s.name,
              isArchived: false,
              isFork: false,
              hasIssuesEnabled: true,
              visibility: "PUBLIC",
              defaultBranchRef: { name: "main" },
            }))
          : [];
    else if (args[0] === "api" && args[1] === "graphql") {
      const query = args.find((x) => x.startsWith("query="))?.slice(6) ?? "";
      if (query.includes("ResumableCoverage")) {
        inventory++;
        lastQuery = query;
        value = model.query(query);
      } else if (query.includes("FleetCoverage {")) {
        counts++;
        value = {
          data: Object.fromEntries(
            [...query.matchAll(/r(\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)/g)].map((m) => {
              const r = model.members.get(m[3]!);
              if (!r) throw new Error("unknown count fixture");
              return [
                "r" + m[1],
                {
                  id: "ID_" + m[3],
                  issues: { totalCount: countWitnesses.get(m[3]!)?.issues ?? r.issues.length },
                  pullRequests: { totalCount: countWitnesses.get(m[3]!)?.pulls ?? r.pulls.length },
                },
              ];
            }),
          ),
        };
      } else {
        legacy++;
        value = { data: {} };
      }
    } else if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      value = {
        full_name: args[1].slice(6),
        private: false,
        visibility: "public",
        has_issues: true,
        default_branch: "main",
        archived: false,
        fork: false,
      };
    } else
      throw new Error(
        "Unexpected subprocess blocked: " + String(command) + " " + JSON.stringify(args),
      );
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(value),
      stderr: "",
      pid: 0,
      output: [],
    };
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      method = request.method;
    if (url.hostname === "api.github.com")
      return Response.json({
        full_name: url.pathname.replace(/^\/repos\//, ""),
        private: false,
        visibility: "public",
        archived: false,
        fork: false,
        has_issues: true,
        default_branch: "main",
      });
    if (url.hostname !== "census-cli.invalid")
      throw new Error("Unexpected network blocked: " + url.hostname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, ...(body ? { body } : {}) });
    if (controlFailure && url.pathname.includes("/census/"))
      return new Response("controlled unsupported v2", { status: 404 });
    if (url.pathname.startsWith("/internal/review-coverage/")) {
      const response = await worker.fetch(request, env, {});
      if (url.pathname.includes("/census/"))
        responses.push({
          path: url.pathname,
          status: response.status,
          body: (await response.clone().json()) as Record<string, unknown>,
        });
      if (url.pathname.includes("/census/"))
        observer?.({ path: url.pathname, ...(body ? { body } : {}) });
      return response;
    }
    if (method !== "GET") throw new Error("Non-coverage mutation blocked: " + url.pathname);
    if (url.pathname.includes("cursor"))
      return Response.json({
        ok: true,
        mode: currentMode,
        next_cursor: 0,
        revision: 0,
        updated_at: null,
        audit_batch: null,
      });
    return new Response("controlled unavailable planning pressure", { status: 503 });
  };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  return {
    authority,
    model,
    responses,
    setCountWitness(name: string, issues: number, pulls: number) {
      countWitnesses.set(name, { issues, pulls });
    },
    addCountedRepository(name: string, issues: number, pulls: number) {
      const template = model.members.values().next().value;
      if (!template) throw new Error("count fixture requires baseline");
      specs.push({ name, issues: 0, pulls: 0 });
      model.members.set(name, {
        ...template,
        issues: [],
        pulls: [],
        labels: [],
        overrides: new Map(),
      });
      countWitnesses.set(name, { issues, pulls });
    },
    calls,
    logs,
    queries,
    get time() {
      return model.time;
    },
    get lastQuery() {
      return lastQuery;
    },
    observe(callback: typeof observer) {
      observer = callback;
    },
    failControls(value: boolean) {
      controlFailure = value;
    },
    advance(ms: number) {
      model.restart(ms);
    },
    async run(mode: string, protocol = "v2") {
      currentMode = mode;
      inventory = 0;
      counts = 0;
      legacy = 0;
      const before = calls.length;
      const args = [
        ...(mode === "coverage" ? ["coverage"] : ["--mode", mode]),
        "--publish-url",
        "https://census-cli.invalid",
        "--cursor-store-url",
        "https://census-cli.invalid",
        "--coverage-protocol",
        protocol,
        "--owners",
        "openclaw",
        "--limit",
        "1",
        "--dry-run",
      ];
      await withReplayClock(model.time, () => runTargetFanout(args));
      const result = { inventory, counts, legacy };
      queries.push(result);
      return { ...result, calls: calls.slice(before) };
    },
    states() {
      return Array.from(
        authority.storage.sql.exec(
          "SELECT repo,state FROM coverage_census_repositories ORDER BY repo",
        ),
      ).map((r) => ({ repo: String(r.repo), state: JSON.parse(String(r.state)) }));
    },
    replayStart(body: Record<string, unknown>) {
      return withReplayClock(model.time, () =>
        censusHttpControl({
          baseUrl: "https://census-cli.invalid",
          secret: authority.secret,
          fetchImpl: globalThis.fetch,
        })("/internal/review-coverage/census/start", body),
      );
    },
    anonymous() {
      return withReplayClock(model.time, () =>
        worker.fetch(new Request("https://census-cli.invalid/api/review-coverage"), env, {}),
      );
    },
    inventory() {
      return new ReviewCoverageCensusStore(authority.storage).inventory(model.time);
    },
    read() {
      return withReplayClock(model.time, () =>
        readCoverageForBuild(authority.secret, globalThis.fetch, "https://census-cli.invalid"),
      );
    },
    close() {
      globalThis.fetch = originalFetch;
      childProcess.spawnSync = originalSpawn;
      syncBuiltinESMExports();
      console.log = originalLog;
      console.error = originalError;
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      model.db.close();
    },
  };
}
