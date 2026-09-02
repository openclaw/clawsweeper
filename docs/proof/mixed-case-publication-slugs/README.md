# Mixed-case publication slug proof

This proof exercises the built dashboard Worker and `ExactReviewQueue` Durable Object through real
HTTP using local Wrangler persistence. It verifies that GitHub repository casing does not block
direct exact-review publication while repository identity remains contained.

The behavior contract is:

- the real Durable Object initializes before any publication claim is made;
- a signed plan for `steipete/CodexBar#2516` whose operation uses the mixed-case
  `records/steipete-CodexBar/...` path returns HTTP 202 with an accepted or deduped receipt;
- the real Worker export surface serves that record only from `steipete-codexbar`, and the
  persisted Durable Object SQLite contains no `steipete-CodexBar` canonical or export row;
- a signed plan whose operation names `steipete-other` returns the HTTP 400
  `invalid_direct_publication_plan` response with a bounded tuple-invariant detail;
- a signed all-lowercase `openclaw/openclaw` plan still returns HTTP 202 with an accepted or
  deduped receipt.

The script boots the Worker, drives `/api/exact-review-queue`, terminates the full Wrangler process
tree, and inspects Wrangler's persisted SQLite database for the direct-publication table. Only
after that assertion does it seed disposable pending fences, restart the Worker, and submit the
three signed plans. It then reads the accepted mixed-case plan through the signed record-export
route, stops the Worker, and verifies the canonical, export-index, and stored receipt namespaces
directly in SQLite. Pending fences let the real Worker accept and persist the valid plans without
mocking the publication store or bypassing HTTP validation.

Run from the repository root on Node 24 or newer:

```bash
bash docs/proof/mixed-case-publication-slugs/run-proof.sh
```

Set `MIXED_CASE_PUBLICATION_SLUGS_PROOF_OUTPUT` to keep generated artifacts outside the repository.
The default artifact directory contains the signed request/response bodies, runtime transcript,
build/install logs, and a redacted Wrangler log.

This proof does not change retry or permanence classification, migrate stored records, deploy, or
mutate production. OpenClaw Bay is unaffected: the change only relaxes repository-name casing at
internal publication validation boundaries and does not change Bay data or controls.
