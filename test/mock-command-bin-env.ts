export function mockCommandBinEnv(command: string, commandPath: string): NodeJS.ProcessEnv {
  const key = command.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  // Strip V8 coverage before Node starts the synthetic CLI. Its caller may
  // time out while Node is flushing a profile, including during raw receipt reads.
  const launcher =
    process.platform === "win32"
      ? { file: process.execPath, args: [commandPath] }
      : { file: "/usr/bin/env", args: ["-u", "NODE_V8_COVERAGE", process.execPath, commandPath] };
  return {
    [`${key}_BIN`]: launcher.file,
    [`${key}_BIN_ARGS`]: JSON.stringify(launcher.args),
  };
}
