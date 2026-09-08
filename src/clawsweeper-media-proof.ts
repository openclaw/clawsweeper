import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";
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
const MEDIA_PROOF_TIMEOUT_MS = 120_000;

export function mediaProofCommandRunner(
  command: string,
  args: readonly string[],
  options: Parameters<MediaProofCommandRunner>[2] = {},
) {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: options.killSignal,
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

export function isGitHubMediaAttachmentUrl(url: URL): boolean {
  if (url.origin !== "https://github.com" || url.username || url.password) return false;
  return (
    /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      url.pathname,
    ) ||
    /^\/[^/]+\/[^/]+\/assets\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      url.pathname,
    )
  );
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
    const isMedia =
      isGitHubMediaAttachmentUrl(parsed) ||
      [...MEDIA_PROOF_EXTENSIONS].some((extension) => pathname.endsWith(extension));
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

function mediaProofKind(url: string): PreparedMediaProofArtifact["kind"] {
  if (isGitHubMediaAttachmentUrl(new URL(url))) return "attachment";
  const extension = mediaProofFileExtension(url);
  return IMAGE_PROOF_EXTENSIONS.has(extension) ? "image" : "video";
}

function attachmentFileExtension(contentType: string, effectiveUrl: string): string {
  const extensions: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-m4v": ".m4v",
    "video/x-msvideo": ".avi",
    "video/x-matroska": ".mkv",
    "video/ogg": ".ogv",
  };
  if (extensions[contentType]) return extensions[contentType];
  try {
    const extension = extname(new URL(effectiveUrl).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,10}$/.test(extension)) return extension;
  } catch {
    // Missing redirect metadata leaves a generic local filename.
  }
  return ".media";
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
    const deadlineAt = performance.now() + MEDIA_PROOF_TIMEOUT_MS;
    const runBeforeDeadline: MediaProofCommandRunner = (command, args) => {
      const timeoutMs = Math.ceil(deadlineAt - performance.now());
      // A zero spawn timeout disables the deadline, so do not start another stage.
      if (timeoutMs <= 0) {
        return { status: null, error: new Error("media proof deadline exceeded") };
      }
      return runner(command, args, { timeoutMs, killSignal: "SIGKILL" });
    };
    const ordinal = index + 1;
    let kind = mediaProofKind(url);
    let downloadedPath = join(
      proofScratchDir,
      `proof-${kind}-${ordinal}${mediaProofFileExtension(url)}`,
    );
    const metadataPath = join(proofScratchDir, `proof-video-${ordinal}.ffprobe.json`);
    const contactSheetPath = join(proofScratchDir, `proof-video-${ordinal}.contact-sheet.jpg`);
    const download = runBeforeDeadline("curl", [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "90",
      "--output",
      downloadedPath,
      ...(kind === "attachment" ? ["-w", "%{content_type}\n%{url_effective}"] : []),
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
        detail: `download failed: ${mediaProofSpawnDetail(kind === "attachment" ? { ...download, stdout: "" } : download)}`,
      });
      continue;
    }
    if (kind === "attachment") {
      const [rawContentType = "", effectiveUrl = ""] = String(download.stdout ?? "").split("\n");
      const contentType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
        artifacts.push({
          kind,
          url,
          downloadedPath: null,
          metadataPath: null,
          contactSheetPath: null,
          status: "failed",
          detail: `unsupported content type ${contentType || "(missing)"}`,
        });
        continue;
      }
      kind = contentType.startsWith("image/") ? "image" : "video";
      const resolvedPath = join(
        proofScratchDir,
        `proof-${kind}-${ordinal}${attachmentFileExtension(contentType, effectiveUrl.trim())}`,
      );
      renameSync(downloadedPath, resolvedPath);
      downloadedPath = resolvedPath;
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
    const metadata = ffprobeMedia(downloadedPath, runBeforeDeadline);
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
    const contactSheet = createVideoContactSheet(
      downloadedPath,
      contactSheetPath,
      runBeforeDeadline,
    );
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
