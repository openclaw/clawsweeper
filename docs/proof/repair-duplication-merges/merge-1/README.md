# Merge notifier hook-client proof

This proof compares the one-shot hook poster extracted from
`origin/main:src/repair/notify-merge.ts` with the shared OpenClaw hook client now
used by the merge notifier.

The representative transient `502` scenario demonstrates the intentional
behavior change: the old path makes one request and gives up, while the shared
client retries and succeeds. Both new attempts carry the same merge
idempotency key. The proof also verifies the three existing sibling notifiers
that already use the shared client: `notify-events.ts`,
`notify-github-activity.ts`, and `notify-maintainer-report.ts`.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-1/run-proof.mjs
```

The checked-in result is in `artifacts/retry-adoption.json`. This is a local,
credential-free HTTP-stub proof; it does not contact OpenClaw, Discord, GitHub,
or any production service.
