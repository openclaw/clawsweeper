import { isJsonObject } from "./json-types.js";

export type OpenClawHookConfig = {
  hookUrl: string;
  token: string;
  agentId: string;
  channel: string;
  discordTarget: string;
  thinking: string;
  timeoutSeconds: number;
  retryAttempts: number;
};

export type OpenClawHookPost = {
  name: string;
  message: string;
  idempotencyKey: string;
  deliver: boolean;
};

export type OpenClawHookDeliveryStatus =
  | "delivered"
  | "admitted"
  | "suppressed"
  | "failed"
  | "unknown"
  | "not-requested";

export type OpenClawHookDelivery = {
  status: OpenClawHookDeliveryStatus;
  suppressionReason: string | null;
  error: string | null;
};

export type OpenClawHookPostResult = {
  runId: string | null;
  delivery: OpenClawHookDelivery;
};

const DEFAULT_AGENT_ID = "clawsweeper";
const DEFAULT_CHANNEL = "discord";
const DEFAULT_THINKING = "low";
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];
const MAX_DIAGNOSTIC_CHARS = 500;
const MAX_SUPPRESSION_REASON_CHARS = 80;

export function resolveOpenClawHookConfig(env: NodeJS.ProcessEnv): OpenClawHookConfig | null {
  const hookUrl = normalizeString(env.CLAWSWEEPER_OPENCLAW_HOOK_URL);
  const token = normalizeString(env.CLAWSWEEPER_OPENCLAW_HOOK_TOKEN);
  const discordTarget = normalizeString(env.CLAWSWEEPER_DISCORD_TARGET);
  if (!hookUrl || !token || !discordTarget) return null;
  return {
    hookUrl: resolveHookAgentUrl(hookUrl),
    token,
    agentId: normalizeString(env.CLAWSWEEPER_OPENCLAW_AGENT_ID) ?? DEFAULT_AGENT_ID,
    channel: normalizeString(env.CLAWSWEEPER_OPENCLAW_HOOK_CHANNEL) ?? DEFAULT_CHANNEL,
    discordTarget,
    thinking: normalizeString(env.CLAWSWEEPER_OPENCLAW_HOOK_THINKING) ?? DEFAULT_THINKING,
    timeoutSeconds: positiveInt(
      env.CLAWSWEEPER_OPENCLAW_HOOK_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
    ),
    retryAttempts: positiveInt(
      env.CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS,
      DEFAULT_RETRY_ATTEMPTS,
    ),
  };
}

export function resolveHookAgentUrl(raw: string): string {
  const url = new URL(raw);
  const trimmed = url.pathname.replace(/\/+$/, "");
  if (trimmed.endsWith("/agent")) {
    url.pathname = trimmed;
  } else {
    url.pathname = `${trimmed || ""}/agent`;
  }
  return url.toString();
}

export async function postOpenClawAgentHook({
  config,
  fetcher,
  post,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = delay,
}: {
  config: OpenClawHookConfig;
  fetcher: typeof fetch;
  post: OpenClawHookPost;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<OpenClawHookPostResult> {
  const attempts = Math.max(1, Math.floor(config.retryAttempts));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postOpenClawAgentHookOnce({ config, fetcher, post });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientOpenClawHookError(error)) {
        throw error;
      }
      await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function postOpenClawAgentHookOnce({
  config,
  fetcher,
  post,
}: {
  config: OpenClawHookConfig;
  fetcher: typeof fetch;
  post: OpenClawHookPost;
}): Promise<OpenClawHookPostResult> {
  const response = await fetcher(config.hookUrl, {
    method: "POST",
    signal: AbortSignal.timeout((config.timeoutSeconds + 15) * 1000),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "idempotency-key": post.idempotencyKey,
    },
    body: JSON.stringify({
      name: post.name,
      agentId: config.agentId,
      deliver: post.deliver,
      channel: config.channel,
      to: config.discordTarget,
      idempotencyKey: post.idempotencyKey,
      thinking: config.thinking,
      timeoutSeconds: config.timeoutSeconds,
      message: post.message,
      waitForCompletion: true,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new OpenClawHookHttpError(
      response.status,
      boundedText(body, MAX_DIAGNOSTIC_CHARS, [config.token]) ?? "",
    );
  }
  const parsed = parseHookBody(body);
  const runId = boundedText(parsed.runId, 128) ?? boundedText(parsed.run_id, 128);
  return {
    runId,
    delivery:
      parsed.ok === true && runId && !Object.hasOwn(parsed, "completion")
        ? hookDelivery("admitted")
        : classifyHookDelivery(parsed.completion, post.deliver, config.token),
  };
}

export class OpenClawHookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenClaw hook returned ${status}: ${body.slice(0, 500)}`);
  }
}

export function isTransientOpenClawHookError(error: unknown): boolean {
  if (error instanceof OpenClawHookHttpError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed)\b/i.test(
    error.message,
  );
}

export function isConclusiveHookDelivery(delivery: OpenClawHookDelivery): boolean {
  return ["delivered", "admitted", "suppressed", "not-requested"].includes(delivery.status);
}

export function hookDeliveryReport(delivery: OpenClawHookDelivery): {
  status: OpenClawHookDeliveryStatus;
  suppression_reason: string | null;
  error: string | null;
} {
  return {
    status: delivery.status,
    suppression_reason: delivery.suppressionReason,
    error: delivery.error,
  };
}

export function describeHookDelivery(delivery: OpenClawHookDelivery): string {
  if (delivery.status === "admitted") {
    return "OpenClaw delivery observability unavailable after legacy admission";
  }
  if (delivery.status === "suppressed" && delivery.suppressionReason) {
    return `OpenClaw delivery suppressed: ${delivery.suppressionReason}`;
  }
  if (delivery.status === "failed" && delivery.error) {
    return `OpenClaw delivery failed: ${delivery.error}`;
  }
  return `OpenClaw delivery ${delivery.status}`;
}

export function hookDeliveryFromError(error: unknown): OpenClawHookDelivery {
  return hookDelivery(
    error instanceof OpenClawHookHttpError ? "failed" : "unknown",
    null,
    errorText(error),
  );
}

export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function errorText(error: unknown): string {
  return (
    boundedText(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_CHARS) ?? ""
  );
}

function classifyHookDelivery(
  value: unknown,
  deliveryRequested: boolean,
  token: string,
): OpenClawHookDelivery {
  if (!isJsonObject(value)) {
    return hookDelivery("unknown");
  }
  const status = value.status;
  if (status !== "ok" && status !== "error" && status !== "skipped") {
    return hookDelivery("unknown");
  }

  const error = boundedText(value.deliveryError, MAX_DIAGNOSTIC_CHARS, [token]);
  const suppressionReason = boundedText(
    value.deliverySuppressionReason,
    MAX_SUPPRESSION_REASON_CHARS,
  );
  const replyDisposition =
    value.replyDisposition === "visible" ||
    value.replyDisposition === "silent" ||
    value.replyDisposition === "empty"
      ? value.replyDisposition
      : null;
  if (value.delivered === true) {
    return hookDelivery("delivered");
  }
  if (replyDisposition === "silent") {
    return hookDelivery("suppressed", suppressionReason ?? "silent");
  }
  if (status === "error" || error) {
    return hookDelivery("failed", null, error);
  }
  if (replyDisposition === "visible") {
    return hookDelivery(value.deliveryAttempted === true ? "failed" : "unknown");
  }
  if (suppressionReason) {
    return hookDelivery("suppressed", suppressionReason);
  }
  if (
    status === "ok" &&
    !deliveryRequested &&
    replyDisposition === "empty" &&
    value.delivered !== true &&
    value.deliveryAttempted !== true
  ) {
    return hookDelivery("not-requested");
  }
  if (value.delivered === false && value.deliveryAttempted === true) {
    return hookDelivery("failed");
  }
  return hookDelivery("unknown");
}

function parseHookBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hookDelivery(
  status: OpenClawHookDeliveryStatus,
  suppressionReason: string | null = null,
  error: string | null = null,
): OpenClawHookDelivery {
  return { status, suppressionReason, error };
}

function boundedText(
  value: unknown,
  limit: number,
  redactions: readonly string[] = [],
): string | null {
  if (typeof value !== "string") return null;
  let text = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const redaction of redactions) {
    if (redaction) text = text.replaceAll(redaction, "<redacted>");
  }
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
