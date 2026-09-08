# Bay duration inspection proof

## Current follow-up

At Martin’s September 7, 2026 request, the production chart keeps its highlighted
five-minute interval but replaces the native interval dropdown and permanent
detail row with a floating tooltip and one plot-wide focusable slider. The
separate inline-proof cohort selector remains. The original chart contract is
preserved in [behavior-contract.md](behavior-contract.md); the follow-up extends
its interaction checks rather than weakening the data or accessibility boundary.

The refreshed production HTML/CSS/browser script passed **16 Chromium scenarios**:
hover and scrubbing, hoverable/Escape-dismissable details, arrows/Home/End, stable
slider DOM/focus/bucket identity through refresh, mobile tap and frame-settled
horizontal drag, capture through refresh, viewport containment, aged-out bucket
clamping, immediate unavailable-state and transport-failure removal, live-region identity, sparse/zero/
empty/partial buckets, stale/browser-clock-skewed data, source query cutoff, and
independent retained lifecycle counts. No visible alternate chart picker remains.

![Desktop floating details](chart-desktop.png)

![Mobile floating details](chart-mobile.png)

## Provenance and reproduction

These are executed **working-tree captures**, based on
`22a614ce1493487d5be5b6e3a860b6ef3e8c80bb` plus the follow-up changes. Their
production-page SHA-256 and scenario/network results are in [summary.json](summary.json).
They do not claim the base commit alone contains the change. The final rewritten
head, exact-head proof, CI and review belong in the follow-up PR body.

- Provider: Crabbox `local-container`, compatible engine Podman.
- Lease: `cbx_521a951843c7`; run: `run_5534ce0996d0`, exit 0.
- Image: `docker.io/library/node:24-bookworm`.
- Node: `v24.20.0`; Chromium: `152.0.7977.82`; Playwright Core: `1.62.1`.
- Captured viewports: 1440×1000 desktop, 360×800 mobile with touch input.

```sh
pnpm install --frozen-lockfile
pnpm run build:all
node --test test/bay-duration-chart.test.ts test/bay-inline-proof.test.ts
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node docs/proof/bay-duration-chart/run-proof.mjs
pnpm run check
```

The browser runner writes screenshots, `trace.zip`, assertion results and network
records under `.artifacts/bay-duration-chart/browser/`. It renders production
`bayHtml()` with controlled same-origin API responses; unrelated APIs return 404
and external fonts are blocked. Native touch moves are inspected after their
frame-coalesced events settle.

## Boundaries

The chart uses `bay.timings.window_ended_at` from the actual timing query. It
never substitutes the earlier status timestamp or browser clock. Missing source
time leaves the chart unavailable. Missing bucket data remains unavailable, not
zero; a rolling hour can intersect 13 intervals while the API retains 12 points.

This proves the rendered production interaction, not real-device screen-reader
certification, live backend completeness, or proof-producer execution. The separate
[inline-proof fixture](../bay-inline-proof/README.md) exercises the real Worker/
SQLite Durable Object and public cohort API. No production mutation, deployment,
workflow dispatch or live producer is part of either fixture.
