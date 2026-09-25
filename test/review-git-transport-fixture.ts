import childProcess from "node:child_process";
import type { TestContext } from "node:test";

// Acquisition policy tests inject transport outcomes; the command-runner tests
// exercise the real supervisor and its process/lock settlement separately.
export function mockReviewGitTransport(
  context: TestContext,
  implementation: (...args: any[]) => any,
) {
  context.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command !== process.execPath || !args?.[0]?.endsWith("/git-acquisition-worker.js"))
      return implementation(command, args, options);
    const input = JSON.parse(options.input);
    const result = implementation("git", input.args, {
      cwd: input.cwd,
      env: options.env,
      input: input.input,
      maxBuffer: input.maxBuffer,
      timeout: input.timeoutMs,
      killSignal: options.killSignal,
      encoding: "utf8",
    });
    return {
      status: 0,
      signal: null,
      stderr: "",
      stdout:
        JSON.stringify({ pid: null }) +
        "\n" +
        JSON.stringify({
          backgroundProcesses: 0,
          status: result.status,
          signal: result.signal ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          ...(result.error
            ? { error: { code: result.error.code, message: result.error.message } }
            : {}),
        }),
    };
  });
}
