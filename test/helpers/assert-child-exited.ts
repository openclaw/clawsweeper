import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";

export function assertChildExited({ error, signal, status }: SpawnSyncReturns<unknown>) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? error?.name ?? "none";
  assert.ok(
    !error && signal === null && status !== null,
    `Child did not exit normally (error=${code}, signal=${signal}, status=${status})`,
  );
}
