import { DatabaseSync } from "node:sqlite";
import { ReviewCoverageCensusStore } from "../../dashboard/review-coverage-census.ts";
import { runReviewCoverageCensus } from "../../dist/repair/review-coverage-census.js";
import type { CensusRepository } from "../../src/review-coverage-census.ts";
export function censusFixture(
  specs: { name: string; issues: number; pulls: number }[],
  owner = "fixture",
) {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query: string, ...values: unknown[]) {
        const statement = db.prepare(query);
        return statement.all(...(values as (string | number | null)[]));
      },
    },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try {
        const value = callback();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let store = new ReviewCoverageCensusStore(storage),
    time = Date.parse("2026-11-04T12:00:00Z"),
    queryCount = 0;
  const at = new Date(time - 1000).toISOString();
  const members = new Map(
    specs.map((s) => [
      s.name,
      {
        issues: Array.from({ length: s.issues }, (_, i) => i + 1),
        pulls: Array.from({ length: s.pulls }, (_, i) => 100001 + i),
        updated: at,
        labels: [] as string[],
        head: "a".repeat(40),
        reopened: null as string | null,
        overrides: new Map<
          number,
          { updated: string; labels: string[]; head: string; reopened: string | null }
        >(),
      },
    ]),
  );
  let mutate: ((name: string, query: number) => void) | null = null,
    dropResponse = false,
    interruptAfter = Infinity,
    accepted = 0;
  const population = (): CensusRepository[] =>
    specs.map((s) => ({
      repo: owner + "/" + s.name,
      id: "ID_" + s.name,
      revision: "policy-v1",
      scope: "eligible",
      visibility: "public",
      issues: members.get(s.name)!.issues.length,
      pulls: members.get(s.name)!.pulls.length,
      countsAt: new Date(time).toISOString(),
    }));
  const query = (text: string) => {
    queryCount++;
    const matches = [
      ...text.matchAll(
        /r(\d+):repository\(owner:"[^"]+",name:"([^"]+)"\) { id nameWithOwner (issues|pullRequests)\(states:OPEN,orderBy:{field:CREATED_AT,direction:ASC},first:100,after:(null|"[^"]+")\)/g,
      ),
    ];
    if (!matches.length) throw new Error("fixture query not understood");
    return {
      data: Object.fromEntries(
        matches.map((m) => {
          const name = m[2]!,
            kind = m[3]!,
            cursor = JSON.parse(m[4]!),
            start = cursor === null ? 0 : Number(cursor.slice(1));
          mutate?.(name, queryCount);
          const r = members.get(name)!,
            ids = kind === "issues" ? r.issues : r.pulls,
            end = Math.min(start + 100, ids.length);
          return [
            "r" + m[1],
            {
              id: "ID_" + name,
              nameWithOwner: owner + "/" + name,
              [kind]: {
                totalCount: ids.length,
                pageInfo: {
                  hasNextPage: end < ids.length,
                  endCursor: end > start ? "c" + end : null,
                },
                nodes: ids.slice(start, end).map((number) => ({
                  number,
                  updatedAt: (r.overrides.get(number) ?? r).updated,
                  ...(kind === "pullRequests"
                    ? { headRefOid: (r.overrides.get(number) ?? r).head }
                    : {}),
                  labels: {
                    nodes: (r.overrides.get(number) ?? r).labels.map((name) => ({ name })),
                    pageInfo: { hasNextPage: false },
                  },
                  timelineItems: {
                    nodes: (r.overrides.get(number) ?? r).reopened
                      ? [{ createdAt: (r.overrides.get(number) ?? r).reopened }]
                      : [],
                  },
                })),
              },
            },
          ];
        }),
      ),
    };
  };
  const control = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (path.endsWith("/start")) return store.start(body, time);
    if (path.endsWith("/next")) {
      if (accepted >= interruptAfter && body.observe !== true)
        throw new Error("simulated process interruption");
      return store.next(body, time);
    }
    if (path.endsWith("/fail")) return store.fail(body, time);
    if (path.endsWith("/accept")) {
      const result = await store.accept(body, time);
      accepted++;
      if (dropResponse) {
        dropResponse = false;
        throw new Error("lost HTTP response after durable accept");
      }
      return result;
    }
    throw new Error("fixture route not understood");
  };
  return {
    db,
    storage,
    members,
    population,
    query,
    control,
    get store() {
      return store;
    },
    get time() {
      return time;
    },
    get queryCount() {
      return queryCount;
    },
    setMutation(value: typeof mutate) {
      mutate = value;
    },
    loseResponse() {
      dropResponse = true;
    },
    interrupt(n: number) {
      interruptAfter = n;
    },
    restart(elapsed = 6 * 60_000) {
      time += elapsed;
      interruptAfter = Infinity;
      accepted = 0;
      store = new ReviewCoverageCensusStore(storage);
    },
    run() {
      return runReviewCoverageCensus({
        repositories: population(),
        control,
        query,
        now: () => time,
      });
    },
    states() {
      return db
        .prepare("SELECT repo,state FROM coverage_census_repositories ORDER BY repo")
        .all()
        .map((row) => ({ repo: String(row.repo), state: JSON.parse(String(row.state)) }));
    },
  };
}
