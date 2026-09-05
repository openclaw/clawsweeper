# GitHub response-body deadline proof

The queue's GitHub deadline must cover response bodies as well as headers.
Successful-body timeouts must retain typed retry classification in both queue
and App-token calls. Existing HTTP/rate-limit errors and malformed JSON retain
their meanings.

[`proof-github-body-deadlines.mjs`](../../../scripts/proof-github-body-deadlines.mjs)
bundles the baseline and candidate code into workerd. It invokes the actual
terminal-run resolver and App JSON helper against a Node HTTP fixture that
flushes headers before delaying or withholding its body. Native workerd egress
is restricted to that loopback fixture. No provider or GitHub credential is used.

Run through the repository's resolved Crabbox provider with its pinned Wrangler
tooling installed outside the checkout:

```sh
npm install --prefix /tmp/clawsweeper-worker-proof-tools --no-save --no-audit --no-fund wrangler@4.107.0
node scripts/proof-github-body-deadlines.mjs a9ed9b5ba7eb12357da7cc2360d87cc5397c3c36 /tmp/clawsweeper-worker-proof-tools .artifacts/github-body-deadlines
```

The receipt records source hashes, Git revisions, dirty state, Node/workerd
versions, elapsed time, error classification, and upstream cancellation. Finite
delayed bodies reproduce the baseline defects without hanging the proof.
Candidate cases additionally cover bodies that never finish.
Deadline cases must finish within six seconds after runtime readiness, allowing
headroom around the existing 4.5-second deadline. Ordinary JSON,
malformed JSON, empty 204, 503, and rate-limit responses guard existing contracts.

This proves the Worker transport boundary; it does not establish that stalled
bodies caused a particular production backlog. OpenClaw Bay is unaffected:
existing timeout/backoff states and public data contracts remain unchanged.
