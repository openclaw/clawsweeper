import { sha256 } from "../content-hash.js";

export function errorFingerprintDigest(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return sha256(message);
}

export function failureFingerprint(error: unknown): string {
  return errorFingerprintDigest(error);
}

export function errorFingerprint(error: unknown): string {
  return `sha256:${errorFingerprintDigest(error)}`;
}
