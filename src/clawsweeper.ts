import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./clawsweeper-runtime.js";
import { isUserFacingCommandError } from "./command.js";

export * from "./clawsweeper-runtime.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = isUserFacingCommandError(error)
      ? `Error: ${error.message}`
      : error instanceof Error
        ? error.stack || error.message
        : String(error);
    console.error(message);
    process.exit(1);
  });
}
