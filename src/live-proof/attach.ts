import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mediaProofCommandRunner, mediaProofSpawnDetail } from "../clawsweeper-media-proof.js";
import {
  LIVE_PROOF_RECORDING_MARKER,
  LIVE_VERIFICATION_MARKER,
  type REVIEW_SECTIONS,
} from "../clawsweeper-policy.js";
import type { CloseReason, LiveProofPlan, MediaProofCommandRunner } from "../clawsweeper-types.js";
import type { LiveProofPullRequestState } from "./execute.js";
import {
  MediaProbeExecutionError,
  parseLiveProofManifest,
  validateAttachedMedia,
  type LiveProofManifest,
} from "./manifest.js";
import {
  encodeLiveVerificationReportPayload,
  parseAttachedLiveVerification,
  parseLiveVerificationResult,
  validateLiveVerificationReportIdentity,
  validateLiveVerificationReportPlan,
  type LiveVerificationResult,
} from "./verification.js";

export interface LiveProofAttachOptions {
  bundleDir: string;
  recordPath: string;
  dryRun: boolean;
}

export interface LiveProofDetachOptions {
  recordPath: string;
  repositorySlug: string;
  item: number;
  dryRun: boolean;
}

export interface LiveProofAttachDependencies {
  env?: NodeJS.ProcessEnv;
  runner?: MediaProofCommandRunner;
  fetchPullRequest: (repo: string, item: number) => Promise<LiveProofPullRequestState>;
  reportLiveProofPlan: (markdown: string) => LiveProofPlan;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  sectionValue: (markdown: string, heading: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  reviewSections: typeof REVIEW_SECTIONS;
  renderReviewCommentFromReport: (markdown: string, closeReason: CloseReason) => string;
  markedReviewCommentBody: (number: number, body: string) => string;
  upsertReviewComment: (number: number, body: string) => Record<string, unknown> | undefined;
  selectTarget?: (repo: string) => void;
  log?: (message: string) => void;
}

export type LiveProofAttachResult = "attached" | "detached" | "unchanged" | "skipped" | "dry-run";

export class LiveProofArtifactValidationError extends Error {
  override name = "LiveProofArtifactValidationError";
}

export async function attachLiveProof(
  options: LiveProofAttachOptions,
  dependencies: LiveProofAttachDependencies,
): Promise<LiveProofAttachResult> {
  return attachLiveProofInternal(options, dependencies, false);
}

export async function attachReviewLiveProofArtifact(
  options: Omit<LiveProofAttachOptions, "dryRun">,
  dependencies: LiveProofAttachDependencies,
): Promise<LiveProofAttachResult> {
  return attachLiveProofInternal({ ...options, dryRun: false }, dependencies, true);
}

async function attachLiveProofInternal(
  options: LiveProofAttachOptions,
  dependencies: LiveProofAttachDependencies,
  reviewedHeadIsAuthoritative: boolean,
): Promise<LiveProofAttachResult> {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? mediaProofCommandRunner;
  const log = dependencies.log ?? console.log;
  const bundleDir = resolve(options.bundleDir);
  const recordPath = resolve(options.recordPath);
  const { verification, report, manifest, mp4Path, posterPath } = validateArtifact(() => {
    const verification = parseLiveVerificationResult(
      JSON.parse(readFileSync(join(bundleDir, "live-verification.json"), "utf8")) as unknown,
    );
    const report = readFileSync(recordPath, "utf8");
    validateReportIdentity(report, verification, dependencies.frontMatterValue);
    validateLiveVerificationReportPlan(verification, dependencies.reportLiveProofPlan(report));
    const manifestPath = join(bundleDir, "live-proof-manifest.json");
    const manifest = existsSync(manifestPath)
      ? parseLiveProofManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown)
      : undefined;
    const mp4Path = join(bundleDir, "live-proof.mp4");
    const posterPath = join(bundleDir, "poster.jpg");
    if (manifest) {
      validateManifestMatchesVerification(manifest, verification);
      validateAttachedMedia({ manifest, mp4Path, posterPath, runner });
    } else if (existsSync(mp4Path) || existsSync(posterPath)) {
      throw new Error("live proof media is present without a manifest");
    }
    return { verification, report, manifest, mp4Path, posterPath };
  });
  dependencies.selectTarget?.(verification.repo);

  const reportHead = dependencies.frontMatterValue(report, "pull_head_sha")?.toLowerCase() ?? "";
  let liveHead: string;
  if (reviewedHeadIsAuthoritative) {
    liveHead = reportHead;
  } else if (options.dryRun) {
    liveHead = reportHead;
    log("[live-proof-attach] dry-run: using the report head for the simulated live-head check");
  } else {
    const pull = await dependencies.fetchPullRequest(verification.repo, verification.item);
    if (pull.kind !== "pull_request" || pull.state.toLowerCase() !== "open") {
      log(
        `[live-proof-attach] skip: ${verification.repo}#${verification.item} is not an open pull request`,
      );
      return "skipped";
    }
    liveHead = pull.headSha?.toLowerCase() ?? "";
  }
  if (liveHead !== verification.head_sha) {
    log(
      `[live-proof-attach] skip: stale proof head ${verification.head_sha} does not match live head ${liveHead || "unknown"}`,
    );
    return "skipped";
  }

  const upload = manifest ? trustedUploadConfiguration(env, manifest) : undefined;
  const recordingBlock =
    manifest && upload
      ? liveProofRecordingBlock(manifest, upload.posterUrl, upload.videoUrl)
      : undefined;
  const verificationBlock = liveVerificationReportBlock(verification);
  const liveProofSection = liveProofSectionWithResult(
    report,
    dependencies.reviewSections.liveProof,
    verificationBlock,
    recordingBlock,
    dependencies.sectionValue,
  );
  let updatedReport = dependencies.replaceSectionValue(
    report,
    dependencies.reviewSections.liveProof,
    liveProofSection,
  );
  const closeReason = (dependencies.frontMatterValue(updatedReport, "close_reason") ??
    "none") as CloseReason;
  const comment = dependencies.renderReviewCommentFromReport(updatedReport, closeReason);
  const markedComment = dependencies.markedReviewCommentBody(verification.item, comment);

  const uploads: Array<{ localPath: string; key: string; contentType: string }> = upload
    ? [
        { localPath: mp4Path, key: upload.videoKey, contentType: "video/mp4" },
        { localPath: posterPath, key: upload.posterKey, contentType: "image/jpeg" },
      ]
    : [];
  if (options.dryRun) {
    for (const candidate of uploads) {
      log(
        `[live-proof-attach] dry-run: ${renderCommand("aws", awsUploadArgs(candidate, upload!))}`,
      );
    }
    log(
      `[live-proof-attach] dry-run: replace ## ${dependencies.reviewSections.liveProof} in ${recordPath} with:\n${liveProofSection}`,
    );
    log(
      `[live-proof-attach] dry-run: upsert marker-backed review comment for ${verification.repo}#${verification.item}:\n${markedComment}`,
    );
    return "dry-run";
  }

  for (const candidate of uploads) {
    const args = awsUploadArgs(candidate, upload!);
    const result = runner("aws", args);
    if (result.status !== 0) {
      throw new Error(`aws s3 cp failed: ${mediaProofSpawnDetail(result)}`);
    }
  }
  writeFileSync(recordPath, updatedReport, "utf8");
  log(
    `[live-proof-attach] prepared ${verification.surface} verification${manifest ? " with media" : " without media"} for ${verification.repo}#${verification.item} at ${verification.head_sha}`,
  );
  return "attached";
}

function validateArtifact<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MediaProbeExecutionError) throw error;
    throw new LiveProofArtifactValidationError(
      error instanceof Error ? error.message : "live proof artifact validation failed",
      { cause: error },
    );
  }
}

export function detachLiveProof(
  options: LiveProofDetachOptions,
  dependencies: LiveProofAttachDependencies,
): LiveProofAttachResult {
  const log = dependencies.log ?? console.log;
  const recordPath = resolve(options.recordPath);
  const report = readFileSync(recordPath, "utf8");
  validateDetachedReportIdentity(
    report,
    options.repositorySlug,
    options.item,
    dependencies.frontMatterValue,
  );
  const section = dependencies.sectionValue(report, dependencies.reviewSections.liveProof);
  const markerIndex = section.lastIndexOf(LIVE_PROOF_RECORDING_MARKER);
  if (markerIndex < 0) {
    log(
      `[live-proof-attach] detach: ${options.repositorySlug}#${options.item} has no recording block; no changes needed`,
    );
    return "unchanged";
  }

  const liveProofSection = section.slice(0, markerIndex).trimEnd();
  if (!liveProofSection) throw new Error("record is missing the Live Proof plan section");
  const updatedReport = dependencies.replaceSectionValue(
    report,
    dependencies.reviewSections.liveProof,
    liveProofSection,
  );
  const closeReason = (dependencies.frontMatterValue(updatedReport, "close_reason") ??
    "none") as CloseReason;
  const comment = dependencies.renderReviewCommentFromReport(updatedReport, closeReason);
  const markedComment = dependencies.markedReviewCommentBody(options.item, comment);

  if (options.dryRun) {
    log(
      `[live-proof-attach] dry-run: replace ## ${dependencies.reviewSections.liveProof} in ${recordPath} with:\n${liveProofSection}`,
    );
    log(
      `[live-proof-attach] dry-run: publish ${recordPath}, then upsert marker-backed review comment for ${options.repositorySlug}#${options.item}:\n${markedComment}`,
    );
    return "dry-run";
  }

  writeFileSync(recordPath, updatedReport, "utf8");
  log(`[live-proof-attach] detached recording from ${options.repositorySlug}#${options.item}`);
  return "detached";
}

export function syncLiveProofComment(
  options: Pick<LiveProofAttachOptions, "bundleDir" | "recordPath">,
  dependencies: LiveProofAttachDependencies,
): void {
  const bundleDir = resolve(options.bundleDir);
  const recordPath = resolve(options.recordPath);
  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(bundleDir, "live-verification.json"), "utf8")) as unknown,
  );
  const report = readFileSync(recordPath, "utf8");
  validateReportIdentity(report, verification, dependencies.frontMatterValue);
  const plan = dependencies.reportLiveProofPlan(report);
  validateLiveVerificationReportPlan(verification, plan);
  const attached = parseAttachedLiveVerification(
    dependencies.sectionValue(report, dependencies.reviewSections.liveProof),
    reportIdentity(report, dependencies.frontMatterValue),
    plan,
  );
  if (attached.status === "absent") {
    throw new Error("record is missing the attached Live Verification result");
  }
  if (
    (attached.status !== "passed" && attached.status !== "failed") ||
    JSON.stringify(attached.result) !== JSON.stringify(verification)
  ) {
    throw new Error("record Live Verification result does not match the proof bundle");
  }
  const closeReason = (dependencies.frontMatterValue(report, "close_reason") ??
    "none") as CloseReason;
  const comment = dependencies.renderReviewCommentFromReport(report, closeReason);
  const markedComment = dependencies.markedReviewCommentBody(verification.item, comment);
  dependencies.upsertReviewComment(verification.item, markedComment);
  (dependencies.log ?? console.log)(
    `[live-proof-attach] synced marker-backed review comment for ${verification.repo}#${verification.item}`,
  );
}

export function syncDetachedLiveProofComment(
  options: Omit<LiveProofDetachOptions, "dryRun">,
  dependencies: LiveProofAttachDependencies,
): void {
  const recordPath = resolve(options.recordPath);
  const report = readFileSync(recordPath, "utf8");
  validateDetachedReportIdentity(
    report,
    options.repositorySlug,
    options.item,
    dependencies.frontMatterValue,
  );
  if (
    dependencies
      .sectionValue(report, dependencies.reviewSections.liveProof)
      .includes(LIVE_PROOF_RECORDING_MARKER)
  ) {
    throw new Error("record still contains the Live Proof recording");
  }
  const closeReason = (dependencies.frontMatterValue(report, "close_reason") ??
    "none") as CloseReason;
  const comment = dependencies.renderReviewCommentFromReport(report, closeReason);
  const markedComment = dependencies.markedReviewCommentBody(options.item, comment);
  dependencies.upsertReviewComment(options.item, markedComment);
  (dependencies.log ?? console.log)(
    `[live-proof-attach] synced retracted marker-backed review comment for ${options.repositorySlug}#${options.item}`,
  );
}

function validateReportIdentity(
  report: string,
  result: Pick<LiveVerificationResult, "repo" | "item" | "head_sha">,
  frontMatterValue: (markdown: string, key: string) => string | undefined,
): void {
  validateLiveVerificationReportIdentity(result, reportIdentity(report, frontMatterValue));
}

function reportIdentity(
  report: string,
  frontMatterValue: (markdown: string, key: string) => string | undefined,
) {
  return {
    repository: frontMatterValue(report, "repository"),
    number: frontMatterValue(report, "number"),
    type: frontMatterValue(report, "type"),
    pullHeadSha: frontMatterValue(report, "pull_head_sha"),
  };
}

function validateDetachedReportIdentity(
  report: string,
  repositorySlug: string,
  item: number,
  frontMatterValue: (markdown: string, key: string) => string | undefined,
): void {
  const repository = frontMatterValue(report, "repository") ?? "";
  const actualSlug = repository
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (actualSlug !== repositorySlug.toLowerCase()) {
    throw new Error("record repository does not match --repo-slug");
  }
  if (Number(frontMatterValue(report, "number")) !== item) {
    throw new Error("record item number does not match --item");
  }
  if (frontMatterValue(report, "type") !== "pull_request") {
    throw new Error("live proof can only be detached from a pull request report");
  }
}

function trustedUploadConfiguration(env: NodeJS.ProcessEnv, manifest: LiveProofManifest) {
  const endpoint = trustedHttpsUrl(
    env.CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT,
    "CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT",
  ).href.replace(/\/$/, "");
  const baseUrl = trustedHttpsUrl(
    env.CLAWSWEEPER_LIVE_PROOF_BASE_URL,
    "CLAWSWEEPER_LIVE_PROOF_BASE_URL",
  ).href.replace(/\/$/, "");
  const bucket = env.CLAWSWEEPER_LIVE_PROOF_BUCKET?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,61}[A-Za-z0-9]$/.test(bucket)) {
    throw new Error("CLAWSWEEPER_LIVE_PROOF_BUCKET is invalid");
  }
  const repoSlug = manifest.repo.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const keyPrefix = `live-proof/${repoSlug}/${manifest.item}/${manifest.head_sha}`;
  const videoKey = `${keyPrefix}/live-proof.mp4`;
  const posterKey = `${keyPrefix}/live-proof.jpg`;
  return {
    endpoint,
    baseUrl,
    bucket,
    videoKey,
    posterKey,
    videoUrl: `${baseUrl}/${videoKey}`,
    posterUrl: `${baseUrl}/${posterKey}`,
  };
}

function trustedHttpsUrl(value: string | undefined, label: string): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${label} must be an HTTPS origin with no credentials, path, query, or hash`);
  }
  return url;
}

function liveProofRecordingBlock(
  manifest: LiveProofManifest,
  posterUrl: string,
  videoUrl: string,
): string {
  const duration = Number(manifest.duration_seconds.toFixed(3)).toString();
  return [
    LIVE_PROOF_RECORDING_MARKER,
    "",
    `[![Live proof recording](${posterUrl})](${videoUrl})`,
    "",
    `*Recorded live on the PR head (\`${manifest.head_sha.slice(0, 12)}\`), ${duration}s, ${manifest.surface} surface.*`,
  ].join("\n");
}

function liveVerificationReportBlock(result: LiveVerificationResult): string {
  return [LIVE_VERIFICATION_MARKER, `Result: ${encodeLiveVerificationReportPayload(result)}`].join(
    "\n",
  );
}

function liveProofSectionWithResult(
  report: string,
  heading: string,
  verificationBlock: string,
  recordingBlock: string | undefined,
  sectionValue: (markdown: string, heading: string) => string,
): string {
  const section = sectionValue(report, heading);
  const markerIndexes = [
    section.indexOf(LIVE_VERIFICATION_MARKER),
    section.indexOf(LIVE_PROOF_RECORDING_MARKER),
  ].filter((index) => index >= 0);
  const markerIndex = markerIndexes.length ? Math.min(...markerIndexes) : -1;
  const planOnly = (markerIndex >= 0 ? section.slice(0, markerIndex) : section).trimEnd();
  if (!planOnly) throw new Error("record is missing the Live Proof plan section");
  return [planOnly, verificationBlock, recordingBlock].filter(Boolean).join("\n\n");
}

function validateManifestMatchesVerification(
  manifest: LiveProofManifest,
  verification: LiveVerificationResult,
): void {
  if (
    manifest.repo !== verification.repo ||
    manifest.item !== verification.item ||
    manifest.head_sha !== verification.head_sha ||
    manifest.surface !== verification.surface ||
    manifest.drive_status !== verification.drive_status
  ) {
    throw new Error("live proof manifest does not match the live verification result");
  }
}

function awsUploadArgs(
  candidate: { localPath: string; key: string; contentType: string },
  upload: { bucket: string; endpoint: string },
): string[] {
  return [
    "s3",
    "cp",
    candidate.localPath,
    `s3://${upload.bucket}/${candidate.key}`,
    "--endpoint-url",
    upload.endpoint,
    "--content-type",
    candidate.contentType,
  ];
}

function renderCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:+@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
