# Snapshot bootstrap proof

- Status: active controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/worker-records.ts` and `test/record-snapshot-upload.test.ts`
- Last verified candidate: base `3db5c867c82e47c1fe31299625d34c184b9a4d8b`, with
  `scripts/worker-records.ts` SHA-256 `aaeaf04eb3111959e20c0e6c994d2155f843075f631de3bcd90206d34e664165`
- Observed on Node 24.19.0: cold reader refused, snapshot registered, all 2,001 records restored exactly
- Update when: snapshot producer admission, export, upload, or hydration changes

Run `node docs/proof/snapshot-bootstrap/run-proof.mjs` on the repository's
qualified Crabbox route with Node 24+ and Corepack. It starts pinned Wrangler
4.131.1 locally, seeds 2,001 synthetic records in real workerd SQLite, observes
ordinary hydration refuse, runs the actual snapshot-upload CLI against signed
loopback HTTP, registers its multipart archive in local R2, and verifies every
restored byte. Results go to stdout; temporary state and the child process are
removed on exit. The fixture blocks outbound Worker fetches and alarm dispatch.

This proves the producer/reader boundary and real local storage/HTTP path,
not production Cloudflare capacity or throughput. The focused tests separately
exercise concurrent changes, first-page watermarks, export caps, upload retries,
coverage validation, and cleanup. OpenClaw Bay is unaffected: no public observer
contract changes.
