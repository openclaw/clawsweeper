# Direct publication rejection detail proof

This proof exercises the built dashboard Worker and `ExactReviewQueue` Durable Object through real
HTTP using local Wrangler persistence. It verifies the diagnosability-only response change for
invalid direct publication plans.

The behavior contract is:

- the real Durable Object initializes before any rejection claim is made;
- a deliberately invalid revision returns HTTP 400 with
  `error: "invalid_direct_publication_plan"`, `fallback_required: true`, and a non-empty `detail`
  naming the invalid revision;
- a structurally different plan whose operation targets the wrong item returns the same unchanged
  error classification with a bounded `detail` that names the violated tuple invariant without
  echoing the submitted path;
- the two validation failures produce different bounded detail values.

The script boots the Worker, drives `/api/exact-review-queue`, terminates the full Wrangler process
tree, and inspects Wrangler's persisted SQLite database for the direct-publication table. Only that
schema observation allows the proof to restart the Worker and make the signed HTTP assertions. The
restart check waits for the health endpoint to stop answering so a surviving `workerd` child cannot
turn the second boot into a false positive.

Run from the repository root on Node 24 or newer:

```bash
bash docs/proof/direct-publication-reject-detail/run-proof.sh
```

Set `DIRECT_PUBLICATION_REJECT_DETAIL_PROOF_OUTPUT` to keep generated artifacts outside the
repository. The default ignored artifact directory contains the captured HTTP responses, runtime
transcript, build/install logs, and a redacted Wrangler log.

This proof does not change or test retry/permanence policy, does not identify or fix the underlying
CodexBar rejection, and does not deploy or mutate production. OpenClaw Bay is unaffected: the
change keeps internal publication rejection fingerprints distinct without exposing submitted
values, with no Bay observer data or control surface change.
