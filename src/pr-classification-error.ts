export type PrClassificationFailure =
  | "source-limit"
  | "source-drift"
  | "snapshot-drift"
  | "receipt-unavailable";

export class PrClassificationError extends Error {
  constructor(
    readonly diagnostic: PrClassificationFailure,
    readonly retryable = false,
  ) {
    super("PR classification failed: " + diagnostic);
    this.name = "PrClassificationError";
  }
}
