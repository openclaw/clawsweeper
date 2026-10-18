#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, boolArg } from "./clawsweeper-args.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (boolArg(args.help)) {
    console.log(
      "Local ClawSweeper: [review] [--base <ref>] [--target-repo <owner/repo>] [--target-dir <path>] [--result-format json] [--preflight]",
    );
    console.log(
      "Review a clean committed range with the full ClawSweeper review engine. Diagnostics integration is deferred.",
    );
    return;
  }
  if (boolArg(args.version)) {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(metadata.version);
    return;
  }
  if (args._.length > 1 || (args._[0] && args._[0] !== "review")) {
    throw new Error("Expected the local review command. Use --help for usage.");
  }
  if (args.diagnostics !== undefined) {
    throw new Error("Diagnostics are not available in this entrypoint yet. Use --help for usage.");
  }
  const { localReviewCommand } = await import("./clawsweeper-local-composition.js");
  localReviewCommand({ ...args, local_range: true });
}

// npm's POSIX bin is a symlink; Node resolves the module but leaves argv[1]
// lexical. Compare real paths so the installed command actually runs.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const [
      { agentInputScanFailureExitCode },
      { emitReviewFailureJson },
      { isUserFacingCommandError },
    ] = await Promise.all([
      import("./agent-input-scan.js"),
      import("./review-output-policy.js"),
      import("./command.js"),
    ]);
    const args = parseArgs(process.argv.slice(2));
    if (emitReviewFailureJson(args, error)) {
      process.exitCode = agentInputScanFailureExitCode(error) ?? 1;
      return;
    }
    console.error(
      isUserFacingCommandError(error)
        ? `Error: ${error.message}`
        : error instanceof Error
          ? error.stack || error.message
          : String(error),
    );
    process.exitCode = agentInputScanFailureExitCode(error) ?? 1;
  });
}
