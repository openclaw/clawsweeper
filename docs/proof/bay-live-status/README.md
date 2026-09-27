# Bay live status cache proof

Claim: a valid queue with `source_incompatible` and `unknown` parked reasons
remains complete after status serialization and cached re-reading. Bay can use
its existing live cards and timing; malformed queue totals still fail closed.
The queue's dedicated closed projector owns this public contract.

The fixture uses synthetic inputs with twelve public-reference cards, four
timing samples, and one item in each affected parked bucket. The production
Worker serves `/api/status` and `/bay`; its real local cache and `StatusStore`
Durable Object persist each returned response before the next read. Three HTTP
traversals expose the original bug: the first drops the two reason fields, and
subsequent reads reject the inconsistent parked total. The proof also checks
that the synthetic private sentinel is removed and malformed totals are rejected.

Start each revision with its own local state and port:

```sh
pnpm --config.ignore-scripts=true dlx wrangler@4.131.1 dev \
  --config docs/proof/bay-live-status/wrangler.toml --local \
  --ip 127.0.0.1 --port 8798 --inspector-ip 127.0.0.1 --inspector-port 8799 \
  --persist-to .artifacts/bay-live-status/after-state
node docs/proof/bay-live-status/run-proof.mjs \
  http://127.0.0.1:8798 after .artifacts/bay-live-status
```

For the baseline, copy this proof directory to an isolated checkout of
`15e21a3b3948590955d2f19eb7e1e996b6b3d73d` without changing its production
source. Use a second port/state directory and invoke the same script with
`before`. Record the exact candidate head and patch digest alongside the
reports. When running through Crabbox, supply `BAY_PROOF_PROVIDER`,
`BAY_PROOF_LEASE`, and `BAY_PROOF_IMAGE` from its actual receipt.

Each proof leaves its server ready for browser inspection at `/bay`.
`POST /fixture/reset` with `{"scenario":"forward"}` moves one synthetic card
for the separate sweeping-animation check. The root task records browser
screenshots and desktop, narrow-layout, and reduced-motion observations.

Limits: synthetic operational inputs; real local Worker, cache, HTTP, and
Durable Object storage. This does not prove live GitHub data collection,
dispatch, review execution, or publication. The fixture is loopback-only,
has no live credentials, and must never be deployed.
