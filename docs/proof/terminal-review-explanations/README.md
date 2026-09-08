# Terminal automatic review explanations

## Contract

Exercise the production webhook worker, exact-review queue, and compiled status
updater through acknowledgement recovery and a complete, lease-fenced
status/completion cycle. Only the external GitHub boundary is substituted. The
terminal-status CLI fixture cannot make network calls, create comments, or
address any comment except the scenario's existing bot acknowledgement; the
recovery fixture accepts only its exact token, pull, comment, and dispatch
requests. The updater subprocess receives a minimal environment with no
inherited credentials.

From the repository root, with Node 24 or newer and frozen dependencies installed:

```sh
pnpm run build:all
node docs/proof/terminal-review-explanations/run-proof.mjs
```

The trace is written to `.artifacts/terminal-review-explanations/result.json`.
Set `TERMINAL_REVIEW_PROOF_OUTPUT` for a different local artifact path. The trace
records the actual Git head, dirty-tree flag, Node version, and limits. Final PR
evidence must use a clean committed head. The full repository gate and executable
workflow regressions also require `jq` and `tmux` on `PATH`; the plain Node
container image does not provide them. Supporting validation runs `pnpm run check`
after the proof.

## Observable results

- Each deterministic terminal reason replaces the existing progress section with
  bounded reason-specific guidance, not a review verdict or scanner details.
- Replaying an identical blocked update performs no additional PATCH.
- The queue records the updater's verified response as an observed receipt.
- A failed PATCH or mismatched response body produces a failed receipt and
  operator delivery health without requeuing the review.
- Receipts survive reconstructing the queue over the same SQLite storage.
- A stale heartbeat after completion returns 409 without binding another receipt.

Supporting regressions execute the real workflow pagination helpers with a
controlled GitHub CLI response boundary: old receipts beyond five pages remain
reachable, the tenth full page stops lookup without returning partial results,
and API/malformed-response failures leave acknowledgement mutation unavailable.
The ten-page cap deliberately resolves the receipt as unavailable without
creating or deleting a comment and still allows the actual review; reaching the
cap is not treated as proof that a receipt is absent.
The completion-supersession proof runs the actual workflow Bash/curl fences over
a loopback HTTP bridge to the production queue. It admits a newer source while
the completion status lease is held, observes the finalizing heartbeat transfer
ownership with `lease_superseded`, and evaluates the actual artifact/direct/queued
publication gates. All eight downstream stages are skipped, the old run completes
as a successful no-op, and the new revision remains pending. The published
pre-fix workflow is a failing baseline for this same scenario.

The hosted webhook regression additionally verifies that a capped lookup still
admits the review without creating or deleting comments. Review-context tests
exclude trusted automatic status noise but retain human quotations.

The source-authority recovery scenario exercises the production webhook and
durable queue `Request`/`Response` paths against a controlled external GitHub
fixture. It loses the response after the fixture creates an `opened` receipt,
observes webhook deferral, makes the same reservation due, and runs the
production alarm fallback. The fallback finds the trusted receipt, attaches it
under the current source-authority sequence, and admits that exact decision
without a second comment. Focused regressions separately keep acknowledgement
errors deferred, preserve concurrent receipt/source changes, and prove that a
later `synchronize` may recover an existing receipt but never creates one.

## Limits and Bay

This is a controlled queue/API/subprocess proof, not a deployed workerd instance
or a complete GitHub Actions run. The external GitHub service is a deterministic
fixture, so the proof covers production request construction, response handling,
durable storage, and queue admission but not live GitHub availability or
Cloudflare scheduling. Workflow tests separately cover the step conditions and
finalizers. No contributor PR or live queue is mutated.

OpenClaw Bay needs no change: explanations and source-authority recovery modify
GitHub bot acknowledgements and internal queue admission only; the public data
contract and UI do not change. Receipt IDs and timestamps remain internal
operator telemetry. Existing public status projections retain their sanitization
boundary, and Bay remains observer-only. The route-level regression also
preserves the last complete Bay activity display while grading status-delivery
failures from fresh queue health, matching the newer dashboard health ownership
contract.
