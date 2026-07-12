export type PackageScriptRequirement = {
  command: string;
  name: string;
};

const VITEST_BOOLEAN_OPTIONS = new Set([
  "-h",
  "-w",
  "--allowOnly",
  "--cache",
  "--clearCache",
  "--clearScreen",
  "--coverage",
  "--dangerouslyIgnoreUnhandledErrors",
  "--detectAsyncLeaks",
  "--disableConsoleIntercept",
  "--dom",
  "--expandSnapshotDiff",
  "--fileParallelism",
  "--globals",
  "--help",
  "--hideSkippedTests",
  "--includeTaskLocation",
  "--isolate",
  "--logHeapUsage",
  "--open",
  "--passWithNoTests",
  "--printConsoleTrace",
  "--run",
  "--standalone",
  "--strictTags",
  "--typecheck",
  "--ui",
  "--watch",
]);

export function packageScriptRequirement(
  parts: readonly string[],
): PackageScriptRequirement | null {
  const commandParts = stripEnvPrefix(parts);
  if (commandParts[0] === "npm" && commandParts[1] === "run" && commandParts[2]) {
    return { name: commandParts[2], command: commandParts.slice(0, 3).join(" ") };
  }
  if (commandParts[0] === "bun" && commandParts[1] === "run" && commandParts[2]) {
    return { name: commandParts[2], command: commandParts.slice(0, 3).join(" ") };
  }
  if (commandParts[0] !== "pnpm") return null;
  let index = 1;
  if (commandParts[index] === "-s" || commandParts[index] === "--silent") index += 1;
  if (commandParts[index] === "run") index += 1;
  const script = commandParts[index];
  if (!script || ["exec", "dlx", "install", "add", "remove"].includes(script)) return null;
  return { name: script, command: ["pnpm", script].join(" ") };
}

export function isExpensivePnpmValidation(
  parts: readonly string[],
  commandStart: number,
  allowExpensiveValidation: boolean,
): boolean {
  if (allowExpensiveValidation) return false;
  const script = String(parts[commandStart] ?? "");
  if (script === "check" || script === "test:all") return true;
  if (script === "openclaw" && parts[commandStart + 1] === "qa") return true;
  if (script === "vitest" && parts[commandStart + 1] === "run") {
    return vitestPathFilterIndexes(parts.slice(commandStart + 2)).length === 0;
  }
  if (
    script === "exec" &&
    parts[commandStart + 1] === "vitest" &&
    parts[commandStart + 2] === "run"
  ) {
    return vitestPathFilterIndexes(parts.slice(commandStart + 3)).length === 0;
  }
  if (script === "test" || script === "test:serial") {
    return !parts.slice(commandStart + 1).some(looksLikePathArgument);
  }
  return /^(?:test:(?:e2e|live|docker|install:e2e|parallels)(?::|$)|qa:e2e$|android:test:integration$)/.test(
    script,
  );
}

export function looksLikePathArgument(value: unknown): boolean {
  const text = String(value ?? "");
  return (
    !text.startsWith("-") &&
    (text.includes("/") || /\.(?:[cm]?[jt]sx?|json|md|yml|yaml)$/.test(text))
  );
}

export function isTestFile(value: unknown): boolean {
  return /(?:^|\/)[^/]*(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(String(value));
}

export function vitestPositionalFilterIndexes(args: readonly string[]): number[] {
  const indexes: number[] = [];
  let optionValue = false;
  let positionalOnly = false;
  for (const [index, arg] of args.entries()) {
    if (optionValue) {
      optionValue = false;
      continue;
    }
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && arg.startsWith("-")) {
      const option = arg.split("=", 1)[0]!;
      // Vitest optional-value flags such as --update consume the following
      // token too. Only documented boolean flags leave it positional.
      optionValue =
        !arg.includes("=") && !option.startsWith("--no-") && !VITEST_BOOLEAN_OPTIONS.has(option);
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

export function vitestPathFilterIndexes(args: readonly string[]): number[] {
  return vitestPositionalFilterIndexes(args).filter((index) => looksLikePathArgument(args[index]));
}

export function uniqueStrings(values: Iterable<unknown>): string[] {
  return [...new Set([...values].filter(Boolean).map(String))];
}

export function parseAllowedValidationCommand(command: unknown): string[] {
  const text = String(command ?? "").trim();
  if (!text) throw new Error("empty validation command");
  const parts = normalizeEnvInvocation(splitValidationCommand(text));
  const executable = validationExecutable(parts);
  if (!executable || !isAllowedValidationExecutable(executable, parts)) {
    throw new Error(`unsupported validation command: ${text}`);
  }
  if (
    hasUnsafePackageRunner(parts) ||
    hasInlineInterpreterCode(parts) ||
    hasMutatingValidationFlag(parts)
  ) {
    throw new Error(`unsafe validation command: ${text}`);
  }
  return parts;
}

export function stripEnvPrefix(parts: readonly string[]): string[] {
  let index = parts[0] === "env" ? 1 : 0;
  while (index < parts.length && isEnvAssignment(parts[index])) index += 1;
  return parts.slice(index);
}

function validationExecutable(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const strippedCount = parts.length - commandParts.length - (parts[0] === "env" ? 1 : 0);
  if (parts[0] === "env" && strippedCount === 0) return "";
  return commandParts[0] ?? "";
}

function isAllowedValidationExecutable(executable: string, parts: readonly string[]) {
  return (
    [
      "pnpm",
      "npm",
      "bun",
      "node",
      "git",
      "make",
      "go",
      "cargo",
      "rustc",
      "swift",
      "swiftc",
      "xcodebuild",
      "python",
      "python3",
      "pytest",
      "uv",
      "ruff",
      "mypy",
      "ansible-playbook",
      "ansible-lint",
      "dotnet",
      "gradle",
      "./gradlew",
      "mvn",
      "./mvnw",
      "php",
      "composer",
      "ruby",
      "bundle",
    ].includes(executable) ||
    isSafeLocalShellScriptInvocation(stripEnvPrefix(parts)) ||
    executable === "scripts/run-opengrep.sh" ||
    executable === "./scripts/run-opengrep.sh"
  );
}

function hasInlineInterpreterCode(parts: readonly string[]) {
  const shellExecutables = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "ksh",
    "pwsh",
    "powershell",
    "cmd",
    "cmd.exe",
  ]);
  const deniedByExecutable: Record<string, readonly string[]> = {
    node: ["-e", "--eval", "-p", "--print"],
    bun: ["-e", "--eval", "-p", "--print"],
    deno: ["eval"],
    tsx: ["-e", "--eval", "-p", "--print"],
    "ts-node": ["-e", "--eval", "-p", "--print"],
    python: ["-c"],
    python3: ["-c"],
    ruby: ["-e"],
    php: ["-r"],
    swift: ["-e"],
  };
  const commandParts = stripEnvPrefix(parts);
  if (
    commandParts.some((part) => shellExecutables.has(part.toLowerCase())) &&
    !isSafeLocalShellScriptInvocation(commandParts)
  ) {
    return true;
  }
  for (const [index, executable] of commandParts.entries()) {
    const denied = deniedByExecutable[executable];
    if (!denied) continue;
    if (
      commandParts
        .slice(index + 1)
        .some((arg) =>
          denied.some(
            (flag) =>
              arg === flag ||
              (flag.startsWith("--") ? arg.startsWith(`${flag}=`) : arg.startsWith(flag)),
          ),
        )
    ) {
      return true;
    }
  }
  return false;
}

function isSafeLocalShellScriptInvocation(commandParts: readonly string[]) {
  const executable = String(commandParts[0] ?? "").toLowerCase();
  if (!["sh", "bash"].includes(executable)) return false;
  const script = String(commandParts[1] ?? "");
  if (
    !script ||
    script.startsWith("-") ||
    script.startsWith("/") ||
    script.includes("\\") ||
    script.split("/").includes("..")
  ) {
    return false;
  }
  return /(?:^|\/)[A-Za-z0-9_.-]+\.sh$/.test(script);
}

function hasUnsafePackageRunner(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0];
  if (!executable) return false;

  if (executable === "npm" && commandParts[1] === "exec") return true;
  if (executable === "bunx" || (executable === "bun" && commandParts[1] === "x")) return true;

  let runnerIndex = 1;
  if (executable === "pnpm" && ["-s", "--silent"].includes(commandParts[runnerIndex] ?? "")) {
    runnerIndex += 1;
  }
  if (executable === "pnpm" && commandParts[runnerIndex] === "dlx") return true;

  const wrapper =
    executable === "pnpm" && commandParts[runnerIndex] === "exec"
      ? commandParts[runnerIndex + 1]
      : executable === "uv" && commandParts[1] === "run"
        ? commandParts[2]
        : executable === "bundle" && commandParts[1] === "exec"
          ? commandParts[2]
          : executable === "composer" && commandParts[1] === "exec"
            ? commandParts[2]
            : "";
  if (!wrapper) return false;
  return !SAFE_WRAPPED_VALIDATION_EXECUTABLES.has(wrapper);
}

function hasMutatingValidationFlag(parts: readonly string[]) {
  const denied = new Set([
    "-u",
    "--fix",
    "--update",
    "--update-snapshot",
    "--update-snapshots",
    "--updateSnapshot",
    "--updateSnapshots",
    "--write",
  ]);
  return stripEnvPrefix(parts).some((part) => denied.has(part.split("=", 1)[0] ?? ""));
}

const SAFE_WRAPPED_VALIDATION_EXECUTABLES = new Set([
  "ava",
  "cargo",
  "c8",
  "eslint",
  "go",
  "jest",
  "mocha",
  "mypy",
  "node",
  "nyc",
  "php",
  "phpstan",
  "phpunit",
  "playwright",
  "prettier",
  "psalm",
  "python",
  "python3",
  "pytest",
  "rake",
  "rspec",
  "rubocop",
  "ruff",
  "ruby",
  "ts-node",
  "tsc",
  "tsx",
  "vitest",
]);

function splitValidationCommand(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        if (quote === '"' && character === "$") {
          const expansion = safeVariableExpansion(text.slice(index));
          if (expansion) {
            current += expansion;
            index += expansion.length - 1;
            continue;
          }
        }
        if (quote === '"' && (character === "`" || character === "$")) {
          throw new Error(`unsafe validation command: ${text}`);
        }
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    if (character === "$") {
      const expansion = safeVariableExpansion(text.slice(index));
      if (expansion) {
        current += expansion;
        index += expansion.length - 1;
        continue;
      }
    }
    if (/[`$;&|<>()[\]{}*?~]/.test(character)) {
      throw new Error(`unsafe validation command: ${text}`);
    }
    current += character;
  }
  if (escaping || quote) throw new Error(`unsafe validation command: ${text}`);
  if (current) parts.push(current);
  return parts;
}

function safeVariableExpansion(value: string) {
  return value.match(/^\$\{[A-Z_][A-Z0-9_]*(?::-[A-Za-z0-9_./:-]+)?\}/)?.[0] ?? "";
}

function isEnvAssignment(value: unknown) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(String(value ?? ""));
}

function normalizeEnvInvocation(parts: readonly string[]): string[] {
  if (parts[0] === "env" || !isEnvAssignment(parts[0])) return [...parts];
  return ["env", ...parts];
}
