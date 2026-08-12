# Stuck queued-run remediation proof

This proof covers the read-only planning surface for the scheduled stuck-run remediation lane. The claim is intentionally narrow: a queued run is selected only after it is older than 90 minutes and at least three newer runs of the same GitHub Actions workflow have reached `in_progress` or `completed`. Known permanent zombies and the intentionally serialized repair-cluster workflow are excluded before history is fetched.

`live-dry-run.json` was captured against `openclaw/clawsweeper` with:

```bash
GH_TOKEN="$(gh auth token)" node scripts/stuck-queued-run-remediation.mjs \
  --repository openclaw/clawsweeper \
  --output docs/proof/stuck-queued-run-remediation/live-dry-run.json \
  --zombie-output .artifacts/exact-review-dlq/stuck-queued-zombies.json
```

The 2026-08-12T03:39:23.031Z snapshot inspected all 18 queued runs returned by GitHub. One current run was younger than the threshold, the other 17 were the already-proven permanent zombies from the July and August incidents, and the cancellation plan was empty. The command made no mutation requests.

Unit tests exercise the positive stale-plus-three-starts case, a global capacity crunch with no newer starts, the strict age boundary, the expected-long-queue exclusion, the ten-run cap, and the 500→500 permanent-zombie path. The container receipt is added after the same committed revision passes the repository gate through Crabbox.

Limits: this proof uses GitHub's live workflow-run inventory but deliberately does not manufacture or cancel a production candidate. The cancellation API behavior is covered with injected responses in the pure remediation tests; the two production incidents are the real-world evidence that regular cancellation is safe for this queue because `workflow_cancelled` is retryable and cleanly re-dispatched.
