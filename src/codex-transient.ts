const CODEX_MODEL_ACCESS_PREFIX = "the model ";
const CODEX_MODEL_ACCESS_SUFFIX = " does not exist or you do not have access to it";

export function isRetryableCodexTransportError(value: string | null | undefined): boolean {
  const message = value ?? "";
  return /write_stdin failed: stdin is closed|stdin is closed for this session|rate limit reached|tokens per min|\bTPM\b|requests per min|\b429\b|temporarily unavailable|overloaded|stream disconnected|reconnecting|please try again in \d+(?:\.\d+)?(?:ms|s)/i.test(
    message,
  );
}

export function isRetryableCodexErrorMessage(value: string | null | undefined): boolean {
  return !isTerminalCodexErrorMessage(value) && isRetryableCodexTransportError(value);
}

export function isTerminalCodexErrorMessage(value: string | null | undefined): boolean {
  return Boolean(codexTerminalErrorDetail(value));
}

export function codexTerminalErrorDetail(value: string | null | undefined): string {
  const finalLine =
    (value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const normalized = finalLine.toLowerCase();
  const prefixIndex = normalized.indexOf(CODEX_MODEL_ACCESS_PREFIX);
  if (prefixIndex === -1) return "";
  const modelStart = prefixIndex + CODEX_MODEL_ACCESS_PREFIX.length;
  return normalized.indexOf(CODEX_MODEL_ACCESS_SUFFIX, modelStart) > modelStart ? finalLine : "";
}

export function codexJsonlFailureDetail(value: string | null | undefined): string {
  const messages: string[] = [];
  for (const line of (value ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "error" && typeof event.message === "string") {
      messages.push(event.message);
    }
    if (event?.type === "turn.failed" && typeof event.error?.message === "string") {
      messages.push(event.error.message);
    }
  }
  return messages.at(-1) ?? "";
}

export function isCodexContextLimitError(value: string | null | undefined): boolean {
  const message = value ?? "";
  return /Requested \d+\. Please try again with a smaller input|context (?:length|window)|maximum context|too many tokens|token limit|input is too large/i.test(
    message,
  );
}

export function codexRetryDelayMs(message: string, attempt: number): number {
  const match = String(message ?? "").match(/try again in\s+(\d+(?:\.\d+)?)(ms|s)\b/i);
  const parsed = match ? Number(match[1]) * (match[2]?.toLowerCase() === "s" ? 1000 : 1) : 0;
  const configured = [
    process.env.CLAWSWEEPER_CODEX_RETRY_DELAY_MS,
    process.env.CLAWSWEEPER_CODEX_REVIEW_RETRY_DELAY_MS,
  ]
    .map((value) => Number(value?.trim()))
    .find((value) => Number.isFinite(value) && value > 0);
  const fallback = configured ?? 15_000;
  return Math.min(
    120_000,
    Math.max(Number.isFinite(parsed) ? Math.ceil(parsed) : 0, fallback * attempt),
  );
}
