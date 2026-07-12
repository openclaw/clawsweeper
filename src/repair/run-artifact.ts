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
  expectedProducerAttempt,
  maxProducerAttempt,
  expectedArtifactId,
  expectedArtifactDigest,
  fallbackPrefixes = [],
  requiredPrefixes = [],
  allowPriorAttempts = process.env.CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT === "1",
}: {
  artifacts: LooseRecord[];
  prefix: string;
  runId: string;
  currentAttempt: number;
  expectedProducerAttempt?: string | number | null;
  maxProducerAttempt?: string | number | null;
  expectedArtifactId?: string | null;
  expectedArtifactDigest?: string | null;
  fallbackPrefixes?: string[];
  requiredPrefixes?: string[];
  allowPriorAttempts?: boolean;
}): ResolvedRunArtifact {
  const prefixes = [prefix, ...fallbackPrefixes];
  if (
    prefixes.some((candidate) => !candidate || !/^[A-Za-z0-9_.-]+$/.test(candidate)) ||
    requiredPrefixes.some((candidate) => !candidate || !/^[A-Za-z0-9_.-]+$/.test(candidate)) ||
    new Set(prefixes).size !== prefixes.length ||
    new Set(requiredPrefixes).size !== requiredPrefixes.length
  ) {
    throw new Error("artifact prefixes are invalid");
  }
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("workflow run id is invalid");
  }
  if (!Number.isInteger(currentAttempt) || currentAttempt < 1) {
    throw new Error("current workflow attempt is invalid");
  }
  const pinnedProducerAttempt = parseOptionalProducerAttempt(expectedProducerAttempt);
  const maximumProducerAttempt = parseOptionalProducerAttempt(maxProducerAttempt);
  if (pinnedProducerAttempt !== null && pinnedProducerAttempt >= currentAttempt) {
    throw new Error("expected producer attempt must precede the current workflow attempt");
  }
  if (maximumProducerAttempt !== null && maximumProducerAttempt >= currentAttempt) {
    throw new Error("maximum producer attempt must precede the current workflow attempt");
  }
  if (pinnedProducerAttempt !== null && maximumProducerAttempt !== null) {
    throw new Error("expected and maximum producer attempts cannot both be provided");
  }
  if (requiredPrefixes.length > 0 && pinnedProducerAttempt !== null) {
    throw new Error("required artifact prefixes cannot be combined with an exact producer attempt");
  }

  const expectedId = parseOptionalArtifactId(expectedArtifactId);
  const expectedDigest = normalizeOptionalDigest(expectedArtifactDigest);
  if ((expectedId === null) !== (expectedDigest === null)) {
    throw new Error("trusted producer artifact id and digest must be provided together");
  }
  const candidates = artifacts.flatMap((artifact) => {
    const name = String(artifact.name ?? "");
    const parsedNames = prefixes.map((candidate) => parseArtifactName(name, candidate, runId));
    const prefixPriority = parsedNames.findIndex((producerAttempt) => producerAttempt !== null);
    if (prefixPriority < 0) return [];
    const producerAttempt = parsedNames[prefixPriority]!;
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
    const exact = candidates.filter(
      (artifact) =>
        artifact.id === expectedId &&
        (pinnedProducerAttempt === null || artifact.producerAttempt === pinnedProducerAttempt),
    );
    if (exact.length !== 1) {
      throw new Error("expected producer artifact id is missing or ambiguous");
    }
    return finalizeArtifact(exact[0]!, expectedDigest);
  }

  const cohortProducerAttempt =
    requiredPrefixes.length > 0
      ? resolveArtifactCohortAttempt({
          artifacts,
          primaryCandidates: candidates,
          requiredPrefixes,
          runId,
          currentAttempt,
          maximumProducerAttempt,
          allowPriorAttempts,
        })
      : null;
  const effectiveProducerAttempt = pinnedProducerAttempt ?? cohortProducerAttempt;
  const eligible = candidates.filter(
    (artifact) =>
      !artifact.expired &&
      (effectiveProducerAttempt === null ||
        artifact.producerAttempt === effectiveProducerAttempt) &&
      (maximumProducerAttempt === null || artifact.producerAttempt <= maximumProducerAttempt) &&
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

function resolveArtifactCohortAttempt({
  artifacts,
  primaryCandidates,
  requiredPrefixes,
  runId,
  currentAttempt,
  maximumProducerAttempt,
  allowPriorAttempts,
}: {
  artifacts: LooseRecord[];
  primaryCandidates: Array<{
    producerAttempt: number;
    expired: boolean;
    digest: string | null;
  }>;
  requiredPrefixes: string[];
  runId: string;
  currentAttempt: number;
  maximumProducerAttempt: number | null;
  allowPriorAttempts: boolean;
}): number {
  const attempts = [
    ...new Set(
      primaryCandidates
        .filter(
          (artifact) =>
            !artifact.expired &&
            artifact.digest &&
            (maximumProducerAttempt === null ||
              artifact.producerAttempt <= maximumProducerAttempt) &&
            (artifact.producerAttempt === currentAttempt ||
              (allowPriorAttempts && artifact.producerAttempt < currentAttempt)),
        )
        .map((artifact) => artifact.producerAttempt),
    ),
  ].sort((left, right) => right - left);
  for (const producerAttempt of attempts) {
    let complete = true;
    for (const requiredPrefix of requiredPrefixes) {
      const matches = artifacts.filter(
        (artifact) =>
          parseArtifactName(String(artifact.name ?? ""), requiredPrefix, runId) === producerAttempt,
      );
      if (matches.length > 1) {
        throw new Error("trusted producer artifact cohort is ambiguous");
      }
      if (
        matches.length !== 1 ||
        matches[0]!.expired === true ||
        !normalizeOptionalDigest(matches[0]!.digest)
      ) {
        complete = false;
        break;
      }
    }
    if (complete) return producerAttempt;
  }
  throw new Error("no complete trusted producer artifact cohort matches this workflow run");
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

function parseOptionalProducerAttempt(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error("expected producer attempt is invalid");
  const attempt = Number(text);
  if (!Number.isSafeInteger(attempt)) throw new Error("expected producer attempt is invalid");
  return attempt;
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

function parseArtifactName(name: string, prefix: string, runId: string): number | null {
  const literalPrefix = `${prefix}-${runId}-`;
  if (!name.startsWith(literalPrefix)) return null;
  const attempt = name.slice(literalPrefix.length);
  if (!/^[1-9][0-9]*$/.test(attempt)) return null;
  const parsed = Number(attempt);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
