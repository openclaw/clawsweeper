# PR read-model identity proof

- Status: active controlled proof fixture
- Owner: ClawSweeper dashboard and queue maintainers
- Source of truth: `dashboard/github-webhook-read-model.ts`
- Base: `1e7c8d9981416ad8e230ab5b4987668053ed8841`
- Last verified source: `dashboard/github-webhook-read-model.ts` SHA-256
  `570d5058f0d66bfce739181886f8807b53fa11d35a93ffb45f174b24791b9086`
- Observed on Node 24.19.0: exact PR head reserved, drift refused, old rows classified as PRs, marker metadata preserved
- Update when: item projection, webhook merge, inventory, or reservation changes

After building on the qualified remote backend, run
`node docs/proof/pr-read-model-kind/run-proof.mjs`. Node 24+, Corepack, curl,
and pinned Wrangler 4.131.1 are required. The driver creates temporary workerd
SQLite state and an isolated Wrangler home, then deletes both on exit.

The fixture sends signed raw PR events into the actual read-model store and
consumes signed item responses through the actual runner client, inventory,
revision selector, and reservation command. It verifies PR heads, drift refusal,
old-row projection, marker metadata after a later raw update, placeholder kind,
and unchanged issue revision selection. Observations and source hashes go to stdout.

The GitHub head lookup and comment receiver are synthetic loopback endpoints;
issue digest calculation is stubbed, so the proof covers its selection only.
This proves the changed store-to-reserver contract, not production GitHub
publication, hosted workflow admission, or Cloudflare edge capacity. Worker
outbound requests are blocked. No production credentials or writes are used.
OpenClaw Bay's public observer contract is unchanged.
