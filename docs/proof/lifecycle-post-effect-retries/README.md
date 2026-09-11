# Lifecycle post-effect retry proof

Claim: the compiled batch client recovers transient failures for router receipts
and terminal dispositions with byte-identical signed requests. The real Worker
and SQLite-backed queue deduplicate a committed operation after its response is
lost, including when a newer requeue arrives before the retry. Publication
enqueue remains single-attempt. The batch CLI opts into lifecycle retries;
other callers, including operator retirement, keep the single-attempt default.

Run on Linux or macOS with Node 24+ and pnpm after `pnpm run build:node`.
The driver resolves the repository's pinned Wrangler 4.107.0 through `pnpm dlx`.
Only Wrangler's esbuild, sharp, and workerd setup scripts are allowed for that
invocation, using packaged libvips rather than a host-installed copy.

```sh
node docs/proof/lifecycle-post-effect-retries/run-proof.mjs
```

The driver starts a local Wrangler Worker and a loopback fault proxy. It uses
synthetic lifecycle admissions, real HTTP requests, the production signature
validator, and the production queue/storage implementation. The proxy either
returns one HTTP 500 before forwarding or drops a response after the queue has
committed it. In the latter case, the queue instance is reconstructed over the
same SQLite storage before retry; a paired scenario also submits a newer requeue.
The receipt records each request count and final persisted lifecycle/driver state.

Fixture-only routes seed and inspect state. The fixture blocks all outbound
Worker fetches and suppresses alarm dispatch; no GitHub, model, or production
state is accessed. A client fetch adapter changes only the HTTPS origin to the
loopback HTTP fault proxy. This proves replay semantics, not production outage
recovery or throughput. OpenClaw Bay's data contract is unchanged; replay uses
the existing lifecycle projection without duplicating or reviving terminal work.
