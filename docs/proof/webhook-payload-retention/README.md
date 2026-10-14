# Webhook payload retention proof

- Status: active local verification fixture
- Owner: ClawSweeper queue maintainers
- Source: `dashboard/github-webhook-read-model.ts`
- Queue integration: `dashboard/exact-review-queue.ts`
- Verified scope: the source revision that contains this fixture
- Update when: payload retention, completeness, ordering, or repair behavior changes

Run from the repository root with Node 24+ and Wrangler on `PATH`:

```sh
node docs/proof/webhook-payload-retention/run-proof.mjs
```

The fixture starts local Workerd with a SQLite-backed Durable Object.
It forbids outbound Worker requests and uses an isolated temporary storage root.
The runner removes that root and stops only its own child processes.

The fixture stores 71 item payloads, ordinary and placeholder comments, and a deletion tombstone.
It retires 64 payloads, restarts Workerd, and drains the remaining seven payloads.
It checks that ordering rows, the tombstone, the receipt, and the unresolved placeholder survive.
It then repairs unchanged source content and checks the original placeholder result.
An active family with 101 comments verifies that old members survive a fresh
observation. The fixture reports native SQLite rows read during its bounded pass.
The runner prints measured JSON payload bytes, SQLite database bytes, and assertions as JSON on stdout.

The upgrade scenario also boots the actual pre-change queue from pinned commit
`bc3ae1d960157d3bbd751af0bfd794c2f2e1aba9`. It extracts only tracked source build
inputs into disposable scratch, records the archive SHA256, and uses the same
Worker name, queue class, binding, object name, and SQLite persistence directory
when restarting with the candidate source. No dependencies are installed.

Normal queue routes seed old payloads, a deletion tombstone, unresolved placeholder,
active comment family, pending review, canonical tuple, and lifecycle records.
The candidate's first normal read initializes the additive columns without
retiring payloads. Explicit calls to the queue's real alarm retire idle bodies;
queue, canonical, receipt, and lifecycle rows remain byte-identical. Normal repair
restores unchanged source content and usable collections across another restart.
Duplicate queue and canonical submissions retain their original revisions.

The local wrapper supplies a fixed future clock and synthetic public-target
probes. Automatic dispatch alarms are disabled; explicit alarms run before the
pending review's debounce deadline. Every outbound request fails and is counted;
the scenario requires zero outbound requests.

This proves the storage component and persisted queue upgrade on real local
Workerd SQLite. It does not measure production eligibility, initializer headroom,
billed storage, or a full production queue workload. No Cloudflare account, R2
object, or production namespace is accessed. Downgrade after retirement remains
unsupported; this fixture does not attempt it.
