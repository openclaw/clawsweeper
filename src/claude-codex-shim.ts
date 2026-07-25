import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream";
import { resolveSpawnCommand } from "./command.js";
import { modelRuntimeCredentials } from "./model-runtime.js";

const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;
const MAX_INLINE_SCHEMA_BYTES = process.platform === "win32" ? 8 * 1024 : 64 * 1024;

interface Translation {
  args: string[];
  cwd: string;
  outputPath?: string;
  structuredOutput: boolean;
}

const translation = translateCodexArgs(process.argv.slice(2), process.cwd());
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...modelRuntimeCredentials(process.env),
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB?.trim() || "1",
};
delete childEnv.CLAWSWEEPER_CLAUDE_CREDENTIALS_FILE;

const claudeCommand = childEnv.CLAUDE_BIN?.trim() || "claude";
delete childEnv.CLAUDE_BIN;
const invocation = resolveSpawnCommand(claudeCommand, translation.args, {
  cwd: translation.cwd,
  env: childEnv,
  missingCommandMessage: `Unable to resolve Claude CLI command: ${claudeCommand}`,
});
const child = spawn(invocation.command, invocation.args, {
  cwd: translation.cwd,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
  ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
});

const stdoutChunks: Buffer[] = [];
let stdoutBytes = 0;
let stdoutOverflow = false;
let spawnError: Error | undefined;

child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  if (stdoutOverflow) return;
  stdoutBytes += chunk.length;
  if (stdoutBytes > MAX_CLAUDE_JSON_BYTES) {
    stdoutOverflow = true;
    stdoutChunks.length = 0;
    return;
  }
  stdoutChunks.push(chunk);
});
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
pipeline(process.stdin, child.stdin, () => {});
child.once("error", (error) => {
  spawnError = error;
});
child.once("close", (status, signal) => {
  if (translation.outputPath && !stdoutOverflow) {
    try {
      writeClaudeOutput(
        translation.outputPath,
        Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        translation.structuredOutput,
      );
    } catch (error) {
      process.stderr.write(
        `Claude CLI compatibility output failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
      return;
    }
  } else if (translation.outputPath && stdoutOverflow) {
    process.stderr.write(
      `Claude CLI output exceeded ${MAX_CLAUDE_JSON_BYTES} bytes before compatibility extraction.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (spawnError) {
    process.stderr.write(`${spawnError.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = status ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => terminateChild(child, signal));
}

export function translateCodexArgs(args: readonly string[], initialCwd: string): Translation {
  const claudeArgs = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  let cwd = initialCwd;
  let outputPath: string | undefined;
  let schemaPath: string | undefined;
  let sandbox = "read-only";
  let networkAccess = false;
  let noTools = false;
  let effort: string | undefined;

  for (let index = args[0] === "exec" ? 1 : 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const next = () => {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`Missing value after ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "-C" || arg === "--cd") {
      cwd = next();
    } else if (arg === "-m" || arg === "--model") {
      claudeArgs.push("--model", next());
    } else if (arg === "--add-dir") {
      claudeArgs.push("--add-dir", next());
    } else if (arg === "--output-last-message") {
      outputPath = next();
    } else if (arg === "--output-schema") {
      schemaPath = next();
    } else if (arg === "--sandbox") {
      sandbox = next();
    } else if (arg === "-c") {
      const config = next();
      const effortMatch = config.match(/^model_reasoning_effort\s*=\s*"?([^"]+)"?$/);
      if (effortMatch?.[1]) effort = effortMatch[1];
      const networkMatch = config.match(
        /^sandbox_workspace_write\.network_access\s*=\s*(true|false)$/,
      );
      if (networkMatch?.[1]) networkAccess = networkMatch[1] === "true";
    } else if (arg === "--disable") {
      if (next() === "shell_tool") noTools = true;
    } else if (
      arg === "--json" ||
      arg === "--ephemeral" ||
      arg === "--ignore-rules" ||
      arg === "--skip-git-repo-check" ||
      arg === "-"
    ) {
      continue;
    } else {
      throw new Error(`Unsupported Codex argument for Claude CLI compatibility: ${arg}`);
    }
  }

  if (effort) claudeArgs.push("--effort", normalizeClaudeEffort(effort));
  if (schemaPath) {
    const schema = readFileSync(schemaPath, "utf8");
    if (Buffer.byteLength(schema) <= MAX_INLINE_SCHEMA_BYTES) {
      claudeArgs.push("--json-schema", schema);
    }
  }
  if (noTools) {
    claudeArgs.push("--permission-mode", "dontAsk", "--tools", "");
  } else if (sandbox === "read-only") {
    claudeArgs.push(
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep,Bash",
      "--settings",
      JSON.stringify({
        permissions: { deny: ["Edit", "Write", "WebFetch", "WebSearch"] },
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: { denyWrite: [cwd] },
          network: { allowedDomains: [] },
        },
      }),
    );
  } else if (sandbox === "workspace-write") {
    claudeArgs.push(
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          ...(networkAccess ? {} : { network: { allowedDomains: [] } }),
        },
      }),
    );
  } else if (sandbox === "danger-full-access") {
    claudeArgs.push("--permission-mode", "bypassPermissions", "--dangerously-skip-permissions");
  } else {
    throw new Error(`Unsupported Codex sandbox for Claude CLI compatibility: ${sandbox}`);
  }

  return {
    args: claudeArgs,
    cwd,
    ...(outputPath ? { outputPath } : {}),
    structuredOutput: Boolean(schemaPath),
  };
}

function writeClaudeOutput(path: string, stdout: string, structuredOutput: boolean): void {
  const envelope = JSON.parse(stdout.trim()) as {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
  };
  if (envelope.is_error) {
    throw new Error(
      typeof envelope.result === "string" && envelope.result.trim()
        ? envelope.result.trim()
        : "Claude CLI returned an error response.",
    );
  }
  const value =
    structuredOutput && envelope.structured_output !== undefined
      ? envelope.structured_output
      : envelope.result;
  if (value === undefined) {
    throw new Error(
      structuredOutput
        ? "Claude response did not contain structured_output or result."
        : "Claude response did not contain result.",
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

function normalizeClaudeEffort(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized;
  return "high";
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
