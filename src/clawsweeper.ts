import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./clawsweeper-runtime.js";
import { agentInputScanFailureExitCode } from "./agent-input-scan.js";
import { parseArgs } from "./clawsweeper-args.js";
import { isUserFacingCommandError } from "./command.js";
import { emitReviewFailureJson } from "./review-output-policy.js";

export * from "./clawsweeper-runtime.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const args = parseArgs(process.argv.slice(2));
    if ((args._[0] ?? "review") === "review" && emitReviewFailureJson(args, error)) {
      process.exit(agentInputScanFailureExitCode(error) ?? 1);
    }
    const message = isUserFacingCommandError(error)
      ? `Error: ${error.message}`
      : error instanceof Error
        ? error.stack || error.message
        : String(error);
    console.error(message);
    process.exit(agentInputScanFailureExitCode(error) ?? 1);
  });
}
