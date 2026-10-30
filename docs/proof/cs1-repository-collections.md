# Repository collection selection proof

- Status: historical controlled proof for this change, not an operational runbook
- Owner: ClawSweeper maintainers
- Intended base after integrating landed Coverage help: `6ed9c97007e38b5afb2ec30c305e7c51c2fa4e11`
- Owning sources: `dashboard-site/scripts/records.ts`,
  `dashboard-site/src/lib/repository-collections.ts`,
  `dashboard-site/src/lib/data.ts`, and the repository Astro page
- Repeat when: selection, totals, truncation, visibility, legacy compatibility or
  repository-card rendering changes

## Claim and boundary

Repository cards select their own stored-corpus matches before bounding the
display. A repository outside the global first 500 still receives its ten rows;
known zero, unknown selection and missing nonzero rows remain distinct. This is
not proof of complete canonical hydration, current GitHub state, source validity,
or correctness/resolution of historical reviewer flags.

## Executed path and environment

The proof uses the real `build-corpus.ts` CLI, `build-data.ts` CLI, Astro production
build and Chromium page. Only external visibility, Actions and public telemetry
responses are controlled by `scripts/proof-repository-collections-network.mjs`.
The external adapter refuses unexpected calls and mutation methods; both token
slots contain the literal synthetic fixture placeholder, not real credentials.

Run from the repository root after installing the pinned root and site packages:

```sh
CHROMIUM_PATH=/usr/bin/google-chrome \
  node scripts/proof-repository-collections.mjs .artifacts/cs1/new-proof
```

The output directory must not exist. The runner archives the pinned baseline
source without changing the current checkout, and independently runs the actual
producer/data/site flow for baseline, patched, legacy-cache, legacy-snapshot,
missing-row and contradictory-count cases.

Executed on 30 October 2026 through Crabbox, provider `aws`, lease
`cbx_f0cc58caa192`, promoted image `ami-04beed173f1785931` in `eu-west-1`, Linux
amd64, Node `v24.19.0`, pnpm `12.15.0`, system Google Chrome. The matched captures
use 1440×1700 CSS pixels, dark theme, UTC, fixed 30 October 2026 noon time and
reduced motion. No workflow dispatch, deployment or live GitHub/Worker call is
part of this proof.

## Fixture and observed results

The deterministic tree contains 600 open plus 600 closed dominant-repository
records, ten open plus ten closed small-repository records, one fresh unflagged
record, and synthetic visibility-exclusion records. The small repository sorts
outside each global first 500. Fixture manifest SHA-256:

`fc249aeb04f75383b0fc77352c8b925a19b7077c4dfcbe74213d8493e05925ad`

| Scenario | Stale | Maintainer | Security | Recorded closes | Observed rendering |
| --- | ---: | ---: | ---: | ---: | --- |
| Baseline small repository | 0 | 0 | 0 | 0 | Incorrect empty flags despite stale KPI 10 |
| Patched small repository | 10 | 10 | 10 | 10 | Each card says showing 10 of 10 stored-corpus matches |
| Legacy cache | 10 | 10 | 10 | 10 | Observations retained; selection coverage explicitly unknown |
| Legacy snapshot without transport | 0 | 0 | 0 | 0 | Unknown/unavailable, never all-clear |
| Missing nonzero rows | 0 | 0 | 0 | 0 | Ten matches recorded, rows unavailable |
| Stale total contradicts KPI | 0 | 0 | 0 | 0 | Nonzero KPI preserved as unknown selection, never empty flag |
| Genuine-zero repository | 0 | 0 | 0 | 0 | Explicit stored-corpus empty states |

All global arrays remain capped at 500, and repository arrays at ten. Synthetic
private records are excluded by the corpus producer. A separately withdrawn
repository is removed by the site-build visibility recheck, including its new
collections and generated route. Browser assertions found no page errors and
only same-origin requests; item links retain canonical public-repository GitHub
GET destinations. They are synthetic fixture item references, not a claim that
every referenced item exists.

## Retained evidence and supporting tests

Each invocation retains `results.json`, `source-hashes.json`,
`fixture-hashes.json`, exact subprocess command logs, six browser traces and the
matched `before.png`/`after.png` plus true-zero capture. The current inspected
before/after pair and a compact public-safe manifest are retained under
`assets/proof/cs1-repository-collections/` during review, per the repository media
retention policy. The PR embeds these images; traces and full logs remain artifacts.
The original pre-integration proof used base `5577656d79ed491486b5e9ab9853df481f9aa8f1`
and committed head `912d7aac8c7fe16cdac297980e974e54f068bb55`. Its evidence is
historical, not current after integration. Its pre-commit source manifest is
`c07b53abb080aed115f334db62969fffa8e39dcda980e2a86c6c4879713312b7`;
it predates this proof note and the explanatory documentation addition. The PR
body records the current committed-head replay, provider provenance and manifest.
The integrated proof also exercises the five landed Coverage help buttons:
focus, Escape, click toggling, and ordinary repository-tooltip hover remain intact.

Focused regressions:

```sh
node --test test/dashboard-repository-collections.test.ts test/dashboard-attention.test.ts test/dashboard-site-tooltips.test.ts
```

These cover all four collections past both cap thresholds, true zero, old cache
metadata, missing/inconsistent counts, forwarded row fields, both public filters,
and fail-closed non-absence directory read errors. Tests support but do not
replace the producer-to-browser execution above.
