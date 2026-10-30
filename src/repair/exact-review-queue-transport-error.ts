import { isJsonObject } from "./json-types.js";

export type TransportFailureReason = "network_error" | "timeout" | `HTTP_${number}`;

export type QueueFailureCategory =
  | "platform_overloaded"
  | "platform_retryable"
  | "remote_exception"
  | "request_exception"
  | "malformed_server_response";

export type QueueFailureDetails = {
  status?: number;
  code?: string;
  category?: QueueFailureCategory;
  traceId?: string;
};

export class ExactReviewBatchQueueRequestError extends Error {
  constructor(
    readonly reason: TransportFailureReason | "invalid_response",
    message: string,
    readonly details: QueueFailureDetails = {},
  ) {
    super(message);
  }
}

// Keep retryable transport failures distinct from rejected or malformed replies.
export class ExactReviewBatchQueueTransportError extends ExactReviewBatchQueueRequestError {
  declare readonly reason: TransportFailureReason;
  constructor(reason: TransportFailureReason, message: string, details: QueueFailureDetails = {}) {
    super(reason, message, details);
  }
}

const ERROR_DIAGNOSTIC_BYTES = 512;

function queueResponseFailureDetails(bytes: Uint8Array): QueueFailureDetails {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, ERROR_DIAGNOSTIC_BYTES)),
    );
    const error = isJsonObject(parsed) ? parsed.error : undefined;
    const category = isJsonObject(parsed) ? parsed.failure_category : undefined;
    return {
      ...(typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error) ? { code: error } : {}),
      ...(category === "platform_overloaded" ||
      category === "platform_retryable" ||
      category === "remote_exception" ||
      category === "request_exception" ||
      category === "malformed_server_response"
        ? { category }
        : {}),
    };
  } catch {
    return {};
  }
}

export function queueResponseErrorCode(bytes: Uint8Array): string | undefined {
  return queueResponseFailureDetails(bytes).code;
}

export function responseFailureMetadata(response: Response): QueueFailureDetails {
  const trace = response.headers.get("x-clawsweeper-exact-review-trace");
  return {
    status: response.status,
    ...(trace && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trace)
      ? { traceId: trace }
      : {}),
  };
}

export async function responseFailureDetails(response: Response): Promise<QueueFailureDetails> {
  const details = responseFailureMetadata(response);
  const reader = response.body?.getReader();
  if (!reader) return details;
  try {
    const bytes = new Uint8Array(ERROR_DIAGNOSTIC_BYTES);
    let length = 0;
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, bytes.length - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    return { ...details, ...queueResponseFailureDetails(bytes.subarray(0, length)) };
  } catch {
    return details;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  return (await responseFailureDetails(response)).code;
}
