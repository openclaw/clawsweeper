# Maintainer-only status routing replay

- Status: active proof recipe, not an operator runbook
- Owner: ClawSweeper review maintainers
- Source: `src/clawsweeper-next-step.ts`, `src/review-record.ts`, `src/clawsweeper-report-comment-helpers.ts`, and `src/clawsweeper-label-policy.ts`
- Verified baseline: `b79b76cc0cc46f266104fb1a8f95cdd2a74c8292`
- Update when: typed next-step kinds, durable review parsing, readiness, or status routing changes

## Claim and limits

Explicit maintainer-only next steps route to `status: ⏳ waiting on maintainer`,
not author work. They remain blocked from merge. Author findings and missing
proof still take precedence; unknown ownership does not become maintainer work.

The public examples are https://github.com/openclaw/openclaw/pull/177823 and
https://github.com/openclaw/openclaw/pull/167431. Their October 21 public labels
said waiting on author while their reviews named maintainer security approval
and, for the latter, a product decision. Their private canonical review records
were not recovered. **All persisted inputs here are synthetic**, not those live
records or a new review of either PR. The new producer must explicitly select
`kind: maintainer`; this patch does not guess ownership from legacy prose.

This driver runs the real compiled durable-record writer/reader, checklist,
automation-marker producer, and label selector. It writes complete generated
reports, comments and a JSON receipt; no model, GitHub mutation, apply command,
or hosted queue is called. Separate parser/schema and regression tests support
the result. Local rendering/routing proof is not hosted deployment proof.

## Reproduce

Use Node 24+ and the pinned pnpm dependencies from the repository root. Build
the full pinned baseline without changing the current checkout:

```sh
pnpm install --frozen-lockfile
pnpm run build:all
mkdir -p .artifacts/maintainer-routing-baseline
git archive b79b76cc0cc46f266104fb1a8f95cdd2a74c8292 | tar -x -C .artifacts/maintainer-routing-baseline
ln -s "$PWD/node_modules" .artifacts/maintainer-routing-baseline/node_modules
node_modules/.bin/tsc -p .artifacts/maintainer-routing-baseline/tsconfig.json
node docs/proof/maintainer-review-routing/replay.mjs
```

Use a fresh baseline directory for the first run; stop if preparation fails.
An optional first argument selects an already-built baseline `dist` directory.
The receipt records compiled hashes, but a supplied path is not independent
proof of its provenance. Rebuild current `dist` after changing source.

Inspect `.artifacts/maintainer-review-routing/result.json`, `before.md`, and
the per-scenario `.report.md` and `.comment.md` files. The receipt records the
current head, dirty flag, input/compiled hashes, runtime, provider, and limits.

## Observed result

On Node v24.20.0 / Linux x64 in the managed Docker sandbox:

| Input | Status | Readiness | Pass/repair marker |
| --- | --- | --- | --- |
| Legacy required approval, baseline and candidate | waiting_on_author | needs-changes | absent |
| Explicit security approval | waiting_on_maintainer | blocked | absent |
| Explicit security approval + product decision | waiting_on_maintainer | blocked | absent |
| Approval + contributor finding | waiting_on_author | blocked | absent |
| Approval + missing contributor proof | needs_proof | blocked | absent |
| Approval + unknown upgrade risk | no status label | blocked | absent |

All candidate scenarios preserve `security-review-required`. No security
approval, merge permission, repair action or change to either live PR is implied.
The managed sandbox image identifier is not exposed and no Crabbox lease was
used; this is a local deterministic production-path replay, not remote proof.
