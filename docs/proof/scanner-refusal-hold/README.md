# Scanner refusal hold proof

Claim: a newly observed terminal input-scanner refusal retains the existing queue row as a durable automatic-review hold. Only a fresh verified re-review, a newly dispatched explicit item request, or an intentional retry-policy epoch change can release it. Automatic source changes cannot.

Surface: production Worker signed enqueue/complete/stats routes, real workerd with SQLite persistence, the owning workflow's continuation gate, and the compiled scheduled-enqueue CLI over a locally trusted HTTPS endpoint. Fixture-only routes seed leases and invoke the production alarm. GitHub responses are synthetic loopback data; the production entrypoint is unchanged.

Run with Node 24+, OpenSSL, the locked dependencies, and built CLIs:

```sh
pnpm run build:all
node scripts/e2e/scanner-refusal-hold.mjs
node scripts/e2e/scanner-refusal-hold.mjs /path/to/base-checkout --before
```

The base scenario reproduces readmission after terminal completion. The candidate scenarios cover restart, different automatic producers, changed source, close/reopen, real alarms, stale and fresh command identities, old and new manual workflow requests, policy epoch release, issue and PR refusal, a newer automatic successor, and independent retryable/source-incompatible behavior. The workflow gate selects the queue for an untargeted dispatch; the compiled CLI skips the hold and retains branch, prompt, and timeout options for another candidate.

Observable results: held items have no active/pending review or waiting Bay card; the failed lifecycle remains terminal and public parked counts include `scanner_refused`. Explicit release uses new authority. Closed/source operator recovery cannot delete the hold. Outputs are `result.json`, bounded `trace.json`, and a Worker log under the fresh `.artifacts/scanner-hold-*` directory. Only compact results and hashes belong in public proof; generated fixture TLS/App keys never do.

Limits: this exercises seeded leases and synthetic GitHub responses, not a live scanner or full hosted Actions run. The command proof supplies already-verified intake metadata; existing command-intake tests own live permission verification. Newly observed refusals are the rollout boundary; historical deleted rows are not inferred. Worker enforcement deploys before updated producer routing relies on it; already-running old direct shards are a rollout limitation. Bay remains observer-only with no release controls. Crabbox provider/lease and final source hashes are recorded in the PR body after execution.

The approved workflow simplification removes the broad manual batch/shard and immediate-apply inputs, five unreachable matrix jobs, and their runtime packaging. The proof executes the remaining planner Bash with controlled capacity responses and the real enqueue CLI against workerd; it also checks that explicit selection and the separate apply job remain. Failed-review retries use automatic queue intake, retain their prompt/timeout/source pin, and cannot release a scanner hold as manual requests. `scripts/e2e/exact-review-noop-read-scope.mjs` additionally exercises the compiled issue admission with matching and changed pinned source, including the required comment reads. Already-running older workflow revisions remain outside the new routing until they finish.

Opaque manual API request IDs retain the existing named/UUID contract: callers use a new unique ID for a new explicit request. The failed ID remains on the held decision, so replay cannot release it after short-lived delivery receipts expire. Numeric workflow IDs keep the older-run fence. The runtime proof exercises both contracts.

`node scripts/e2e/implementation-backfill.mjs` executes the actual planner backfill Bash, shared dispatcher, and compiled canonical-report candidate discovery for `vision_fit` and non-core `viable` reports. It verifies bounded dispatch and rejection of manual record/comment-only reports; only outbound GitHub dispatch is captured locally. The planner reads prior canonical reports, while the dedicated strict-bug backfill and exact publication hooks remain. Existing intake owns live item validation and deduplication.

Verified command timestamps must be strictly later than both the refusal and any failed command timestamp. GitHub timestamp precision makes same-second requests ambiguous, so all remain held regardless of command ID or refusal origin. A later command or edit can retry. The real Worker proof exercises both automatic-origin and command-origin refusals: tied verified commands are rejected, the production alarm leaves the row parked with zero new dispatches, and a later-second command is admitted. The redacted `authority_proof` observations in `result.json` record actual timestamps, responses, and dispatch deltas.

An in-flight re-review successor uses the actual refusal time too. The proof seeds a command timestamped after lease claim but before refusal, observes `requeued: false`, verifies the parked row and zero dispatch through the alarm, then admits a post-refusal command. Lease start time is never substituted for the refusal cutoff.

Authority-proof dispatch counts are scoped to the held item and exclude terminal command acknowledgement work. Other deliberately admitted positive controls can progress in the same alarm. Each rejection observation is captured before its later-command positive control, so legitimate work cannot contaminate the negative result.
