import type { LooseRecord } from "./json-types.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type ResolvedRunArtifact = {
  id: number;
  name: string;
  producerAttempt: number;
  digest: string;
};

export function resolveRunArtifact({
  artifacts,
  prefix,
  runId,
  currentAttempt,
  expectedArtifactId,
  expectedArtifactDigest,
  fallbackPrefixes = [],
  allowPriorAttempts = process.env.CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT === "1",
}: {
  artifacts: LooseRecord[];
  prefix: string;
  runId: string;
  currentAttempt: number;
  expectedArtifactId?: string | null;
  expectedArtifactDigest?: string | null;
  fallbackPrefixes?: string[];
  allowPriorAttempts?: boolean;
}): ResolvedRunArtifact {
  const prefixes = [prefix, ...fallbackPrefixes];
  if (
    prefixes.some((candidate) => !candidate || !/^[A-Za-z0-9_.-]+$/.test(candidate)) ||
    new Set(prefixes).size !== prefixes.length
  ) {
    throw new Error("artifact prefixes are invalid");
  }
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("workflow run id is invalid");
  }
  if (!Number.isInteger(currentAttempt) || currentAttempt < 1) {
    throw new Error("current workflow attempt is invalid");
  }

  const expectedId = parseOptionalArtifactId(expectedArtifactId);
  const expectedDigest = normalizeOptionalDigest(expectedArtifactDigest);
  if ((expectedId === null) !== (expectedDigest === null)) {
    throw new Error("trusted producer artifact id and digest must be provided together");
  }
  const namePatterns = prefixes.map(
    (candidate) => new RegExp(`^${escapeRegExp(candidate)}-${runId}-([1-9][0-9]*)$`),
  );
  const candidates = artifacts.flatMap((artifact) => {
    const name = String(artifact.name ?? "");
    const prefixPriority = namePatterns.findIndex((pattern) => pattern.test(name));
    if (prefixPriority < 0) return [];
    const match = name.match(namePatterns[prefixPriority]!);
    if (!match) return [];
    const producerAttempt = Number(match[1]);
    const id = Number(artifact.id);
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      !Number.isInteger(producerAttempt) ||
      producerAttempt > currentAttempt
    ) {
      return [];
    }
    const digest = normalizeOptionalDigest(artifact.digest);
    return [
      {
        id,
        name: String(artifact.name),
        producerAttempt,
        prefixPriority,
        digest,
        expired: artifact.expired === true,
      },
    ];
  });

  if (expectedId !== null) {
    const exact = candidates.filter((artifact) => artifact.id === expectedId);
    if (exact.length !== 1) {
      throw new Error("expected producer artifact id is missing or ambiguous");
    }
    return finalizeArtifact(exact[0]!, expectedDigest);
  }

  const eligible = candidates.filter(
    (artifact) =>
      !artifact.expired &&
      (artifact.producerAttempt === currentAttempt ||
        (allowPriorAttempts && artifact.producerAttempt < currentAttempt)),
  );
  if (eligible.length === 0) {
    throw new Error(
      allowPriorAttempts
        ? "no trusted current or prior producer artifact matches this workflow run"
        : "current producer attempt did not publish a trusted artifact",
    );
  }
  const producerAttempt = Math.max(...eligible.map((artifact) => artifact.producerAttempt));
  const latest = eligible.filter((artifact) => artifact.producerAttempt === producerAttempt);
  const prefixPriority = Math.min(...latest.map((artifact) => artifact.prefixPriority));
  const preferred = latest.filter((artifact) => artifact.prefixPriority === prefixPriority);
  if (preferred.length !== 1) {
    throw new Error("trusted producer artifact selection is ambiguous");
  }
  return finalizeArtifact(preferred[0]!, expectedDigest);
}

function finalizeArtifact(
  artifact: {
    id: number;
    name: string;
    producerAttempt: number;
    digest: string | null;
    expired: boolean;
  },
  expectedDigest: string | null,
): ResolvedRunArtifact {
  if (artifact.expired) throw new Error("expected producer artifact has expired");
  if (!artifact.digest) throw new Error("producer artifact is missing a trusted digest");
  if (expectedDigest && artifact.digest !== expectedDigest) {
    throw new Error("producer artifact digest does not match the trusted job output");
  }
  return {
    id: artifact.id,
    name: artifact.name,
    producerAttempt: artifact.producerAttempt,
    digest: artifact.digest,
  };
}

function parseOptionalArtifactId(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error("expected artifact id is invalid");
  return Number(text);
}

function normalizeOptionalDigest(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!normalized) return null;
  if (!DIGEST_PATTERN.test(normalized)) throw new Error("artifact digest is invalid");
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
