import { installReplayClock } from "./replay-clock.mjs";

// Loaded only through the replay's explicit node --import argument. The child
// process is isolated; its native timers/performance remain real. Parent and
// browser clocks are untouched, and process teardown disposes this clock too.
const at = process.env.CLAWSWEEPER_PROOF_EVALUATION_AT;
if (!at) throw new Error("Explicit CLAWSWEEPER_PROOF_EVALUATION_AT is required");
const restore = installReplayClock(at);
process.once("exit", restore);
