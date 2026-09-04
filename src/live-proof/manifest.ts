import { requireRecord, rejectUnexpectedKeys, requirePositiveInteger } from "../value-coerce.js";
import { statSync } from "node:fs";
import { mediaProofSpawnDetail, ffprobeMedia } from "../clawsweeper-media-proof.js";
import type { MediaProofCommandRunner } from "../clawsweeper-types.js";

export const LIVE_PROOF_SCHEMA_VERSION = 1;
export const LIVE_PROOF_MAX_DURATION_SECONDS = 90;
export const LIVE_PROOF_MAX_MP4_BYTES = 50 * 1024 * 1024;
export const LIVE_PROOF_MAX_POSTER_BYTES = 10 * 1024 * 1024;

export type LiveProofDriveStatus = "completed" | "partial" | "failed";

export interface LiveProofManifest {
  schema_version: 1;
  repo: string;
  item: number;
  head_sha: string;
  surface: "browser" | "terminal";
  duration_seconds: number;
  width: number;
  height: number;
  drive_status: LiveProofDriveStatus;
  steps_executed: string[];
  recorded_at: string;
}

export interface ProbedMedia {
  durationSeconds: number | null;
  width: number;
  height: number;
}

export class MediaProbeExecutionError extends Error {
  override name = "MediaProbeExecutionError";
}

const MANIFEST_KEYS = new Set([
  "schema_version",
  "repo",
  "item",
  "head_sha",
  "surface",
  "duration_seconds",
  "width",
  "height",
  "drive_status",
  "steps_executed",
  "recorded_at",
]);

export function parseLiveProofManifest(value: unknown): LiveProofManifest {
  const record = requireRecord(value, "live proof manifest");
  rejectUnexpectedKeys(record, MANIFEST_KEYS, "live proof manifest");
  if (record.schema_version !== LIVE_PROOF_SCHEMA_VERSION) {
    throw new Error("live proof manifest.schema_version must be 1");
  }
  const repo = requireString(record.repo, "live proof manifest.repo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("live proof manifest.repo must be owner/repo");
  }
  const item = requirePositiveInteger(record.item, "live proof manifest.item");
  const headSha = requireString(record.head_sha, "live proof manifest.head_sha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("live proof manifest.head_sha must be a 40-character commit SHA");
  }
  if (record.surface !== "browser" && record.surface !== "terminal") {
    throw new Error("live proof manifest.surface must be browser or terminal");
  }
  const durationSeconds = requireFiniteNumber(
    record.duration_seconds,
    "live proof manifest.duration_seconds",
  );
  if (durationSeconds <= 0 || durationSeconds > LIVE_PROOF_MAX_DURATION_SECONDS) {
    throw new Error("live proof manifest.duration_seconds must be greater than 0 and at most 90");
  }
  const width = requirePositiveInteger(record.width, "live proof manifest.width");
  const height = requirePositiveInteger(record.height, "live proof manifest.height");
  if (width > 4096 || height > 4096) {
    throw new Error("live proof manifest dimensions exceed the 4096-pixel cap");
  }
  if (!["completed", "partial", "failed"].includes(String(record.drive_status))) {
    throw new Error("live proof manifest.drive_status is invalid");
  }
  if (!Array.isArray(record.steps_executed) || record.steps_executed.length > 10) {
    throw new Error("live proof manifest.steps_executed must be an array of at most 10 items");
  }
  const stepsExecuted = record.steps_executed.map((entry, index) => {
    const step = requireString(entry, `live proof manifest.steps_executed[${index}]`);
    if (!/^[a-z_]+$/.test(step)) {
      throw new Error(
        `live proof manifest.steps_executed[${index}] must contain only an action name`,
      );
    }
    return step;
  });
  const recordedAt = requireString(record.recorded_at, "live proof manifest.recorded_at");
  const recordedAtMs = Date.parse(recordedAt);
  if (!Number.isFinite(recordedAtMs) || new Date(recordedAtMs).toISOString() !== recordedAt) {
    throw new Error("live proof manifest.recorded_at must be an ISO8601 UTC timestamp");
  }
  return {
    schema_version: 1,
    repo,
    item,
    head_sha: headSha,
    surface: record.surface,
    duration_seconds: durationSeconds,
    width,
    height,
    drive_status: record.drive_status as LiveProofDriveStatus,
    steps_executed: stepsExecuted,
    recorded_at: recordedAt,
  };
}

export function probeMedia(path: string, runner: MediaProofCommandRunner): ProbedMedia {
  const result = ffprobeMedia(path, runner);
  if (result.error || result.status === null) {
    throw new MediaProbeExecutionError(
      `ffprobe could not execute for ${path}: ${mediaProofSpawnDetail(result)}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${path}: ${mediaProofSpawnDetail(result)}`);
  }
  const stdout = String(result.stdout ?? "");
  if (!stdout.trim()) {
    throw new MediaProbeExecutionError(`ffprobe returned no output for ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new MediaProbeExecutionError(`ffprobe returned invalid JSON for ${path}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MediaProbeExecutionError(`ffprobe returned a non-object JSON value for ${path}`);
  }
  const root = parsed as Record<string, unknown>;
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const video = streams
    .map((stream) => (stream && typeof stream === "object" ? stream : null))
    .find((stream) => stream && (stream as Record<string, unknown>).codec_type === "video") as
    | Record<string, unknown>
    | undefined;
  if (!video) throw new Error(`ffprobe found no video stream in ${path}`);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`ffprobe returned invalid dimensions for ${path}`);
  }
  const format = root.format && typeof root.format === "object" ? root.format : {};
  const rawDuration = Number((format as Record<string, unknown>).duration ?? video.duration);
  return {
    durationSeconds: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
    width,
    height,
  };
}

export function validateAttachedMedia(options: {
  manifest: LiveProofManifest;
  mp4Path: string;
  posterPath: string;
  runner: MediaProofCommandRunner;
}): ProbedMedia {
  const mp4Size = statSync(options.mp4Path).size;
  if (mp4Size <= 0 || mp4Size > LIVE_PROOF_MAX_MP4_BYTES) {
    throw new Error("live-proof.mp4 violates the 50 MB size cap");
  }
  const posterSize = statSync(options.posterPath).size;
  if (posterSize <= 0 || posterSize > LIVE_PROOF_MAX_POSTER_BYTES) {
    throw new Error("poster.jpg violates the 10 MB size cap");
  }
  const video = probeMedia(options.mp4Path, options.runner);
  const poster = probeMedia(options.posterPath, options.runner);
  if (
    video.durationSeconds === null ||
    video.durationSeconds > LIVE_PROOF_MAX_DURATION_SECONDS + 0.05
  ) {
    throw new Error("live-proof.mp4 violates the 90-second duration cap");
  }
  if (Math.abs(video.durationSeconds - options.manifest.duration_seconds) > 1) {
    throw new Error("live-proof.mp4 duration does not match the manifest");
  }
  if (video.width !== options.manifest.width || video.height !== options.manifest.height) {
    throw new Error("live-proof.mp4 dimensions do not match the manifest");
  }
  if (poster.width > 4096 || poster.height > 4096) {
    throw new Error("poster.jpg dimensions exceed the 4096-pixel cap");
  }
  return video;
}

// Manifest strings must be trimmed and single-line.
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\u2028\u2029]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return value.trim();
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}
