export type PackageScriptRequirement = {
  command: string;
  name: string;
  packageManager: PackageManagerExecutable;
  workspaceAll: boolean;
  workspaceScoped: boolean;
  workspaceSelectors: string[];
};

type PackageManagerExecutable = "pnpm" | "npm" | "bun";

type PackageManagerInvocation = {
  executable: PackageManagerExecutable;
  command: string;
  commandIndex: number;
  args: string[];
  globalOptions: Array<{
    kind: "boolean" | "value";
    name: string;
    value: string | null;
  }>;
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
      "--fail-if-no-match",
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
      "--ws",
    ]),
    value: new Set(["-w", "--cache", "--loglevel", "--prefix", "--userconfig", "--workspace"]),
  },
  bun: {
    boolean: new Set(["--silent"]),
    value: new Set(["-C", "--cwd", "--filter"]),
  },
};

const PACKAGE_MANAGER_WORKSPACE_OPTIONS: Record<PackageManagerExecutable, ReadonlySet<string>> = {
  pnpm: new Set(["-F", "-r", "--filter", "--recursive"]),
  npm: new Set(["-w", "--workspace", "--workspaces", "--ws"]),
  bun: new Set(["--filter"]),
};

const UNSAFE_PACKAGE_MANAGER_PATH_OPTIONS: Record<PackageManagerExecutable, ReadonlySet<string>> = {
  pnpm: new Set(["-C", "--config-dir", "--dir", "--store-dir", "--virtual-store-dir"]),
  npm: new Set(["--cache", "--prefix", "--userconfig"]),
  bun: new Set(["-C", "--cwd"]),
};

const PACKAGE_COMMAND_ALIASES = new Map([
  ["c", "config"],
  ["cit", "install-ci-test"],
  ["i", "install"],
  ["in", "install"],
  ["ins", "install"],
  ["inst", "install"],
  ["insta", "install"],
  ["instal", "install"],
  ["isnt", "install"],
  ["isnta", "install"],
  ["isntal", "install"],
  ["isntall", "install"],
  ["ic", "clean-install"],
  ["install-clean", "clean-install"],
  ["isntall-clean", "clean-install"],
  ["it", "install-test"],
  ["ln", "link"],
  ["pub", "publish"],
  ["r", "remove"],
  ["rb", "rebuild"],
  ["rm", "remove"],
  ["rt", "runtime"],
  ["run-script", "run"],
  ["rum", "run"],
  ["t", "test"],
  ["un", "uninstall"],
  ["unlink", "uninstall"],
  ["up", "update"],
  ["upgrade", "update"],
  ["urn", "run"],
  ["x", "exec"],
]);

const PACKAGE_MANAGER_NON_SCRIPT_COMMANDS = new Set([
  "access",
  "add",
  "approve-builds",
  "audit",
  "bin",
  "cache",
  "cat-file",
  "cat-index",
  "ci",
  "clean",
  "clean-install",
  "completion",
  "config",
  "create",
  "dedupe",
  "deprecate",
  "deploy",
  "diff",
  "dist-tag",
  "dlx",
  "doctor",
  "env",
  "exec",
  "explore",
  "fetch",
  "find-hash",
  "find-dupes",
  "fund",
  "get",
  "help",
  "hook",
  "ignored-builds",
  "import",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "licenses",
  "list",
  "login",
  "logout",
  "ls",
  "npm",
  "org",
  "outdated",
  "owner",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "remove",
  "repo",
  "restart",
  "root",
  "runtime",
  "search",
  "set",
  "self-update",
  "setup",
  "shrinkwrap",
  "star",
  "stage",
  "start",
  "stop",
  "store",
  "team",
  "token",
  "uninstall",
  "unlink",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
  "why",
  "workspace",
  "workspaces",
]);

const MUTATING_PACKAGE_LIFECYCLE_SCRIPTS = new Set([
  "dependencies",
  "install",
  "pack",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postrestart",
  "poststart",
  "poststop",
  "posttest",
  "postuninstall",
  "postversion",
  "preinstall",
  "prepack",
  "preprepare",
  "prepare",
  "prepublish",
  "prepublishonly",
  "prerestart",
  "prestart",
  "prestop",
  "pretest",
  "preuninstall",
  "preversion",
  "publish",
  "restart",
  "start",
  "stop",
  "uninstall",
  "version",
]);

const UNSAFE_VALIDATION_ENV_NAMES = new Set([
  "APPDATA",
  "AR",
  "AS",
  "BASH_ENV",
  "BAZELRC",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_HOME",
  "CC",
  "CFLAGS",
  "CDPATH",
  "CMAKE_TOOLCHAIN_FILE",
  "CLASSPATH",
  "COMSPEC",
  "COREPACK_HOME",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_NPM_REGISTRY",
  "CPP",
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_SHARED_STORE",
  "DOTNET_STARTUP_HOOKS",
  "ENV",
  "FC",
  "FFLAGS",
  "GEM_HOME",
  "GEM_PATH",
  "GOENV",
  "GOFLAGS",
  "GOCACHEPROG",
  "GOROOT",
  "GOTOOLDIR",
  "GOTOOLCHAIN",
  "GOWORK",
  "GRADLE_OPTS",
  "HOME",
  "IFS",
  "JAVA_HOME",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LD",
  "LDFLAGS",
  "LOCALAPPDATA",
  "MAKEFLAGS",
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "MFLAGS",
  "NM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OBJCOPY",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PERL5OPT",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PKG_CONFIG",
  "PNPM_HOME",
  "PYTEST_ADDOPTS",
  "PYTEST_PLUGINS",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RANLIB",
  "RUBYLIB",
  "RUBYOPT",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "RUSTUP_HOME",
  "SHELL",
  "STRIP",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "_JAVA_OPTIONS",
]);

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
  const command = normalizedPackageCommand(invocation.command);
  const usesRunCommand = command === "run";
  const runInvocation = usesRunCommand ? packageRunInvocation(invocation) : null;
  const script = usesRunCommand
    ? runInvocation?.script
    : implicitPackageScriptName(invocation, command);
  const supportsPackageScript =
    usesRunCommand ||
    invocation.executable === "pnpm" ||
    (invocation.executable === "npm" && command === "test");
  if (
    !script ||
    !supportsPackageScript ||
    (!usesRunCommand && PACKAGE_MANAGER_NON_SCRIPT_COMMANDS.has(script))
  ) {
    return null;
  }
  const scriptIndex = usesRunCommand
    ? invocation.commandIndex + 1 + runInvocation!.scriptArgIndex
    : invocation.commandIndex;
  const workspaceOptions = [
    ...invocation.globalOptions,
    ...(runInvocation?.workspaceOptions ?? []),
    ...(invocation.executable === "npm" && command === "test"
      ? npmWorkspaceOptions(invocation.args)
      : []),
  ].filter((option) => PACKAGE_MANAGER_WORKSPACE_OPTIONS[invocation.executable].has(option.name));
  const workspaceSelectors = workspaceOptions.flatMap((option) =>
    option.kind === "value" && option.value !== null ? [option.value] : [],
  );
  const workspaceAll = lastPackageBooleanOptionEnabled(workspaceOptions);
  return {
    name: script,
    command: commandParts.slice(0, scriptIndex + 1).join(" "),
    packageManager: invocation.executable,
    workspaceAll,
    workspaceScoped: workspaceAll || workspaceSelectors.length > 0,
    workspaceSelectors,
  };
}

function lastPackageBooleanOptionEnabled(
  options: ReadonlyArray<PackageManagerInvocation["globalOptions"][number]>,
) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    const option = options[index]!;
    if (option.kind === "boolean") return packageBooleanOptionEnabled(option.value);
  }
  return false;
}

export function packageManagerCommandIndex(parts: readonly string[]): number | null {
  return packageManagerInvocation(parts)?.commandIndex ?? null;
}

export function packageManagerWorkspaceScoped(parts: readonly string[]) {
  const invocation = packageManagerInvocation(parts);
  if (!invocation) return false;
  const runOptions =
    normalizedPackageCommand(invocation.command) === "run"
      ? (packageRunInvocation(invocation)?.workspaceOptions ?? [])
      : [];
  return [...invocation.globalOptions, ...runOptions].some((option) =>
    PACKAGE_MANAGER_WORKSPACE_OPTIONS[invocation.executable].has(option.name),
  );
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
    hasUnsafeValidationEnvironment(normalized) ||
    hasUnsupportedPackageManagerInvocation(normalized) ||
    hasNoopPackageScriptOption(normalized) ||
    hasUncontainedPackageLifecycleHooks(normalized) ||
    hasUnsafePackageManagerPathOption(normalized) ||
    hasUnsafePackageRunner(normalized) ||
    hasInlineInterpreterCode(normalized) ||
    hasMutatingValidationFlag(normalized) ||
    hasMutatingValidationCommand(normalized)
  ) {
    throw new Error(`unsafe validation command: ${displayCommand}`);
  }
  return normalized;
}

export function validationCommandForExecution(parts: readonly string[]): string[] {
  const guardedParts = requireWorkspaceMatchFailure(parts);
  const commandParts = stripEnvPrefix(guardedParts);
  const invocation = packageManagerInvocation(commandParts);
  if (!invocation || !packageScriptRequirement(commandParts)) return guardedParts;
  const envPrefix = guardedParts.slice(0, guardedParts.length - commandParts.length);
  if (invocation.executable === "npm") {
    const ignoreScripts = npmIgnoreScriptsMode(guardedParts);
    if (ignoreScripts === "disabled") {
      throw new Error("unsafe validation command: npm lifecycle suppression is overridden");
    }
    if (ignoreScripts === "enabled") return guardedParts;
    return [...envPrefix, "npm", "--ignore-scripts", ...commandParts.slice(1)];
  }
  if (invocation.executable === "pnpm") {
    return [
      ...envPrefix,
      "pnpm",
      "--config.enable-pre-post-scripts=false",
      ...commandParts.slice(1),
    ];
  }
  return guardedParts;
}

export function requireWorkspaceMatchFailure(parts: readonly string[]): string[] {
  const commandParts = stripEnvPrefix(parts);
  const invocation = packageManagerInvocation(commandParts);
  const runWorkspaceOptions =
    invocation && normalizedPackageCommand(invocation.command) === "run"
      ? (packageRunInvocation(invocation)?.workspaceOptions ?? [])
      : [];
  if (
    invocation?.executable !== "pnpm" ||
    ![...invocation.globalOptions, ...runWorkspaceOptions].some(
      (option) => option.name === "-F" || option.name === "--filter",
    )
  ) {
    return [...parts];
  }
  const envPrefixLength = parts.length - commandParts.length;
  const commandIndex = envPrefixLength + invocation.commandIndex;
  const globalOptions = parts
    .slice(envPrefixLength + 1, commandIndex)
    .filter((token) => token.split("=", 1)[0] !== "--fail-if-no-match");
  return [
    ...parts.slice(0, envPrefixLength + 1),
    "--fail-if-no-match",
    ...globalOptions,
    ...parts.slice(commandIndex),
  ];
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

function packageManagerInvocation(parts: readonly string[]): PackageManagerInvocation | null {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0];
  if (executable !== "pnpm" && executable !== "npm" && executable !== "bun") return null;
  const allowed = PACKAGE_MANAGER_GLOBAL_OPTIONS[executable];
  const globalOptions: PackageManagerInvocation["globalOptions"] = [];
  let index = 1;
  while (index < commandParts.length && commandParts[index]?.startsWith("-")) {
    const token = commandParts[index]!;
    const option = token.split("=", 1)[0]!;
    if (allowed.boolean.has(option)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
      if (value !== null && !isPackageBooleanOptionValue(value)) return null;
      globalOptions.push({
        kind: "boolean",
        name: option,
        value,
      });
      index += 1;
      continue;
    }
    if (allowed.value.has(option)) {
      if (token.includes("=")) {
        const value = token.slice(token.indexOf("=") + 1);
        if (!value) return null;
        globalOptions.push({ kind: "value", name: option, value });
        index += 1;
        continue;
      }
      const value = commandParts[index + 1];
      if (!value || value.startsWith("-")) return null;
      globalOptions.push({ kind: "value", name: option, value });
      index += 2;
      continue;
    }
    if (executable === "pnpm" && option.startsWith("--config.") && token.includes("=")) {
      globalOptions.push({
        kind: "value",
        name: option,
        value: token.slice(token.indexOf("=") + 1),
      });
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
    globalOptions,
  };
}

function packageRunInvocation(invocation: PackageManagerInvocation): {
  script: string;
  scriptArgIndex: number;
  workspaceOptions: PackageManagerInvocation["globalOptions"];
} | null {
  if (normalizedPackageCommand(invocation.command) !== "run") return null;
  const workspaceOptions: PackageManagerInvocation["globalOptions"] = [];
  let scriptArgIndex = 0;
  while (scriptArgIndex < invocation.args.length) {
    const token = invocation.args[scriptArgIndex]!;
    if (token === "--") return null;
    if (!token.startsWith("-")) break;
    const parsed = packageRunWorkspaceOption(invocation, scriptArgIndex);
    if (!parsed) return null;
    workspaceOptions.push(parsed.option);
    scriptArgIndex += parsed.consumed;
  }
  const script = invocation.args[scriptArgIndex];
  if (!script || script.startsWith("-")) return null;

  if (invocation.executable !== "npm") {
    return { script, scriptArgIndex, workspaceOptions };
  }
  workspaceOptions.push(...npmWorkspaceOptions(invocation.args.slice(scriptArgIndex + 1)));
  return { script, scriptArgIndex, workspaceOptions };
}

function npmWorkspaceOptions(args: readonly string[]) {
  const workspaceOptions: PackageManagerInvocation["globalOptions"] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    const name = token.split("=", 1)[0]!;
    if (name === "--workspaces" || name === "--ws") {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
      if (value === null || isPackageBooleanOptionValue(value)) {
        workspaceOptions.push({ kind: "boolean", name, value });
      }
      continue;
    }
    if (name !== "-w" && name !== "--workspace") continue;
    if (token.includes("=")) {
      const value = token.slice(token.indexOf("=") + 1);
      if (value) workspaceOptions.push({ kind: "value", name, value });
      continue;
    }
    const value = args[index + 1];
    if (value && value !== "--" && !value.startsWith("-")) {
      workspaceOptions.push({ kind: "value", name, value });
      index += 1;
    }
  }
  return workspaceOptions;
}

function packageRunWorkspaceOption(invocation: PackageManagerInvocation, index: number) {
  const token = invocation.args[index]!;
  const name = token.split("=", 1)[0]!;
  const allowed = PACKAGE_MANAGER_WORKSPACE_OPTIONS[invocation.executable];
  if (!allowed.has(name)) return null;
  if (name === "-r" || name === "--recursive" || name === "--workspaces" || name === "--ws") {
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
    if (value !== null && !isPackageBooleanOptionValue(value)) return null;
    return {
      consumed: 1,
      option: { kind: "boolean" as const, name, value },
    };
  }
  if (token.includes("=")) {
    const value = token.slice(token.indexOf("=") + 1);
    if (!value) return null;
    return {
      consumed: 1,
      option: { kind: "value" as const, name, value },
    };
  }
  const value = invocation.args[index + 1];
  if (!value || value === "--" || value.startsWith("-")) return null;
  return {
    consumed: 2,
    option: { kind: "value" as const, name, value },
  };
}

function isPackageBooleanOptionValue(value: string) {
  return /^(?:0|1|false|no|off|on|true|yes)$/i.test(value);
}

function packageBooleanOptionEnabled(value: string | null) {
  return value === null || /^(?:1|on|true|yes)$/i.test(value);
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
    node: [
      "-e",
      "--eval",
      "-p",
      "--print",
      "-r",
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
    ],
    bun: ["-e", "--eval", "-p", "--print", "-r", "--preload", "--require", "--import", "--loader"],
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
  const invocation = packageManagerInvocation(commandParts);
  const packageCommand = invocation ? normalizedPackageCommand(invocation.command) : "";

  if (invocation?.executable === "npm" && packageCommand === "exec") return true;
  if (executable === "bunx" || (invocation?.executable === "bun" && packageCommand === "exec")) {
    return true;
  }
  if (invocation?.executable === "pnpm" && packageCommand === "dlx") return true;

  const wrapper =
    invocation?.executable === "pnpm" && packageCommand === "exec"
      ? invocation.args[0]
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
  if (!["pnpm", "npm", "bun"].includes(executable ?? "")) return false;
  const invocation = packageManagerInvocation(parts);
  if (!invocation) return true;
  const command = normalizedPackageCommand(invocation.command);
  if (command === "run") {
    const script = packageRunInvocation(invocation)?.script;
    return !script || script.startsWith("-") || MUTATING_PACKAGE_LIFECYCLE_SCRIPTS.has(script);
  }
  if (invocation.executable === "pnpm" && command === "exec") return false;
  if (invocation.executable === "npm") return command !== "test";
  if (invocation.executable === "bun") return command !== "test";
  return (
    PACKAGE_MANAGER_NON_SCRIPT_COMMANDS.has(command) ||
    MUTATING_PACKAGE_LIFECYCLE_SCRIPTS.has(command)
  );
}

function hasNoopPackageScriptOption(parts: readonly string[]) {
  if (packageScriptRequirement(parts) === null) return false;
  const commandParts = stripEnvPrefix(parts);
  const separatorIndex = commandParts.indexOf("--");
  const packageManagerParts =
    separatorIndex >= 0 ? commandParts.slice(1, separatorIndex) : commandParts.slice(1);
  return packageManagerParts.some((token) => {
    if (token.split("=", 1)[0] !== "--if-present") return false;
    if (!token.includes("=")) return true;
    const value = token.slice(token.indexOf("=") + 1);
    return !isPackageBooleanOptionValue(value) || packageBooleanOptionEnabled(value);
  });
}

function hasUncontainedPackageLifecycleHooks(parts: readonly string[]) {
  const invocation = packageManagerInvocation(parts);
  if (!invocation || packageScriptRequirement(parts) === null) return false;
  return invocation.executable === "npm" && npmIgnoreScriptsMode(parts) === "disabled";
}

function hasUnsafePackageManagerPathOption(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0];
  if (executable !== "pnpm" && executable !== "npm" && executable !== "bun") return false;
  const denied = UNSAFE_PACKAGE_MANAGER_PATH_OPTIONS[executable];
  for (const token of commandParts.slice(1)) {
    if (token === "--") break;
    const option = token.split("=", 1)[0]!;
    if (denied.has(option)) return true;
    if (executable === "pnpm" && option.startsWith("--config.")) return true;
  }
  return false;
}

function hasUnsafeValidationEnvironment(parts: readonly string[]) {
  let index = parts[0] === "env" ? 1 : 0;
  while (index < parts.length && isEnvAssignment(parts[index])) {
    const assignment = String(parts[index]);
    const name = assignment.slice(0, assignment.indexOf("="));
    const value = assignment.slice(assignment.indexOf("=") + 1);
    if (
      isUnsafeValidationEnvironmentName(name) &&
      !(value === "" && isSensitiveValidationEnvironmentName(name))
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

export function isUnsafeValidationEnvironmentName(name: string) {
  const normalized = String(name).toUpperCase();
  return (
    UNSAFE_VALIDATION_ENV_NAMES.has(normalized) ||
    isSensitiveValidationEnvironmentName(normalized) ||
    normalized.startsWith("DYLD_") ||
    normalized.startsWith("GIT_") ||
    normalized.startsWith("LD_") ||
    normalized.startsWith("NPM_CONFIG_") ||
    normalized.startsWith("PNPM_CONFIG_") ||
    /^CARGO_TARGET_.+_RUNNER$/.test(normalized)
  );
}

function isSensitiveValidationEnvironmentName(name: string) {
  return /(?:^|_)(?:API_KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_KEY|PROXY|SECRET|TOKEN)(?:_|$)/.test(
    String(name).toUpperCase(),
  );
}

function hasMutatingValidationFlag(parts: readonly string[]) {
  const denied = new Set([
    "--fix",
    "--fix-only",
    "--apply",
    "--apply-unsafe",
    "--unsafe-fixes",
    "--update",
    "--update-snapshot",
    "--update-snapshots",
    "--updateSnapshot",
    "--updateSnapshots",
    "--write",
  ]);
  const commandParts = stripEnvPrefix(parts);
  if (commandParts.some((part) => denied.has(part.split("=", 1)[0] ?? ""))) return true;
  const executable = commandParts[0] ?? "";
  const invocation = packageManagerInvocation(commandParts);
  if (
    invocation?.executable === "pnpm" &&
    normalizedPackageCommand(invocation.command) === "exec"
  ) {
    return hasMutatingValidationFlag(commandParts.slice(invocation.commandIndex + 1));
  }
  if (
    (executable === "uv" && commandParts[1] === "run") ||
    (["bundle", "composer"].includes(executable) && commandParts[1] === "exec")
  ) {
    return hasMutatingValidationFlag(commandParts.slice(2));
  }
  if (executable === "prettier" && commandParts.slice(1).some((part) => /^-[^-]*w/.test(part))) {
    return true;
  }
  return hasSnapshotUpdateShortFlag(commandParts);
}

function hasSnapshotUpdateShortFlag(parts: readonly string[]): boolean {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0] ?? "";
  const invocation = packageManagerInvocation(commandParts);
  if (
    invocation?.executable === "pnpm" &&
    normalizedPackageCommand(invocation.command) === "exec"
  ) {
    return hasSnapshotUpdateShortFlag(commandParts.slice(invocation.commandIndex + 1));
  }
  if (
    (executable === "uv" && commandParts[1] === "run") ||
    (["bundle", "composer"].includes(executable) && commandParts[1] === "exec")
  ) {
    return hasSnapshotUpdateShortFlag(commandParts.slice(2));
  }

  const shortUpdateIndexes = commandParts
    .map((part, index) => ({ index, option: part.split("=", 1)[0] ?? "" }))
    .filter(({ index, option }) => index > 0 && option === "-u")
    .map(({ index }) => index);
  if (shortUpdateIndexes.length === 0) return false;
  if (invocation) {
    if (
      invocation.executable === "bun" &&
      normalizedPackageCommand(invocation.command) === "test"
    ) {
      return true;
    }
    const script = packageScriptRequirement(commandParts)?.name ?? "";
    return /^(?:jest|vitest|test(?::|$)|[^:]+:(?:jest|snapshot|spec|test)(?::|$))/i.test(script);
  }
  return executable === "ava" || executable === "jest" || executable === "vitest";
}

function hasMutatingValidationCommand(parts: readonly string[]): boolean {
  const commandParts = stripEnvPrefix(parts);
  const executable = commandParts[0] ?? "";
  const invocation = packageManagerInvocation(commandParts);
  const subcommand = invocation
    ? normalizedPackageCommand(invocation.command)
    : (commandParts[1] ?? "");
  const packageScript = packageScriptRequirement(commandParts)?.name ?? "";
  const wrappedCommandStart =
    invocation?.executable === "pnpm" && subcommand === "exec"
      ? invocation.commandIndex + 1
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
    !/^(?:format|fmt):(?:check|verify)$/.test(packageScript) &&
    /^(?:format|fmt|fix|write|update)(?::|$)|(?::)(?:fix|write|update)$/.test(packageScript)
  ) {
    return true;
  }
  if (executable === "git") {
    if (subcommand === "fsck" && commandParts.includes("--lost-found")) return true;
    return !["diff", "fsck", "status"].includes(subcommand);
  }
  if (executable === "go") {
    if (subcommand === "env") {
      return commandParts
        .slice(2)
        .some(
          (arg) => arg === "-w" || arg.startsWith("-w=") || arg === "-u" || arg.startsWith("-u="),
        );
    }
    if (subcommand === "mod") return !["graph", "verify", "why"].includes(commandParts[2] ?? "");
    return ["clean", "fmt", "generate", "get", "install", "work"].includes(subcommand);
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
  if (executable === "make") {
    const targets = commandParts
      .slice(1)
      .filter((part) => !part.startsWith("-") && !part.includes("="));
    return (
      targets.length === 0 ||
      targets.some(
        (target) =>
          !/^(?:all|analy[sz]e|assemble|build|check|compile|fmt|format|lint|test|typecheck|verify|vet)(?::|[-_].*)?$/.test(
            target,
          ),
      )
    );
  }
  if (executable === "mvn" || executable === "./mvnw") {
    const goals = commandParts.slice(1).filter((part) => !part.startsWith("-"));
    return (
      goals.length === 0 ||
      goals.some(
        (goal) =>
          !/^(?:clean|compile|package|test|test-compile|validate|verify|(?:[^:]+:)?(?:check|lint|test|verify))$/.test(
            goal,
          ),
      )
    );
  }
  if (executable === "gradle" || executable === "./gradlew") {
    const tasks = commandParts.slice(1).filter((part) => !part.startsWith("-"));
    return (
      tasks.length === 0 ||
      tasks.some(
        (task) =>
          !/^(?:analy[sz]e|assemble|build|check|compile\w*|lint\w*|test\w*|verify\w*)$/i.test(
            task.split(":").at(-1) ?? "",
          ),
      )
    );
  }
  if (executable === "dotnet") {
    if (!["build", "format", "test"].includes(subcommand)) return true;
    return subcommand === "format" && !commandParts.includes("--verify-no-changes");
  }
  if (executable === "ansible-playbook") return !commandParts.includes("--syntax-check");
  if (executable === "composer")
    return !["audit", "check-platform-reqs", "validate"].includes(subcommand);
  if (executable === "bundle") return subcommand !== "check";
  if (executable === "xcodebuild") {
    return commandParts.some((part) => ["archive", "-exportArchive"].includes(part));
  }
  return false;
}

function npmIgnoreScriptsMode(parts: readonly string[]): "enabled" | "disabled" | null {
  const commandParts = stripEnvPrefix(parts);
  if (commandParts[0] !== "npm") return null;
  let enabled = false;
  for (const token of commandParts.slice(1)) {
    if (token === "--") break;
    const option = token.split("=", 1)[0] ?? "";
    if (isAbbreviatedNpmLifecycleOption(option)) {
      return "disabled";
    }
    if (option === "--ignore-scripts") {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
      if (value !== null && !packageBooleanOptionEnabled(value)) return "disabled";
      enabled = true;
      continue;
    }
    if (option === "--foreground-scripts") {
      return "disabled";
    }
  }
  return enabled ? "enabled" : null;
}

function isAbbreviatedNpmLifecycleOption(option: string) {
  return (
    option.startsWith("--") &&
    option !== "--ignore-scripts" &&
    option !== "--foreground-scripts" &&
    ["--ignore-scripts", "--no-ignore-scripts", "--foreground-scripts"].some((name) =>
      name.startsWith(option),
    )
  );
}

function normalizedPackageCommand(command: string): string {
  return PACKAGE_COMMAND_ALIASES.get(command) ?? command;
}

function implicitPackageScriptName(
  invocation: PackageManagerInvocation,
  normalizedCommand: string,
) {
  if (invocation.executable === "npm" && normalizedCommand === "test") return "test";
  if (
    invocation.executable === "pnpm" &&
    !PACKAGE_COMMAND_ALIASES.has(invocation.command.toLowerCase())
  ) {
    return invocation.command;
  }
  return normalizedCommand;
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
