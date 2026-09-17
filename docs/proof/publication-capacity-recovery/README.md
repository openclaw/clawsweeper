# Publication capacity recovery proof

This local proof runs the frozen main and candidate queue owners through signed
Worker HTTP routes in real Workerd with SQLite-backed Durable Objects.
It demonstrates ten post-cooldown published members, partial and completed
replays, stale fences, duplicate-envelope rejection, process restart, mixed quota
feedback, and SQL plus KV rollback after a late membership failure.

Run `node docs/proof/publication-capacity-recovery/run-proof.mjs` with
`CAPACITY_PROOF_BASELINE` pointing to the verified frozen-source fixture and
`CAPACITY_PROOF_WRANGLER` pointing to Wrangler 4.131.1. The native proof wrapper
pins source/install inputs and Workerd 1.20260911.1, denies external network,
and verifies owned process and socket cleanup before accepting the result.

The fixture supplies public-target admission, synthetic publication tuples, and
a controlled future clock. Its failure trigger aborts a real SQLite membership
write. Production queue and controller code are imported without replacement.
The baseline and candidate use the same fixture bytes. Results and bounded
request hashes are written under `.artifacts/publication-capacity-recovery`.

No live GitHub publication or production queue operation is performed. This
proves the canonical batch recovery invariant; it does not measure production
throughput or imply that legacy completions cannot recover the shared ceiling.
Bay remains an observer of the existing public capacity field.
