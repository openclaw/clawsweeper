# Authoritative Bay lifecycle metrics proof

This proof starts the actual local Wrangler Worker and its Durable Object, then
uses signed internal lifecycle requests to admit and complete public review
requests triggered by a new pull request, new commits, a changed pull-request
body, `@clawsweeper review`, and `@clawsweeper re-review`.

It proves that the public status route receives 21 durable completions across
those sources, advances a 20-review completed tide, retains the next completion
in the lane, records `last_tide_at`, and excludes a private repository from the
public aggregate. The one-hour timing coverage intentionally remains warming in
this short scenario; the emitted aggregate contains all samples while the page
correctly withholds a partial average.

Run from the repository root:

```bash
BAY_LIFECYCLE_PROOF_OUTPUT=.artifacts/bay-lifecycle-metrics \
crabbox run \
  --provider local-container \
  --local-container-image mcr.microsoft.com/playwright:v1.60.0-noble \
  --no-hydrate \
  --timing-json \
  --script docs/proof/bay-authoritative-lifecycle/run-proof.sh \
  --require-artifact '.artifacts/bay-lifecycle-metrics/proof-summary.json' \
  --require-artifact '.artifacts/bay-lifecycle-metrics/bay-lifecycle-metrics.png' \
  --artifact-glob '.artifacts/bay-lifecycle-metrics/**'
```
