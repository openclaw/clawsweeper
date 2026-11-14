import {
  fleetCoverageResponse,
  fleetCoverageSelections,
  fixtureQuery,
  projectFixtureFields,
} from "./fleet-coverage-query.ts";
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
  implementations: {
    authority?: Awaited<ReturnType<typeof authorityFixture>>;
    worker?: typeof worker;
    runTargetFanout?: typeof runTargetFanout;
    readCoverageForBuild?: typeof readCoverageForBuild;
    protocolFlag?: boolean;
  } = {},
) {
  let activeWorker = implementations.worker ?? worker,
    activeCli = implementations.runTargetFanout ?? runTargetFanout,
    activeRead = implementations.readCoverageForBuild ?? readCoverageForBuild,
    protocolFlag = implementations.protocolFlag !== false;
  const authority = implementations.authority ?? (await authorityFixture()),
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
  const repositoryIds = new Map<string, unknown>(
    model.population().map((r) => [r.repo.slice("openclaw/".length), r.id]),
  );
  const absentCountRepositories = new Set<string>();
  const metadataOverrides = new Map<string, Record<string, unknown> | null>();
  const countExchanges: {
    query: string;
    selections: ReturnType<typeof fleetCoverageSelections>;
    response: unknown;
  }[] = [];
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
  // A killed producer never reaches its lease release; thrown test interrupts would.
  let killed = false;
  let controlFailure = false;
  let publicCoverageOverride: ((request: Request) => Response | Promise<Response>) | undefined;
  const publicCoverageReads: {
    path: string;
    method: string;
    query: string;
    authorization: boolean;
    signature: boolean;
    redirect: string;
  }[] = [];
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
        value = fleetCoverageResponse(query, (owner, name) => {
          const r = model.members.get(name);
          if (owner !== "openclaw" || !r || absentCountRepositories.has(name)) return null;
          return {
            id: repositoryIds.get(name),
            issues: countWitnesses.get(name)?.issues ?? r.issues.length,
            pulls: countWitnesses.get(name)?.pulls ?? r.pulls.length,
          };
        });
        countExchanges.push({
          query,
          selections: fleetCoverageSelections(query),
          response: structuredClone(value),
        });
      } else {
        legacy++;
        const selection = fixtureQuery(query);
        if (selection.operation !== "FleetCoverageItems")
          throw new Error("unexpected legacy inventory operation");
        value = {
          data: Object.fromEntries(
            selection.selection.map((root) => {
              if (
                root.name !== "repository" ||
                root.args.owner !== "openclaw" ||
                typeof root.args.name !== "string"
              )
                throw new Error("unsupported legacy repository selection");
              const name = root.args.name,
                r = model.members.get(name);
              if (!r) return [root.alias, null];
              const connection = (field: (typeof root.children)[number]) => {
                const numbers = field.name === "issues" ? r.issues : r.pulls,
                  after =
                    field.args.after == null
                      ? 0
                      : Number(String(field.args.after).replace(/^legacy/, "")),
                  count = Number(field.args.first ?? 100),
                  page = numbers.slice(after, after + count);
                return {
                  totalCount: numbers.length,
                  pageInfo: {
                    hasNextPage: after + count < numbers.length,
                    endCursor: page.length ? "legacy" + (after + page.length) : null,
                  },
                  nodes: page.map((number) => {
                    const item = r.overrides.get(number) ?? r;
                    return {
                      __typename: field.name === "issues" ? "Issue" : "PullRequest",
                      id: "source-" + name + "-" + number,
                      number,
                      state: "OPEN",
                      createdAt: item.updated,
                      updatedAt: item.updated,
                      headRefOid: item.head,
                      labels: {
                        totalCount: item.labels.length,
                        nodes: item.labels.map((name) => ({ name })),
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                      timelineItems: {
                        nodes: item.reopened ? [{ createdAt: item.reopened }] : [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    };
                  }),
                };
              };
              const raw: Record<string, unknown> = {
                id: repositoryIds.get(name),
                nameWithOwner: "openclaw/" + name,
              };
              for (const field of root.children)
                if (field.name === "issues" || field.name === "pullRequests")
                  raw[field.name] = connection(field);
              return [root.alias, projectFixtureFields(root.children, raw)];
            }),
          ),
        };
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
        ...metadataOverrides.get(args[1].slice(6)),
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
    if (url.hostname === "api.github.com") {
      const listed = /^\/(?:orgs|users)\/([^/]+)\/repos$/.exec(url.pathname);
      if (listed) {
        const names = new Set([
          ...specs.map((s) => "openclaw/" + s.name),
          ...(authority.cache?.repositories ?? []).map(
            (p: { stats: { repo: string } }) => p.stats.repo,
          ),
        ]);
        const rows = [...names]
          .filter((n) => n.split("/")[0] === listed[1])
          .sort()
          .flatMap((name) => {
            const override = metadataOverrides.get(name);
            if (metadataOverrides.has(name) && override === null) return [];
            const value = {
              full_name: name,
              private: false,
              visibility: "public",
              archived: false,
              fork: false,
              has_issues: true,
              default_branch: "main",
              ...override,
            };
            return value.private ? [] : [value];
          });
        const page = Number(url.searchParams.get("page") ?? 1);
        return Response.json(rows.slice((page - 1) * 100, page * 100));
      }
      const repo = url.pathname.replace(/^\/repos\//, "");
      if (metadataOverrides.has(repo) && metadataOverrides.get(repo) === null)
        return Response.json({}, { status: 404 });
      return Response.json({
        full_name: url.pathname.replace(/^\/repos\//, ""),
        private: false,
        visibility: "public",
        archived: false,
        fork: false,
        has_issues: true,
        default_branch: "main",
        ...metadataOverrides.get(repo),
      });
    }
    if (url.hostname !== "census-cli.invalid")
      throw new Error("Unexpected network blocked: " + url.hostname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, ...(body ? { body } : {}) });
    if (url.pathname === "/api/review-coverage" && method === "GET") {
      publicCoverageReads.push({
        path: url.pathname,
        method,
        query: url.search,
        authorization: request.headers.has("authorization"),
        signature: request.headers.has("x-clawsweeper-exact-review-signature"),
        redirect: request.redirect,
      });
      return publicCoverageOverride
        ? publicCoverageOverride(request)
        : activeWorker.fetch(request, env, {});
    }
    if (controlFailure && url.pathname.includes("/census/"))
      return new Response("controlled unsupported v2", { status: 404 });
    if (killed && url.pathname.endsWith("/census/release"))
      throw new Error("simulated producer kill");
    if (url.pathname.startsWith("/internal/review-coverage/")) {
      const response = await activeWorker.fetch(request, env, {});
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
    countExchanges,
    publicCoverageReads,
    setPublicCoverageResponse(reply: typeof publicCoverageOverride) {
      publicCoverageOverride = reply;
    },
    useImplementations(next: {
      worker: typeof worker;
      runTargetFanout: typeof runTargetFanout;
      readCoverageForBuild: typeof readCoverageForBuild;
      queue: typeof authority.queue;
      protocolFlag?: boolean;
    }) {
      activeWorker = next.worker;
      activeCli = next.runTargetFanout;
      activeRead = next.readCoverageForBuild;
      authority.queue = next.queue;
      protocolFlag = next.protocolFlag !== false;
    },
    setRepositoryId(name: string, id: unknown) {
      repositoryIds.set(name, id);
    },
    hideCountRepository(name: string) {
      absentCountRepositories.add(name);
    },
    setMetadataReply(repo: string, value: Record<string, unknown> | null) {
      metadataOverrides.set(repo, value);
    },
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
      const witness = model.population().find((r) => r.repo === "openclaw/" + name);
      if (!witness) throw new Error("new count source lacks repository identity");
      repositoryIds.set(name, witness.id);
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
    kill(value = true) {
      killed = value;
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
    async run(
      mode: string,
      protocol = "v2",
      reportOptions: { publish?: boolean; windowDays?: number } = {},
    ) {
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
      if (reportOptions.publish === false) {
        const at = args.indexOf("--publish-url");
        if (at >= 0) args.splice(at, 2);
      }
      if (reportOptions.windowDays !== undefined)
        args.push("--window-days", String(reportOptions.windowDays));
      await withReplayClock(model.time, () =>
        activeCli(
          protocolFlag
            ? args
            : args.filter(
                (_, i) =>
                  args[i] !== "--coverage-protocol" && args[i - 1] !== "--coverage-protocol",
              ),
        ),
      );
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
        activeRead(authority.secret, globalThis.fetch, "https://census-cli.invalid"),
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
