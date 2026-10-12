import readline from "node:readline";

const fields = [
  "delivery_id",
  "source_event",
  "repository",
  "item_number",
  "outcome",
  "hook_status",
  "attempts",
  "duration_ms",
];
const lines = readline.createInterface({ input: process.stdin });
let buffer = "";
for await (const line of lines) {
  if (!buffer && !line.trimStart().startsWith("{")) continue;
  buffer += `${line}\n`;
  if (buffer.length > 1_048_576) {
    buffer = "";
    continue;
  }
  let invocation;
  try {
    invocation = JSON.parse(buffer);
  } catch {
    continue;
  }
  buffer = "";
  if (!Array.isArray(invocation?.logs)) continue;
  for (const log of invocation.logs) {
    if (!Array.isArray(log?.message)) continue;
    for (const message of log.message) {
      if (typeof message !== "string") continue;
      let outcome;
      try {
        outcome = JSON.parse(message);
      } catch {
        continue;
      }
      if (outcome?.event !== "github_activity_hook") continue;
      if (
        !["filtered", "delivered", "admitted", "suppressed", "not-requested", "failed"].includes(
          outcome.outcome,
        )
      )
        continue;
      const redacted = Object.fromEntries(
        fields.flatMap((field) => {
          const value = outcome[field];
          return value === null || typeof value === "string" || typeof value === "number"
            ? [[field, value]]
            : [];
        }),
      );
      process.stdout.write(`${JSON.stringify(redacted)}\n`);
    }
  }
}
