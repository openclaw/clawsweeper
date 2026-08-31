import baseWorker, { ExactReviewQueue as BaseQueue, StatusStore } from "./dashboard/worker.ts";
import { validateDirectPublicationPlan } from "./dashboard/exact-review-direct-publication.ts";
export { StatusStore };
// Harness-only network fence. No production credential, GitHub, or model calls.
let outbound = 0;
let unexpectedAlarms = 0;
globalThis.fetch = async () => {
  outbound += 1;
  throw new Error("proof forbids outbound Worker fetch");
};
const response = (value: unknown) => Response.json(value);
export class ExactReviewQueue extends BaseQueue {
  async alarm() {
    const q = this as any;
    const items = Object.values(q.readStateSync().items) as any[];
    if (items.length !== 1 || items[0].state !== "pending") {
      unexpectedAlarms += 1;
      throw new Error("proof alarm did not find exactly one pending item");
    }
    // A newly recovered review may already be due. Observe its pending state
    // at the alarm boundary, then suppress dispatch in this harness only.
    await q.storage.deleteAlarm();
    console.log("proof: dispatch suppressed after asserting exactly one pending item");
  }
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/publications/list")
      return super.fetch(request);
    const body = (await request.clone().json()) as any;
    if (!body.proof) return super.fetch(request);
    // These fixture-only operations are reached through the real signed public
    // Worker forwarding path, after the normal queue initialization barrier.
    const initialized = await super.fetch(
      new Request(request.url, { method: "POST", body: '{"limit":1}' }),
    );
    if (!initialized.ok) throw new Error("queue initialization failed");
    const q = this as any;
    if (body.proof === "seed") {
      const state = q.readStateSync();
      state.items = { [body.item.key]: body.item };
      q.writeStateSync(state);
      return response({ ok: true });
    }
    if (body.proof === "prior") {
      const plan = await validateDirectPublicationPlan(body.plan);
      return response(q.directPublicationStore.accept(plan, Date.now()));
    }
    if (body.proof === "authority") {
      const state = q.readStateSync();
      const item = state.items[body.key];
      if (body.change === "missing") delete item.leaseDecision;
      else if (body.change === "wrong_source") item.leaseDecision.sourceAction = "opened";
      else if (body.change === "current_plan")
        item.decision.publication.directLifecycle.plan = { kind: "policy_noop" };
      else if (body.change === "ambiguous") {
        const otherDecision = {
          ...item.decision.publication.producerDecision,
          itemNumber: item.decision.itemNumber + 1,
        };
        const otherKey = `${otherDecision.targetRepo}#${otherDecision.itemNumber}`;
        state.items[otherKey] = {
          ...item,
          key: otherKey,
          decision: otherDecision,
          leaseDecision: otherDecision,
        };
      } else throw new Error("unknown authority fixture");
      q.writeStateSync(state);
      return response({ ok: true });
    }
    if (body.proof === "inspect") {
      const state = q.readStateSync();
      const item = state.items[body.key] ?? null;
      if (body.expect_pending) {
        if (!item || item.state !== "pending" || Object.keys(state.items).length !== 1)
          throw new Error("expected exactly one pending item before suppressing dispatch");
        await q.storage.deleteAlarm();
      }
      const tables = [
        "exact_review_lifecycle_bay_event_v2",
        "exact_review_lifecycle_bay_pending_v2",
        "exact_review_lifecycle_bay_tide_buffer_v2",
      ];
      return response({
        item,
        item_count: Object.keys(state.items).length,
        projection: q.lifecycleProjectionStore.read(body.key, body.key, 4),
        newer_projection: q.lifecycleProjectionStore.read(body.key, body.key, 5),
        counters: [
          ...q.storage.sql.exec(
            "SELECT review_completed_total, publication_retried_total, publication_enqueued_total, publication_completed_total FROM exact_review_queue_metrics",
          ),
        ][0],
        bay_rows: Object.fromEntries(
          tables.map((t) => [
            t,
            [...q.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${t}`)][0].count,
          ]),
        ),
        outbound,
        unexpectedAlarms,
      });
    }
    throw new Error("unknown fixture operation");
  }
}
export default baseWorker;
