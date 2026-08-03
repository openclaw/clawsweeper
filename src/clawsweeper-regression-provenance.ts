import type {
  RegressionAssessment,
  RegressionProvenanceCandidate,
  RegressionSupportingEvidence,
  VerifiedRegressionProvenance,
} from "./clawsweeper-types.js";

const fullShaPattern = /^[0-9a-f]{40}$/i;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const safeBranchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_SOURCE_PATH_LENGTH = 4_096;
const MAX_SOURCE_LINE = 1_000_000;
const regressionSupportingEvidence = new Set<RegressionSupportingEvidence>([
  "reproduction",
  "reviewed_change",
  "failure_trace",
  "known_regression_link",
]);

export interface RegressionProvenanceVerifierDependencies {
  fetchPull: (repo: string, number: number) => unknown;
  runGit: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => string;
}

export interface VerifyRegressionProvenanceOptions {
  candidate: RegressionProvenanceCandidate | VerifiedRegressionProvenance | null | undefined;
  item: { repo: string; number: number };
  checkoutDir: string;
  targetBranch: string | undefined;
  reviewedCommitShas: readonly (string | undefined)[];
}

type VerifiedPullMetadata = {
  mergedAt: string;
};

/**
 * Independently verifies the only public predecessor-provenance form we
 * support: a reviewed source line blames exactly to a PR's merge commit.
 *
 * This module never accepts a command from model output. It executes only the
 * fixed read-only Git commands below, after rejecting malformed candidates.
 */
export function createRegressionProvenanceVerifier({
  fetchPull,
  runGit,
}: RegressionProvenanceVerifierDependencies) {
  function verify(options: VerifyRegressionProvenanceOptions): VerifiedRegressionProvenance | null {
    const candidate = normalizeCandidate(options.candidate, options.item);
    const reviewedCommitShas = options.reviewedCommitShas
      .map((sha) => fullSha(sha ?? ""))
      .filter((sha): sha is string => sha !== null);
    if (!candidate || !isSafeTargetBranch(options.targetBranch) || !reviewedCommitShas.length) {
      return null;
    }

    try {
      const pull = verifiedPullMetadata(
        fetchPull(candidate.repo, candidate.pullRequestNumber),
        candidate,
        options.targetBranch,
      );
      if (!pull) return null;

      // A missing partial-clone blob must fail closed. Do not let blame fetch
      // history or content as an incidental side effect of review rendering.
      const env = { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" };
      const checkoutHeadSha = fullSha(
        runGit(["rev-parse", "--verify", "HEAD"], { cwd: options.checkoutDir, env }),
      );
      if (!checkoutHeadSha || !reviewedCommitShas.includes(checkoutHeadSha)) return null;

      runGit(["ls-files", "--error-unmatch", "--", candidate.sourcePath], {
        cwd: options.checkoutDir,
        env,
      });
      const blame = runGit(
        [
          "blame",
          "--line-porcelain",
          "-L",
          `${candidate.sourceLine},${candidate.sourceLine}`,
          checkoutHeadSha,
          "--",
          candidate.sourcePath,
        ],
        { cwd: options.checkoutDir, env },
      );
      if (hasBlameBoundary(blame) || blamedSha(blame) !== candidate.mergeCommitSha) return null;

      return {
        ...candidate,
        evidenceType: "blame_to_merge_commit",
        mergedAt: pull.mergedAt,
        reviewedCommitSha: checkoutHeadSha,
      };
    } catch {
      // Metadata, checkout history, and tracked-path failures are unknown, not
      // evidence. Rendering must omit the candidate rather than guess.
      return null;
    }
  }

  return { verify };
}

export function isVerifiedRegressionProvenance(
  value: unknown,
): value is VerifiedRegressionProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<VerifiedRegressionProvenance>;
  return (
    normalizedCandidateFields(candidate) !== null &&
    candidate.evidenceType === "blame_to_merge_commit" &&
    typeof candidate.mergedAt === "string" &&
    isIsoTimestamp(candidate.mergedAt) &&
    typeof candidate.reviewedCommitSha === "string" &&
    fullSha(candidate.reviewedCommitSha) !== null
  );
}

export function regressionProvenancePublicLine(value: unknown): string | null {
  if (!isVerifiedRegressionProvenance(value)) return null;
  return `Verified regression provenance: [#${value.pullRequestNumber}](${value.pullRequestUrl}) introduced the reviewed source line (blame-to-merge-commit; \`${value.mergeCommitSha.slice(0, 12)}\`).`;
}

export function isRegressionAssessment(value: unknown): value is RegressionAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const assessment = value as Partial<RegressionAssessment>;
  const evidence = assessment.supportingEvidence;
  return (
    (assessment.confidence === "suspected" || assessment.confidence === "probable") &&
    Array.isArray(evidence) &&
    evidence.length >= 1 &&
    evidence.length <= 3 &&
    evidence.every((entry) => regressionSupportingEvidence.has(entry)) &&
    new Set(evidence).size === evidence.length &&
    (assessment.confidence !== "probable" || evidence.length >= 2)
  );
}

export function regressionAssessmentPublicLine(value: unknown): string | null {
  if (!isRegressionAssessment(value)) return null;
  const evidence = value.supportingEvidence.map(regressionEvidenceLabel).join("; ");
  return `Possible regression — ${value.confidence} (${evidence}). No predecessor PR is attributed.`;
}

function normalizeCandidate(
  value: RegressionProvenanceCandidate | VerifiedRegressionProvenance | null | undefined,
  item: { repo: string; number: number },
): RegressionProvenanceCandidate | null {
  const candidate = normalizedCandidateFields(value);
  if (!candidate || candidate.repo !== item.repo || candidate.pullRequestNumber === item.number) {
    return null;
  }
  return candidate;
}

function normalizedCandidateFields(value: unknown): RegressionProvenanceCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RegressionProvenanceCandidate>;
  const pullRequestNumber = candidate.pullRequestNumber;
  const sourceLine = candidate.sourceLine;
  if (
    typeof candidate.repo !== "string" ||
    !repositoryPattern.test(candidate.repo) ||
    typeof pullRequestNumber !== "number" ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    typeof candidate.pullRequestUrl !== "string" ||
    candidate.pullRequestUrl !==
      `https://github.com/${candidate.repo}/pull/${candidate.pullRequestNumber}` ||
    typeof candidate.mergeCommitSha !== "string" ||
    typeof candidate.sourcePath !== "string" ||
    !isSafeSourcePath(candidate.sourcePath) ||
    typeof sourceLine !== "number" ||
    !Number.isSafeInteger(sourceLine) ||
    sourceLine <= 0 ||
    sourceLine > MAX_SOURCE_LINE
  ) {
    return null;
  }
  const mergeCommitSha = fullSha(candidate.mergeCommitSha);
  return mergeCommitSha
    ? {
        repo: candidate.repo,
        pullRequestNumber,
        pullRequestUrl: candidate.pullRequestUrl,
        mergeCommitSha,
        sourcePath: candidate.sourcePath,
        sourceLine,
      }
    : null;
}

function verifiedPullMetadata(
  value: unknown,
  candidate: RegressionProvenanceCandidate,
  targetBranch: string,
): VerifiedPullMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pull = value as Record<string, unknown>;
  if (
    pull.number !== candidate.pullRequestNumber ||
    pull.html_url !== candidate.pullRequestUrl ||
    pull.merged !== true ||
    typeof pull.merged_at !== "string" ||
    !isIsoTimestamp(pull.merged_at) ||
    fullSha(typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : "") !==
      candidate.mergeCommitSha ||
    !pull.base ||
    typeof pull.base !== "object" ||
    Array.isArray(pull.base) ||
    (pull.base as Record<string, unknown>).ref !== targetBranch
  ) {
    return null;
  }
  return { mergedAt: pull.merged_at };
}

function isSafeSourcePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_SOURCE_PATH_LENGTH &&
    !path.startsWith("/") &&
    !path.startsWith("-") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !hasControlCharacter(path) &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function isSafeTargetBranch(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    safeBranchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("@{")
  );
}

function fullSha(value: string): string | null {
  const sha = value.trim();
  return fullShaPattern.test(sha) ? sha.toLowerCase() : null;
}

function blamedSha(value: string): string | null {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
  const sha = firstLine.split(/\s+/, 1)[0] ?? "";
  return fullSha(sha);
}

function hasBlameBoundary(value: string): boolean {
  return /(?:^|\r?\n)boundary(?:\r?\n|$)/.test(value);
}

function regressionEvidenceLabel(value: RegressionSupportingEvidence): string {
  switch (value) {
    case "reproduction":
      return "reproduction";
    case "reviewed_change":
      return "reviewed change";
    case "failure_trace":
      return "failure trace";
    case "known_regression_link":
      return "known regression link";
  }
}

function isIsoTimestamp(value: string): boolean {
  return isoTimestampPattern.test(value) && Number.isFinite(Date.parse(value));
}
