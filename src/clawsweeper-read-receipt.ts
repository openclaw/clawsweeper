import { appendFileSync } from "node:fs";

// Standalone OpenClaw plugin (its file name is the plugin id) loaded only into
// the checkout-inspection agent. OpenClaw runs before_message_write for every
// transcript message before storing it, so the inspection gets the same
// { message } lines whether the release keeps sessions in JSONL files or in its
// database, and without the path redaction of trajectory exports.
interface ReadReceiptPluginApi {
  on(hook: "before_message_write", handler: (event: { message?: unknown }) => void): void;
}

export default {
  id: "clawsweeper-read-receipt",
  name: "ClawSweeper read receipt",
  description: "Records transcript messages for the ClawSweeper checkout inspection.",
  register(api: ReadReceiptPluginApi): void {
    const receiptPath = process.env.CLAWSWEEPER_OPENCLAW_RECEIPT_PATH;
    if (!receiptPath) return;
    // Synchronous on purpose: OpenClaw ignores promises from this hook.
    api.on("before_message_write", (event) => {
      appendFileSync(receiptPath, `${JSON.stringify({ message: event.message })}\n`, {
        mode: 0o600,
      });
    });
  },
};
