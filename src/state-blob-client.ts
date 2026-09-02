import { createHash, createHmac } from "node:crypto";

const SINGLE_PUT_MAX_BYTES = 24 * 1024 * 1024;

type StateBlobClientOptions = {
  baseUrl: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
};

export async function publishStateBlob(
  options: StateBlobClientOptions & { path: string; content: Buffer },
): Promise<{ path: string; bytes: number; digest: string; unchanged: boolean }> {
  const digest = createHash("sha256").update(options.content).digest("hex");
  if (options.content.byteLength <= SINGLE_PUT_MAX_BYTES) {
    const result = await signedBlobPost<{ unchanged?: boolean }>(options, "put", {
      path: options.path,
      digest,
      contentBase64: options.content.toString("base64"),
    });
    return {
      path: options.path,
      bytes: options.content.byteLength,
      digest,
      unchanged: result.unchanged === true,
    };
  }

  const started = await signedBlobPost<{
    unchanged?: boolean;
    uploadId?: string | null;
    partBytes?: number;
  }>(options, "multipart/start", {
    path: options.path,
    digest,
    bytes: options.content.byteLength,
  });
  if (started.unchanged === true || !started.uploadId) {
    return { path: options.path, bytes: options.content.byteLength, digest, unchanged: true };
  }
  const partBytes = Number(started.partBytes);
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) {
    throw new Error("Worker returned an invalid state blob multipart size");
  }
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let offset = 0; offset < options.content.byteLength; offset += partBytes) {
      const content = options.content.subarray(
        offset,
        Math.min(offset + partBytes, options.content.byteLength),
      );
      const uploaded = await signedBlobPost<{
        part: { partNumber: number; etag: string };
      }>(options, "multipart/part", {
        path: options.path,
        uploadId: started.uploadId,
        partNumber: parts.length + 1,
        contentBase64: Buffer.from(content).toString("base64"),
      });
      parts.push(uploaded.part);
    }
    await signedBlobPost(options, "multipart/complete", {
      path: options.path,
      uploadId: started.uploadId,
      digest,
      bytes: options.content.byteLength,
      parts,
    });
  } catch (error) {
    await signedBlobPost(options, "multipart/abort", {
      path: options.path,
      uploadId: started.uploadId,
    }).catch(() => undefined);
    throw error;
  }
  return { path: options.path, bytes: options.content.byteLength, digest, unchanged: false };
}

async function signedBlobPost<T>(
  options: StateBlobClientOptions,
  operation: string,
  payload: unknown,
): Promise<T> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("state blob Worker URL is required");
  if (!options.webhookSecret) throw new Error("state blob Worker secret is required");
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", options.webhookSecret)
    .update(body)
    .digest("hex")}`;
  let lastError = "request failed";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await (options.fetchImpl ?? fetch)(
        `${baseUrl}/internal/state/blobs/${operation}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const value = (await response.json().catch(() => null)) as unknown;
      if (response.ok && value && typeof value === "object") return value as T;
      const code =
        value && typeof value === "object" && "error" in value
          ? String((value as { error: unknown }).error)
          : "invalid_response";
      lastError = `state blob ${operation} returned ${response.status}: ${code}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(redact(lastError, options.webhookSecret));
}

function redact(value: string, secret: string): string {
  return secret ? value.split(secret).join("<redacted>") : value;
}
