import { isJsonObject } from "./json-types.js";

export type TransportFailureReason = "network_error" | "timeout" | `HTTP_${number}`;

export class ExactReviewBatchQueueTransportError extends Error {
  constructor(
    readonly reason: TransportFailureReason,
    message: string,
  ) {
    super(message);
  }
}

const ERROR_DIAGNOSTIC_BYTES = 512;

export function queueResponseErrorCode(bytes: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, ERROR_DIAGNOSTIC_BYTES)),
    );
    const error = isJsonObject(parsed) ? parsed.error : undefined;
    return typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error) ? error : undefined;
  } catch {
    return undefined;
  }
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
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
    return queueResponseErrorCode(bytes.subarray(0, length));
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
