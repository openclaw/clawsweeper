import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mediaProofCommandRunner, mediaProofSpawnDetail } from "../clawsweeper-media-proof.js";
import { LIVE_PROOF_RECORDING_MARKER, type REVIEW_SECTIONS } from "../clawsweeper-policy.js";
import type { CloseReason, MediaProofCommandRunner } from "../clawsweeper-types.js";
import type { LiveProofPullRequestState } from "./execute.js";
import {
  parseLiveProofManifest,
  validateAttachedMedia,
  type LiveProofManifest,
} from "./manifest.js";

export interface LiveProofAttachOptions {
  bundleDir: string;
  recordPath: string;
  dryRun: boolean;
}

export interface LiveProofAttachDependencies {
  env?: NodeJS.ProcessEnv;
  runner?: MediaProofCommandRunner;
  fetchPullRequest: (repo: string, item: number) => Promise<LiveProofPullRequestState>;
  frontMatterValue: (markdown: string, key: string) => string | undefined;
  sectionValue: (markdown: string, heading: string) => string;
  replaceSectionValue: (markdown: string, heading: string, value: string) => string;
  reviewSections: typeof REVIEW_SECTIONS;
  renderReviewCommentFromReport: (markdown: string, closeReason: CloseReason) => string;
  markedReviewCommentBody: (number: number, body: string) => string;
  upsertReviewComment: (number: number, body: string) => Record<string, unknown> | undefined;
  log?: (message: string) => void;
}

export type LiveProofAttachResult = "attached" | "skipped" | "dry-run";

export async function attachLiveProof(
  options: LiveProofAttachOptions,
  dependencies: LiveProofAttachDependencies,
): Promise<LiveProofAttachResult> {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? mediaProofCommandRunner;
  const log = dependencies.log ?? console.log;
  const bundleDir = resolve(options.bundleDir);
  const recordPath = resolve(options.recordPath);
  const manifest = parseLiveProofManifest(
    JSON.parse(readFileSync(join(bundleDir, "live-proof-manifest.json"), "utf8")) as unknown,
  );
  const mp4Path = join(bundleDir, "live-proof.mp4");
  const posterPath = join(bundleDir, "poster.jpg");
  validateAttachedMedia({ manifest, mp4Path, posterPath, runner });

  const report = readFileSync(recordPath, "utf8");
  validateReportIdentity(report, manifest, dependencies.frontMatterValue);
  const reportHead = dependencies.frontMatterValue(report, "pull_head_sha")?.toLowerCase() ?? "";
  let liveHead: string;
  if (options.dryRun) {
    liveHead = reportHead;
    log("[live-proof-attach] dry-run: using the report head for the simulated live-head check");
  } else {
    const pull = await dependencies.fetchPullRequest(manifest.repo, manifest.item);
    if (pull.kind !== "pull_request" || pull.state.toLowerCase() !== "open") {
      log(
        `[live-proof-attach] skip: ${manifest.repo}#${manifest.item} is not an open pull request`,
      );
      return "skipped";
    }
    liveHead = pull.headSha?.toLowerCase() ?? "";
  }
  if (liveHead !== manifest.head_sha) {
    log(
      `[live-proof-attach] skip: stale proof head ${manifest.head_sha} does not match live head ${liveHead || "unknown"}`,
    );
    return "skipped";
  }

  const upload = trustedUploadConfiguration(env, manifest);
  const recordingBlock = liveProofRecordingBlock(manifest, upload.posterUrl, upload.videoUrl);
  const liveProofSection = liveProofSectionWithRecording(
    report,
    dependencies.reviewSections.liveProof,
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
  const markedComment = dependencies.markedReviewCommentBody(manifest.item, comment);

  const uploads: Array<{ localPath: string; key: string; contentType: string }> = [
    { localPath: mp4Path, key: upload.videoKey, contentType: "video/mp4" },
    { localPath: posterPath, key: upload.posterKey, contentType: "image/jpeg" },
  ];
  if (options.dryRun) {
    for (const candidate of uploads) {
      log(`[live-proof-attach] dry-run: ${renderCommand("aws", awsUploadArgs(candidate, upload))}`);
    }
    log(
      `[live-proof-attach] dry-run: replace ## ${dependencies.reviewSections.liveProof} in ${recordPath} with:\n${liveProofSection}`,
    );
    log(
      `[live-proof-attach] dry-run: upsert marker-backed review comment for ${manifest.repo}#${manifest.item}:\n${markedComment}`,
    );
    return "dry-run";
  }

  for (const candidate of uploads) {
    const args = awsUploadArgs(candidate, upload);
    const result = runner("aws", args);
    if (result.status !== 0) {
      throw new Error(`aws s3 cp failed: ${mediaProofSpawnDetail(result)}`);
    }
  }
  writeFileSync(recordPath, updatedReport, "utf8");
  log(
    `[live-proof-attach] prepared ${manifest.surface} proof for ${manifest.repo}#${manifest.item} at ${manifest.head_sha}`,
  );
  return "attached";
}

export function syncLiveProofComment(
  options: Pick<LiveProofAttachOptions, "bundleDir" | "recordPath">,
  dependencies: LiveProofAttachDependencies,
): void {
  const bundleDir = resolve(options.bundleDir);
  const recordPath = resolve(options.recordPath);
  const manifest = parseLiveProofManifest(
    JSON.parse(readFileSync(join(bundleDir, "live-proof-manifest.json"), "utf8")) as unknown,
  );
  const report = readFileSync(recordPath, "utf8");
  validateReportIdentity(report, manifest, dependencies.frontMatterValue);
  if (
    !dependencies
      .sectionValue(report, dependencies.reviewSections.liveProof)
      .includes(LIVE_PROOF_RECORDING_MARKER)
  ) {
    throw new Error("record is missing the attached Live Proof recording");
  }
  const closeReason = (dependencies.frontMatterValue(report, "close_reason") ??
    "none") as CloseReason;
  const comment = dependencies.renderReviewCommentFromReport(report, closeReason);
  const markedComment = dependencies.markedReviewCommentBody(manifest.item, comment);
  dependencies.upsertReviewComment(manifest.item, markedComment);
  (dependencies.log ?? console.log)(
    `[live-proof-attach] synced marker-backed review comment for ${manifest.repo}#${manifest.item}`,
  );
}

function validateReportIdentity(
  report: string,
  manifest: LiveProofManifest,
  frontMatterValue: (markdown: string, key: string) => string | undefined,
): void {
  if (frontMatterValue(report, "repository")?.toLowerCase() !== manifest.repo.toLowerCase()) {
    throw new Error("record repository does not match the live proof manifest");
  }
  if (Number(frontMatterValue(report, "number")) !== manifest.item) {
    throw new Error("record item number does not match the live proof manifest");
  }
  if (frontMatterValue(report, "type") !== "pull_request") {
    throw new Error("live proof can only be attached to a pull request report");
  }
  if (frontMatterValue(report, "pull_head_sha")?.toLowerCase() !== manifest.head_sha) {
    throw new Error("record pull_head_sha does not match the live proof manifest");
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

function liveProofSectionWithRecording(
  report: string,
  heading: string,
  recordingBlock: string,
  sectionValue: (markdown: string, heading: string) => string,
): string {
  const section = sectionValue(report, heading);
  const markerIndex = section.lastIndexOf(LIVE_PROOF_RECORDING_MARKER);
  const planOnly = (markerIndex >= 0 ? section.slice(0, markerIndex) : section).trimEnd();
  if (!planOnly) throw new Error("record is missing the Live Proof plan section");
  return `${planOnly}\n\n${recordingBlock}`;
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
