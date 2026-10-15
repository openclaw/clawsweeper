# Snapshot bootstrap proof

- Status: active controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/worker-records.ts`, `dashboard/record-snapshots.ts`,
  and `test/dashboard-worker-bay-records-routes.test.ts`
- Last verified candidate: base `75c614ee432a8c6e9ef7dec0b98ba0a6a15fc32b`, with
  `scripts/worker-records.ts` SHA-256 `eb1be9f8f725e70aa378cb9558e3e3c0ef094bc52a6fb10d53187260ce1c0476`
- Observed on Node 24.19.0: cold reader refused, snapshot registered, all 2,001 records restored exactly; 27 queue range calls, largest descriptor 415 bytes; prune race returned 503
- Update when: snapshot producer admission, export, upload, or hydration changes

Run `node docs/proof/snapshot-bootstrap/run-proof.mjs` on the repository's
qualified Crabbox route with Node 24+ and Corepack. It starts pinned Wrangler
4.131.1 locally, seeds 2,001 synthetic records in real workerd SQLite, observes
ordinary hydration refuse, runs the actual snapshot-upload CLI against signed
loopback HTTP, registers its multipart archive in local R2, and verifies every
restored byte. The queue fixture rejects R2 payload reads and the retired inner
chunk route; successful hydration must instead use bounded range descriptors
from the queue and stream snapshot bytes through the outer Worker. Results report
the largest metadata response and go to stdout. The fixture advertises 1 KiB
chunks to exercise multiple range authorizations, then deletes the object after
authorization and verifies the next outer read returns 503. Temporary state and the child process are
removed on exit. The fixture blocks outbound Worker fetches and alarm dispatch.

This proves the producer/reader boundary and real local storage/HTTP path,
not production Cloudflare capacity or throughput. The focused tests separately
exercise concurrent changes, first-page watermarks, export caps, upload retries,
coverage validation, and cleanup. OpenClaw Bay is unaffected: no public observer
contract changes.

The R2 contract is the official [Workers API ranged-read
reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads).
The [consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
also applies: pruning can remove a registered object after range authorization.
That race remains a snapshot-store-unavailable response; the reader does not
silently switch to a different snapshot.
