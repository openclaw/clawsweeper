export type PackageScriptRequirement = {
  command: string;
  name: string;
};

type PackageManagerExecutable = "pnpm" | "npm" | "bun";

export type PackageManagerInvocation = {
  executable: PackageManagerExecutable;
  command: string;
  commandIndex: number;
  args: string[];
};

const PACKAGE_MANAGER_GLOBAL_OPTIONS: Record<
  PackageManagerExecutable,
  { boolean: ReadonlySet<string>; value: ReadonlySet<string> }
> = {
  pnpm: {
    boolean: new Set([
      "-r",
      "-s",
      "-w",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--offline",
      "--prefer-offline",
      "--recursive",
      "--silent",
      "--workspace-root",
    ]),
    value: new Set([
      "-C",
      "-F",
      "--config-dir",
      "--dir",
      "--filter",
      "--loglevel",
      "--network-concurrency",
      "--reporter",
      "--store-dir",
      "--virtual-store-dir",
      "--workspace-concurrency",
    ]),
  },
  npm: {
    boolean: new Set([
      "-s",
      "--foreground-scripts",
      "--if-present",
      "--ignore-scripts",
      "--silent",
      "--workspaces",
    ]),
    value: new Set(["-w", "--cache", "--loglevel", "--prefix", "--userconfig", "--workspace"]),
  },
  bun: {
    boolean: new Set(["--silent"]),
    value: new Set(["-C", "--cwd", "--filter"]),
  },
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
  const invocation = packageManagerInvocation(commandParts);
  if (!invocation) return null;
  const usesRunCommand = invocation.command === "run";
  if (invocation.executable !== "pnpm" && !usesRunCommand) return null;
  const script = usesRunCommand ? invocation.args[0] : invocation.command;
  if (!script || ["exec", "dlx", "install", "add", "remove"].includes(script)) return null;
  const scriptIndex = usesRunCommand ? invocation.commandIndex + 1 : invocation.commandIndex;
  return {
    name: script,
    command: commandParts.slice(0, scriptIndex + 1).join(" "),
  };
}

export function packageScriptArguments(parts: readonly string[]): string[] {
  const invocation = packageManagerInvocation(parts);
  const requirement = packageScriptRequirement(parts);
  if (!invocation || !requirement) return [];
  const args = invocation.command === "run" ? invocation.args.slice(1) : invocation.args;
  return args[0] === "--" ? args.slice(1) : args;
}

export function packageManagerInvocation(
  parts: readonly string[],
): PackageManagerInvocation | null {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0];
  if (executable !== "pnpm" && executable !== "npm" && executable !== "bun") return null;
  const options = PACKAGE_MANAGER_GLOBAL_OPTIONS[executable];
  let index = 1;
  while (index < commandParts.length && commandParts[index]?.startsWith("-")) {
    const token = commandParts[index]!;
    const option = token.split("=", 1)[0]!;
    if (options.boolean.has(option)) {
      index += 1;
      continue;
    }
    if (options.value.has(option)) {
      if (token.includes("=")) {
        index += 1;
        continue;
      }
      if (!commandParts[index + 1] || commandParts[index + 1]!.startsWith("-")) return null;
      index += 2;
      continue;
    }
    if (executable === "pnpm" && option.startsWith("--config.") && token.includes("=")) {
      index += 1;
      continue;
    }
    return null;
  }
  const command = commandParts[index];
  if (!command) return null;
  return {
    executable,
    command,
    commandIndex: index,
    args: commandParts.slice(index + 1),
  };
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
  return validateAllowedValidationCommandParts(parts, text);
}

export function validateAllowedValidationCommandParts(
  parts: readonly string[],
  displayCommand = "resolved validation command",
): string[] {
  const normalized = normalizeEnvInvocation(parts);
  if (normalized.length === 0) throw new Error("empty validation command");
  const executable = validationExecutable(normalized);
  if (!executable || !isAllowedValidationExecutable(executable, normalized)) {
    throw new Error(`unsupported validation command: ${displayCommand}`);
  }
  if (
    hasUnsupportedPackageManagerInvocation(normalized) ||
    hasUnsafePackageRunner(normalized) ||
    hasInlineInterpreterCode(normalized) ||
    hasMutatingValidationFlag(normalized) ||
    hasMutatingValidationCommand(normalized)
  ) {
    throw new Error(`unsafe validation command: ${displayCommand}`);
  }
  return normalized;
}

export function resolveValidationCommandEnvironment(
  parts: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  const resolved = [...parts];
  let index = resolved[0] === "env" ? 1 : 0;
  while (index < resolved.length && isEnvAssignment(resolved[index])) {
    const assignment = resolved[index]!;
    const separator = assignment.indexOf("=");
    const name = assignment.slice(0, separator);
    const value = resolveSafeVariableExpansions(assignment.slice(separator + 1), resolvedEnv);
    resolved[index] = `${name}=${value}`;
    resolvedEnv[name] = value;
    index += 1;
  }
  for (; index < resolved.length; index += 1) {
    resolved[index] = resolveSafeVariableExpansions(resolved[index]!, resolvedEnv);
  }
  return resolved;
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
  const packageInvocation = packageManagerInvocation(commandParts);

  if (packageInvocation?.executable === "npm" && packageInvocation.command === "exec") return true;
  if (
    executable === "bunx" ||
    (packageInvocation?.executable === "bun" && packageInvocation.command === "x")
  ) {
    return true;
  }
  if (packageInvocation?.executable === "pnpm" && packageInvocation.command === "dlx") return true;

  const wrapper =
    packageInvocation?.executable === "pnpm" && packageInvocation.command === "exec"
      ? packageInvocation.args[0]
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

function hasUnsupportedPackageManagerInvocation(parts: readonly string[]) {
  const executable = stripEnvPrefix(parts)[0];
  return (
    ["pnpm", "npm", "bun"].includes(executable ?? "") && packageManagerInvocation(parts) === null
  );
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

function hasMutatingValidationCommand(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0] ?? "";
  const packageInvocation = packageManagerInvocation(commandParts);
  const subcommand = packageInvocation?.command ?? commandParts[1] ?? "";
  const packageScript = packageScriptRequirement(commandParts)?.name ?? "";
  const wrappedCommandStart =
    packageInvocation?.executable === "pnpm" && packageInvocation.command === "exec"
      ? packageInvocation.commandIndex + 1
      : executable === "uv" && subcommand === "run"
        ? 2
        : ["bundle", "composer"].includes(executable) && subcommand === "exec"
          ? 2
          : -1;
  if (wrappedCommandStart >= 0) {
    return hasMutatingValidationCommand(commandParts.slice(wrappedCommandStart));
  }

  if (
    packageScript &&
    /^(?:format|fmt|fix|write|update)(?::|$)|(?::)(?:fix|write|update)$/.test(packageScript)
  ) {
    return true;
  }
  if (executable === "git") {
    if (subcommand === "fsck" && commandParts.includes("--lost-found")) return true;
    return !["diff", "fsck", "status"].includes(subcommand);
  }
  if (["pnpm", "npm", "bun"].includes(executable)) {
    return [
      "add",
      "ci",
      "clean-install",
      "install",
      "link",
      "prune",
      "publish",
      "rebuild",
      "remove",
      "uninstall",
      "unlink",
      "update",
    ].includes(subcommand);
  }
  if (executable === "go") {
    if (subcommand === "env") {
      return commandParts
        .slice(2)
        .some(
          (arg) => arg === "-w" || arg.startsWith("-w=") || arg === "-u" || arg.startsWith("-u="),
        );
    }
    return ["clean", "fmt", "generate", "get", "install", "mod", "work"].includes(subcommand);
  }
  if (executable === "cargo") {
    if (subcommand === "fmt") return !commandParts.includes("--check");
    return [
      "add",
      "clean",
      "fix",
      "install",
      "login",
      "owner",
      "publish",
      "remove",
      "uninstall",
      "update",
      "yank",
    ].includes(subcommand);
  }
  if (executable === "ruff" && subcommand === "format") {
    return !commandParts.includes("--check");
  }
  return false;
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

function resolveSafeVariableExpansions(value: string, env: NodeJS.ProcessEnv) {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([A-Za-z0-9_./:-]+))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const current = env[name];
      return current ? current : (fallback ?? "");
    },
  );
}

function isEnvAssignment(value: unknown) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(String(value ?? ""));
}

function normalizeEnvInvocation(parts: readonly string[]): string[] {
  if (parts[0] === "env" || !isEnvAssignment(parts[0])) return [...parts];
  return ["env", ...parts];
}
