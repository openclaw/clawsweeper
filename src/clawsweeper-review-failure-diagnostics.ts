import { stringOrEmpty as stringValue } from "./value-coerce.js";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentInputScanError } from "./agent-input-scan.js";
import { codexJsonlFailureDetail } from "./codex-transient.js";

const FILE_LIMITS = { "error.txt": 4096, "stdout.error.txt": 4096, "stderr.tail.txt": 12_288 };
const TOTAL_LIMIT = 24 * 1024;
const OMITTED = "[omitted: unsafe diagnostic content]\n";
const SENSITIVE_NAME = String.raw`(?:ACCOUNT|ACTOR|AUTH|CODEX_HOME|COOKIE|CREDENTIAL|HOST|KEY|MODEL|PASSWORD|PRIVATE|PROVIDER|PROXY|RUNNER|SECRET|SESSION|TOKEN|USER|WEBHOOK)`;
const ASSIGNMENT = new RegExp(
  String.raw`\b[A-Z0-9_-]*${SENSITIVE_NAME}[A-Z0-9_-]*[ \t]*[:=][ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`,
  "gi",
);
const TOKEN =
  /\b(?:bearer|basic)\s+\S+|\b(?:sk-(?:proj-)?|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{12,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gi;
const OPAQUE =
  /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-]))(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]+/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const PRIVATE_PATH =
  /(?:~\/|(?<![A-Za-z0-9_+=-])\/(?!\/)[^\s"'<>]+|[A-Za-z]:\\[^\s"'<>]+|\\\\[^\\\s"'<>]+\\[^\s"'<>]+)/gi;
const INTERNAL_HOST =
  /\b(?:localhost|(?:[a-z0-9-]+\.)*(?:corp|internal|local)(?:\.[a-z0-9-]+)*)(?::\d+)?\b/gi;
const PRIVATE_IP =
  /(?<![A-Za-z0-9])(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?(?![A-Za-z0-9])|\[(?:::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\](?::\d+)?|(?<![A-Za-z0-9])(?:::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)(?![A-Za-z0-9])/gi;
const AMBIGUOUS = new RegExp(
  String.raw`(?:^|\n)\s*[A-Z0-9_-]*${SENSITIVE_NAME}[A-Z0-9_-]*\s*[:=]\s*(?:[>|][+-]?\d*|["'][^"'\r\n]*$|[^\r\n]*\\\s*$)`,
  "im",
);

export function writeExactReviewFailureDiagnostics(options: {
  artifactDir: string;
  error: unknown;
  prompt: string;
  model: string;
  classification: string;
  repo: string;
  itemKind: "issue" | "pull_request";
  itemNumber: number;
  sourceSha?: string | null | undefined;
  retryable: boolean;
  workflowExit: number;
  env?: NodeJS.ProcessEnv;
}): string {
  const error = record(options.error);
  const scanFailure = options.error instanceof AgentInputScanError ? options.error : undefined;
  const diagnosticStage = scanFailure
    ? "agent_input_scan"
    : safeCode(error.diagnosticStage, /^source_preparation$/);
  const diagnosticReason = scanFailure
    ? safeCode(
        error.reason,
        /^(?:scanner_unavailable|scanner_failed|findings|deadline|staging_limit|incomplete_source|source_drift|unsafe_path|unsupported_content)$/,
      )
    : diagnosticStage
      ? safeCode(
          error.diagnosticReason,
          /^(?:configuration_missing|setup_script_failed|source_incompatible|review_commits_unavailable|review_history_unavailable|review_blob_metadata_unavailable|review_blobs_unavailable|review_checkout_unavailable|review_commit_fetch_failed|review_checkout_failed|review_git_inspection_failed)$/,
        )
      : null;
  const values = exactValues(options.prompt, options.model, options.env ?? process.env);
  const inputs = {
    "error.txt": options.error instanceof Error ? options.error.message : String(options.error),
    "stdout.error.txt": scanFailure ? "" : codexJsonlFailureDetail(stringValue(error.stdout)),
    "stderr.tail.txt": scanFailure ? "" : stringValue(error.stderr),
  };
  const files = Object.entries(inputs).map(([name, value]) => {
    const result = sanitize(value, values, FILE_LIMITS[name as keyof typeof FILE_LIMITS]);
    return { name, ...result };
  });
  const manifest = `${JSON.stringify(
    {
      version: 1,
      classification:
        diagnosticStage ??
        (/^(?:provider_throttle|transport_network|content_or_output|model_access|timeout|codex_execution)$/.test(
          options.classification,
        )
          ? options.classification
          : "codex_execution"),
      retryable: options.retryable,
      failure: {
        stage: diagnosticStage ?? "unknown",
        reason_code: diagnosticReason ?? "unknown",
        ...(scanFailure?.scanDiagnostic ? { scan: scanFailure.scanDiagnostic } : {}),
      },
      process: {
        status: Number.isInteger(error.status) && Number(error.status) >= 0 ? error.status : null,
        signal: safeCode(error.signal, /^SIG[A-Z0-9]+$/),
        error_code: safeCode(error.errorCode, /^[A-Z][A-Z0-9_]{1,63}$/),
        workflow_exit: options.workflowExit,
      },
      source: {
        repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)
          ? options.repo
          : "unknown/unknown",
        item_kind: options.itemKind,
        item_number: options.itemNumber,
        sha: /^[0-9a-f]{40,64}$/i.test(options.sourceSha ?? "")
          ? options.sourceSha!.toLowerCase()
          : null,
      },
      omitted_files: files.filter((file) => file.omitted).map((file) => file.name),
    },
    null,
    2,
  )}\n`;
  const total =
    Buffer.byteLength(manifest) +
    files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0);
  if (total > TOTAL_LIMIT) throw new Error(`Exact-review diagnostics exceed ${TOTAL_LIMIT} bytes.`);

  const outputDir = join(options.artifactDir, "failure-diagnostics");
  const stagingDir = `${outputDir}.tmp-${process.pid}`;
  mkdirSync(options.artifactDir, { recursive: true, mode: 0o700 });
  if (existsSync(outputDir)) throw new Error("Exact-review failure diagnostics already exist.");
  rmSync(stagingDir, { recursive: true, force: true });
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    for (const file of files) {
      writeFileSync(join(stagingDir, file.name), file.content, { mode: 0o600 });
    }
    writeFileSync(join(stagingDir, "manifest.json"), manifest, { mode: 0o600 });
    renameSync(stagingDir, outputDir);
  } catch (writeError) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw writeError;
  }
  return outputDir;
}

function sanitize(value: string, exact: readonly string[], limit: number) {
  if (!value) return { content: "[no diagnostic detail]\n", omitted: false };
  if (unsafeControl(value) || ambiguous(value, exact)) return { content: OMITTED, omitted: true };
  let redacted = value;
  for (const secret of exact) redacted = redacted.replaceAll(secret, "[REDACTED]");
  redacted = redacted
    .replace(ASSIGNMENT, (entry) => `${entry.slice(0, entry.search(/[:=]/) + 1)}[REDACTED]`)
    .replace(TOKEN, "[REDACTED]")
    .replace(URL, "[REDACTED_URL]")
    .replace(PRIVATE_PATH, "[REDACTED_PATH]")
    .replace(INTERNAL_HOST, "[REDACTED_HOST]")
    .replace(PRIVATE_IP, "[REDACTED_HOST]");
  const content = utf8Tail(redacted.endsWith("\n") ? redacted : `${redacted}\n`, limit);
  return residual(content, exact)
    ? { content: OMITTED, omitted: true }
    : { content, omitted: false };
}

function exactValues(prompt: string, model: string, env: NodeJS.ProcessEnv): string[] {
  const promptLines = prompt
    .split(/\r?\n/)
    .flatMap((line) => (line.trim().length >= 2 ? [line, line.trim()] : []));
  const values = [
    prompt,
    ...promptLines,
    model,
    ...Object.entries(env)
      .filter(([name, value]) => value && new RegExp(SENSITIVE_NAME, "i").test(name))
      .map(([, value]) => value!),
  ].filter(Boolean);
  return [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function ambiguous(value: string, exact: readonly string[]): boolean {
  return (
    /-----BEGIN [A-Z0-9 -]*PRIVATE KEY(?: BLOCK)?-----/i.test(value) ||
    AMBIGUOUS.test(value) ||
    exact.some((secret) => /[\r\n]/.test(secret) && value.includes(secret))
  );
}

function residual(value: string, exact: readonly string[]): boolean {
  const clean = value.replace(/\[REDACTED(?:_[A-Z]+)?\]/g, "");
  return (
    unsafeControl(value) ||
    exact.some((secret) => clean.includes(secret)) ||
    [ASSIGNMENT, TOKEN, OPAQUE, URL, PRIVATE_PATH, INTERNAL_HOST, PRIVATE_IP].some((pattern) =>
      new RegExp(pattern.source, pattern.flags.replace("g", "")).test(clean),
    )
  );
}

function utf8Tail(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  const marker = "...[truncated]...\n";
  let tail = "";
  for (const character of Array.from(value).reverse()) {
    if (Buffer.byteLength(marker + character + tail) > limit) break;
    tail = character + tail;
  }
  return marker + tail;
}

function unsafeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 9 || code === 11 || code === 12 || (code > 13 && code < 32) || code === 127;
  });
}

function safeCode(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
