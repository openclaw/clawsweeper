import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./value-coerce.js";

export interface ReviewModelRef {
  provider: string;
  model: string;
}
/** Native runtime facts only. Requested selection lives separately in the review record. */
export interface ReviewExecutionReceipt {
  provider?: string;
  model?: string;
  sessionId?: string;
  runtimeModelSelection?: ReviewModelRef;
  terminalReceipt?: {
    requested: ReviewModelRef;
    effective: ReviewModelRef & { responseModel?: string };
    rerouted: boolean;
  };
  requestShaping?: { thinking?: string; thinkingClamped?: boolean };
}
const atom = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value) &&
  !value.includes("://");
const ref = (value: unknown): ReviewModelRef | undefined =>
  isRecord(value) && atom(value.provider) && atom(value.model)
    ? { provider: value.provider, model: value.model }
    : undefined;

/** Project a successful host envelope before its private state is removed; never scan model text. */
export function projectOpenclawExecutionReceipt(
  input: unknown,
): ReviewExecutionReceipt | undefined {
  if (!isRecord(input)) return undefined;
  const result = isRecord(input.result) ? input.result : input;
  const meta = isRecord(result.meta) ? result.meta : {};
  const agent = isRecord(meta.agentMeta) ? meta.agentMeta : {};
  const runtimeModelSelection = ref(agent.runtimeModelSelection);
  const terminal = isRecord(agent.terminalReceipt) ? agent.terminalReceipt : {};
  const requested = ref(terminal.requested);
  const effective = ref(terminal.effective);
  const shaping = isRecord(meta.requestShaping) ? meta.requestShaping : {};
  const receipt: ReviewExecutionReceipt = {
    ...(atom(agent.provider) ? { provider: agent.provider } : {}),
    ...(atom(agent.model) ? { model: agent.model } : {}),
    ...(atom(agent.sessionId) ? { sessionId: agent.sessionId } : {}),
    ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
    ...(requested && effective && typeof terminal.rerouted === "boolean"
      ? {
          terminalReceipt: {
            requested,
            effective: {
              ...effective,
              ...(isRecord(terminal.effective) && atom(terminal.effective.responseModel)
                ? { responseModel: terminal.effective.responseModel }
                : {}),
            },
            rerouted: terminal.rerouted,
          },
        }
      : {}),
    ...(atom(shaping.thinking) || typeof shaping.thinkingClamp === "string"
      ? {
          requestShaping: {
            ...(atom(shaping.thinking) ? { thinking: shaping.thinking } : {}),
            ...(typeof shaping.thinkingClamp === "string"
              ? { thinkingClamped: Boolean(shaping.thinkingClamp) }
              : {}),
          },
        }
      : {}),
  };
  return Object.keys(receipt).length ? receipt : undefined;
}

/** Startup selection/configuration only, not terminal-model or provider-observed effort evidence.
 * Public contract: openai/codex rust-v0.162.1 exec human config summary. Other versions stay unreported.
 */
export function projectCodexExecExecutionReceipt(
  header: string,
): ReviewExecutionReceipt | undefined {
  if (Buffer.byteLength(header) > 64 * 1024) return undefined;
  const match =
    /^OpenAI Codex v0\.162\.1\r?\n--------\r?\n([\s\S]*?)\r?\n--------\r?\nuser\r?\n/.exec(header);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (fields.has(key)) return undefined;
    fields.set(key, line.slice(separator + 2));
  }
  return projectOpenclawExecutionReceipt({
    meta: {
      agentMeta: {
        provider: fields.get("provider"),
        model: fields.get("model"),
        sessionId: fields.get("session id"),
      },
      requestShaping: { thinking: fields.get("reasoning effort") },
    },
  });
}

export function parseReviewExecutionReceipt(input: unknown): ReviewExecutionReceipt {
  if (!isRecord(input)) throw new Error("Invalid execution receipt.");
  const shaping = isRecord(input.requestShaping) ? input.requestShaping : undefined;
  const projected = projectOpenclawExecutionReceipt({
    meta: {
      agentMeta: {
        provider: input.provider,
        model: input.model,
        sessionId: input.sessionId,
        runtimeModelSelection: input.runtimeModelSelection,
        terminalReceipt: input.terminalReceipt,
      },
      ...(shaping
        ? {
            requestShaping: {
              thinking: shaping.thinking,
              ...(typeof shaping.thinkingClamped === "boolean"
                ? { thinkingClamp: shaping.thinkingClamped ? "clamped" : "" }
                : {}),
            },
          }
        : {}),
    },
  });
  if (!projected || !isDeepStrictEqual(projected, input))
    throw new Error("Invalid execution receipt.");
  return projected;
}
