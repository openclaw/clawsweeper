# Codex worker signal termination proof

The Codex process worker starts the `codex` CLI in its own process group and
forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to that group, escalating to
`SIGKILL` after one second. Two paths still left descendants running: the
signal handlers were one-shot, so a second signal during the escalation window
fell through to Node's default action and killed the worker before the
`SIGKILL` timer fired; and the `close` handler cancelled that timer as soon as
the direct child exited, so a CLI that honoured `SIGTERM` while a detached
descendant ignored it left that descendant alive. The OpenClaw process worker
already handles both cases; this proof shows the Codex worker now does the
same.

[`run-proof.mjs`](run-proof.mjs) starts the compiled worker with a fake `codex`
binary that spawns a signal-ignoring grandchild and never exits on its own,
then sends `SIGTERM` to the worker and records whether the child and
grandchild are still alive three seconds later. Three scenarios run per arm: a
control in which the direct child ignores a single `SIGTERM` (both arms stop
the tree through the existing escalation), the direct child exits on `SIGTERM`
while its grandchild ignores it, and repeated `SIGTERM` while both ignore it.
The baseline arm compiles `src/codex-process-worker.ts` from the base commit
inside an isolated copy of `src/` under the output directory (with its own
`package.json` and a link to the repository's `node_modules`), so the tracked
checkout is never modified; the candidate arm uses the current build. No model
inference, network access, or credential is involved. The driver is POSIX
only.

```sh
pnpm run build
node docs/proof/codex-worker-signal-termination/run-proof.mjs --out .artifacts/codex-worker-signal-termination
```

`--base <rev>` selects the baseline commit (default: the merge base with
`origin/main`, or `HEAD~1` once the change is on `main`); `--baseline-dist`
reuses a previously compiled baseline. The driver writes `summary.json` with
the worker exit status, the elapsed time until the worker exited, the elapsed
time until the tree was gone, and the recorded result signal for each arm and
scenario, and exits non-zero unless the baseline stops the tree only in the
control scenario and the candidate stops it in all three.

Expected result: the baseline worker stops the tree in the control scenario
and records `signal: "SIGKILL"`. When the direct child exits on `SIGTERM`, the
baseline worker exits with code 0 and records `signal: "SIGTERM"`, but the
grandchild survives the three-second wait. Under repeated `SIGTERM`, the
baseline worker dies from the second signal without writing a result, and both
the child and the grandchild survive. The candidate worker exits with code 0
in all three scenarios and leaves no surviving process: it records
`signal: "SIGKILL"` when the child ignores the signal, once or repeatedly, and
`signal: "SIGTERM"` when the child exits and the remaining process group is
killed on close.

Limits: controlled compiled run with a fake CLI; it does not claim a specific
production cancellation left an orphaned `codex` process. Windows keeps the
existing `taskkill /t` path and is not exercised. The app-server worker is not
part of this proof. OpenClaw Bay is unaffected: no lifecycle, queue,
telemetry, or dashboard contract changes.
