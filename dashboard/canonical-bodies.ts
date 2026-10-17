import { EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES } from "../src/exact-review-publication-limits.ts";

import { CANONICAL_BODY_PREFIX } from "../src/canonical-body-tiering-policy.ts";
export { CANONICAL_BODY_PREFIX };
export type CanonicalBodyDescriptor = { digest: string; bytes: number };
type BodyBucket = {
  put(
    key: string,
    value: Uint8Array,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      sha256: ArrayBuffer;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
};

export class CanonicalBodyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("canonical body unavailable or corrupt", options);
    this.name = "CanonicalBodyUnavailableError";
  }
}

// This namespace has no delete API. Snapshot retention and generic blob routes
// must never acquire authority to remove current or previously published bodies.
export class CanonicalBodyStore {
  private readonly bucket: unknown;
  constructor(bucket: unknown) {
    this.bucket = bucket;
  }

  private requireBucket(): BodyBucket {
    const bucket = this.bucket as Partial<BodyBucket> | null;
    if (typeof bucket?.get !== "function" || typeof bucket.put !== "function")
      throw new CanonicalBodyUnavailableError();
    return bucket as BodyBucket;
  }

  async prepare(content: string, descriptor: CanonicalBodyDescriptor): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(content);
      assertDescriptor(descriptor);
      if (bytes.byteLength !== descriptor.bytes || (await digestHex(bytes)) !== descriptor.digest)
        throw new Error("source integrity mismatch");
      const checksum = Uint8Array.from(descriptor.digest.match(/../g)!, (pair) =>
        parseInt(pair, 16),
      );
      await this.requireBucket().put(CANONICAL_BODY_PREFIX + descriptor.digest, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: checksum.buffer,
      });
      // A failed conditional put returns null. Existing objects require the
      // same exact read verification as new objects before SQL may reference it.
      const stored = await this.read(descriptor);
      if (stored !== content) throw new Error("stored bytes differ");
    } catch (cause) {
      throw unavailable(cause);
    }
  }

  async read(descriptor: CanonicalBodyDescriptor): Promise<string> {
    try {
      assertDescriptor(descriptor);
      const object = await this.requireBucket().get(CANONICAL_BODY_PREFIX + descriptor.digest);
      if (!object) throw new Error("body missing");
      if (object.size !== descriptor.bytes) {
        await object.body.cancel().catch(() => {});
        throw new Error("body wrong size");
      }
      const reader = object.body.getReader();
      const bytes = new Uint8Array(descriptor.bytes);
      let offset = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > bytes.byteLength)
            throw new Error("body exceeds descriptor");
          bytes.set(value, offset);
          offset += value.byteLength;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (offset !== bytes.byteLength || (await digestHex(bytes)) !== descriptor.digest)
        throw new Error("body integrity mismatch");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw unavailable(cause);
    }
  }
}

function assertDescriptor(descriptor: CanonicalBodyDescriptor) {
  if (
    !/^[a-f0-9]{64}$/.test(descriptor.digest) ||
    !Number.isSafeInteger(descriptor.bytes) ||
    descriptor.bytes < 0 ||
    descriptor.bytes > EXACT_REVIEW_DIRECT_PUBLICATION_MAX_FILE_BYTES
  )
    throw new Error("invalid body descriptor");
}
function unavailable(cause: unknown) {
  return cause instanceof CanonicalBodyUnavailableError
    ? cause
    : new CanonicalBodyUnavailableError({ cause });
}
async function digestHex(bytes: Uint8Array) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
