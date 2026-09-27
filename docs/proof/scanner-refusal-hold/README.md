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
