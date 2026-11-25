export type PrClassificationFailure =
  | "source-limit"
  | "source-drift"
  | "snapshot-drift"
  | "receipt-unavailable";

// A model-chosen tool argument the source policy refuses. The fixed message goes
// back to the model as tool output instead of failing classification: refused
// reads aborted 8 of 19 runs after the retry rollout, e.g.
// https://github.com/openclaw/openclaw/pull/205037 (one changed file, so the
// model most likely asked for an unlisted caller or test).
export class PrClassificationToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrClassificationToolInputError";
  }
}

export class PrClassificationError extends Error {
  constructor(
    readonly diagnostic: PrClassificationFailure,
    readonly retryable = false,
  ) {
    super("PR classification failed: " + diagnostic);
    this.name = "PrClassificationError";
  }
}
