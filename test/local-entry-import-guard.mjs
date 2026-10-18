import { registerHooks } from "node:module";

const forbidden = [
  "clawsweeper-runtime.js",
  "clawsweeper-review-runtime.js",
  "clawsweeper-review-command-workflow.js",
  "clawsweeper-status-context.js",
  "clawsweeper-apply-decision-workflow.js",
  "repair/command-runner.js",
  "action-ledger.js",
  "action-ledger-runtime.js",
  "clawsweeper-review-ledger.js",
  "clawsweeper-apply-ledger.js",
  "clawsweeper-plan-command.js",
  "clawsweeper-action-commands.js",
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (forbidden.some((path) => result.url.endsWith("/" + path))) {
      throw new Error("Hosted module entered local closure: " + result.url);
    }
    return result;
  },
});
