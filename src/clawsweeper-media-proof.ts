import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trimMiddle } from "./clawsweeper-text.js";
import type {
  ItemContext,
  MediaProofCommandRunner,
  PreparedMediaProof,
  PreparedMediaProofArtifact,
  ReviewPromptRuntimeHints,
} from "./clawsweeper-types.js";
const IMAGE_PROOF_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_PROOF_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm", ".avi", ".mkv"]);
const MEDIA_PROOF_EXTENSIONS = new Set([...IMAGE_PROOF_EXTENSIONS, ...VIDEO_PROOF_EXTENSIONS]);
const MEDIA_PROOF_MANIFEST_FILE = "media-proof-manifest.json";
const MEDIA_PROOF_SUMMARY_FILE = "media-proof-summary.md";
const MAX_MEDIA_PROOF_URLS = 4;

export function mediaProofCommandRunner(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
}

function trimTrailingUrlPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const char = raw.charCodeAt(end - 1);
    if (char !== 44 && char !== 46 && char !== 58 && char !== 59) break;
    end -= 1;
  }
  return raw.slice(0, end);
}

function proofMediaUrlsFromContext(context: ItemContext): string[] {
  const {
    pullCommitsRevision: __,
    prHydrationSnapshot: ___,
    pullFiles: ____,
    ...proofContext
  } = context;
  // PR patches and supplemental body excerpts are reviewer text, never host download inputs.
  const text = JSON.stringify(proofContext, (key, value) =>
    key === "bodyCoverage" ? undefined : value,
  );
  const matches = text.match(/https?:\/\/[^\s<>"'\\)]+/g) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = trimTrailingUrlPunctuation(raw);
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    const pathname = parsed.pathname.toLowerCase();
    const isMedia = [...MEDIA_PROOF_EXTENSIONS].some((extension) => pathname.endsWith(extension));
    if (!isMedia || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= MAX_MEDIA_PROOF_URLS) break;
  }
  return urls;
}

function mediaProofFileExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const extension = [...MEDIA_PROOF_EXTENSIONS].find((candidate) => pathname.endsWith(candidate));
    return extension ?? ".media";
  } catch {
    return ".media";
  }
}

function mediaProofKind(url: string): "image" | "video" {
  const extension = mediaProofFileExtension(url);
  return IMAGE_PROOF_EXTENSIONS.has(extension) ? "image" : "video";
}

export function mediaProofSpawnDetail(result: ReturnType<MediaProofCommandRunner>): string {
  if (result.status === 0) return "ok";
  const details = [result.stderr, result.stdout, result.error?.message]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (details.length === 0) return "command failed without output";
  // Reserve room for each stream, then flatten so one-line reasons retain both.
  const separator = " | ";
  const budget = Math.floor((1000 - separator.length * (details.length - 1)) / details.length);
  return details
    .map((detail) => trimMiddle(detail, budget))
    .join(separator)
    .replace(/\s+/g, " ");
}

export function ffprobeMedia(path: string, runner: MediaProofCommandRunner) {
  return runner("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
}

export function createVideoContactSheet(
  inputPath: string,
  outputPath: string,
  runner: MediaProofCommandRunner,
) {
  return runner("ffmpeg", [
    "-hide_banner",
    "-y",
    "-i",
    inputPath,
    "-vf",
    "fps=1/5,scale=640:-1,tile=5x4",
    "-frames:v",
    "1",
    outputPath,
  ]);
}

export function prepareMediaProofArtifacts(
  context: ItemContext,
  proofScratchDir: string,
  runner: MediaProofCommandRunner = mediaProofCommandRunner,
): PreparedMediaProof {
  const urls = proofMediaUrlsFromContext(context);
  if (urls.length === 0) return { manifestPath: null, summaryPath: null, artifacts: [] };
  mkdirSync(proofScratchDir, { recursive: true });
  const artifacts: PreparedMediaProofArtifact[] = [];
  for (const [index, url] of urls.entries()) {
    const ordinal = index + 1;
    const kind = mediaProofKind(url);
    const downloadedPath = join(
      proofScratchDir,
      `proof-${kind}-${ordinal}${mediaProofFileExtension(url)}`,
    );
    const metadataPath = join(proofScratchDir, `proof-video-${ordinal}.ffprobe.json`);
    const contactSheetPath = join(proofScratchDir, `proof-video-${ordinal}.contact-sheet.jpg`);
    const download = runner("curl", [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "90",
      "--output",
      downloadedPath,
      url,
    ]);
    if (download.status !== 0) {
      artifacts.push({
        kind,
        url,
        downloadedPath: null,
        metadataPath: null,
        contactSheetPath: null,
        status: "failed",
        detail: `download failed: ${mediaProofSpawnDetail(download)}`,
      });
      continue;
    }
    if (kind === "image") {
      artifacts.push({
        kind,
        url,
        downloadedPath,
        metadataPath: null,
        contactSheetPath: null,
        status: "prepared",
        detail: "downloaded image proof for local inspection",
      });
      continue;
    }
    const metadata = ffprobeMedia(downloadedPath, runner);
    if (metadata.status !== 0) {
      artifacts.push({
        kind,
        url,
        downloadedPath,
        metadataPath: null,
        contactSheetPath: null,
        status: "failed",
        detail: `ffprobe failed: ${mediaProofSpawnDetail(metadata)}`,
      });
      continue;
    }
    writeFileSync(metadataPath, String(metadata.stdout ?? "{}"), "utf8");
    const contactSheet = createVideoContactSheet(downloadedPath, contactSheetPath, runner);
    if (contactSheet.status !== 0) {
      artifacts.push({
        kind,
        url,
        downloadedPath,
        metadataPath,
        contactSheetPath: null,
        status: "failed",
        detail: `ffmpeg contact sheet failed: ${mediaProofSpawnDetail(contactSheet)}`,
      });
      continue;
    }
    artifacts.push({
      kind,
      url,
      downloadedPath,
      metadataPath,
      contactSheetPath,
      status: "prepared",
      detail: "downloaded, probed, and converted to a contact sheet with ffmpeg",
    });
  }
  const manifestPath = join(proofScratchDir, MEDIA_PROOF_MANIFEST_FILE);
  const summaryPath = join(proofScratchDir, MEDIA_PROOF_SUMMARY_FILE);
  const prepared: PreparedMediaProof = { manifestPath, summaryPath, artifacts };
  writeFileSync(manifestPath, JSON.stringify(prepared, null, 2), "utf8");
  writeFileSync(summaryPath, mediaProofSummaryMarkdown(prepared), "utf8");
  return prepared;
}

function mediaProofSummaryMarkdown(prepared: PreparedMediaProof): string {
  const lines = ["# Prepared Media Proof", ""];
  for (const artifact of prepared.artifacts) {
    lines.push(`- ${artifact.status}: ${artifact.url}`);
    if (artifact.downloadedPath) lines.push(`  - downloaded: ${artifact.downloadedPath}`);
    if (artifact.metadataPath) lines.push(`  - ffprobe metadata: ${artifact.metadataPath}`);
    if (artifact.contactSheetPath) lines.push(`  - contact sheet: ${artifact.contactSheetPath}`);
    lines.push(`  - detail: ${artifact.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

export function mediaProofRuntimePrompt(
  summary: string | undefined,
  manifestPath: string | undefined,
) {
  const trimmed = summary?.trim();
  if (!trimmed || !manifestPath) return "";
  return `
- ClawSweeper downloaded linked image and video proof before this review. Read \`${manifestPath}\` and inspect downloaded image paths and generated video contact-sheet paths locally before trying browser playback.
- Assess screenshots directly from their downloaded image paths. If browser video playback fails but ffprobe metadata and ffmpeg contact sheets are readable, assess the video from those generated artifacts instead of treating it as uninspectable.
- Only fall back to browser playback after checking the prepared local artifacts. If local preparation and browser playback both fail, report the exact failure from the manifest.
`;
}

export function mediaProofRuntimeHints(
  proofScratchDir: string,
  preparedMediaProof: PreparedMediaProof,
): ReviewPromptRuntimeHints {
  const hints: ReviewPromptRuntimeHints = { proofScratchDir };
  if (preparedMediaProof.manifestPath)
    hints.mediaProofManifestPath = preparedMediaProof.manifestPath;
  if (preparedMediaProof.summaryPath && preparedMediaProof.artifacts.length) {
    hints.mediaProofSummary = mediaProofSummaryMarkdown(preparedMediaProof);
  }
  return hints;
}

export function proofMediaUrlsFromContextForTest(context: ItemContext): string[] {
  return proofMediaUrlsFromContext(context);
}

export function proofVideoUrlsFromContextForTest(context: ItemContext): string[] {
  return proofMediaUrlsFromContext(context).filter((url) => mediaProofKind(url) === "video");
}

export function prepareMediaProofArtifactsForTest(
  context: ItemContext,
  proofScratchDir: string,
  runner: MediaProofCommandRunner,
): PreparedMediaProof {
  return prepareMediaProofArtifacts(context, proofScratchDir, runner);
}
