export type StaleEventPreflightResult = "remote-closed" | "remote-newer" | "missing";

export type StaleEventDisposition = {
  detail: string;
  requeueLatest: boolean;
  terminalClosed: boolean;
  terminalMissing: boolean;
};

// A stale publication artifact can never publish: the state already advanced,
// closed, or the event carried no tuple. Each case maps to a terminal workflow
// disposition — failing the run instead would requeue the same artifact forever.
export function staleEventDisposition(result: StaleEventPreflightResult): StaleEventDisposition {
  if (result === "remote-closed") {
    return {
      detail: "current state is already closed",
      requeueLatest: false,
      terminalClosed: true,
      terminalMissing: false,
    };
  }
  if (result === "remote-newer") {
    return {
      detail: "current state has a newer tuple",
      requeueLatest: true,
      terminalClosed: false,
      terminalMissing: false,
    };
  }
  return {
    detail: "the event produced no record tuple",
    requeueLatest: false,
    terminalClosed: false,
    terminalMissing: true,
  };
}

export function staleEventDispositionOutputLines(disposition: StaleEventDisposition): string[] {
  return [
    "remote_tuple_verified=false",
    `terminal_missing=${disposition.terminalMissing ? "true" : "false"}`,
    `terminal_closed=${disposition.terminalClosed ? "true" : "false"}`,
    "guarded_open=false",
    "guarded_open_action=",
    "policy_noop=false",
    `requeue_latest=${disposition.requeueLatest ? "true" : "false"}`,
    "routing_deferred=false",
  ];
}
