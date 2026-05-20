# Safe ramp for valkyriweb ClawSweeper

Read when restarting Luke's ClawSweeper fork after a pause, especially when Codex token burn is the risk.

This fork is deliberately configured for a slow ramp:

- `workers.max = 5`, so broad manual review defaults to 3 shards and scheduled background work gets 1 shard after reserves.
- Dashboard Runner Lane has a `paused` mode: `['self-hosted', 'clawsweeper-paused']`.
- `valkyriweb/openclaw` is intentionally not scheduled during the ramp. Do not use it for smoke tests.
- Mutation lanes should stay off until read-only review is boring.

## Safe target order

Use these before anything larger:

1. `valkyriweb/openclaw-claude` — low-risk ops/release hub target for release-risk, docs-state, and workflow triage.
2. `valkyriweb/clawsweeper` — self-review, but watch recursion/noise.
3. `valkyriweb/lue-kube` — ops repo; manual exact items only.
4. `valkyriweb/pi-mono` — larger active fork; only after the first three look sane.

Avoid during ramp:

- `valkyriweb/openclaw` — explicitly excluded for now.
- `bermont-digital/multica` — real product repo; keep manual-only until review quality is trusted.
- commit review — can scale with pushes and should be enabled last.
- repair/comment-router/automerge — mutations should be enabled only after read-only review is boring.

## Current safe defaults

```bash
gh variable set CLAWSWEEPER_RUNNER_LABELS \
  --repo valkyriweb/clawsweeper \
  --body '["self-hosted","clawsweeper-paused"]'

gh variable set CLAWSWEEPER_ALLOW_AUTOMERGE \
  --repo valkyriweb/clawsweeper \
  --body 0

gh variable set CLAWSWEEPER_ALLOW_EXECUTE \
  --repo valkyriweb/clawsweeper \
  --body 0

gh variable set CLAWSWEEPER_ALLOW_FIX_PR \
  --repo valkyriweb/clawsweeper \
  --body 0

gh variable set CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS \
  --repo valkyriweb/clawsweeper \
  --body 0
```

## Phase 1 — one exact read-only item

Only enable the main sweep workflow and one runner lane for the duration of the run.
Pick an `openclaw-claude` item that asks for release-risk triage, docs/state cleanup,
or workflow review. Good canaries ask ClawSweeper to classify operational risk;
they should not require code edits or cluster mutations.

```bash
gh workflow enable sweep.yml --repo valkyriweb/clawsweeper

gh variable set CLAWSWEEPER_RUNNER_LABELS \
  --repo valkyriweb/clawsweeper \
  --body '["self-hosted","macOS","ARM64","mac-mini"]'

gh workflow run sweep.yml \
  --repo valkyriweb/clawsweeper \
  -f target_repo=valkyriweb/openclaw-claude \
  -f item_number=REPLACE_WITH_ONE_ISSUE_OR_PR \
  -f batch_size=1 \
  -f shard_count=1 \
  -f apply_existing=false \
  -f apply_after_review=false \
  -f hot_intake=false
```

After the run finishes, pause immediately:

```bash
gh variable set CLAWSWEEPER_RUNNER_LABELS \
  --repo valkyriweb/clawsweeper \
  --body '["self-hosted","clawsweeper-paused"]'

gh workflow disable sweep.yml --repo valkyriweb/clawsweeper
```

Review the run before scaling:

```bash
gh run list --repo valkyriweb/clawsweeper --limit 5
gh run view --repo valkyriweb/clawsweeper RUN_ID --log > /tmp/clawsweeper-ramp-run.log
```

## Phase 2 — tiny exact batch

Same as phase 1, but use an explicit short list and keep one shard:

```bash
gh workflow run sweep.yml \
  --repo valkyriweb/clawsweeper \
  -f target_repo=valkyriweb/openclaw-claude \
  -f item_numbers=123,456,789 \
  -f batch_size=1 \
  -f shard_count=1 \
  -f apply_existing=false \
  -f apply_after_review=false \
  -f hot_intake=false
```

## Phase 3 — one scheduled repo

Only after manual exact runs look cheap and useful:

1. Keep repair/comment-router/commit-review disabled.
2. Enable `sweep.yml` only.
3. Keep `workers.max = 5`.
4. Let the daily cron run for `valkyriweb/openclaw-claude` first.
5. Review whether ClawSweeper correctly treats release logs, `docs/releases.md`, `docs/issues.md`, plans, state logs, and methodology TODOs as operational context rather than stale clutter.
6. Reassess dashboard, runs, and token usage before adding another repo.

## Scale-up checklist

Move one notch at a time:

- `workers.max: 5 -> 10 -> 20`, never straight back to 57.
- scheduled repos: one repo for 24h, then two, then three.
- mutations: `ALLOW_* = 0` until read-only review is boring.
- repair/comment-router: enable only after a real maintainer command needs it.
- commit-review: last; it can spend on every pushed commit.

## Emergency stop

```bash
gh variable set CLAWSWEEPER_RUNNER_LABELS \
  --repo valkyriweb/clawsweeper \
  --body '["self-hosted","clawsweeper-paused"]'

gh workflow disable sweep.yml --repo valkyriweb/clawsweeper
gh workflow disable repair-comment-router.yml --repo valkyriweb/clawsweeper
gh workflow disable repair-cluster-worker.yml --repo valkyriweb/clawsweeper
gh workflow disable repair-issue-implementation-intake.yml --repo valkyriweb/clawsweeper
gh workflow disable verify-reproduction.yml --repo valkyriweb/clawsweeper
gh workflow disable commit-review.yml --repo valkyriweb/clawsweeper
```
