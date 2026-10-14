# Webhook payload retention proof

- Status: active local verification fixture
- Owner: ClawSweeper queue maintainers
- Source: `dashboard/github-webhook-read-model.ts`
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

This proves the storage component on real local SQLite through Worker HTTP calls.
It does not measure production eligibility, billed storage, or full queue
transitions. Queue and consumer regressions have separate tests. No Cloudflare
account, R2 object, or production namespace is accessed.
