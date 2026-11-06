# Coverage ACCEPT diagnosis — 2026-11-06

Status: **diagnostic prerequisite, not a recovery fix**. The deployed producer's
closed phase=accept category=unclassified warnings do not reveal the actual
Worker exception. This candidate does not establish that exception's cause.

## Bounded native-runtime investigation

### Reproduce on Linux

Claim: otherwise-unclassified authenticated ACCEPT failures gain only a closed
operation/fault pair; admission, original exceptions, rollback and observer
behavior remain unchanged. This is stage-2 instrumentation, not a causal repair.

After ordinary local dependency setup, run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node docs/proof/ui-live-coverage/coverage-accept-operations.mjs c1d3aebd59790a33e7fc18e61631c06bc5b0761c
```

The narrow executable fixture bundles the actual signed Worker → queue → SQLite
Durable Object path twice: pinned base and current source. It emits the observed
Git HEAD, exact engine versions, bundle SHA-256s, assertions and an ignored local
evidence artifact path. It uses pinned test-only Miniflare 5.20260911.0-alpha and
esbuild 0.28.1 from this worktree's normal installation, not another owner's
dependency link. Node is v26.12.1; workerd is 1.20260911.1; the compatibility date
is 2026-05-11. No container provider, image or lease is claimed on this Linux host.

The preserved valid workload is **145 synthetic repositories, 8,149 identities,
40 invocations, 217 queries and 736 accepted requests**, with two-pass promotion
on both base and candidate. A separate 25,000-identity population exceeds the
existing 20,000-identity fence and is correctly capacity-blocked; this candidate
does not change that fence.

Controlled checkpoint rejection and a deliberately injected receipt TypeError
remain rejected with unchanged derived rows. Base responses contain only
accept/unclassified; current responses add checkpoint/checkpoint and
receipt/type_error respectively. A subsequent uninjected request succeeds.
Unsigned method denials expose no operation field and mutate no state. All 58
non-census tables, KV entries and the null alarm remain unchanged; outbound
network is blocked and no R2 binding exists. Native 100-binding SQL succeeds and
101-binding SQL is rejected: this does not reproduce a production SQL-budget
failure. Fault injection proves mapping/rollback, never production causality.

The final committed-head run and its artifact hash belong in the PR body. A
dirty-tree run is development evidence, not proof of the eventual published head.

- Base: c1d3aebd59790a33e7fc18e61631c06bc5b0761c.
- Linux, Node v26.12.1; cached Miniflare 5.20260911.0-alpha,
  workerd 1.20260911.1, compatibility date 2026-05-11. These are actual
  workerd SQLite Durable Objects, not Node SQLite relabeled as Cloudflare.
- Real producer → signed owned Worker route → real ExactReviewQueue DO →
  ReviewCoverageCensusStore, with synthetic local-only HMAC, persistent local
  storage and outbound networking blocked. No production API or credentials.
- Synthetic population: core 4,865 issues / 2,881 PRs; enterprise 107 / 153;
  143 one-issue peers. Both baseline and candidate completed all 145 repositories
  with identical aggregate counters: 40 invocations, 217 queries, 736 accepted
  pages, zero failed connections. This exercises both witnesses and promotion.
- The final native run compares all 58 non-census SQL tables, supported KV
  contents and the DO alarm before/after collection: unchanged; alarm stays null.
  No R2 binding or live service is configured. These are synthetic clean-state
  checks, not an inspection of production canonical records.
- Native SQL accepts 100 bound variables and rejects 101. Current census SQL
  uses at most eight placeholders per statement; page identity writes are
  individual statements. A generic clean-state binding-limit failure was not
  reproduced. This does not rule out production state-dependent failures.

## Diagnostic behavior proof

A real invalid revision checkpoint sent through the signed native route is
rejected with unchanged persisted census state before and after this change.
Baseline omits its owning operation (expected assertion exit 1); candidate
returns only operation=checkpoint fault=checkpoint (exit 0). This is a
controlled negative proof of better diagnosis, **not** reproduction of the
unknown production failure. A deliberate SQL-throw unit test proves only
original Error/cause identity and rollback, not production causality.

The operation is invocation-local and records fixed source-owned stages. Faults
come only from exact owning guard constants, built-in Error classes, or an
explicit SQLite code allowlist read through own data descriptors. No raw
exception, SQL, IDs, payload, stack, message fragments or getters are emitted.
Unknown exceptions remain unknown. Existing category/error strings and all
checkpoint, witness, visibility, count and promotion fences are unchanged.
Only otherwise-unclassified failures gain the extra private reply fields;
known-category reply shapes remain compatible with existing callers.

## Evidence and limits

Local evidence is in .openclaw/tmp/accept-repro/: proof contract, baseline
and candidate worker/driver bundles, native baseline/candidate logs, controlled
negative red/green logs, build/lint/test outputs, and candidate manifest.
The controlled proof commands are recorded with that manifest. Runtime versions
are pinned above, but differ from the continuously updated hosted runtime.
Native fixtures start with synthetic clean derived state; canonical handover,
unknown fallback, partial peers and error/replay regressions have focused tests.
The actual production exception or its bounded operation/fault is still needed
to choose and prove a causal repair. No live recovery, deployment, private read,
production mutation, permission change, or publication is claimed.
