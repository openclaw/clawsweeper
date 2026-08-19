# Comment router throttle resilience proof

Production run [31697514690](https://github.com/openclaw/clawsweeper/actions/runs/31697514690)
failed while prehydrating the full comment history for
[openclaw/openclaw#120500](https://github.com/openclaw/openclaw/issues/120500).
The exact repository dispatch had no durable router claim; recovery depended on
the rolling three-hour scheduled scan, so a long enough throttle window could
lose the command rather than merely delay it.

The fix gives scheduled scans their own per-repository `updated_at` plus
same-timestamp-id cursor. Broad scans read bounded, oldest-first repository
comment pages from that cursor. The wrapper persists a new watermark only after
the entire router process succeeds; exact routes never advance it. Within a
throttled cycle, context already fetched remains usable and affected commands
are retained as waiting before the shared operator-skip classifier turns the
child failure into an operator-visible exit-0 defer.

The cheap read-economy change applies to repository-wide discovery. Per-item
comment histories remain complete because they feed source-revision hashes,
linked-PR discovery, historical command/status idempotency, exact-review lease
checks, and close guards. Adding `since=<routing cursor>` to those reads would
silently weaken those contracts, so that more invasive optimization is not part
of this fix.

OpenClaw Bay is unaffected: this changes an internal router workflow and its
git-backed progress cursor, not Bay's public observer-only status contract.

## Container proof

The committed [run-proof.sh](run-proof.sh) is the static `jq` recipe used in the
Docker-backed Crabbox container. It obtains every commit/tree id through
`git rev-parse`, verifies each with `git cat-file`, runs the production loopback
CLI and focused tests, and validates the generated JSON receipt.

The successful run used Crabbox `provider=local-container`, lease
`cbx_6efbcfb3f874` (`coral-barnacle-e30e`), run `run_4fe08202fe1b`, and stopped
the one-shot lease automatically. The raw Ubuntu image required NodeSource Node
24 because its default package is Node 22. The raw synced workspace also needed
a temporary Git bundle containing the already-committed head and base objects;
the bundle was proof transport only and is not committed.

The receipt commit contains proof artifacts only after tested runtime commit
`7d991891672e29f6f5d09961a7a34b205e2602cd`; no source, script, test, workflow,
or operational documentation change follows the tested tree in this push.
