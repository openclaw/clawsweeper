# Bay public-reference blade proof

This deterministic browser proof exercises the real Overview and OpenClaw Bay
HTML served by the local Wrangler Worker. A synthetic status response contains
two verified public GitHub references plus marker-bearing private fields that
must never render.

The proof searches for and clicks a reference on each page, checks the local
blade, verifies canonical repository and issue/PR links, verifies keyboard
focus, refreshes an already-open Bay blade after a bounded stage transition,
and confirms malformed deep links fail safely. It also proves that the browser
sends no mutations or direct GitHub API requests and records screenshots and a
Playwright trace.

Run from the repository root with the pinned Playwright image:

```bash
BLADE_PROOF_SOURCE_SHA="$(git rev-parse HEAD)" \
crabbox run \
  --provider local-container \
  --local-container-image mcr.microsoft.com/playwright:v1.60.0-noble \
  --no-hydrate \
  --allow-env BLADE_PROOF_SOURCE_SHA \
  --timing-json \
  --script docs/proof/bay-public-reference-blade/run-proof.sh \
  --require-artifact '.artifacts/bay-public-reference-blade/trace.zip' \
  --require-artifact '.artifacts/bay-public-reference-blade/proof-summary.json' \
  --artifact-glob '.artifacts/bay-public-reference-blade/**'
```

The fixture is deliberately synthetic and the canonical links are inspected
without being opened. This proves the interaction and privacy boundary, not
live dashboard freshness or external GitHub availability.

Run the broad Linux gate from the same exact tree with:

```bash
(
  set -e
  bundle=docs/proof/bay-public-reference-blade/exact-tree.bundle
  trap 'rm -f "$bundle"' EXIT
  git bundle create "$bundle" HEAD origin/main
  BLADE_PROOF_SOURCE_SHA="$(git rev-parse HEAD)" \
  BLADE_PROOF_TREE_SHA="$(git rev-parse 'HEAD^{tree}')" \
  BLADE_PROOF_BUNDLE="$bundle" \
  crabbox run \
    --provider local-container \
    --local-container-image node:24.13.0-bookworm \
    --no-hydrate \
    --allow-env BLADE_PROOF_SOURCE_SHA \
    --allow-env BLADE_PROOF_TREE_SHA \
    --allow-env BLADE_PROOF_BUNDLE \
    --timing-json \
    --script docs/proof/bay-public-reference-blade/run-gates.sh
)
```

## Visual artifacts

- [`overview-blade.png`](overview-blade.png) shows the local reference blade on
  the Overview page.
- [`bay-blade.png`](bay-blade.png) shows the same reference after its bounded
  queue-to-live transition on OpenClaw Bay.

The runnable proof also emits `proof-summary.json` and `trace.zip` under the
ignored artifact directory. The PR body records the exact-head Crabbox receipt
and hashes after the final committed run.
