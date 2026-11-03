// Test/proof-only wall clock. No timer, performance, hrtime, browser or socket
// API is replaced. Use only around the in-process local Worker (no sockets), or
// in an isolated Astro build child. Never leave it installed around Playwright.
export function installReplayClock(evaluationAt) {
  const at = typeof evaluationAt === "number" ? evaluationAt : Date.parse(evaluationAt);
  if (!Number.isFinite(at)) throw new Error("A valid explicit replay evaluation time is required");
  const RealDate = globalThis.Date;
  function ReplayDate(...args) {
    if (!new.target) return new RealDate(at).toString();
    return Reflect.construct(RealDate, args.length ? args : [at], new.target);
  }
  Object.setPrototypeOf(ReplayDate, RealDate);
  ReplayDate.prototype = RealDate.prototype;
  Object.defineProperty(ReplayDate, "now", { value: () => at });
  globalThis.Date = ReplayDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

export async function withReplayClock(evaluationAt, operation) {
  const restore = installReplayClock(evaluationAt);
  try {
    return await operation();
  } finally {
    restore();
  }
}

export function replayCaption(evaluationAt, executionStartedAt) {
  return (
    "FROZEN INPUT REPLAY — evaluated as of " +
    new Date(evaluationAt).toISOString() +
    ". Real execution began " +
    new Date(executionStartedAt).toISOString() +
    ". Counts are historical as-of evidence, not current live observations. " +
    "The browser uses real wall time: its snapshot-age/refresh banner describes the old snapshot, not a newly observed production outage."
  );
}
