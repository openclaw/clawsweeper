import { createHash } from "node:crypto";

export function errorFingerprintDigest(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return createHash("sha256").update(message).digest("hex");
}

export function failureFingerprint(error: unknown): string {
  return errorFingerprintDigest(error);
}

export function errorFingerprint(error: unknown): string {
  return `sha256:${errorFingerprintDigest(error)}`;
}
