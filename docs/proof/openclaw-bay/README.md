# OpenClaw Bay deterministic browser proof

This proof package exercises the real `/bay-demo` page and its checked-in
artwork in Chromium. Playwright replaces only `/api/status` with a fully
synthetic, redacted sequence so stage changes can be reproduced without live
dashboard data, credentials, or GitHub API traffic.

The sequence proves:

- visible partial-telemetry diagnostics;
- the three-hour exact-review handoff-pressure chart, including its queue-owned pending and leased lines;
- the Bay timing badge naming its bounded **review trigger → final review** measurement, completed by the command-status update emitted after the durable review summary;
- a 390px portrait layout that stacks Arriving through Applying vertically, keeps the terminal pools at the waterline, and has no horizontal page overflow;
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
  labelled 18-state contact sheet that can be inspected without video codecs.
- [`trace.zip`](trace.zip) is the Playwright action, DOM snapshot, and network
  trace. Open it with
  `npx --yes playwright@1.60.0 show-trace docs/proof/openclaw-bay/trace.zip`.
- [`proof-summary.json`](proof-summary.json) records all 28 passing assertions,
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

- implementation source: working-tree patch `ec0f64c822983d6b630602c7183578a312127a88` based on `ecc6d03d1ec73267d434cb1905cfc216c78fcd70`
- provider: Crabbox `local-container`
- lease: `cbx_e42103e2f43c` (`coral-barnacle`)
- image: `mcr.microsoft.com/playwright:v1.60.0-noble`
- fixture SHA-256:
  `F766EE78A4E8E4F41EA9F2F64C9C85DFE3D04D7962B647007F073F40AF94ADA5`
- exact response SHA-256 values:
  - `01-initial.json`:
    `9D6CA7EDD926508DBB3DB7ED3B8328405F8404E16AEE303AE9057CA6B3BA0397`
  - `02-forward.json`:
    `7D102233EE8A63E7987DAAB53A231C1DD35008C0734A771119488BC54F4499C9`
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
