export interface CodexWorkState {
  state: string;
  phase: string;
  summary: string;
  codexThreadId?: string;
  codexTurnId?: string;
}

// Match the action-session request deadline; telemetry must not stall the worker.
const FETCH_TIMEOUT_MS = 15_000;

export function createCodexWorkStatePublisher(
  options: {
    url: string | undefined;
    token: string | undefined;
    signal: AbortSignal;
    deadlineAt: number;
    onError: (error: unknown) => void;
  },
  fetchImpl: typeof fetch = fetch,
): (update: CodexWorkState) => Promise<void> {
  const url = options.url?.trim();
  const token = options.token?.trim();
  let pending = Promise.resolve();
  return (update) => {
    if (!url || !token || options.signal.aborted) return Promise.resolve();
    const body = JSON.stringify(update);
    pending = pending.then(async () => {
      if (options.signal.aborted) return;
      try {
        const remainingMs = Math.floor(options.deadlineAt - Date.now());
        if (remainingMs <= 0) throw new Error("Work-state publication deadline expired.");
        await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.any([
            options.signal,
            AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remainingMs)),
          ]),
          body,
        });
      } catch (error) {
        if (!options.signal.aborted) options.onError(error);
      }
    });
    return pending;
  };
}
