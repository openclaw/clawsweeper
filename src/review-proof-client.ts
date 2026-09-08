import { createHash } from "node:crypto";
import { validReviewProofPlan, validFixedWebUiProofPlan } from "./review-proof-plan.js";
import {
  REVIEW_PROOF_LIFETIME_MS,
  REVIEW_PROOF_RESPONSE_MAX_BYTES,
} from "./review-proof-limits.js";

export interface ReviewProofCapability {
  queueUrl: string;
  allowedScenarios?: Array<"telegram-bot-e2e-proof" | "web-ui-chat-proof">;
  lease: {
    itemKey: string;
    leaseId: string;
    leaseRevision: number;
    claimGeneration: number;
    runId: string;
    runAttempt: number;
    sourceHeadSha: string;
  };
}

const proofDeadlines = new WeakMap<ReviewProofCapability, { owner: string; expiresAt: number }>();

/** Resolve policy from the owning queue item, never from model-visible prompt text. */
export async function resolveReviewProofCapability(
  capability: ReviewProofCapability,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ReviewProofCapability> {
  const denied: ReviewProofCapability = { ...capability, allowedScenarios: [] };
  try {
    const response = await fetcher(new URL("/internal/exact-review/proof", capability.queueUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "capabilities", lease: capability.lease }),
    });
    if (!response.ok) return denied;
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return denied;
    const result = value as Record<string, unknown>;
    if (
      result?.ok !== true ||
      !Array.isArray(result.allowedScenarios) ||
      result.allowedScenarios.length > 2 ||
      !result.allowedScenarios.every(
        (scenario: unknown) =>
          scenario === "telegram-bot-e2e-proof" || scenario === "web-ui-chat-proof",
      )
    )
      return denied;
    return {
      ...capability,
      allowedScenarios: [...new Set(result.allowedScenarios)],
    } as ReviewProofCapability;
  } catch {
    return denied;
  }
}

export function reviewProofTools(capability: ReviewProofCapability) {
  return [
    ...(capability.allowedScenarios?.includes("telegram-bot-e2e-proof") ? [reviewProofTool] : []),
    ...(capability.allowedScenarios?.includes("web-ui-chat-proof") ? [webUiReviewProofTool] : []),
  ];
}

export function reviewProofCapabilityFromEnv(
  repository: string,
  headSha: string,
  env: NodeJS.ProcessEnv = process.env,
): ReviewProofCapability | undefined {
  if (repository !== "openclaw/openclaw" || !/^[a-f0-9]{40}$/.test(headSha)) return;
  const positive = (name: string) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const lease = {
    itemKey: env.EXACT_REVIEW_ITEM_KEY ?? "",
    leaseId: env.EXACT_REVIEW_LEASE_ID ?? "",
    leaseRevision: positive("EXACT_REVIEW_LEASE_REVISION"),
    claimGeneration: positive("EXACT_REVIEW_CLAIM_GENERATION"),
    runId: /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID! : "",
    runAttempt: positive("GITHUB_RUN_ATTEMPT"),
    sourceHeadSha: env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "",
  };
  if (
    !lease.itemKey ||
    !lease.leaseId ||
    !lease.leaseRevision ||
    !lease.claimGeneration ||
    !lease.runId ||
    !lease.runAttempt ||
    lease.sourceHeadSha !== headSha
  )
    return;
  const queueUrl = env.QUEUE_URL || "https://clawsweeper.openclaw.ai";
  try {
    const url = new URL(queueUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return;
  } catch {
    return;
  }
  return { queueUrl, lease };
}

export function canonicalProofPlan(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProofPlan).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalProofPlan(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const text = { type: "string", minLength: 1, maxLength: 4096 };
const offset = { type: "integer", minimum: 0, maximum: 60_000 };
export const reviewProofTool = {
  type: "function",
  name: "request_behavior_proof",
  description:
    "Request a bounded Telegram E2E scenario against this exact PR when runtime observations would materially help this review. Use Telegram to exercise relevant core behavior too. This runs inside the current review; inspect all returned observations before judging the claim. Missing, rejected, failed or timed-out proof is inconclusive, never a pass. No shell commands, configuration patches, paths, URLs or credentials are accepted. At most three bounded requests. Do not request unrelated smoke tests.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["claim", "actions", "modelReplies", "settings", "maxDurationMs", "expectations"],
    properties: {
      claim: { type: "string", minLength: 1, maxLength: 1024 },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "atMs", "text"],
              properties: { type: { const: "send" }, atMs: offset, text },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "atMs", "messageText", "buttonText", "timeoutMs"],
              properties: {
                type: { const: "click" },
                atMs: offset,
                messageText: text,
                buttonText: { type: "string", minLength: 1, maxLength: 256 },
                timeoutMs: { type: "integer", minimum: 1, maximum: 10_000 },
              },
            },
          ],
        },
      },
      modelReplies: { type: "array", maxItems: 8, items: text },
      settings: {
        type: "object",
        additionalProperties: false,
        required: ["streaming", "nativeCommands"],
        properties: {
          streaming: { enum: ["off", "partial", "block"] },
          nativeCommands: { type: "boolean" },
        },
      },
      maxDurationMs: { type: "integer", minimum: 1000, maximum: 90_000 },
      expectations: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
  },
};

export const webUiReviewProofTool = {
  type: "function",
  name: "request_web_ui_chat_proof",
  description:
    "Run the existing fixed Web UI chat send/final-reply smoke check against this PR, only when that specific check helps the review. Uses a mocked Gateway: it does not execute an arbitrary UI scenario, real provider/channel, authentication, or settings flow. Assess applicability and returned evidence before your final decision; completion is not blanket proof for the PR.",
  inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
};

export async function requestReviewProof(
  capability: ReviewProofCapability,
  proofPlan: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  scenario: "telegram-bot-e2e-proof" | "web-ui-chat-proof" = "telegram-bot-e2e-proof",
): Promise<unknown> {
  if (!capability.allowedScenarios?.includes(scenario))
    return { status: "inconclusive", reason: "Proof scenario is not authorized for this review." };
  const encoded = JSON.stringify(proofPlan);
  if (
    !encoded ||
    !(scenario === "web-ui-chat-proof"
      ? validFixedWebUiProofPlan(proofPlan)
      : validReviewProofPlan(proofPlan))
  ) {
    return { status: "inconclusive", reason: "Invalid or oversized data-only proof plan." };
  }
  const planSha256 = createHash("sha256").update(canonicalProofPlan(proofPlan)).digest("hex");
  const owner = canonicalProofPlan({ queueUrl: capability.queueUrl, lease: capability.lease });
  const previous = proofDeadlines.get(capability);
  let deadline =
    previous?.owner === owner ? previous.expiresAt : Date.now() + REVIEW_PROOF_LIFETIME_MS;
  proofDeadlines.set(capability, { owner, expiresAt: deadline });
  let operation = "request";
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetcher(new URL("/internal/exact-review/proof", capability.queueUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
        ]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lease: capability.lease,
          operation,
          scenario,
          proofPlan,
          planSha256,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: "inconclusive",
          reason: `Proof service rejected or unavailable (HTTP ${response.status}).`,
        };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: "inconclusive", reason: "Proof service returned no evidence." };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > REVIEW_PROOF_RESPONSE_MAX_BYTES) {
          await reader.cancel();
          throw new Error("oversized evidence");
        }
        chunks.push(part.value);
      }
      if (signal.aborted || Date.now() >= deadline) throw new Error("proof deadline expired");
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (["completed", "pending", "dispatch_claimed"].includes(String(result.state))) {
        if (!Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) <= 0)
          throw new Error("missing or invalid proof expiry");
        deadline = Math.min(deadline, Number(result.expiresAt));
        proofDeadlines.set(capability, { owner, expiresAt: deadline });
        if (Date.now() >= deadline) throw new Error("proof deadline expired");
      }
      if (result.state !== "pending" && result.state !== "dispatch_claimed") return result;
      operation = "poll";
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Math.min(3000, deadline - Date.now())));
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    } catch {
      return {
        status: "inconclusive",
        reason: "Proof transport failed or its time budget expired; no pass established.",
      };
    }
  }
  return {
    status: "inconclusive",
    reason:
      "Proof time budget expired; continue this review without treating missing evidence as success.",
  };
}
