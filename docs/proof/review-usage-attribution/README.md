# Review usage attribution proof

Status: controlled runtime proof driver. Owner: ClawSweeper review maintainers.
Update this driver when native review invocation, usage capture, terminal
attributes, canonical shard parsing or recovery changes.

Build the selected source with `pnpm run build:node`, then run:

```sh
node docs/proof/review-usage-attribution/run-proof.mjs \
  .artifacts/review-usage-attribution/proof.json
```

To reproduce the original failure with an independently built frozen source tree,
add `--baseline-root /path/to/baseline`. The same driver uses the baseline review
CLI and the candidate offline reader. Its measured handoff must still contain
all five counters, while the baseline ledger has no attributed token counts.

The driver launches the real compiled `review` CLI against an isolated local
Git repository. GitHub, the scanner and Codex are executable fixture boundaries;
no product functions are replaced. Each synthetic Codex invocation consumes its
prompt and writes a protocol-shaped rollout using the five counters present in
the pinned Codex 0.164.0 source. No model or production service is invoked.

Scenarios exercise successful inference with measured usage, successful
inference with unavailable usage, and failed inference with measured usage.
The assertions follow the synchronous handoff into the canonical item terminal,
including its existing operation, attempt, run/attempt and source revision.
The real offline reporting CLI reads the resulting shards. It must report
unavailable usage and billing honestly and perform no import or network call.
All fixture GitHub mutations are forbidden. Synthetic fixtures are removed;
the requested result file retains the bounded scenario receipts and hashes.

Cache non-measurement, malformed count pairs and post-processing failure are
covered by the focused ledger, recovery and usage regression tests. This driver
does not establish complete artifact retention, queue committed starts, loaded
admission settings, provider invoices or historical token usage. Source-specific
execution outcomes belong in the PR's proof package; this driver alone is not
a claim that a run passed.
