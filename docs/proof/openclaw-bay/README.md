# OpenClaw Bay deterministic browser proof

This proof package exercises the real `/bay-demo` page and its checked-in
artwork in Chromium. Playwright replaces only `/api/status` with a fully
synthetic, redacted sequence so stage changes can be reproduced without live
dashboard data, credentials, or GitHub API traffic.

The sequence proves:

- visible partial-telemetry diagnostics;
- advancing crustacean-claw and master-sweeper animations;
- a READY flag followed by a physical forward sweep and landing;
- a changed run ID using the retrigger tunnel and resurfacing path;
- GitHub-reference search and focus;
- repository filtering;
- the read-only drawer's safe GitHub item, job, and workflow-run links;
- the local-only tide preview advancing through incoming, crest, backwash, and restored states while preserving terminal keys and count;
- the short static reduced-motion tide cue preserving the same preview state;
- completed and failed/cancelled outcomes grouped into their respective terminal pools;
- twenty completed outcomes fitting individually in the expanded terminal pool without a hidden overflow at the standard desktop width, plus a constrained-width layout that keeps twelve labels readable and makes the remaining eight explicit; and
- a generated real tide visibly washing terminal crustaceans before clearing the shared buffer; and
- zero browser-to-GitHub API requests, mutation requests, console errors, or
  uncaught page errors.

## Artifacts

- [`playwright-proof-storyboard.jpg`](playwright-proof-storyboard.jpg) is a
  labelled 17-state contact sheet that can be inspected without video codecs.
- [`trace.zip`](trace.zip) is the Playwright action, DOM snapshot, and network
  trace. Open it with
  `npx --yes playwright@1.60.0 show-trace docs/proof/openclaw-bay/trace.zip`.
- [`proof-summary.json`](proof-summary.json) records all 25 passing assertions,
  sanitized request/response metadata, safe drawer links, the unchanged
  terminal keys before and after both preview modes, and the proved real-tide
  clear.
- [`run-proof.mjs`](run-proof.mjs) contains the Playwright assertions and
  artifact renderer. [`run-proof.sh`](run-proof.sh) installs the pinned
  Playwright package in `/tmp`, starts the real local Wrangler Worker, and runs
  that script without changing repository dependencies.
- [`fixtures/`](fixtures/) contains the exact three checked-in synthetic
  `/api/status` transition responses. The runner derives dense-terminal and
  real-tide responses from the final fixture and records the real-tide SHA-256
  in the summary. It
  fails before launching Chromium if the checked-in sequence drifts.

The compact trace intentionally omits Playwright's continuous screenshot film
strip; the storyboard supplies the visual milestones while the trace supplies
the independently inspectable DOM, action, and network record.

From the repository root, reproduce the proof with the known Playwright image:

```bash
BAY_PROOF_SOURCE_SHA="$(git rev-parse HEAD)" \
crabbox run \
  --provider local-container \
  --local-container-image mcr.microsoft.com/playwright:v1.60.0-noble \
  --no-hydrate \
  --allow-env BAY_PROOF_SOURCE_SHA \
  --timing-json \
  --script docs/proof/openclaw-bay/run-proof.sh \
  --require-artifact '.artifacts/openclaw-bay-proof/trace.zip' \
  --artifact-glob '.artifacts/openclaw-bay-proof/**'
```

## Provenance and privacy

- implementation source: `d4390494189680c25a2aa8fa9454df5f332613a9`
- provider: Crabbox `local-container`
- lease: `cbx_a397c065e00e` (`swift-shrimp`)
- image: `mcr.microsoft.com/playwright:v1.60.0-noble`
- fixture SHA-256:
  `FC584F8F0521221B77897384BDEB3A167E85AA6C17708A7783740FCDF363CD21`
- exact response SHA-256 values:
  - `01-initial.json`:
    `F052DEC5FD41FB83AB5237076DDE644A2363332580242AEE3B5C4ECB359BAEB0`
  - `02-forward.json`:
    `34AA3F22C198D67C3FB6B9E9731C13ACD55E37E27BD829FABA54399124A2A0E2`
  - `03-retrigger.json`:
    `39DA760BF2E1A9E982404B2F27ABAE8649EF18B21A20E558787921D314BFC4C0`
- derived real-tide response:
  `B7F86FC41DC7D3868D9BA17793C262B5A2BA0D4FC5871157A2A8B13768EED880`

The browser allowed only `bay-proof.test:8787`, mapped to the local Wrangler
Worker. The trace contains no cookies or authorization headers. A binary text
scan also found no GitHub tokens, local Windows user paths, usernames, or live
private payloads.

This is deterministic interaction proof, not a claim that synthetic state is
live operational evidence. The separate deployment smoke covers the public
route, response headers, unpublished `/bay`, shared schema, and static assets.
