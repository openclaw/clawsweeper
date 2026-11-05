import type { DurableStorage } from "./durable-storage.ts";
import type {
  ReviewCoverageInventorySnapshot,
  ReviewCoverageOpenItem,
} from "../src/review-coverage.ts";
import {
  CENSUS,
  censusBytes,
  censusDate,
  censusDigest,
  censusChecksum,
  censusItem,
  censusIdentifier,
  censusPage,
  censusRecord,
  censusRepository,
  censusToken,
  type CensusKind,
  type CensusPage,
  type CensusRepository,
  type CensusWork,
} from "../src/review-coverage-census.ts";

type Connection = {
  cursor: string | null;
  done: boolean;
  count: number;
  total: number | null;
  stable: boolean;
  digest: string;
};
type Witness = {
  issue: string;
  pull_request: string;
  issues: number;
  pulls: number;
  stable: boolean;
  start: string;
  end: string;
};
type Generation = {
  id: string;
  pass: number;
  revision: number;
  started: string;
  passStarted: string;
  updated: number;
  turn: number;
  connections: Record<CensusKind, Connection>;
  previous: Witness | null;
  compatible?: boolean;
  promoting?: Witness;
  prunePass?: number;
};
type Complete = Witness & {
  generation: string;
  published: string;
  started: string;
  attemptStarted?: string;
};
type RepositoryState = {
  repository: CensusRepository;
  active: Generation | null;
  complete: Complete | null;
  reason: string | null;
  retryAt: number;
  lastReceipt: string | null;
  isolated?: boolean;
};
type Control = {
  attempt: string;
  until: number;
  frontier: string;
  turn: number;
  finalize?: string;
};
const EMPTY = (): Connection => ({
  cursor: null,
  done: false,
  count: 0,
  total: null,
  stable: true,
  digest: "",
});
const MAX_ROWS = CENSUS.identities * 2;

// Derived coverage state only. This class never opens a canonical-record,
// review-admission, audit-cursor, body-tiering or queue-alarm table.
export class ReviewCoverageCensusStore {
  private readonly storage: DurableStorage;
  private schemaInitialized = false;
  constructor(storage: DurableStorage) {
    this.storage = storage;
  }
  ensureSchemaSync() {
    if (this.schemaInitialized) return;
    const storage = this.storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coverage_census_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coverage_census_repositories (repo TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coverage_census_items (repo TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL, number INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, checksum INTEGER NOT NULL, seen INTEGER NOT NULL, slot TEXT NOT NULL, PRIMARY KEY(repo,generation,kind,number))",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS coverage_census_items_slot ON coverage_census_items(slot,repo,generation)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coverage_census_cursors (repo TEXT NOT NULL, generation TEXT NOT NULL, pass INTEGER NOT NULL, kind TEXT NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY(repo,generation,pass,kind,cursor))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS coverage_census_receipts (id TEXT PRIMARY KEY, attempt TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL)",
    );
    this.schemaInitialized = true;
  }
  private rows(query: string, ...args: unknown[]) {
    return Array.from(this.storage.sql.exec(query, ...args));
  }
  private meta<T>(key: string): T | null {
    const r = this.rows("SELECT value FROM coverage_census_meta WHERE key=?", key)[0];
    return r ? (JSON.parse(String(r.value)) as T) : null;
  }
  private putMeta(key: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO coverage_census_meta(key,value) VALUES(?,?)",
      key,
      JSON.stringify(value),
    );
  }
  private all(): RepositoryState[] {
    return this.rows(
      "SELECT state FROM coverage_census_repositories ORDER BY repo LIMIT ?",
      CENSUS.repositories,
    ).map((r) => JSON.parse(String(r.state)) as RepositoryState);
  }
  private state(repo: string): RepositoryState {
    const r = this.rows("SELECT state FROM coverage_census_repositories WHERE repo=?", repo)[0];
    if (!r) throw new Error("census repository missing");
    return JSON.parse(String(r.state)) as RepositoryState;
  }
  private save(s: RepositoryState, now: number) {
    if (censusBytes(s) > 16 * 1024) throw new Error("census metadata byte bound");
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO coverage_census_repositories(repo,state,updated) VALUES(?,?,?)",
      s.repository.repo,
      JSON.stringify(s),
      now,
    );
  }
  private lease(attempt: unknown, now: number): Control {
    const c = this.meta<Control>("control");
    if (!c || c.attempt !== censusIdentifier(attempt) || c.until < now)
      throw new Error("census lease conflict");
    return c;
  }
  private cleanup(now: number) {
    // Work stays bounded independently of fleet/history size. Expired active
    // generations lose authority before their orphan chunks are pruned.
    const expired = this.rows(
      "SELECT repo,state FROM coverage_census_repositories WHERE json_extract(state,'$.active.updated')<? ORDER BY updated LIMIT 32",
      now - CENSUS.retentionMs,
    );
    for (const row of expired) {
      const s = JSON.parse(String(row.state)) as RepositoryState;
      if (s.active) {
        this.storage.sql.exec(
          "UPDATE coverage_census_items SET slot='orphan' WHERE repo=? AND generation=?",
          row.repo,
          s.active.id,
        );
        this.storage.sql.exec(
          "DELETE FROM coverage_census_cursors WHERE repo=? AND generation=?",
          row.repo,
          s.active.id,
        );
        s.active = null;
        s.reason = "expired_census";
        this.save(s, now);
      }
    }
    this.storage.sql.exec(
      "DELETE FROM coverage_census_items WHERE rowid IN (SELECT rowid FROM coverage_census_items WHERE slot='orphan' LIMIT ?)",
      CENSUS.cleanupRows,
    );
    this.storage.sql.exec(
      "DELETE FROM coverage_census_receipts WHERE id IN (SELECT id FROM coverage_census_receipts WHERE created<? ORDER BY created LIMIT 32)",
      now - CENSUS.retentionMs,
    );
    this.storage.sql.exec(
      "DELETE FROM coverage_census_receipts WHERE id IN (SELECT id FROM coverage_census_receipts ORDER BY created DESC,rowid DESC LIMIT 32 OFFSET ?)",
      CENSUS.receipts,
    );
  }
  private witnessCurrent(s: RepositoryState, now: number): boolean {
    const c = s.complete;
    if (!c) return false;
    const start = Date.parse(c.started),
      end = Date.parse(c.end),
      counts = Date.parse(s.repository.countsAt);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Number.isFinite(counts) &&
      start <= end &&
      end <= now &&
      counts <= now &&
      now - start <= CENSUS.observationMaxAgeMs &&
      now - counts <= CENSUS.observationMaxAgeMs &&
      c.issues === s.repository.issues &&
      c.pulls === s.repository.pulls
    );
  }
  private completeCurrent(s: RepositoryState, now: number): boolean {
    return this.witnessCurrent(s, now) && (s.active ? s.active.compatible === true : !s.reason);
  }
  private populationObservation(
    repositories: CensusRepository[],
    observedAt: string,
    fingerprint: string,
    capacity: boolean,
  ) {
    const population = this.meta<{
      observed: string;
      count: number;
      countWitnessAt?: string;
      fingerprint?: string;
    }>("population");
    if (!population) return null;
    const currentAt =
      population.countWitnessAt ??
      this.all().reduce(
        (at, s) =>
          Date.parse(s.repository.countsAt) > Date.parse(at) ? s.repository.countsAt : at,
        population.count === 0 ? population.observed : "1970-01-01T00:00:00.000Z",
      );
    if (Date.parse(observedAt) < Date.parse(currentAt))
      return {
        ok: true,
        version: CENSUS.version,
        metadataAccepted: false,
        stale: true,
        capacityBlocked: this.meta<boolean>("blocked") === true,
        population: population.count,
      };
    if (Date.parse(observedAt) === Date.parse(currentAt)) {
      const same = population.fingerprint
        ? population.fingerprint === fingerprint
        : population.count === repositories.length &&
          JSON.stringify(
            this.all()
              .map((s) => s.repository)
              .sort((a, b) => a.repo.localeCompare(b.repo)),
          ) === JSON.stringify(repositories);
      if (same) {
        const detail = this.meta<Record<string, unknown>>("capacity");
        return {
          ok: true,
          version: CENSUS.version,
          metadataAccepted: true,
          replayed: true,
          capacityBlocked: this.meta<boolean>("blocked") === true,
          population: population.count,
          ...(detail
            ? {
                capacityReason: detail.reason,
                observedTotal: detail.observedTotal,
                sumOverflow: detail.sumOverflow,
              }
            : {}),
        };
      }
      if (!capacity) {
        if (this.meta<boolean>("blocked") !== true) {
          this.putMeta("blocked", true);
          this.putMeta("capacity", {
            represented: false,
            sumOverflow: false,
            reason: "observation_conflict",
          });
          for (const state of this.all()) {
            if (state.active) state.active.compatible = false;
            state.reason = "bounded_census";
            this.save(state, Date.parse(observedAt));
          }
        }
        return {
          ok: true,
          version: CENSUS.version,
          metadataAccepted: false,
          conflict: true,
          capacityBlocked: true,
          population: population.count,
        };
      }
    }
    return null;
  }
  private acceptCapacity(
    attempt: string,
    repositories: CensusRepository[],
    observedAt: string,
    fingerprint: string,
    total: number | null,
    sumOverflow: boolean,
    now: number,
  ) {
    return this.storage.transactionSync(() => {
      const control = this.meta<Control>("control");
      if (control && control.attempt !== attempt && control.until > now)
        throw new Error("census lease conflict");
      const replay = this.populationObservation(repositories, observedAt, fingerprint, true);
      if (replay) return replay;
      this.cleanup(now);
      const represented = repositories.length <= CENSUS.repositories,
        wanted = new Map(repositories.map((r) => [r.repo, r]));
      if (represented)
        for (const old of this.all())
          if (!wanted.has(old.repository.repo)) {
            this.storage.sql.exec(
              "UPDATE coverage_census_items SET slot='orphan' WHERE repo=?",
              old.repository.repo,
            );
            this.storage.sql.exec(
              "DELETE FROM coverage_census_cursors WHERE repo=?",
              old.repository.repo,
            );
            this.storage.sql.exec(
              "DELETE FROM coverage_census_repositories WHERE repo=?",
              old.repository.repo,
            );
          }
      const retained = represented
        ? repositories
        : this.all()
            .map((s) => wanted.get(s.repository.repo))
            .filter((r): r is CensusRepository => !!r);
      for (const repository of retained) {
        let state: RepositoryState;
        try {
          state = this.state(repository.repo);
        } catch {
          state = {
            repository,
            active: null,
            complete: null,
            reason: "bounded_census",
            retryAt: 0,
            lastReceipt: null,
          };
        }
        const old = state.repository,
          changed =
            old.id !== repository.id ||
            old.revision !== repository.revision ||
            old.visibility !== repository.visibility ||
            old.scope !== repository.scope;
        if (changed) {
          this.storage.sql.exec(
            "UPDATE coverage_census_items SET slot='orphan' WHERE repo=?",
            repository.repo,
          );
          this.storage.sql.exec(
            "DELETE FROM coverage_census_cursors WHERE repo=?",
            repository.repo,
          );
          state.active = null;
          state.complete = null;
        }
        const issueDrift = old.issues !== repository.issues,
          pullDrift = old.pulls !== repository.pulls;
        state.repository = repository;
        if (state.active && (issueDrift || pullDrift)) {
          const g = state.active;
          g.compatible = false;
          g.revision++;
          if (issueDrift) g.connections.issue.stable = false;
          if (pullDrift) g.connections.pull_request.stable = false;
          if (g.promoting) {
            g.previous = { ...g.promoting, stable: false };
            delete g.promoting;
            g.prunePass = g.pass;
            g.pass++;
            g.passStarted = observedAt;
            g.connections = { issue: EMPTY(), pull_request: EMPTY() };
          }
        }
        if (state.active && !this.witnessCurrent(state, now)) state.active.compatible = false;
        if (!this.completeCurrent(state, now)) state.reason = "bounded_census";
        this.save(state, now);
      }
      const reason = !represented
        ? "repository_metadata_capacity"
        : sumOverflow
          ? "count_sum_overflow"
          : "identity_capacity";
      this.putMeta("control", {
        attempt,
        until: now + CENSUS.leaseMs,
        frontier: control?.frontier ?? "",
        turn: control?.turn ?? 0,
        finalize: control?.finalize ?? "",
      });
      this.putMeta("population", {
        observed: observedAt,
        count: repositories.length,
        countWitnessAt: observedAt,
        fingerprint,
      });
      this.putMeta("blocked", true);
      this.putMeta("capacity", { represented, sumOverflow, observedTotal: total, reason });
      return {
        ok: true,
        version: CENSUS.version,
        metadataAccepted: true,
        capacityBlocked: true,
        capacityReason: reason,
        population: repositories.length,
        observedTotal: total,
        sumOverflow,
      };
    });
  }
  async start(value: unknown, now = Date.now()) {
    const v = censusRecord(value),
      attempt = censusIdentifier(v.attempt);
    if (
      v.version !== CENSUS.version ||
      !Array.isArray(v.repositories) ||
      censusBytes(v) > CENSUS.wireBytes
    )
      throw new Error("invalid census population");
    const repositories = v.repositories
      .map(censusRepository)
      .sort((a, b) => a.repo.localeCompare(b.repo));
    if (
      new Set(repositories.map((r) => r.repo)).size !== repositories.length ||
      new Set(repositories.map((r) => r.id)).size !== repositories.length
    )
      throw new Error("duplicate census repository");
    const latest = repositories.reduce(
      (at, r) => Math.max(at, Date.parse(r.countsAt)),
      Number.NEGATIVE_INFINITY,
    );
    const observedAt =
      v.observedAt === undefined
        ? repositories.length
          ? new Date(latest).toISOString()
          : (() => {
              throw new Error("empty census observation requires timestamp");
            })()
        : censusDate(censusToken(v.observedAt));
    if (Date.parse(observedAt) > now || Date.parse(observedAt) < latest)
      throw new Error("invalid census observation time");
    const fingerprint = await censusDigest([observedAt, repositories]);
    let total = 0,
      sumOverflow = false;
    for (const repository of repositories)
      for (const count of [repository.issues, repository.pulls])
        if (!sumOverflow) {
          if (count > Number.MAX_SAFE_INTEGER - total) sumOverflow = true;
          else total += count;
        }
    if (repositories.length > CENSUS.repositories || sumOverflow || total > CENSUS.identities)
      return this.acceptCapacity(
        attempt,
        repositories,
        observedAt,
        fingerprint,
        sumOverflow ? null : total,
        sumOverflow,
        now,
      );
    return this.storage.transactionSync(() => {
      const old = this.meta<Control>("control");
      if (old && old.attempt !== attempt && old.until > now)
        throw new Error("census lease conflict");
      const replay = this.populationObservation(repositories, observedAt, fingerprint, false);
      if (replay) return replay;
      this.cleanup(now);
      const wanted = new Set(repositories.map((r) => r.repo));
      for (const s of this.all())
        if (!wanted.has(s.repository.repo)) {
          this.storage.sql.exec(
            "UPDATE coverage_census_items SET slot='orphan' WHERE repo=?",
            s.repository.repo,
          );
          this.storage.sql.exec(
            "DELETE FROM coverage_census_cursors WHERE repo=?",
            s.repository.repo,
          );
          this.storage.sql.exec(
            "DELETE FROM coverage_census_repositories WHERE repo=?",
            s.repository.repo,
          );
        }
      for (const repository of repositories) {
        let s: RepositoryState;
        try {
          s = this.state(repository.repo);
        } catch {
          s = {
            repository,
            active: null,
            complete: null,
            reason: "pending_census",
            retryAt: 0,
            lastReceipt: null,
          };
        }
        if (
          s.repository.id !== repository.id ||
          s.repository.revision !== repository.revision ||
          s.repository.visibility !== repository.visibility ||
          s.repository.scope !== repository.scope
        ) {
          this.storage.sql.exec(
            "UPDATE coverage_census_items SET slot='orphan' WHERE repo=?",
            repository.repo,
          );
          this.storage.sql.exec(
            "DELETE FROM coverage_census_cursors WHERE repo=?",
            repository.repo,
          );
          s.active = null;
          s.complete = null;
          s.reason = "qualification_changed";
        }
        s.repository = repository;
        if (s.active && !this.witnessCurrent(s, now)) s.active.compatible = false;
        if (
          !s.active &&
          (!s.complete ||
            !!s.reason ||
            s.complete.issues !== repository.issues ||
            s.complete.pulls !== repository.pulls ||
            now - Date.parse(s.complete.published) >= CENSUS.refreshMs) &&
          !this.rows(
            "SELECT 1 FROM coverage_census_items WHERE repo=? AND slot='orphan' LIMIT 1",
            repository.repo,
          ).length
        ) {
          const compatible = this.completeCurrent(s, now);
          s.active = {
            compatible,
            id: crypto.randomUUID(),
            pass: 1,
            revision: 0,
            started: new Date(now).toISOString(),
            passStarted: new Date(now).toISOString(),
            updated: now,
            turn: 0,
            connections: { issue: EMPTY(), pull_request: EMPTY() },
            previous: null,
          };
          s.reason = "collecting";
        }
        this.save(s, now);
      }
      this.putMeta("control", {
        attempt,
        until: now + CENSUS.leaseMs,
        frontier: old?.frontier ?? "",
        finalize: old?.finalize ?? "",
        turn: old?.turn ?? 0,
      });
      this.putMeta("population", {
        observed: observedAt,
        count: repositories.length,
        countWitnessAt: observedAt,
        fingerprint,
      });
      this.putMeta("blocked", false);
      this.putMeta("capacity", null);
      return {
        ok: true,
        version: CENSUS.version,
        population: repositories.length,
        metadataAccepted: true,
        capacityBlocked: false,
      };
    });
  }
  next(value: unknown, now = Date.now()) {
    const v = censusRecord(value);
    if (v.version !== CENSUS.version) throw new Error("invalid census version");
    return this.storage.transactionSync(() => {
      const c = this.lease(v.attempt, now);
      if (v.observe === true)
        return {
          ok: true,
          receipts: this.rows(
            "SELECT id,result FROM coverage_census_receipts WHERE attempt=? ORDER BY created DESC,rowid DESC LIMIT ?",
            c.attempt,
            CENSUS.queries,
          ).map((r) => ({ id: r.id, ...(JSON.parse(String(r.result)) as object) })),
        };
      if (this.meta<boolean>("blocked") === true)
        return { ok: true, work: [], capacityBlocked: true };
      const pending = this.all()
        .filter(
          (s) => (s.active?.promoting || s.active?.prunePass !== undefined) && s.retryAt <= now,
        )
        .sort(
          (a, b) =>
            Number(a.repository.repo <= (c.finalize ?? "")) -
              Number(b.repository.repo <= (c.finalize ?? "")) ||
            a.repository.repo.localeCompare(b.repository.repo),
        )
        .slice(0, 10);
      let cleanupBudget: number = CENSUS.cleanupRows;
      if (pending.length) {
        for (const state of pending) {
          const generation = state.active!;
          const stale = Number(
            this.rows(
              "SELECT COUNT(*) AS n FROM coverage_census_items WHERE repo=? AND generation=? AND seen<>?",
              state.repository.repo,
              generation.id,
              generation.prunePass ?? generation.pass,
            )[0]?.n ?? 0,
          );
          this.promote(state, now, cleanupBudget);
          cleanupBudget -= Math.min(stale, cleanupBudget);
          c.finalize = state.repository.repo;
        }
        this.putMeta("control", c);
      } else this.cleanup(now);
      const excluded = new Set(
        Array.isArray(v.excluded)
          ? v.excluded.filter((x) => typeof x === "string").slice(0, CENSUS.repositories * 2)
          : [],
      );
      const candidates = this.all()
        .flatMap((s) => {
          const g = s.active;
          if (!g || g.promoting || g.prunePass !== undefined || s.retryAt > now) return [];
          const kinds: CensusKind[] =
            g.turn % 2 ? ["pull_request", "issue"] : ["issue", "pull_request"];
          const kind = kinds.find(
            (k) => !g.connections[k].done && !excluded.has(s.repository.repo + ":" + k),
          );
          if (!kind) return [];
          return [{ s, g, kind, connection: g.connections[kind] }];
        })
        .sort((a, b) => {
          const ar = a.s.repository.repo > c.frontier ? 0 : 1,
            br = b.s.repository.repo > c.frontier ? 0 : 1;
          return ar - br || a.s.repository.repo.localeCompare(b.s.repository.repo);
        });
      const continuing = candidates.filter((x) => x.connection.cursor !== null);
      const pool = c.turn % 2 === 0 && continuing.length ? continuing : candidates;
      const first = pool[0];
      if (!first)
        return {
          ok: true,
          work: [],
          pending:
            this.all().some(
              (s) =>
                (!!s.active?.promoting || s.active?.prunePass !== undefined) && s.retryAt <= now,
            ) ||
            this.rows("SELECT 1 FROM coverage_census_items WHERE slot='orphan' LIMIT 1").length > 0,
        };
      // First-page batching remains bounded to ten repository connections. The
      // alternating continuation reservation prevents a 145-small-repo flood
      // from monopolizing all 25 queries in every invocation.
      const selected =
        first.connection.cursor === null && !first.s.isolated
          ? pool.filter((x) => x.connection.cursor === null && !x.s.isolated).slice(0, 10)
          : [first];
      const work: CensusWork[] = selected.map(({ s, g, kind, connection }) => ({
        repo: s.repository.repo,
        id: s.repository.id,
        revision: s.repository.revision,
        generation: g.id,
        revisionNumber: g.revision,
        pass: g.pass,
        kind,
        cursor: connection.cursor,
      }));
      c.frontier = selected.at(-1)!.s.repository.repo;
      c.turn++;
      c.until = now + CENSUS.leaseMs;
      this.putMeta("control", c);
      return { ok: true, work };
    });
  }
  async accept(value: unknown, now = Date.now()) {
    const v = censusRecord(value),
      attempt = censusIdentifier(v.attempt),
      requestId = censusIdentifier(v.requestId);
    if (
      v.version !== CENSUS.version ||
      !Array.isArray(v.pages) ||
      !v.pages.length ||
      v.pages.length > 10 ||
      censusBytes(v) > CENSUS.wireBytes
    )
      throw new Error("invalid census acceptance");
    const pages = v.pages.map(censusPage),
      digest = await censusDigest(pages);
    if (new Set(pages.map((p) => p.repo)).size !== pages.length)
      throw new Error("duplicate census page repository");
    const hashes = await Promise.all(
      pages.map(async (p) => ({
        page: p,
        hash: await censusDigest([
          this.state(p.repo).active?.connections[p.kind].digest ?? "",
          p.items,
        ]),
      })),
    );
    for (const { page, hash } of hashes) await this.verifyRetained(page, hash, now);
    return this.storage.transactionSync(() => {
      const receipt = this.rows(
        "SELECT attempt,digest,result FROM coverage_census_receipts WHERE id=?",
        requestId,
      )[0];
      if (receipt) {
        if (receipt.attempt !== attempt || receipt.digest !== digest)
          throw new Error("census replay conflict");
        return { ok: true, ...(JSON.parse(String(receipt.result)) as object), replayed: true };
      }
      const control = this.lease(attempt, now);
      if (this.meta<boolean>("blocked") === true) throw new Error("census capacity blocked");
      for (const { page: p, hash } of hashes) this.acceptPage(p, hash, requestId, now);
      const result = { accepted: true, requestId };
      this.storage.sql.exec(
        "INSERT INTO coverage_census_receipts(id,attempt,digest,result,created) VALUES(?,?,?,?,?)",
        requestId,
        attempt,
        digest,
        JSON.stringify(result),
        now,
      );
      control.until = now + CENSUS.leaseMs;
      this.putMeta("control", control);
      this.cleanup(now);
      return { ok: true, ...result };
    });
  }
  private checkedPayload(row: Record<string, unknown>): ReviewCoverageOpenItem {
    const payload = String(row.payload);
    if (
      new TextEncoder().encode(payload).byteLength !== Number(row.bytes) ||
      Number(row.bytes) > CENSUS.chunkBytes ||
      censusChecksum(payload) !== Number(row.checksum)
    )
      throw new Error("census stored integrity failed");
    if (row.kind !== "issue" && row.kind !== "pull_request")
      throw new Error("census stored integrity failed");
    return censusItem(JSON.parse(payload), row.kind);
  }
  private async verifyRetained(p: CensusPage, pendingHash: string, now: number) {
    const s = this.state(p.repo),
      g = s.active,
      other = p.kind === "issue" ? "pull_request" : "issue";
    if (
      !g ||
      g.id !== p.generation ||
      g.revision !== p.revisionNumber ||
      p.hasNext ||
      !g.previous?.stable ||
      !g.connections[other].done ||
      !g.connections[other].stable ||
      !g.connections[p.kind].stable ||
      pendingHash !== g.previous[p.kind] ||
      g.connections[other].digest !== g.previous[other]
    )
      return;
    let visited = 0,
      bytes = 0;
    try {
      for (const kind of ["issue", "pull_request"] as const) {
        let digest = "",
          after = 0,
          count = 0;
        for (let page = 0; page < CENSUS.projectionPages; page++) {
          const rows = this.rows(
            "SELECT rowid,payload,bytes,checksum,kind FROM coverage_census_items WHERE repo=? AND generation=? AND kind=? AND seen=? AND rowid>? ORDER BY rowid LIMIT ?",
            p.repo,
            g.id,
            kind,
            g.pass,
            after,
            CENSUS.projectionRows,
          );
          if (!rows.length) break;
          const items = rows.map((row) => {
            visited++;
            bytes += Number(row.bytes);
            if (visited > CENSUS.identities || bytes > CENSUS.copyBytes)
              throw new Error("census retained verification bound");
            after = Number(row.rowid);
            return this.checkedPayload(row);
          });
          count += items.length;
          digest = await censusDigest([digest, items]);
          if (rows.length < CENSUS.projectionRows) break;
        }
        if (kind === p.kind) {
          digest = await censusDigest([digest, p.items]);
          count += p.items.length;
        } else if (count === 0) digest = await censusDigest(["", []]);
        const expected = kind === p.kind ? pendingHash : g.connections[kind].digest;
        if (
          digest !== expected ||
          count !== (kind === p.kind ? p.total : g.connections[kind].count)
        )
          throw new Error("census stored integrity failed");
      }
    } catch (error) {
      this.storage.transactionSync(() => {
        const current = this.state(p.repo);
        if (current.active?.id === g.id && current.active.revision === g.revision) {
          this.storage.sql.exec(
            "UPDATE coverage_census_items SET slot='orphan' WHERE repo=? AND generation=?",
            p.repo,
            g.id,
          );
          this.storage.sql.exec(
            "DELETE FROM coverage_census_cursors WHERE repo=? AND generation=?",
            p.repo,
            g.id,
          );
          current.active = null;
          current.reason = "corrupt_census";
          this.save(current, now);
        }
      });
      throw error;
    }
  }
  private retainedUsage() {
    const usage = { rows: 0, bytes: 0, stagingRows: 0, stagingBytes: 0 };
    for (const row of this.rows(
      "SELECT slot,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items GROUP BY slot",
    )) {
      const count = Number(row.n),
        bytes = Number(row.bytes);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("census retained accounting");
      usage.rows += count;
      usage.bytes += bytes;
      if (row.slot === "staging") {
        usage.stagingRows = count;
        usage.stagingBytes = bytes;
      }
    }
    if (!Number.isSafeInteger(usage.rows) || !Number.isSafeInteger(usage.bytes))
      throw new Error("census retained accounting");
    return usage;
  }
  private acceptPage(p: CensusPage, hash: string, receipt: string, now: number) {
    const s = this.state(p.repo),
      g = s.active,
      c = g?.connections[p.kind];
    if (
      !g ||
      !c ||
      g.id !== p.generation ||
      g.revision !== p.revisionNumber ||
      g.pass !== p.pass ||
      s.repository.id !== p.id ||
      s.repository.revision !== p.revision ||
      c.cursor !== p.cursor ||
      c.done
    )
      throw new Error("census checkpoint conflict");
    if (Date.parse(p.observedAt) > now || Date.parse(p.observedAt) < Date.parse(g.passStarted))
      throw new Error("census observation window conflict");
    if (
      p.next &&
      this.rows(
        "SELECT 1 FROM coverage_census_cursors WHERE repo=? AND generation=? AND pass=? AND kind=? AND cursor=?",
        p.repo,
        g.id,
        g.pass,
        p.kind,
        p.next,
      ).length
    )
      throw new Error("census cursor cycle");
    if (g.compatible && s.complete) {
      const expected = p.kind === "issue" ? s.complete.issues : s.complete.pulls;
      if (p.total !== expected) g.compatible = false;
      for (const item of p.items) {
        const prior = this.rows(
          "SELECT payload,bytes,checksum,kind FROM coverage_census_items WHERE repo=? AND generation=? AND kind=? AND number=? AND slot='complete'",
          p.repo,
          s.complete.generation,
          p.kind,
          item.number,
        )[0];
        if (!prior || JSON.stringify(this.checkedPayload(prior)) !== JSON.stringify(item)) {
          g.compatible = false;
          break;
        }
      }
    }
    const cursorBound =
      !!p.cursor &&
      Number(this.rows("SELECT COUNT(*) AS n FROM coverage_census_cursors")[0]?.n ?? 0) >=
        CENSUS.cursors;
    if (cursorBound) c.stable = false;
    if (p.cursor && !cursorBound)
      this.storage.sql.exec(
        "INSERT INTO coverage_census_cursors(repo,generation,pass,kind,cursor) VALUES(?,?,?,?,?)",
        p.repo,
        g.id,
        g.pass,
        p.kind,
        p.cursor,
      );
    const usage = this.retainedUsage();
    const exceeds = (rows = 0, bytes = 0) =>
      usage.rows + rows > MAX_ROWS ||
      usage.bytes + bytes > 2 * CENSUS.copyBytes ||
      usage.stagingRows + rows > CENSUS.identities ||
      usage.stagingBytes + bytes > CENSUS.copyBytes;
    // One whole old staging copy fits this finite page budget. Every candidate
    // read/delete is additionally bounded to pageNodes metadata rows, not payloads.
    let reclaimRemaining = CENSUS.identities;
    let newlySeen = 0;
    for (const item of p.items) {
      const old = this.rows(
        "SELECT seen,bytes,slot FROM coverage_census_items WHERE repo=? AND generation=? AND kind=? AND number=?",
        p.repo,
        g.id,
        p.kind,
        item.number,
      )[0];
      if (old?.seen === g.pass) {
        c.stable = false;
        continue;
      }
      newlySeen++;
      const bytes = censusBytes(item),
        oldBytes = old ? Number(old.bytes) : 0;
      if (
        old &&
        (old.slot !== "staging" ||
          !Number.isSafeInteger(oldBytes) ||
          oldBytes <= 0 ||
          oldBytes > CENSUS.chunkBytes)
      )
        throw new Error("census retained accounting");
      const rowDelta = old ? 0 : 1,
        byteDelta = bytes - oldBytes;
      while (exceeds(rowDelta, byteDelta)) {
        if (reclaimRemaining <= 0) throw new Error("census retained capacity bound");
        const candidates = this.rows(
          "SELECT rowid,bytes FROM coverage_census_items WHERE slot='staging' AND repo=? AND generation=? AND seen<? AND NOT(kind=? AND number=?) ORDER BY rowid LIMIT ?",
          p.repo,
          g.id,
          g.pass,
          p.kind,
          item.number,
          Math.min(CENSUS.pageNodes, reclaimRemaining),
        );
        if (!candidates.length) throw new Error("census retained capacity bound");
        let count = 0,
          lastRow = 0;
        for (const candidate of candidates) {
          const obsoleteBytes = Number(candidate.bytes),
            rowid = Number(candidate.rowid);
          if (
            !Number.isSafeInteger(obsoleteBytes) ||
            obsoleteBytes <= 0 ||
            obsoleteBytes > CENSUS.chunkBytes ||
            !Number.isSafeInteger(rowid) ||
            rowid <= 0
          )
            throw new Error("census retained accounting");
          count++;
          lastRow = rowid;
          reclaimRemaining--;
          usage.rows--;
          usage.stagingRows--;
          usage.bytes -= obsoleteBytes;
          usage.stagingBytes -= obsoleteBytes;
          if (usage.rows < 0 || usage.stagingRows < 0 || usage.bytes < 0 || usage.stagingBytes < 0)
            throw new Error("census retained accounting");
          if (!exceeds(rowDelta, byteDelta)) break;
        }
        // Prior-pass payloads are expendable: their witness is already a digest.
        // Excluding the replacement target prevents subtracting its bytes twice.
        this.storage.sql.exec(
          "DELETE FROM coverage_census_items WHERE rowid IN (SELECT rowid FROM coverage_census_items WHERE slot='staging' AND repo=? AND generation=? AND seen<? AND NOT(kind=? AND number=?) AND rowid<=? ORDER BY rowid LIMIT ?)",
          p.repo,
          g.id,
          g.pass,
          p.kind,
          item.number,
          lastRow,
          count,
        );
      }
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO coverage_census_items(repo,generation,kind,number,payload,bytes,checksum,seen,slot) VALUES(?,?,?,?,?,?,?,?,'staging')",
        p.repo,
        g.id,
        p.kind,
        item.number,
        JSON.stringify(item),
        bytes,
        censusChecksum(JSON.stringify(item)),
        g.pass,
      );
      usage.rows += rowDelta;
      usage.stagingRows += rowDelta;
      usage.bytes += byteDelta;
      usage.stagingBytes += byteDelta;
    }
    const actual = this.retainedUsage();
    if (
      actual.rows !== usage.rows ||
      actual.bytes !== usage.bytes ||
      actual.stagingRows !== usage.stagingRows ||
      actual.stagingBytes !== usage.stagingBytes
    )
      throw new Error("census retained accounting");
    if (exceeds()) throw new Error("census retained capacity bound");
    c.count += newlySeen;
    c.stable = c.stable && (c.total === null || c.total === p.total);
    c.total = p.total;
    c.digest = hash;
    c.done = !p.hasNext || cursorBound;
    c.cursor = c.done ? null : p.next;
    if (c.count > CENSUS.identities) throw new Error("census identity bound");
    if ((c.done && c.count !== c.total) || (!c.done && c.count >= p.total)) c.stable = false;
    if (!c.stable) g.compatible = false;
    g.revision++;
    g.turn++;
    g.updated = now;
    s.lastReceipt = receipt;
    s.isolated = false;
    s.retryAt = 0;
    s.reason = "collecting";
    if (g.connections.issue.done && g.connections.pull_request.done) {
      const a = g.connections.issue,
        b = g.connections.pull_request;
      const witness: Witness = {
        issue: a.digest,
        pull_request: b.digest,
        issues: a.count,
        pulls: b.count,
        stable: a.stable && b.stable,
        start: g.passStarted,
        end: p.observedAt,
      };
      g.prunePass = g.pass;
      const previous = g.previous;
      const same =
        previous?.stable &&
        witness.stable &&
        Date.parse(witness.end) - Date.parse(previous.start) <= CENSUS.observationMaxAgeMs &&
        previous.issue === witness.issue &&
        previous.pull_request === witness.pull_request &&
        previous.issues === witness.issues &&
        previous.pulls === witness.pulls;
      if (same) {
        g.promoting = witness;
        s.reason = "finalizing";
      } else {
        g.previous = witness;
        g.pass++;
        g.passStarted = new Date(now).toISOString();
        g.connections = { issue: EMPTY(), pull_request: EMPTY() };
        s.reason = witness.stable ? "verifying" : "count_drift";
      }
      this.storage.sql.exec(
        "DELETE FROM coverage_census_cursors WHERE repo=? AND generation=?",
        p.repo,
        g.id,
      );
    }
    this.save(s, now);
  }
  private promote(s: RepositoryState, now: number, cleanupBudget: number) {
    const g = s.active;
    if (!g || (g.prunePass === undefined && !g.promoting)) return;
    const prunePass = g.prunePass ?? g.pass;
    this.storage.sql.exec(
      "DELETE FROM coverage_census_items WHERE rowid IN (SELECT rowid FROM coverage_census_items WHERE repo=? AND generation=? AND seen<>? LIMIT ?)",
      s.repository.repo,
      g.id,
      prunePass,
      cleanupBudget,
    );
    if (
      this.rows(
        "SELECT 1 FROM coverage_census_items WHERE repo=? AND generation=? AND seen<>? LIMIT 1",
        s.repository.repo,
        g.id,
        prunePass,
      ).length
    )
      return;
    delete g.prunePass;
    g.updated = now;
    if (!g.promoting) {
      this.save(s, now);
      return;
    }
    const remaining = this.rows(
      "SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items WHERE slot='complete' AND repo<>?",
      s.repository.repo,
    )[0]!;
    const next = this.rows(
      "SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM coverage_census_items WHERE repo=? AND generation=?",
      s.repository.repo,
      g.id,
    )[0]!;
    if (
      Number(remaining.n) + Number(next.n) > CENSUS.identities ||
      Number(remaining.bytes) + Number(next.bytes) > CENSUS.copyBytes
    ) {
      s.reason = "bounded_census";
      s.retryAt = now + CENSUS.leaseMs;
      this.save(s, now);
      return;
    }
    this.storage.sql.exec(
      "UPDATE coverage_census_items SET slot='orphan' WHERE repo=? AND slot='complete'",
      s.repository.repo,
    );
    this.storage.sql.exec(
      "UPDATE coverage_census_items SET slot='complete' WHERE repo=? AND generation=?",
      s.repository.repo,
      g.id,
    );
    s.complete = {
      ...g.promoting,
      generation: g.id,
      started: g.previous!.start,
      attemptStarted: g.started,
      published: new Date(now).toISOString(),
    };
    s.active = null;
    s.reason = null;
    this.save(s, now);
  }
  fail(value: unknown, now = Date.now()) {
    const v = censusRecord(value),
      c = this.lease(v.attempt, now);
    if (v.version !== CENSUS.version || !Array.isArray(v.work) || v.work.length > 10)
      throw new Error("invalid census failure");
    const work = v.work;
    return this.storage.transactionSync(() => {
      for (const x of work) {
        const w = censusRecord(x),
          s = this.state(censusToken(w.repo));
        if (s.active?.id === w.generation && s.active.revision === w.revisionNumber) {
          s.reason = "census_read_failed";
          s.active.compatible = false;
          s.isolated = true;
          s.retryAt = now + CENSUS.leaseMs;
          this.save(s, now);
        }
      }
      c.until = now + CENSUS.leaseMs;
      this.putMeta("control", c);
      return { ok: true };
    });
  }
  inventory(now = Date.now()): ReviewCoverageInventorySnapshot | null {
    const blocked = this.meta<boolean>("blocked") === true,
      capacity = this.meta<{ represented: boolean; sumOverflow: boolean }>("capacity");
    if (blocked && (!capacity?.represented || capacity.sumOverflow))
      throw new Error("census population capacity unsupported");
    const population = this.meta<{ observed: string }>("population");
    if (!population) return null;
    let total = 0,
      bytes = 0;
    const repositories = this.all().map((s) => {
      const r = s.repository,
        complete = s.complete;
      const valid = !!complete && this.completeCurrent(s, now);
      const readRows = (query: string, ...bindings: unknown[]) => this.rows(query, ...bindings);
      const checked = (row: Record<string, unknown>) => this.checkedPayload(row);
      const items = valid
        ? {
            length: complete.issues + complete.pulls,
            slice(start: number, end: number): ReviewCoverageOpenItem[] {
              if (start < 0 || end < start || end - start > CENSUS.projectionRows)
                throw new Error("census partition bound");
              return readRows(
                "SELECT payload,bytes,checksum,kind FROM coverage_census_items WHERE repo=? AND generation=? AND slot='complete' ORDER BY rowid LIMIT ? OFFSET ?",
                r.repo,
                complete.generation,
                end - start,
                start,
              ).map((row) => checked(row));
            },
            *[Symbol.iterator](): IterableIterator<ReviewCoverageOpenItem> {
              let after = 0,
                seen = 0;
              for (let page = 0; page < CENSUS.projectionPages; page++) {
                const rows = readRows(
                  "SELECT rowid,payload,bytes,checksum,kind FROM coverage_census_items WHERE repo=? AND generation=? AND slot='complete' AND rowid>? ORDER BY rowid LIMIT ?",
                  r.repo,
                  complete.generation,
                  after,
                  CENSUS.projectionRows,
                );
                for (const row of rows) {
                  seen++;
                  bytes += Number(row.bytes);
                  if (seen > CENSUS.identities || bytes > 4 * CENSUS.copyBytes)
                    throw new Error("census projection capacity bound");
                  after = Number(row.rowid);
                  yield checked(row);
                }
                if (rows.length < CENSUS.projectionRows) break;
              }
              if (seen !== complete.issues + complete.pulls)
                throw new Error("census complete chunk missing");
            },
            some(predicate: (item: ReviewCoverageOpenItem) => unknown): boolean {
              for (const item of this) if (predicate(item)) return true;
              return false;
            },
          }
        : [];
      if (valid) {
        total += items.length;
        if (total > CENSUS.identities) throw new Error("census projection identity bound");
      }
      return {
        repo: r.repo,
        repo_slug: r.repo.replace("/", "-"),
        open_issues: r.issues,
        open_pull_requests: r.pulls,
        counts_observed_at: r.countsAt,
        ...(valid
          ? {
              collection_window: {
                started_at: complete.started,
                ended_at: complete.end,
                witness_observed_at: complete.end,
                published_at: complete.published,
              },
            }
          : {}),
        visibility: r.visibility,
        observation_scope: r.scope,
        complete: valid,
        reason: valid ? undefined : (s.reason ?? "stale_census"),
        items,
      };
    });
    return {
      generated_at: population.observed,
      repositories,
      ...(blocked ? { capacity_blocked: true } : {}),
    };
  }
  progress() {
    const states = this.all();
    return {
      participating: states.length,
      complete: states.filter((s) => this.completeCurrent(s, Date.now())).length,
      collecting: states.filter((s) => s.active).length,
      observational: true,
    };
  }
}
