import type { JsonValue, LooseRecord } from "./json-types.js";

const DEFAULT_ADAPTIVE_CODEX_TIMEOUT_MS = 600_000;
const MAX_ADAPTIVE_CODEX_TIMEOUT_MS = 1_500_000;
const PR_SIZE_BASELINE_FILES = 20;
const PR_SIZE_FILE_STEP_MS = 10_000;
const PR_SIZE_BASELINE_LINES = 1_000;
const PR_SIZE_LINE_STEP_MS = 50;
const MAX_PR_FILE_TIMEOUT_BONUS_MS = 600_000;
const MAX_PR_LINE_TIMEOUT_BONUS_MS = 300_000;
const MEDIA_PROOF_TIMEOUT_BONUS_MS = 120_000;
const MAX_MEDIA_PROOF_URLS = 4;
const VIDEO_PROOF_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm", ".avi", ".mkv"]);

export type AdaptiveReviewBudget = {
  codexTimeoutMs: number;
  mediaProofTimeoutMs: number;
};

export function adaptiveReviewBudgetForPullRequest(pull: LooseRecord): AdaptiveReviewBudget {
  const files = (Array.isArray(pull.files) ? pull.files : []) as LooseRecord[];
  const changedFiles =
    pull.changed_files == null && pull.changedFiles == null
      ? files.length
      : nonNegativeInteger(pull.changed_files ?? pull.changedFiles);
  const changedLines =
    pull.additions == null && pull.deletions == null
      ? files.reduce<number>(
          (total, file) =>
            total + nonNegativeInteger(file?.additions) + nonNegativeInteger(file?.deletions),
          0,
        )
      : nonNegativeInteger(pull.additions) + nonNegativeInteger(pull.deletions);
  const mediaProofCount = videoProofUrlsFromText(
    [String(pull.title ?? ""), String(pull.body ?? "")].join("\n"),
  ).length;
  const fileBonusMs = clamp(
    (changedFiles - PR_SIZE_BASELINE_FILES) * PR_SIZE_FILE_STEP_MS,
    0,
    MAX_PR_FILE_TIMEOUT_BONUS_MS,
  );
  const lineBonusMs = clamp(
    (changedLines - PR_SIZE_BASELINE_LINES) * PR_SIZE_LINE_STEP_MS,
    0,
    MAX_PR_LINE_TIMEOUT_BONUS_MS,
  );
  const mediaProofTimeoutMs = mediaProofCount * MEDIA_PROOF_TIMEOUT_BONUS_MS;
  return {
    codexTimeoutMs: clamp(
      DEFAULT_ADAPTIVE_CODEX_TIMEOUT_MS + fileBonusMs + lineBonusMs,
      DEFAULT_ADAPTIVE_CODEX_TIMEOUT_MS,
      MAX_ADAPTIVE_CODEX_TIMEOUT_MS,
    ),
    mediaProofTimeoutMs,
  };
}

function videoProofUrlsFromText(text: string) {
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
    const isVideo = [...VIDEO_PROOF_EXTENSIONS].some((extension) => pathname.endsWith(extension));
    if (!isVideo || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= MAX_MEDIA_PROOF_URLS) break;
  }
  return urls;
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

function nonNegativeInteger(value: JsonValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
