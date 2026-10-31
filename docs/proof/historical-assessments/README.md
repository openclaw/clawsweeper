# Recorded assessment classification: controlled real-site proof

- Status: active proof procedure, not a production observation
- Owner: ClawSweeper dashboard maintainers
- Owning source: `dashboard-site/scripts/attention.ts`,
  `dashboard-site/scripts/assessment-collections.ts`,
  `dashboard-site/scripts/records.ts` and the real Astro consumers
- Verified baseline: `c1c4dd7bef083590d0a76b2dfcdf43d3922827ca`
- Update when: record evidence semantics, attention groups/caps, privacy filtering
  or rendered assessment metadata changes

## Claim and surface

The production record aggregator and combiner feed the actual static Astro site.
Overview, Assessments and repository pages separate recorded-open flags, source
changes, unavailable state/completion and closed/archived history. An old open
security flag stays visible. No record is declared current merely because its
review is recent, a drift marker is absent/equal, or apply ran. Closed/archive is
not proof of resolution. Legacy and true-zero records do not create a false
current-source all-clear.

## Scenario and command

The public-safe scenario generator is
`dashboard-site/fixtures/assessment-records.ts`. It writes canonical front-matter
fields used by the report, reconciliation and source-drift producers. All titles
are explicitly fixtures; they do not describe real GitHub items. The production
parser reads the files directly; report bodies and an excluded repository carry
sentinels that must not appear in output. Repository visibility is a controlled
fixture input, not a live visibility check.

From the managed checkout on Node >=24 with pinned dependencies and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm --dir dashboard-site install --frozen-lockfile
node --test test/dashboard-assessment.test.ts test/dashboard-assessment-corpus.test.ts test/dashboard-attention.test.ts
PROOF_OUTPUT_DIR=.artifacts/historical-assessments node docs/proof/historical-assessments/run-proof.mjs
pnpm run check
```

The harness exports the pinned baseline's source into ignored proof scratch,
uses the same fixture data/viewport/theme, builds both real sites and also builds
legacy and recorded-zero variants. Chromium checks 112 route/compatibility cases: Overview,
Assessments and repository scope, before/after/legacy/recorded-zero variants, both
themes and 320/390/768/1440px widths. Eight additional repository cases remove
that repository from the legacy global flag lists while preserving the landed
scoped collections; the old concern must remain visible and unclassified. It checks full title/identity and assessment
metadata fit, no page-wide overflow, explicit unknown review dates, snapshot
expansion, repository search/Escape, reachable active mobile navigation, and
opens history with the keyboard, verifies the landed Coverage help buttons by
focus/Escape and mobile tap/outside dismissal, records requests and captures before/after
screenshots at 1000px height in every width/theme, with curated desktop and
390px before/after pairs against the landed mobile-triage baseline. No external browser
requests or action endpoints are needed. The repository's existing preview
snapshot supplies unrelated queue/Actions/coverage context; it is not proof of
those systems. The harness restores the ignored preview data after building.

## Observable result and artifacts

For each concern (security and maintainer), the primary scenario has three
recorded-open entries globally (two in the main repository), two changed, one
unknown and two historical. The 302-day-old open concern stays first by reviewer
priority; the archived concern appears only in history. A larger real record
walk counts 243 recorded-open flags while keeping 100 global and 20 per-repository
rows. These are pre-cap group totals, not counts filtered from the old lists.

`receipt.json` records the exercised head/base, source-content digest, source file
list, browser/Node, 112 route/compatibility results, requests, screenshot hashes and limits.
`before-corpus.json`, `after-corpus.json`, `bounded-corpus.json` and per-build logs
retain the producer/build trace. Final execution environment, provider, image,
lease, command outcome and curated media belong in the PR's Real Behavior Proof
package; a local run alone is not a hosted-provider claim.

## Limits

This controlled proof does not read or mutate live records, hydrate Worker/R2,
verify real item state/source, exercise GitHub visibility authentication, deploy,
request reviews, alter queue state, or validate review correctness. Browser
requests remain read-only and do not call the GitHub API. Current source-valid
attention stays explicitly unavailable because the stored schema has no positive
independently reverified matching-source receipt. Historical means latest stored
records for closed/archived items, not every past review event.
