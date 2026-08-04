import type {
  RegressionAssessment,
  RegressionProvenanceCandidate,
  RegressionSupportingEvidence,
  SuspectedRegressionProvenance,
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
  fetchPullDiff: (repo: string, number: number) => string;
  runGit: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => string;
}

export interface VerifyRegressionProvenanceOptions {
  candidate:
    | RegressionProvenanceCandidate
    | VerifiedRegressionProvenance
    | SuspectedRegressionProvenance
    | null
    | undefined;
  item: { repo: string; number: number };
  checkoutDir: string;
  targetBranch: string | undefined;
  reviewedCommitShas: readonly (string | undefined)[];
}

type VerifiedPullMetadata = {
  mergedAt: string;
  headSha: string;
};

/**
 * Independently verifies the only public predecessor-provenance form we
 * support: a reviewed source line either blames exactly to a PR's merge
 * commit, or retains a cautiously labeled non-causal relationship after the
 * conservative rewrite-equivalence checks below.
 *
 * This module never accepts a command from model output. It executes only the
 * fixed read-only Git commands below, after rejecting malformed candidates.
 */
export function createRegressionProvenanceVerifier({
  fetchPull,
  fetchPullDiff,
  runGit,
}: RegressionProvenanceVerifierDependencies) {
  function verify(
    options: VerifyRegressionProvenanceOptions,
  ): VerifiedRegressionProvenance | SuspectedRegressionProvenance | null {
    const candidate = normalizeCandidate(options.candidate, options.item);
    const reviewedCommitShas = options.reviewedCommitShas
      .map((sha) => fullSha(sha ?? ""))
      .filter((sha): sha is string => sha !== null);
    const reviewedBaseCommitSha = fullSha(options.reviewedCommitShas[0] ?? "");
    if (
      !candidate ||
      !isSafeTargetBranch(options.targetBranch) ||
      !reviewedCommitShas.length ||
      !reviewedBaseCommitSha
    ) {
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
      const sourceCommitSha = blamedSha(blame);
      if (hasBlameBoundary(blame) || !sourceCommitSha) return null;

      const sourceAuthor = blamedAuthor(blame);
      if (!sourceAuthor || !isSafeSourceAuthor(sourceAuthor)) return null;

      if (sourceCommitSha !== candidate.mergeCommitSha) {
        runGit(["merge-base", "--is-ancestor", sourceCommitSha, reviewedBaseCommitSha], {
          cwd: options.checkoutDir,
          env,
        });
        let rewriteEquivalent = false;
        try {
          rewriteEquivalent = isConservativeRewriteEquivalent({
            candidate,
            pull,
            sourceCommitSha,
            sourceAuthor,
            pullDiff: fetchPullDiff(candidate.repo, candidate.pullRequestNumber),
            checkoutDir: options.checkoutDir,
            env,
            runGit,
          });
        } catch {
          // The local blame result remains useful even when the optional
          // canonical-PR diff cannot be fetched or compared. Fail closed only
          // for the related-PR association.
        }
        return {
          evidenceType: rewriteEquivalent ? "rewrite_equivalent" : "source_line",
          sourceCommitSha,
          sourceAuthor,
          sourcePath: candidate.sourcePath,
          sourceLine: candidate.sourceLine,
          relatedPullRequestNumber: rewriteEquivalent ? candidate.pullRequestNumber : null,
          relatedPullRequestUrl: rewriteEquivalent ? candidate.pullRequestUrl : null,
          relatedRepo: rewriteEquivalent ? candidate.repo : null,
        };
      }

      return {
        ...candidate,
        evidenceType: "blame_to_merge_commit",
        mergedAt: pull.mergedAt,
        reviewedCommitSha: checkoutHeadSha,
        sourceCommitSha: candidate.mergeCommitSha,
        sourceAuthor,
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
    fullSha(candidate.reviewedCommitSha) !== null &&
    ((candidate.sourceCommitSha === undefined && candidate.sourceAuthor === undefined) ||
      (typeof candidate.sourceCommitSha === "string" &&
        fullSha(candidate.sourceCommitSha) !== null &&
        fullSha(candidate.sourceCommitSha) === fullSha(candidate.mergeCommitSha ?? "") &&
        typeof candidate.sourceAuthor === "string" &&
        isSafeSourceAuthor(candidate.sourceAuthor)))
  );
}

export function regressionProvenancePublicLine(
  value: unknown,
  regressionAssessment?: unknown,
): string | null {
  if (isVerifiedRegressionProvenance(value)) {
    const sourceCommitSha = fullSha(value.sourceCommitSha ?? value.mergeCommitSha)!;
    const sourceAuthor = value.sourceAuthor
      ? markdownText(value.sourceAuthor)
      : "source author not recorded in this legacy report";
    return `Regression provenance — verified: source commit \`${sourceCommitSha.slice(0, 12)}\` by ${sourceAuthor}; canonical PR [#${value.pullRequestNumber}](${value.pullRequestUrl}) (blame-to-merge-commit).`;
  }
  if (!isSuspectedRegressionProvenance(value)) return null;
  if (!isRegressionAssessment(regressionAssessment)) return null;
  const related = value.relatedPullRequestUrl
    ? `safely related PR [#${value.relatedPullRequestNumber}](${value.relatedPullRequestUrl}) (rewrite-equivalent)`
    : "no PR verified";
  return `Regression provenance — suspected predecessor, not a causality claim: source commit \`${value.sourceCommitSha.slice(0, 12)}\` by ${markdownText(value.sourceAuthor)}; ${related}.`;
}

export function isSuspectedRegressionProvenance(
  value: unknown,
): value is SuspectedRegressionProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SuspectedRegressionProvenance>;
  const hasRelated =
    typeof candidate.relatedRepo === "string" &&
    repositoryPattern.test(candidate.relatedRepo) &&
    typeof candidate.relatedPullRequestNumber === "number" &&
    Number.isSafeInteger(candidate.relatedPullRequestNumber) &&
    candidate.relatedPullRequestNumber > 0 &&
    typeof candidate.relatedPullRequestUrl === "string" &&
    candidate.relatedPullRequestUrl ===
      `https://github.com/${candidate.relatedRepo}/pull/${candidate.relatedPullRequestNumber}`;
  return (
    (candidate.evidenceType === "source_line" || candidate.evidenceType === "rewrite_equivalent") &&
    fullSha(candidate.sourceCommitSha ?? "") !== null &&
    typeof candidate.sourceAuthor === "string" &&
    isSafeSourceAuthor(candidate.sourceAuthor) &&
    typeof candidate.sourcePath === "string" &&
    isSafeSourcePath(candidate.sourcePath) &&
    typeof candidate.sourceLine === "number" &&
    Number.isSafeInteger(candidate.sourceLine) &&
    candidate.sourceLine > 0 &&
    candidate.sourceLine <= MAX_SOURCE_LINE &&
    ((candidate.evidenceType === "source_line" &&
      candidate.relatedPullRequestNumber === null &&
      candidate.relatedPullRequestUrl === null &&
      candidate.relatedRepo === null) ||
      (candidate.evidenceType === "rewrite_equivalent" && hasRelated))
  );
}

export function isPublicRegressionProvenance(
  value: unknown,
): value is VerifiedRegressionProvenance | SuspectedRegressionProvenance {
  return isVerifiedRegressionProvenance(value) || isSuspectedRegressionProvenance(value);
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

export function regressionAssessmentPublicLine(
  value: unknown,
  options: { predecessorAttributed?: boolean } = {},
): string | null {
  if (!isRegressionAssessment(value)) return null;
  const evidence = value.supportingEvidence.map(regressionEvidenceLabel).join("; ");
  const attribution = options.predecessorAttributed ? "" : " No predecessor PR is attributed.";
  return `Possible regression — ${value.confidence} (${evidence}).${attribution}`;
}

function normalizeCandidate(
  value:
    | RegressionProvenanceCandidate
    | VerifiedRegressionProvenance
    | SuspectedRegressionProvenance
    | null
    | undefined,
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
  const head = pull.head;
  const rawHeadSha =
    head && typeof head === "object" && !Array.isArray(head)
      ? (head as Record<string, unknown>).sha
      : null;
  const headSha = typeof rawHeadSha === "string" ? fullSha(rawHeadSha) : null;
  if (!headSha) return null;
  return { mergedAt: pull.merged_at, headSha };
}

function isConservativeRewriteEquivalent(options: {
  candidate: RegressionProvenanceCandidate;
  pull: VerifiedPullMetadata;
  sourceCommitSha: string;
  sourceAuthor: string;
  pullDiff: string;
  checkoutDir: string;
  env: NodeJS.ProcessEnv;
  runGit: RegressionProvenanceVerifierDependencies["runGit"];
}): boolean {
  try {
    const sourceSubject = options.runGit(["show", "-s", "--format=%s", options.sourceCommitSha], {
      cwd: options.checkoutDir,
      env: options.env,
    });
    if (!new RegExp(`\\(#${options.candidate.pullRequestNumber}\\)\\s*$`).test(sourceSubject)) {
      return false;
    }
    const sourceParents = options
      .runGit(["show", "-s", "--format=%P", options.sourceCommitSha], {
        cwd: options.checkoutDir,
        env: options.env,
      })
      .trim()
      .split(/\s+/);
    if (sourceParents.length !== 1) return false;
    const diffArgs = (parent: string, sha: string) => [
      "diff",
      "--unified=3",
      "--no-renames",
      parent,
      sha,
      "--",
    ];
    const sourceDiff = options.runGit(diffArgs(sourceParents[0]!, options.sourceCommitSha), {
      cwd: options.checkoutDir,
      env: options.env,
    });
    const normalizedSourceDiff = normalizedTextPatch(sourceDiff);
    const normalizedHeadDiff = normalizedTextPatch(options.pullDiff);
    return normalizedSourceDiff !== null && normalizedSourceDiff === normalizedHeadDiff;
  } catch {
    return false;
  }
}

function normalizedTextPatch(value: string): string | null {
  if (!value.trim() || /(?:GIT binary patch|Binary files .* differ)/.test(value)) return null;
  return value
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*/, "$1"))
    .join("\n")
    .trim();
}

function markdownText(value: string): string {
  return value.replace(/@/g, "@\u200b").replace(/[\\`*_[\]<>]/g, "\\$&");
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

function hasUnsafeUnicodeFormat(value: string): boolean {
  return /[\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isSafeSourceAuthor(value: string): boolean {
  const author = value.trim();
  return (
    author.length > 0 && !hasUnsafeUnicodeFormat(author) && !/[^\s<>@]+@[^\s<>@]+/.test(author)
  );
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

function blamedAuthor(value: string): string | null {
  const match = /(?:^|\r?\n)author (.+)(?:\r?\n|$)/.exec(value);
  const author = match?.[1]?.trim() ?? "";
  return author && author.length <= 200 && !hasControlCharacter(author) ? author : null;
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
