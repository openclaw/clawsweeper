import { randomUUID } from "node:crypto";
import { stableJson } from "../src/stable-json.ts";
import {
  activityHash,
  captureOversizedActivity,
  OVERSIZED_ACTIVITY_FENCE_MS,
  parseOversizedActivityEvidence,
  type OversizedActivityReference,
  type OversizedActivityBaseline,
  type OversizedActivityEvidence,
  type OversizedAcknowledgementReceipt,
  type OversizedActivityOwner,
} from "../src/oversized-activity-contract.ts";

type Kv = { get<T = unknown>(key: string): T | undefined; put(key: string, value: unknown): void };
type Meta = {
  reference: OversizedActivityReference;
  scope: string;
  receiptCount: number;
  invalid: string | null;
  pending: string | null;
  consumers?: Record<string, "active" | "complete" | "failed">;
};
type Control = {
  reference: OversizedActivityReference;
  scope: string;
  busyUntil: number;
  busyOwner?: string;
  fence?: { owner: OversizedActivityOwner; expiresAt: number };
};
const prefix = "oversized-activity:v1:";
const controlKey = (repo: string, number: number) =>
  `${prefix}item:${repo.toLowerCase()}#${number}`;
const epochKey = (ref: OversizedActivityReference) => `${prefix}epoch:${ref.epoch}`;

/** Additive, separate keys: no rewrite or migration of existing queue items. */
export class OversizedActivityStore {
  private readonly kv: Kv;
  constructor(kv: Kv) {
    this.kv = kv;
  }
  control(repo: string, number: number): Control | undefined {
    return this.kv.get(controlKey(repo, number));
  }
  private meta(ref: OversizedActivityReference): Meta | undefined {
    const meta = this.kv.get<Meta>(epochKey(ref));
    return meta && stableJson(meta.reference) === stableJson(ref) ? meta : undefined;
  }
  reference(repo: string, number: number, scope: unknown): OversizedActivityReference | undefined {
    const c = this.control(repo, number);
    return c?.scope === activityHash(scope) ? c.reference : undefined;
  }
  blocked(repo: string, number: number, now = Date.now()): boolean {
    const c = this.control(repo, number);
    return Boolean(c && (c.busyUntil > now || (c.fence && c.fence.expiresAt > now)));
  }
  async prepare(
    repo: string,
    number: number,
    scope: unknown,
    read: (path: string) => Promise<unknown>,
  ): Promise<OversizedActivityReference> {
    const old = this.control(repo, number);
    const scopeHash = activityHash(scope);
    if (old?.scope === scopeHash) return old.reference;
    if (this.blocked(repo, number)) throw new Error("oversized acknowledgement is fenced");
    const reference: OversizedActivityReference = { version: 1, repo, number, epoch: randomUUID() };
    const meta: Meta = {
      reference,
      scope: scopeHash,
      receiptCount: 0,
      invalid: "activity baseline capture incomplete",
      pending: null,
    };
    const captureToken = randomUUID();
    const control: Control = {
      reference,
      scope: scopeHash,
      busyUntil: Date.now() + 60_000,
      busyOwner: captureToken,
    };
    this.kv.put(epochKey(reference), meta);
    this.kv.put(controlKey(repo, number), control);
    try {
      // The source command/event must be outside GitHub's coarse timestamp margin.
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const capture = captureOversizedActivity(repo, number, new Date().toISOString(), true);
      let next = capture.next();
      while (next.done !== true) next = capture.next(await read(next.value));
      const current = this.control(repo, number);
      if (
        current?.reference.epoch !== reference.epoch ||
        current.busyOwner !== captureToken ||
        current.busyUntil <= Date.now()
      )
        throw new Error("activity capture ownership expired or changed");
      const b = next.value;
      // Keep each KV value below the platform limit even at the 300-entry bound.
      this.kv.put(`${epochKey(reference)}:source`, b.source);
      this.kv.put(`${epochKey(reference)}:comments`, b.comments);
      b.streams.forEach((s, i) => this.kv.put(`${epochKey(reference)}:stream:${i}`, s));
      meta.invalid = null;
      this.kv.put(epochKey(reference), meta);
    } catch (error) {
      this.invalidate(
        reference,
        `queue activity baseline unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      const current = this.control(repo, number);
      if (current?.reference.epoch === reference.epoch && current.busyOwner === captureToken) {
        current.busyUntil = 0;
        delete current.busyOwner;
        this.kv.put(controlKey(repo, number), current);
      }
    }
    return reference;
  }
  unavailable(
    repo: string,
    number: number,
    scope: unknown,
    reason: string,
  ): OversizedActivityReference {
    if (this.blocked(repo, number)) throw new Error("oversized acknowledgement is fenced");
    const existing = this.control(repo, number);
    if (existing) {
      this.invalidate(existing.reference, reason);
      return existing.reference;
    }
    const reference: OversizedActivityReference = { version: 1, repo, number, epoch: randomUUID() };
    const scopeHash = activityHash(scope);
    this.kv.put(epochKey(reference), {
      reference,
      scope: scopeHash,
      receiptCount: 0,
      invalid: reason,
      pending: null,
    });
    this.kv.put(controlKey(repo, number), { reference, scope: scopeHash, busyUntil: 0 });
    return reference;
  }
  lockAcknowledgement(ref: OversizedActivityReference): string {
    if (this.blocked(ref.repo, ref.number)) throw new Error("oversized acknowledgement is fenced");
    const c = this.control(ref.repo, ref.number);
    if (!c || c.reference.epoch !== ref.epoch)
      throw new Error("oversized acknowledgement reference is stale");
    c.busyUntil = Date.now() + 60_000;
    c.busyOwner = randomUUID();
    this.kv.put(controlKey(ref.repo, ref.number), c);
    return c.busyOwner;
  }
  assertAcknowledgement(ref: OversizedActivityReference, token: string): void {
    const c = this.control(ref.repo, ref.number);
    if (
      !c ||
      c.reference.epoch !== ref.epoch ||
      c.busyOwner !== token ||
      (c.fence && c.fence.expiresAt > Date.now())
    )
      throw new Error("oversized acknowledgement is fenced");
    c.busyUntil = Date.now() + 60_000;
    this.kv.put(controlKey(ref.repo, ref.number), c);
  }
  unlockAcknowledgement(ref: OversizedActivityReference, token: string): void {
    const c = this.control(ref.repo, ref.number);
    if (c?.reference.epoch !== ref.epoch || c.busyOwner !== token) return;
    c.busyUntil = 0;
    delete c.busyOwner;
    this.kv.put(controlKey(ref.repo, ref.number), c);
  }
  fence(
    ref: OversizedActivityReference,
    owner: OversizedActivityOwner,
    expiresAt: number,
  ): boolean {
    const c = this.control(ref.repo, ref.number);
    const meta = this.meta(ref);
    if (!c || c.reference.epoch !== ref.epoch || c.busyUntil > Date.now()) return false;
    if (
      meta?.pending &&
      !meta.invalid &&
      (!c.fence || stableJson(c.fence.owner) !== stableJson(owner))
    ) {
      this.invalidate(ref, "an owned write was still unresolved at publication handoff");
    }
    if (
      c.fence &&
      c.fence.expiresAt > Date.now() &&
      stableJson(c.fence.owner) !== stableJson(owner) &&
      !(
        c.fence.owner.itemKey === owner.itemKey &&
        c.fence.owner.leaseId === owner.leaseId &&
        owner.claimGeneration > c.fence.owner.claimGeneration
      )
    )
      return false;
    if (meta) {
      const key = activityHash(owner);
      const consumers = meta.consumers ?? {};
      if (Object.entries(consumers).some(([other, state]) => other !== key && state !== "complete"))
        meta.invalid = "previous publication owner did not seal its writes";
      if (Object.keys(consumers).length >= 500 && !consumers[key])
        meta.invalid = "publication owner history exceeds the validation bound";
      else consumers[key] = "active";
      meta.consumers = consumers;
      this.kv.put(epochKey(ref), meta);
    }
    c.fence = { owner, expiresAt: Math.min(expiresAt, Date.now() + OVERSIZED_ACTIVITY_FENCE_MS) };
    this.kv.put(controlKey(ref.repo, ref.number), c);
    return true;
  }
  owns(ref: OversizedActivityReference, owner: OversizedActivityOwner): boolean {
    const c = this.control(ref.repo, ref.number);
    return Boolean(
      c?.reference.epoch === ref.epoch &&
      c.fence &&
      c.fence.expiresAt > Date.now() &&
      stableJson(c.fence.owner) === stableJson(owner),
    );
  }
  seal(ref: OversizedActivityReference, owner: OversizedActivityOwner, failed: boolean): void {
    const meta = this.meta(ref);
    if (!meta) return;
    const key = activityHash(owner);
    if (meta.consumers?.[key])
      meta.consumers[key] = failed || meta.consumers[key] === "failed" ? "failed" : "complete";
    if (failed) meta.invalid = "publisher could not persist all owned-write receipts";
    this.kv.put(epochKey(ref), meta);
  }
  release(ref: OversizedActivityReference, owner: OversizedActivityOwner): void {
    const c = this.control(ref.repo, ref.number);
    if (!c?.fence || stableJson(c.fence.owner) !== stableJson(owner)) return;
    delete c.fence;
    this.kv.put(controlKey(ref.repo, ref.number), c);
  }
  invalidate(ref: OversizedActivityReference, reason: string): void {
    const meta = this.meta(ref);
    if (!meta) return;
    meta.invalid = reason;
    this.kv.put(epochKey(ref), meta);
  }
  begin(ref: OversizedActivityReference, receipt: OversizedAcknowledgementReceipt): void {
    const meta = this.meta(ref);
    if (!meta) throw new Error("activity evidence is missing");
    if (meta.pending) meta.invalid = "an earlier owned write has no complete receipt";
    meta.receiptCount++;
    meta.pending = receipt.id;
    if (meta.receiptCount > 500) meta.invalid = "owned-write history exceeds the validation bound";
    this.kv.put(`${epochKey(ref)}:receipt:${meta.receiptCount}`, receipt);
    this.kv.put(`${epochKey(ref)}:intent:${receipt.id}`, meta.receiptCount);
    this.kv.put(epochKey(ref), meta);
  }
  complete(ref: OversizedActivityReference, receipt: OversizedAcknowledgementReceipt): void {
    const meta = this.meta(ref);
    const index = this.kv.get<number>(`${epochKey(ref)}:intent:${receipt.id}`);
    if (!meta || !index) throw new Error("activity write intent is missing");
    const original = this.kv.get<OversizedAcknowledgementReceipt>(
      `${epochKey(ref)}:receipt:${index}`,
    );
    if (
      !original ||
      stableJson({ ...receipt, after: null, completedAt: null, pullAfter: null }) !==
        stableJson(original)
    )
      throw new Error("activity write intent changed");
    this.kv.put(`${epochKey(ref)}:receipt:${index}`, receipt);
    if (meta.pending === receipt.id) meta.pending = null;
    this.kv.put(epochKey(ref), meta);
  }
  evidence(ref: OversizedActivityReference): OversizedActivityEvidence | null {
    const meta = this.meta(ref);
    if (!meta) return null;
    if (meta.invalid)
      return { reference: ref, baseline: null, receipts: [], invalid: meta.invalid };
    const key = epochKey(ref);
    const baseline: OversizedActivityBaseline = {
      source: this.kv.get(`${key}:source`)!,
      comments: this.kv.get(`${key}:comments`)!,
      streams: [0, 1, 2, 3].map((i) => this.kv.get(`${key}:stream:${i}`)!),
    };
    return parseOversizedActivityEvidence({
      reference: ref,
      baseline,
      receipts: Array.from({ length: meta.receiptCount }, (_, i) =>
        this.kv.get(`${key}:receipt:${i + 1}`),
      ),
      invalid: meta.pending ? "owned write has no complete receipt" : null,
    });
  }
}
