import { readReviewGit, reviewCommitParents } from "./pr-review-evidence.js";
import type {
  Decision,
  LikelyOwner,
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

type SourceCommit = {
  sha: string;
  parents: string[];
  author: string | null;
  committer: string | null;
  subject: string;
};
type SourceLineChange =
  | { status: "changed"; commit: SourceCommit; sourcePath: string; sourceLine: number }
  | { status: "unknown" | "carried_forward" };

function createSourceLineReader(
  checkoutDir: string,
  reviewedCommitShas: readonly (string | undefined)[],
) {
  const deadlineAt = Date.now() + 5_000;
  const git = (args: string[]) =>
    readReviewGit(checkoutDir, args, { deadlineAt })?.toString("utf8") ?? null;
  const headSha = fullSha(git(["rev-parse", "--verify", "HEAD"]) ?? "");
  const recordedHead =
    headSha && reviewedCommitShas.some((sha) => fullSha(sha ?? "") === headSha) ? headSha : null;
  const cache = new Map<string, SourceLineChange>();
  const readCommit = (sha: string): SourceCommit | null => {
    const raw = git(["cat-file", "commit", sha]);
    if (raw === null) return null;
    const [header, message] = raw.split("\n\n", 2);
    const parents = reviewCommitParents(raw);
    if (!parents || parents.length > 8) return null;
    const records = (header ?? "").split("\n");
    const actor = (role: "author" | "committer") => {
      const record = records.find((line) => line.startsWith(`${role} `));
      const name = new RegExp(`^${role} (.+) <[^>]*> -?\\d+ [+-]\\d{4}$`).exec(record ?? "")?.[1];
      return name && isSafeSourceAuthor(name) ? name : null;
    };
    return {
      sha,
      parents,
      author: actor("author"),
      committer: actor("committer"),
      subject: message?.split("\n", 1)[0] ?? "",
    };
  };
  const read = (sourcePath: string, sourceLine: number): SourceLineChange => {
    const unknown = { status: "unknown" } as const;
    if (
      !recordedHead ||
      !isSafeSourcePath(sourcePath) ||
      !Number.isSafeInteger(sourceLine) ||
      sourceLine <= 0 ||
      sourceLine > MAX_SOURCE_LINE
    )
      return unknown;
    const key = `${sourcePath}:${sourceLine}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const blame = git([
      "blame",
      "--line-porcelain",
      "--no-textconv",
      // Repository ignore lists can blame different text to an older author.
      "--ignore-revs-file",
      "",
      "-L",
      `${sourceLine},${sourceLine}`,
      recordedHead,
      "--",
      sourcePath,
    ]);
    const blameRecords = (blame ?? "").split("\n");
    const header = /^(\^?[0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/i.exec(blameRecords[0] ?? "");
    const sha = fullSha(header?.[1]?.replace(/^\^/, "") ?? "");
    const originalLine = Number(header?.[2]);
    // Git records split only on LF; CR inside identities cannot forge metadata.
    const originalPath = blameRecords.find((line) => line.startsWith("filename "))?.slice(9);
    if (
      !sha ||
      !originalLine ||
      !originalPath ||
      !isSafeSourcePath(originalPath) ||
      originalPath.startsWith('"')
    )
      return unknown;
    const commit = readCommit(sha);
    // %P and show --root honor shallow/graft boundaries. Only raw commit parents
    // tell us whether a displayed "root" actually carried the line forward.
    if (!commit || commit.parents.some((parent) => !readCommit(parent))) return unknown;
    let status: "changed" | "carried_forward" = "changed";
    for (const parent of commit.parents) {
      // A path-limited diff hides a rename's old side. Exact moves carry the
      // line forward; inexact moves need a line mapping we have not verified.
      const renames = git([
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "-l0",
        "--diff-filter=R",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        parent,
        sha,
        "--",
      ]);
      if (renames === null) return unknown;
      const fields = renames.split("\0");
      const renamed = fields.findIndex((entry, index) => index % 3 === 2 && entry === originalPath);
      if (renamed >= 0) {
        if (fields[renamed - 2] !== "R100") return unknown;
        status = "carried_forward";
        continue;
      }
      const patch = git([
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--unified=0",
        "--inter-hunk-context=0",
        parent,
        sha,
        "--",
        originalPath,
      ]);
      if (patch === null || /^(?:Binary files |GIT binary patch|Submodule )/m.test(patch))
        return unknown;
      const addsLine = patch.split("\n").some((line) => {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) return false;
        const start = Number(match[1]);
        return originalLine >= start && originalLine < start + Number(match[2] ?? 1);
      });
      if (!addsLine) status = "carried_forward";
    }
    // A genuine parentless root still needs a local blob, not a boundary display.
    if (!commit.parents.length && git(["cat-file", "blob", `${sha}:${originalPath}`]) === null)
      return unknown;
    const result: SourceLineChange =
      status === "changed"
        ? { status, commit, sourcePath: originalPath, sourceLine: originalLine }
        : { status };
    cache.set(key, result);
    return result;
  };
  return { git, headSha: recordedHead, read };
}

/** Public attribution is host-owned Git fact, never free-form model role/reason. */
export function publicLikelyOwner(owner: LikelyOwner): LikelyOwner {
  if (owner.attributionSource === "raw_parent_line_v1") return owner;
  const person = owner.person.trim();
  return {
    person: isSafeSourceAuthor(person) ? markdownText(person) : "unknown",
    role: "unverified routing candidate",
    reason: "Suggested for follow-up; no historical authorship or introduction is verified.",
    commits: [],
    files: [],
    confidence: "low",
    attributionSource: "raw_parent_line_v1",
  };
}

export function verifyLikelyOwnerHistory(
  decision: Decision,
  options: Pick<VerifyRegressionProvenanceOptions, "checkoutDir" | "reviewedCommitShas">,
): Decision {
  const reader = createSourceLineReader(options.checkoutDir, options.reviewedCommitShas);
  const baseSha = fullSha(options.reviewedCommitShas[0] ?? "");
  const selected = decision.likelyOwners.find(
    (owner) => owner.person === decision.maintainerDecision.likelyOwner.person,
  );
  const candidates = decision.likelyOwners.slice(0, 5);
  // The decision packet must select from the same bounded, normalized public set.
  if (decision.maintainerDecision.required && selected && !candidates.includes(selected))
    candidates[4] = selected;
  const likelyOwners = candidates.map((owner): LikelyOwner => {
    const history = owner.history;
    if (!history) return publicLikelyOwner(owner);
    const unknown = publicLikelyOwner({
      person: "unknown",
      role: "",
      reason: "",
      commits: [],
      files: [],
      confidence: "low",
    });
    const result = fullSha(history.commitSha)
      ? reader.read(history.sourcePath, history.sourceLine)
      : null;
    if (!result || result.status !== "changed") {
      const carried = result?.status === "carried_forward";
      return {
        ...unknown,
        role: carried ? "carried-forward source line" : "source history unknown",
        reason: carried
          ? "The blamed commit carries this line unchanged from a recorded parent; no introducing author is attributed."
          : "The claimed source-line change could not be verified from bounded local history.",
      };
    }
    const person = result.commit[history.actor];
    // PR-head coordinates locate prior merged history, not proposal authorship.
    // Domain/reviewer routing independent of that history uses history: null.
    if (
      result.commit.sha !== fullSha(history.commitSha) ||
      !person ||
      !baseSha ||
      reader.git(["merge-base", "--is-ancestor", result.commit.sha, baseSha]) === null
    )
      return unknown;
    return {
      person: markdownText(person),
      role: `source-line ${history.actor}`,
      reason: `Raw commit ${result.commit.sha} adds ${markdownText(result.sourcePath)}:${result.sourceLine} relative to its recorded parents. This identifies ${history.actor} metadata, not feature responsibility or a PR merger.`,
      commits: [result.commit.sha],
      files: [result.sourcePath],
      confidence: owner.confidence,
      attributionSource: "raw_parent_line_v1",
    };
  });
  const selectedOwner = selected ? likelyOwners[candidates.indexOf(selected)] : undefined;
  return {
    ...decision,
    likelyOwners,
    maintainerDecision: decision.maintainerDecision.required
      ? {
          ...decision.maintainerDecision,
          likelyOwner: {
            person: selectedOwner?.person ?? "unknown",
            reason: selectedOwner?.reason ?? "No verified decision owner is available.",
            confidence: selectedOwner?.confidence ?? "low",
          },
        }
      : decision.maintainerDecision,
  };
}

export function createRegressionProvenanceVerifier({
  fetchPull,
  fetchPullDiff,
}: RegressionProvenanceVerifierDependencies) {
  function verify(
    options: VerifyRegressionProvenanceOptions,
  ): VerifiedRegressionProvenance | SuspectedRegressionProvenance | null {
    const candidate = normalizeCandidate(options.candidate, options.item);
    const reviewedBaseCommitSha = fullSha(options.reviewedCommitShas[0] ?? "");
    if (!candidate || !isSafeTargetBranch(options.targetBranch) || !reviewedBaseCommitSha)
      return null;
    try {
      const pull = verifiedPullMetadata(
        fetchPull(candidate.repo, candidate.pullRequestNumber),
        candidate,
        options.targetBranch,
      );
      if (!pull) return null;
      const reader = createSourceLineReader(options.checkoutDir, options.reviewedCommitShas);
      const source = reader.read(candidate.sourcePath, candidate.sourceLine);
      if (source.status !== "changed" || !reader.headSha) return null;
      const { sha: sourceCommitSha, author: sourceAuthor } = source.commit;
      if (sourceCommitSha !== candidate.mergeCommitSha) {
        if (
          !sourceAuthor ||
          reader.git(["merge-base", "--is-ancestor", sourceCommitSha, reviewedBaseCommitSha]) ===
            null
        )
          return null;
        let rewriteEquivalent = false;
        try {
          rewriteEquivalent = isConservativeRewriteEquivalent({
            candidate,
            sourceCommit: source.commit,
            pullDiff: fetchPullDiff(candidate.repo, candidate.pullRequestNumber),
            git: reader.git,
          });
        } catch {
          // A verified line change remains useful when the optional PR diff is unavailable.
        }
        return {
          verificationSource: "raw_parent_line_v1",
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
        verificationSource: "raw_parent_line_v1",
        evidenceType: "blame_to_merge_commit",
        mergedAt: pull.mergedAt,
        reviewedCommitSha: reader.headSha,
        ...(sourceAuthor ? { sourceCommitSha, sourceAuthor } : {}),
      };
    } catch {
      // Metadata or local history failures are unknown, never an attribution.
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
    candidate.verificationSource === "raw_parent_line_v1" &&
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
      : "source author unavailable";
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
    candidate.verificationSource === "raw_parent_line_v1" &&
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
  sourceCommit: SourceCommit;
  pullDiff: string;
  git: (args: string[]) => string | null;
}): boolean {
  const { sourceCommit } = options;
  if (
    sourceCommit.parents.length !== 1 ||
    !new RegExp(`\\(#${options.candidate.pullRequestNumber}\\)\\s*$`).test(sourceCommit.subject)
  )
    return false;
  const sourceDiff = options.git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=3",
    "--no-renames",
    sourceCommit.parents[0]!,
    sourceCommit.sha,
    "--",
  ]);
  const normalizedSourceDiff = normalizedTextPatch(sourceDiff ?? "");
  return (
    normalizedSourceDiff !== null && normalizedSourceDiff === normalizedTextPatch(options.pullDiff)
  );
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
    author.length > 0 &&
    author.length <= 200 &&
    !hasControlCharacter(author) &&
    !hasUnsafeUnicodeFormat(author) &&
    !/[^\s<>@]+@[^\s<>@]+/.test(author)
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
