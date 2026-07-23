# OpenClaw Bay deterministic browser proof

This proof package exercises the real `/bay-demo` page and its checked-in
artwork in Chromium. Playwright replaces the dashboard's `/api/status` and
`/api/health-history` reads with fully synthetic, redacted fixtures so stage
changes and telemetry controls can be reproduced without live dashboard data,
credentials, or GitHub API traffic.

The sequence proves:

- visible partial-telemetry diagnostics;
- the Bay timing badge naming its bounded **review trigger → final review** measurement, completed by the command-status update emitted after the durable review summary;
- a 390px portrait layout that stacks Arriving through Applying vertically, keeps the terminal pools at the waterline, and has no horizontal page overflow;
- advancing crustacean-claw and master-sweeper animations;
- a READY flag followed by a physical forward sweep and landing;
- a changed run ID using the retrigger tunnel and resurfacing path;
- GitHub-reference search and focus;
- repository filtering;
- the read-only drawer's safe GitHub item, job, and workflow-run links;
- readable overflow controls that open the known queue sample and explicitly explain when aggregate queue IDs are outside the bounded public projection;
- compact review-admission and result-publication charts with labelled y-axes, exact point hover labels, and cached 6-hour, 24-hour, and 7-day range controls;
- lightweight hover/focus explanations on the beach lane signs;
- the local-only tide preview advancing through incoming, crest, backwash, and restored states while preserving terminal keys and count;
- the short static reduced-motion tide cue preserving the same preview state;
- completed and failed/cancelled outcomes grouped into their respective terminal pools;
- twenty completed outcomes fitting individually in the expanded terminal pool without a hidden overflow at the standard desktop width, plus a constrained-width layout that keeps twelve labels readable and makes the remaining eight explicit; and
- a generated real tide visibly washing terminal crustaceans before clearing the shared buffer; and
- zero browser-to-GitHub API requests, mutation requests, unexpected console
  errors, or uncaught page errors. The deliberate synthetic health-history
  outage records one expected 503 console error while the resilience state is
  being exercised.

## Artifacts

- [`playwright-proof-storyboard.jpg`](playwright-proof-storyboard.jpg) is a
  labelled 23-state contact sheet that can be inspected without video codecs.
- [`trace.zip`](trace.zip) is the Playwright action, DOM snapshot, and network
  trace. Open it with
  `npx --yes playwright@1.60.0 show-trace docs/proof/openclaw-bay/trace.zip`.
- [`proof-summary.json`](proof-summary.json) records all 42 passing assertions
  from its accompanying deterministic proof run,
  sanitized request/response metadata, safe drawer links, the unchanged
  terminal keys before and after both preview modes, the proved real-tide
  clear, and the held terminal failure tunnelling to its bounded live retry.
- [`run-proof.mjs`](run-proof.mjs) contains the Playwright assertions and
  artifact renderer. [`run-proof.sh`](run-proof.sh) installs the pinned
  Playwright package in `/tmp`, starts the real local Wrangler Worker, and runs
  that script without changing repository dependencies.
- [`fixtures/`](fixtures/) contains the exact three checked-in synthetic
  `/api/status` transition responses. The runner derives dense-terminal and
  real-tide responses from the final fixture, provides a synthetic in-memory
  `/api/health-history` response for telemetry, and records the real-tide
  SHA-256 in the summary. It
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

- implementation source: `854d8923e523f0cd2d76b4fdf92fec18fb4d012a`
- provider: Crabbox `local-container`
- lease: `cbx_862b38501790` (`brisk-lobster`)
- image: `mcr.microsoft.com/playwright:v1.60.0-noble`
- fixture SHA-256:
  `B0180F79C465964AD39E6E45F730211294742E1206EA4CE1A4C39DEB61AFCB71`
- exact response SHA-256 values:
  - `01-initial.json`:
    `9D6CA7EDD926508DBB3DB7ED3B8328405F8404E16AEE303AE9057CA6B3BA0397`
  - `02-forward.json`:
    `A94441D54E4CBBAE21C788C65FF60B0DCDA166459CBDA77C0A70F827076E9126`
  - `03-retrigger.json`:
    `9BAF0B764E413369EC8D9554D731A4E6B008B2DCB266B5D2837E94E820CEEBFE`
- derived real-tide response:
  `18FAF63BD6529D1F4EB03BF880343E20244413F82FE62029F055AABC13F44DA9`

The browser allowed only `bay-proof.test:8787`, mapped to the local Wrangler
Worker. The trace contains no cookies or authorization headers. A binary text
scan also found no GitHub tokens, local Windows user paths, usernames, or live
private payloads.

This is deterministic interaction proof, not a claim that synthetic state is
live operational evidence. The separate deployment smoke covers the public
route, response headers, unpublished `/bay`, shared schema, and static assets.
