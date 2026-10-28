# Batch publication outcome summary proof

- Status: active controlled CLI proof
- Owner: ClawSweeper maintainers
- Source of truth: `src/repair/exact-review-batch-cli.ts`, its terminal outcome
  type, and `run-proof.mjs` in this directory
- Verified scope: the candidate's built CLI; each run prints its source HEAD,
  dirty state, compiled CLI hash, Node version, and observed outputs
- Update when: completion classifications, acknowledgement fields, or CLI
  summary output changes

The built `complete` and `release` commands must report five separate
`submitted_outcomes` counts alongside server acknowledgement totals. This
proof uses mixed batches, fully skipped submissions, and empty no-ops. It
checks the real signed HTTPS requests and CLI stdout without replacing fetch,
timers, or CLI modules. The coordinator is a loopback fixture; its returned
batch membership is empty to ensure output is not inferred from that view.

Run from a qualified checkout with Node 24+, OpenSSL 3, and dependencies ready:

```sh
pnpm run build:repair
node docs/proof/batch-publication-outcome-summary/run-proof.mjs
```

To record the same scenarios against an already built baseline:

```sh
node docs/proof/batch-publication-outcome-summary/run-proof.mjs <baseline-directory>/dist/repair/exact-review-batch-cli.js --baseline
```

The candidate asserts the reporting contract; baseline mode records its old
summaries while still checking wire outcomes and acknowledgement totals.
TLS keys, the certificate, manifests, and receipts are created in a disposable
temporary directory and removed when the run finishes. Only the child CLI
trusts that certificate through [Node's extra CA setting](https://nodejs.org/api/cli.html#node_extra_ca_certsfile);
certificate verification remains enabled.

This proves reporting and transport behavior, not the real queue's retry,
refresh, or dead-letter disposition. The synthetic coordinator returns
aggregate accepted/skipped counts without accepted identities. No production
Cloudflare state, GitHub state, inference, schema, or retry policy is changed.
