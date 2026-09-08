# Bay duration chart and retained lifecycle — behavior proof

## Original contract (defined before the first chart PR)

- Claim: Bay exposes a readable minutes Y-axis and an actual rolling last-hour X-axis; bucket-wide hover, keyboard focus and touch show interval, median, mean and sample count. Missing buckets remain gaps, never zero-duration observations. Retained lifecycle is collapsed below operational content and accurately distinguishes records from revisions without changing its query or counts. The legacy toggle remains available; inline proof stays in ordinary end-to-end timings.
- Exercised surface: production `bayHtml()` HTML, CSS and browser script in Chromium, with controlled same-origin API fixtures. No production API, workflow dispatch, credentials or GitHub mutations.
- Scenarios: sparse, single, empty and zero-duration timing points; non-aligned hour edges and current partial bucket; direct/legacy selection; desktop and narrow mobile viewport; pointer at bucket edges away from dots, keyboard focus, touch; focus across refresh; lifecycle starts collapsed, opens with keyboard/tap, preserves record totals and filter independence.
- Commands: `node --test test/bay-duration-chart.test.ts`; `node docs/proof/bay-duration-chart/run-proof.mjs`; `pnpm run check`. Container entrypoint and exact commands/results will be recorded after provider preflight.
- Environment: requested Crabbox `local-container`, Node >=24, existing Playwright tooling and Chromium. Record actual compatible container engine, image, lease, head and dirty patch digest; do not call Podman Docker Engine.
- Observable results: assertions on actual DOM geometry, axis endpoints/units, details content, gap representation, responsive containment and unchanged lifecycle/toggle state; no browser errors or external/mutating network requests.
- Artifacts: `.artifacts/bay-duration-chart/` screenshots, trace, assertion summary and runtime/gate logs.
- Limits: controlled browser UI proof does not establish production telemetry completeness, modern proof execution attribution, live workflow behavior, provider execution time or historical retention completeness. The existing API caps returned history at 12 aligned five-minute buckets although a rolling hour can intersect 13; absent edge data must remain explicitly unavailable. The original chart PR did not add a proof telemetry dimension.

## Authorized follow-up (September 7, 2026)

The unpublished modern inline-proof follow-up also removes the chart interval
picker and permanent detail panel at Martin’s request. Retain the distinct
inline-proof cohort selector. A single plot-wide slider now exposes floating
details through hover/scrub, keyboard arrows/Home/End and touch tap/drag. Escape
dismisses the tooltip; it remains hoverable and contained on desktop/mobile.
Preserve the exact source cutoff, missing/partial intervals, stable navigation
node and focus across valid refresh, and immediate fail-closed unavailable state.
The updated browser runner exercises the production DOM/CSS and replaces
picker-specific checks with equivalent slider/tooltip assertions.
