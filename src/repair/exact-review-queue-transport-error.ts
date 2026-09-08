export type TransportFailureReason = "network_error" | "timeout" | `HTTP_${number}`;

export class ExactReviewBatchQueueTransportError extends Error {
  constructor(
    readonly reason: TransportFailureReason,
    message: string,
  ) {
    super(message);
  }
}
