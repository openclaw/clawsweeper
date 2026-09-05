import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CommandProofConsumer,
  type ProofPlanner,
} from "../../dist/repair/command-proof-consumer.js";
import { CommandProofHttpTransport } from "../../dist/repair/command-proof-http.js";
import {
  COMMAND_PROOF_PROFILES,
  type CommandProofScenario,
} from "../../src/command-proof-contract.ts";
import { CommandProofRequestStore } from "../../dashboard/command-proof-requests.ts";
import {
  worker,
  ExactReviewQueue,
  MemoryDurableStorage,
  MemoryDurableNamespace,
} from "../dashboard-worker-harness.ts";
import { proofFixture } from "./command-proof-fixtures.ts";

export function proofBatchHarness(
  options: {
    command?: string;
    planner?: ProofPlanner;
    database?: string;
    lostStart?: boolean;
    lostDispatch?: boolean;
    lostEnqueue?: boolean;
    expireAfterEnqueue?: boolean;
    failScenario?: string;
    inconclusiveScenario?: string;
  } = {},
) {
  let storage = new MemoryDurableStorage(options.database);
  let queue = new ExactReviewQueue({ storage }, {});
  const secret = randomBytes(32).toString("hex");
  const base = proofFixture();
  const live = {
    ...base.live,
    pull: { ...base.live.pull, title: "Change chat and Telegram formatting", changed_files: 1 },
  };
  live.comment.body = options.command ?? "@clawsweeper proof";
  const dispatches: string[] = [],
    enqueues: Record<string, any>[] = [],
    statuses: string[] = [];
  const fixtures = new Map<string, ReturnType<typeof proofFixture>>();
  let active = base,
    lostStart = false,
    lostDispatch = false,
    lostEnqueue = false,
    plans = 0;
  const json = (value: unknown) => Response.json(value);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.pathname.startsWith("/internal/")) {
      const body = await request.clone().json();
      if (url.pathname.endsWith("exact-review/enqueue")) enqueues.push(body);
      const response = await worker.fetch(request, {
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
      });
      if (
        response.ok &&
        options.expireAfterEnqueue &&
        url.pathname.endsWith("exact-review/enqueue")
      ) {
        const store = new CommandProofRequestStore(storage);
        const id = /^command-proof-([0-9a-f]{64})-/.exec(body.delivery_id)?.[1];
        const record = id ? store.get(id) : null;
        assert.ok(record);
        store.pending(record.expiresAt + 1);
      }
      if (response.ok && options.lostStart && !lostStart && body.operation === "batch-start") {
        lostStart = true;
        throw new Error("fixture lost start acknowledgement");
      }
      if (
        response.ok &&
        options.lostEnqueue &&
        !lostEnqueue &&
        url.pathname.endsWith("exact-review/enqueue")
      ) {
        lostEnqueue = true;
        throw new Error("fixture lost enqueue acknowledgement");
      }
      return response;
    }
    assert.equal(url.hostname, "api.github.com");
    const p = "/repos/openclaw/openclaw";
    if (url.pathname === p) return json(live.repository);
    if (url.pathname === p + "/pulls/42") return json(live.pull);
    if (url.pathname === p + "/issues/comments/200") return json(live.comment);
    if (url.pathname === p + "/collaborators/maintainer/permission") return json(live.permission);
    if (url.pathname === p + "/pulls/42/files")
      return json([
        {
          filename: "ui/src/ui/controllers/chat.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old chat render\n+new chat render",
        },
      ]);
    if (url.pathname === p + "/pulls/42/reviews" || url.pathname === p + "/issues/42/comments")
      return json([{ body: "Missing targeted proof", state: "COMMENTED" }]);
    if (url.pathname.startsWith(p + "/commits/"))
      return json({ sha: url.pathname.includes("telegram") ? "e".repeat(40) : "b".repeat(40) });
    if (request.method === "POST" && url.pathname.endsWith("/dispatches")) {
      const body = await request.json(),
        id = body.inputs.request_id;
      assert.equal(dispatches.includes(id), false, "no duplicate external dispatch");
      dispatches.push(id);
      const scenario = body.inputs.scenario ?? "web-ui-chat-proof";
      const f = proofFixture(
        id,
        scenario,
        options.failScenario === scenario ? "fail" : "pass",
        live.pull.head.sha,
        300 + dispatches.length,
      );
      if (options.inconclusiveScenario === scenario) f.jobs.jobs[0]!.conclusion = "failure";
      fixtures.set(String(f.run.id), f);
      if (options.lostDispatch && !lostDispatch) {
        lostDispatch = true;
        throw new Error("fixture lost dispatch acknowledgement");
      }
      return json({ workflow_run_id: f.run.id });
    }
    if (url.pathname.endsWith("/runs") && url.pathname.includes("/workflows/")) {
      const runs = [...fixtures.values()]
        .filter((f) => url.pathname.includes(f.claim.workflowPath.split("/").at(-1)!))
        .map((f) => f.run);
      return json({ workflow_runs: runs, total_count: runs.length });
    }
    const run = /\/actions\/runs\/(\d+)(.*)$/.exec(url.pathname);
    if (run) {
      active = fixtures.get(run[1]!)!;
      assert.ok(active, "known run");
      if (!run[2]) return json(active.run);
      if (run[2] === "/artifacts")
        return json({
          artifacts: [active.receiptArtifact, active.evidenceArtifact],
          total_count: 2,
        });
      if (run[2] === "/attempts/1/jobs") return json(active.jobs);
    }
    if (url.pathname.endsWith("/artifacts/401/zip")) return new Response(active.receiptArchive);
    if (url.pathname.endsWith("/artifacts/400/zip")) return new Response(active.evidenceArchive);
    throw new Error("unexpected fixture request " + request.method + " " + url.pathname);
  };
  const producer = Object.fromEntries(
    Object.keys(COMMAND_PROOF_PROFILES).map((id) => {
      const { workflowPath, workflowRef, workflowSha, harnessSha } = proofFixture(
        undefined,
        id as CommandProofScenario,
      ).claim;
      return [id, { workflowPath, workflowRef, workflowSha, harnessSha }];
    }),
  );
  const transport = new CommandProofHttpTransport({
    githubToken: "ephemeral-fixture-token",
    queueUrl: "https://clawsweeper.openclaw.ai",
    queueSecret: secret,
    fetchImpl,
    status: async (_claim, state, detail) => {
      statuses.push(state + ":" + detail);
    },
  });
  const planner: ProofPlanner = async (context) => {
    plans++;
    return options.planner
      ? options.planner(context)
      : {
          scenarios: Object.keys(COMMAND_PROOF_PROFILES),
          reason: "Controlled planner fixture selects three scenarios.",
          missingProof: "Real provider coverage remains absent.",
        };
  };
  const consumer = () => new CommandProofConsumer(transport, producer, planner);
  return {
    live,
    dispatches,
    enqueues,
    statuses,
    fixtures,
    fetchImpl,
    producer,
    secret,
    consumer,
    plans: () => plans,
    record: (id: string) => new CommandProofRequestStore(storage).get(id),
    request: () =>
      consumer().request({ repository: "openclaw/openclaw", pullRequest: 42, commentId: "200" }),
    recreate: () => {
      assert.ok(options.database);
      storage = new MemoryDurableStorage(options.database);
      queue = new ExactReviewQueue({ storage }, {});
    },
  };
}
