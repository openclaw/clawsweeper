# AGENTS.MD

ClawSweeper is the conservative maintenance bot for OpenClaw repositories.
Keep changes narrow, evidence-backed, and automation-safe.

`AGENTS.md` is the canonical repository-wide coding-agent policy. Task-specific
workflows under `.agents/skills/` are opt-in procedures and do not override this
file. This repository does not currently maintain `AGENT.md`, `CLAUDE.md`, or
Cursor aliases; agents that do not discover `AGENTS.md` automatically must be
directed here rather than given a duplicated policy copy.

## Structure

- Main code: `src/clawsweeper.ts`.
- Repair lane code: `src/repair/`; canonical records live in the Cloudflare
  Worker, ledger/assets blobs live in R2, and remaining operational state lives
  in `openclaw/clawsweeper-state`.
- Tests: `test/*.test.ts` and `test/repair/*.test.ts`; add new coverage to the
  narrowest matching test file instead of growing `test/clawsweeper.test.ts`.
- Workflow: `.github/workflows/sweep.yml`.
- Vision and product boundaries: `VISION.md`.
- Explainer: `README.md`; state/dashboard repo: `../clawsweeper-state`.
- Open/reviewed records in the canonical Worker store:
  `records/<repo-slug>/items/<number>.md`.
- Archived records in the canonical Worker store:
  `records/<repo-slug>/closed/<number>.md`.
- Scratch/generated output: `.artifacts/`, `artifacts/`, `apply-report.json`.

Preserve one flat `items/` and `closed/` report layout per repository slug. Do
not split reports into issue/PR subtrees.

## Operating Model

- Review lane is proposal-only. It never closes GitHub items.
- Apply lane mutates GitHub by syncing the durable Codex review comment and then
  closing only unchanged, high-confidence proposals.
- Repository-specific rules live in `src/repository-profiles.ts`; ClawHub apply
  may close only PRs that are certainly implemented on `main`.
- Worker concurrency is shard-level: each shard processes its selected items
  sequentially. Maximum parallel Codex sessions equals `shard_count`, not
  `batch_size * shard_count`.
- `openclaw/clawsweeper-state` is the live status surface and operational state
  store; the Worker/R2 pair is authoritative for records, ledger, and assets.
  Check current Actions and the canonical owner before trusting local generated
  timestamps.
- When asked about PRs outside `openclaw/clawsweeper`, treat the task as
  monitoring/debugging how ClawSweeper workflows operate on that PR. Do not fix
  foreign PR branches directly; ClawSweeper repair/automerge workflows own those
  branch edits.
- In `openclaw/openclaw`, `CHANGELOG.md` is release-owned. Do not ask contributor
  PR authors, repair workers, or automerge/autofix lanes to edit it during normal
  PR work. Preserve release-note context in PR bodies and commit messages instead.
- When referencing GitHub issues or PRs in user-facing output, always include
  the full GitHub URL, not only `#12345`.

## Safety Rules

- Never disable or pause the live ClawSweeper sweep workflow unless Peter
  explicitly asks for that exact action.
- Do not run live apply/close commands unless Peter explicitly asks.
- For apply-path repros, copy one report into a temp `items/` dir and pass
  `--skip-dashboard`, `--item-number`, and a temp `--closed-dir`.
- Treat maintainer-authored and protected-label items as non-closeable.
- Leave canonical OpenClaw Mantis locale PRs open; their generated-PR publisher
  owns freshness and auto-merge. See `docs/target-repositories.md` for identity scope.
- Snapshot or `updated_at` drift blocks apply unless the only change is the
  existing ClawSweeper review comment.
- Open-but-locked issues can exist when stale automation locked a closed issue
  and the author later reopened it. These must be skipped, not allowed to crash
  the apply run.
- Locked-comment 403s from GitHub are terminal apply skips, not retryable API
  failures.

## PR Validation and Landing

- For code-bearing changes, run focused validation that exercises the changed
  behavior, then run a fresh Codex `/review` before committing and again on the
  committed branch against its base before landing. Address every accepted or
  actionable finding and repeat the relevant proof and review. CI, an older
  ClawSweeper comment, prior review comments, or manual self-review alone do
  not replace this loop.
- At task kickoff, define the `pr-behavior-proof` contract for every
  code-bearing PR: claim, exercised surface, scenario or fixture, command and
  environment, observable result, artifact or trace, and limits. Run its
  controlled real-behavior proof before opening even a draft PR; only Martin
  may expressly approve an evidence-in-progress exception.
- Keep that proof current in the PR body. Tests, CI, mocks, snapshots, lint,
  typechecks, and clean review support the claim but never replace proof of a
  changed runtime, workflow, queue, API, UI, package, or integration path. On
  this Windows host, proof for those surfaces uses Docker-backed Crabbox
  `local-container` and records the current head, provider, image, lease,
  artifact, and limits. Use the narrowest meaningful proof first and broaden
  it for shared or higher-risk behavior. Docs-only changes normally need
  `git diff --check` and relevant link or command sanity instead.
- For lifecycle/review publication, queue/workflow, status/telemetry, or
  dashboard data-contract changes, state in the PR or handoff whether
  OpenClaw Bay is affected. If it is, update Bay and its proof; otherwise
  record why no Bay change is needed. OpenClaw Bay is a public, indexable,
  observer-only surface: it may display status and provide view-only navigation
  to verified-public GitHub repository, item, workflow-run, and job pages. Those
  canonical GET links are references, not action controls. Bay must never call
  GitHub from the browser or trigger or offer queue, workflow, GitHub, DLQ,
  recovery, deploy, rollback, or other mutation controls.
- A ClawSweeper result that requires proof or identifies an accepted/actionable
  finding remains PR-owner work, not a handoff. Before a manually requested
  review or re-review, put current proof and the finding disposition or evidence
  in the main PR body. A head or PR-body change after the durable review marker
  makes that review and any affected proof stale: rerun the affected proof and
  obtain a review for the current head and body. CI, labels, readiness, and
  maintainer permissions are evidence only; the explicit-user-approval boundary
  below still controls landing.
- Before merge or automerge, the latest ClawSweeper review must apply to the
  current PR head and body. Resolve every accepted finding. Apply each
  applicable `Rank-up moves:` item, or explicitly justify the exception in the
  PR body; Rank-up moves remain optional and do not by themselves block merge.
  Do not merge while proof is missing or while the review has an unresolved
  contributor-facing blocker.
- Land only after the current review and status evidence is ready for
  maintainer look, including `proof: sufficient` or `proof: override` when the
  proof label applies. This does not replace the user's explicit merge approval
  in the current conversation; agents must not merge or enable/execute
  automerge without it.

## Commands

```bash
corepack enable
pnpm install
pnpm run build
pnpm run test:unit
pnpm run format
pnpm run check
```

Use `pnpm run check` before handoff for code/test/workflow changes.

`engines.node` is `>=24`. Node 22 will install (no `engine-strict`) but the
notifier tests' 5-second retry paths surface as `cancelledByParent` under the
old `node:test` runner. Run on Node 24 or newer before reporting test
failures.

## GitHub Checks

Useful live probes:

```bash
gh run list --repo openclaw/clawsweeper --limit 20 --json databaseId,displayTitle,status,conclusion,createdAt,updatedAt
gh api repos/openclaw/clawsweeper/readme --jq '.content' | base64 --decode
gh api graphql -f query='query { repository(owner:"openclaw", name:"openclaw") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }'
```

For throughput/default tuning, start with `config/automation-limits.json` and
[`docs/limits.md`](docs/limits.md). `scripts/check-limits.ts` identifies the
derived docs, Worker values, and the `workflow_dispatch` literals that must stay
aligned. Effective exact-review admission, publication, and batching overrides
live in `dashboard/wrangler.toml`; owning fallback behavior lives in
`dashboard/exact-review-queue.ts`. Update `.github/workflows/sweep.yml` or
`src/clawsweeper.ts` only when the changed contract is actually owned there.

Use [`docs/README.md`](docs/README.md) for the documentation map, lifecycle
states, role ownership, and cross-surface update triggers.
