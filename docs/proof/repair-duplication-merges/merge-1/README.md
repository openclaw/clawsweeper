# Merge notifier hook-client proof

This proof builds the complete pre-change tree from `origin/main` and runs its
production `dist/repair/notify-merge.js` entry point. It invokes the current
built `runMergeNotifier` function with the same arguments used by that CLI's
`main`. Both receive their normal hook configuration through the
`CLAWSWEEPER_OPENCLAW_*` environment variables and post through Node's real
`fetch` implementation to one HTTP server bound to an ephemeral
`127.0.0.1:<port>` socket.

The listener returns `503` to the first request for each path and `200` to a
second request. The old process makes one request, records a failed delivery,
and exits 1 under `--strict`. The current process retries over the socket,
receives `200`, records a sent delivery, and exits 0. The transport trace
captures a timestamp, socket addresses, response status, and the identical
idempotency-key header and JSON field for every request. The proof also verifies
the three existing sibling notifiers that already use the shared client: `notify-events.ts`,
`notify-github-activity.ts`, and `notify-maintainer-report.ts`.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-1/run-proof.mjs
```

The checked-in result is in `artifacts/retry-adoption.json`. This is a local,
credential-free real-transport proof. It uses a disposable token and a
loopback-only listener; it does not contact OpenClaw, Discord, GitHub, or any
production service.
