// Pure, testable helpers for the Claude CLI (`-p`) review engine: building the
// subprocess argv (read-only, no permission bypass) and recognising the
// terminal result record in the CLI's output. Kept separate from clawsweeper.ts
// so the security-relevant command construction and the output parsing are
// unit-tested in isolation.

// Read-only inspection tools the reviewer is permitted to use. This is an
// explicit allow-list — NOT a permission bypass — so the spawned binary can
// never invoke Edit/Write/Bash/etc. against the target checkout. A local review
// has the full diff and context in the prompt, so read-only file inspection is
// all the engine needs.
export const CLAUDE_REVIEW_READONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

// Credentials the configurable Claude binary must never receive: GitHub tokens,
// the ClawSweeper GitHub App identity/key, and OpenAI/Codex keys. The Claude CLI
// authenticates from its own local credentials, so none of these are needed.
export const SCRUBBED_CREDENTIAL_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COMMIT_SWEEPER_TARGET_GH_TOKEN",
  "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
  "CLAWSWEEPER_APP_ID",
  "CLAWSWEEPER_APP_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

// Build the environment for the Claude review subprocess, scrubbing the
// credentials above. The binary is operator-configurable via --claude-bin, so
// this boundary matters even though Codex's path scrubs the same set.
export function claudeReviewEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of SCRUBBED_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export type ClaudeReviewArgsOptions = {
  proofScratchDir: string;
  model?: string;
};

// Build the argv for a headless, read-only `claude -p` review. Deliberately
// uses an `--allowedTools` allow-list and NO `--permission-mode bypassPermissions`,
// so the engine cannot mutate the checkout via tools.
export function buildClaudeReviewArgs(options: ClaudeReviewArgsOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowedTools",
    ...CLAUDE_REVIEW_READONLY_TOOLS,
    "--add-dir",
    options.proofScratchDir,
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  return args;
}

export type ClaudeResultRecord = {
  isError: boolean;
  structuredOutput: unknown;
  resultText: string;
  errorText: string;
};

// Recognise the terminal result record in Claude CLI `-p` output. claude-code
// emits the conversation as JSONL records (an `init`, any number of
// `stream_event`s, then exactly one `{ "type": "result", ... }`). With
// `--output-format json` those records arrive as a single JSON array; with
// `stream-json` they arrive one-per-line. This mirrors how OpenClaw's own
// claude-stream-json parser locates the terminal record, in either shape.
export function parseClaudeResultRecord(raw: string): ClaudeResultRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const records: Record<string, unknown>[] = [];
  const pushRecord = (value: unknown): void => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      records.push(value as Record<string, unknown>);
    }
  };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) parsed.forEach(pushRecord);
    else pushRecord(parsed);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        pushRecord(JSON.parse(text));
      } catch {
        // Skip non-JSON lines (banners, partial chunks).
      }
    }
  }
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record && record.type === "result") {
      return {
        isError: record.is_error === true,
        structuredOutput: record.structured_output,
        resultText: typeof record.result === "string" ? record.result : "",
        errorText: typeof record.error === "string" ? record.error : "",
      };
    }
  }
  return null;
}

// Pull a bare JSON object out of the reviewer's final text (handles an optional
// ```json fence or surrounding prose).
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const candidate = (fence ? (fence[1]?.trim() ?? "") : trimmed).trim();
  if (candidate.startsWith("{")) return candidate;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) return candidate.slice(first, last + 1);
  return null;
}
