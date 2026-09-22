# CI comment read budget

- Status: active behavior proof
- Owner: ClawSweeper publication maintainers
- Update when: comment context hydration, apply read generations, or freshness barriers change

## Contract

Claim: review/publication context fetches the complete issue-comment thread once,
derives its bounded prompt window locally, and shares that complete read with
later guards in the same apply generation. It avoids duplicate REST pagination
without retaining comments across mutations or explicit fresh-read boundaries.

Surface: production context hydration, GitHub pagination, source-revision hashing,
and `LiveReadGeneration`, exercised through a local HTTP server with synthetic
GitHub issue/comment responses. Cases cover short threads, truncated prompt
windows, multiple REST pages, unknown counts, empty threads, a changed middle
comment, explicit bypass, and generation invalidation.

Command/environment: Node 24+, the repository's pinned pnpm, compiled production
modules, and `node scripts/e2e/ci-comment-read-budget.mjs`. Run the same harness
against the baseline and candidate builds and retain request-count JSON traces.
Focused tests and `pnpm run check` supplement this runtime proof.

Observable result: fewer comment REST requests for context plus a same-generation
guard, unchanged bounded comment content and full-thread source revision, and a
new complete read after bypass or invalidation. Existing two-sided mutation
barriers must retain their live reads and reject concurrent changes.

Limits: loopback GitHub responses are synthetic. The proof does not claim a
production quota reduction measurement or mutate GitHub, queue state, production
limits, or deployments. OpenClaw Bay is unaffected: no public status schema,
rendering, navigation, or action boundary changes.

## Observed result

On macOS with Node 24.21.0 and pnpm 12.4.1, the same production-runtime harness
measured the following comment REST requests for context hydration followed by
a same-generation complete-comment read:

| Thread | Baseline | Candidate |
| --- | ---: | ---: |
| Empty | 1 | 1 |
| 10 comments | 2 | 1 |
| 40 comments | 2 | 1 |
| 250 comments | 5 | 3 |
| 40 comments, unknown count | 1 | 1 |

Source revisions and bounded prompt comments matched the baseline. A middle
comment edit remained invisible to the current generation, but was detected by
an explicit bypass and after generation invalidation. The existing apply
read-generation loopback independently retained both live pull-head reads and
the complete-comment read at each mutation barrier, and rejected concurrent
head/comment changes. All 51 focused tests passed.

```sh
pnpm run build:all
# Baseline build, before applying the runtime change:
node scripts/e2e/ci-comment-read-budget.mjs --baseline
# Candidate build:
node scripts/e2e/ci-comment-read-budget.mjs
node --test test/context.test.ts test/primary-body*.test.ts \
  test/live-read-generation.test.ts test/apply-read-generations-loopback.test.ts
```

The machine-readable before/after observations and runtime source identity are
in [results.json](results.json).
