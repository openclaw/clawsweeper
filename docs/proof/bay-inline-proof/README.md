# Bay inline-proof participation — behavior-proof contract

- Claim: Bay compares full request-to-final review durations for all reviews, reviews with an accepted inline-proof request, reviews tracked from admission with no such request, and unknown history. A request is not execution, producer redemption, returned evidence, or proof sufficiency. Inline time is never subtracted.
- Surface: exact-review Durable Object request admission and durable lifecycle projection; bounded last-hour telemetry; public Worker status API; real browser comparison control.
- Scenario: controlled current-head review leases with accepted/deduped requests, rejected stale owners, no request, historical missing tracking, lease clearing/retry, final receipt dedupe, and legacy publication paths. No live producer dispatch or credentials.
- Command/environment: Node >=24; Docker/Podman-backed Crabbox `local-container`; isolated local Wrangler Worker/SQLite Durable Object; Playwright Chromium. Exact commands, source revision, lease, image and results recorded after execution.
- Observable result: closed enum survives lease cleanup, is fenced to the admitted revision, historical absence is unknown, each completion appears once, cohort counts/median/mean equal fixture arithmetic, browser selection changes only timing cohort and composes with legacy filtering.
- Artifact: sanitized API JSON, assertions, browser screenshots/trace and Crabbox execution summary under `.artifacts/bay-inline-proof/`.
- Limits: controlled local fixtures do not prove live Telegram/Web UI producer execution, deployment, GitHub publication effects, or production population coverage. Legacy publication records lacking original-review tracking remain unknown. Public Bay remains observer-only; no capabilities, plans, observations, credentials or request identifiers are projected.

## Semantics

`requested` means the DO accepted at least one inline-proof request for this admitted review revision. It remains requested even if that attempt later fails or is retried: those attempts are part of the same request-to-final journey. `not_requested` means tracking began at original admission and no request was accepted; while active this means “not requested yet”. Missing, historical, reconstructed or invalid tracking is `unknown`. New source/head revisions do not inherit the previous revision’s classification. The legacy publication-path flag stays independent.

## September 7 chart interaction refinement

- Claim/surface: production Bay retains its highlighted five-minute interval and readable axes, but has no interval dropdown or permanent bucket detail panel. The separate inline-proof cohort selector remains.
- Stimulus: desktop hover/scrub, keyboard arrows/Home/End/Escape, touch tap/horizontal drag, response refresh, resizing, missing/stale/unavailable snapshots.
- Invariant: one plot-wide focusable slider exposes the same interval, median, mean and sample count in a compact floating tooltip. Tooltip and axes remain within the viewport; valid refresh preserves slider DOM identity, focus and logical bucket key. Unavailable data removes stale interaction without inventing zero samples.
- Proof: production DOM/CSS in Chromium at desktop/mobile sizes in local-container. Capture screenshots, trace, geometry, source cutoff and input outcomes. Replace picker assertions with equivalent slider/tooltip safety assertions, not weaker tests.
- Limits: controlled local status fixtures and real Worker/DO; no production dispatch/deployment or live producer execution.
