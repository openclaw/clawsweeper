# OpenClaw worker signal termination proof

The OpenClaw process worker starts the `openclaw` CLI in its own process group
so that its own timeout can stop the whole tree. A signal delivered to the
worker itself, which is what a job cancellation, a runner shutdown, or the outer
`spawnSync` deadline sends, never reached that group: the worker exited and
the CLI and its descendants kept running. The Codex process worker already
forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to its process tree; this proof
shows the OpenClaw worker now does the same, and that descendants are still
stopped when the direct child exits before the `SIGKILL` escalation fires.

[`run-proof.mjs`](run-proof.mjs) starts the compiled worker with a fake
`openclaw` binary that spawns a signal-ignoring grandchild and never exits on
its own, then sends `SIGTERM` to the worker and records whether the child and
grandchild are still alive three seconds later. Three scenarios run per arm: the
direct child ignores `SIGTERM`, and the direct child exits on `SIGTERM` while
its grandchild ignores it, and repeated signals while both ignore termination. Persistent
worker handlers keep the one-second escalation alive on repeated signals.
The baseline arm compiles
`src/openclaw-process-worker.ts` from the base commit inside an isolated copy of
`src/` under the output directory (with its own `package.json` and a link to the
repository's `node_modules`), so the tracked checkout is never modified;
the candidate arm uses the current build. No model inference, network access,
or credential is involved. The driver is POSIX only.

```sh
pnpm run build
node docs/proof/openclaw-worker-signal-termination/run-proof.mjs --out .artifacts/openclaw-worker-signal-termination
```

`--base <rev>` selects the baseline commit (default: the merge base with
`origin/main`, or `HEAD~1` once the change is on `main`); `--baseline-dist`
reuses a previously compiled baseline. The driver writes `summary.json` with
the worker exit status, the elapsed time until the worker exited, the elapsed
time until the tree was gone, and the recorded result signal for each arm and
scenario, and exits non-zero unless the baseline leaves both processes alive
in all three scenarios and the candidate stops both in all three scenarios.

Expected result: in all three scenarios the baseline worker dies from `SIGTERM`
without writing a result, and both the child and the grandchild survive the
three-second wait. The candidate worker forwards the signal; with a
`SIGTERM`-ignoring child it escalates to `SIGKILL` after one second and records
`signal: "SIGKILL"`, and with a child that exits on `SIGTERM` it sends `SIGKILL`
to the remaining process group when the child closes and records
`signal: "SIGTERM"`. In all cases it exits with code 0 and leaves no surviving
process.

Limits: controlled compiled run with a fake CLI; it does not claim a specific
production cancellation left an orphaned `openclaw` process. Windows keeps the
existing `taskkill /t` path and is not exercised. OpenClaw Bay is unaffected:
no lifecycle, queue, telemetry, or dashboard contract changes.
