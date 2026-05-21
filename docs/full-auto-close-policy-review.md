# Full auto-close policy — observation review

**Policy enabled:** 2026-05-15 (commit `04dcc9fb4b`)
**First review window:** 2026-05-19 (Tuesday, ~10:00 SAST)

## What changed

Before: maintainer-authored items (OWNER/MEMBER/COLLABORATOR) were short-circuited to keep-open. Only non-maintainer items could auto-close.

After (commit `04dcc9fb4b feat(repair): enable full auto-close on configured reasons`):
- Removed the maintainer-author short-circuit in `src/clawsweeper.ts` (`reviewActionForDecision` + apply pipeline).
- Dropped the blanket OWNER/MEMBER/COLLABORATOR keep-open rule in `prompts/review-item.md`. **Protected labels still hard keep-open.**
- Populated `apply_close_rules` in `config/target-repositories.json` for all four targets (issues + PRs):
  - issue: `implemented_on_main`, `duplicate_or_superseded`, `cannot_reproduce`, `incoherent`, `not_actionable_in_repo`, `stale_insufficient_info`
  - pull_request: `implemented_on_main`, `mostly_implemented_on_main`, `duplicate_or_superseded`, `cannot_reproduce`, `incoherent`, `not_actionable_in_repo`

Smoke proven on `valkyriweb/clawsweeper#4,6,8,9,10` (run `25942677509`).

## What to check on 2026-05-19

1. **List every issue + PR closed by `valkyriweb-clawsweeper[bot]` between 2026-05-15 and review date** across the four active targets (`bermont-digital/multica`, `valkyriweb/clawsweeper`, `CLIP-SA/core-ai`, `CLIP-SA/core-wholesale`):

   ```bash
   for repo in bermont-digital/multica valkyriweb/clawsweeper CLIP-SA/core-ai CLIP-SA/core-wholesale; do
     echo "=== $repo ==="
     gh search issues "repo:$repo closed:>=2026-05-15 commenter:app/valkyriweb-clawsweeper is:closed" \
       --json number,title,closedAt,author,repository,state,url \
       --jq '.[] | "\(.closedAt) #\(.number) [\(.repository.nameWithOwner)] \(.title) — \(.url)"'
   done
   ```

2. **For each: triage as one of**
   - **Correct close** — record nothing, move on.
   - **False positive** — note the `close_reason` and item characteristics. The corrective lever is `apply_close_rules` in `config/target-repositories.json`. Narrow that reason for that target (or all targets) before doing another sweep. **Do not roll back the maintainer-author change unless multiple reasons misfire across multiple repos.**
   - **Edge case** — keep the close but file a tightening issue (review prompt change, new keep-open label, etc).

3. **If anything was closed by a maintainer-authored item, flag specifically.** That's the new blast radius.

4. **Update this doc** with the verdict (no-op / narrowed / rolled-back) and the date.

## Rollback path (in priority order)

1. **Narrow `apply_close_rules`** in `config/target-repositories.json` — surgical, per-target, per-reason. Cheapest.
2. **Add a new protected label** (or label rule) for the failing item class.
3. **Tighten `prompts/review-item.md`** keep-open conditions — affects review verdicts, not just apply.
4. **Restore the maintainer-author short-circuit** in `src/clawsweeper.ts` — nuclear. Only if 1–3 don't contain the bleed.

## Planner-side follow-up (2026-05-21)

May-15 removed the maintainer-author short-circuit from the **apply** pipeline
but left it in place in the **planner** (`shouldPlanItem`). That meant
maintainer-authored items never reached review at all, even though the apply
guard would now have made closure safe. Today's fork ran personal/ops repos
where every issue is maintainer-authored, so the planner skip effectively
disabled review.

This was completed by making the planner filter per-target opt-in:

- `config/target-repositories.json`: each profile gets an optional
  `include_maintainer_authored: boolean` flag (default false preserves the
  upstream skip).
- `valkyriweb/openclaw-claude`, `valkyriweb/clawsweeper`, `valkyriweb/lue-kube`,
  `valkyriweb/pi-mono`, `valkyriweb/openclaw` opt in (these are Luke's
  personal/ops repos where every issue is OWNER-authored).
- Client targets (`bermont-digital/multica`, `CLIP-SA/core-ai`,
  `CLIP-SA/core-wholesale`) stay opted-out so bot review comments don't appear
  publicly on Luke's own issues in shared client repos.
- `CLAWSWEEPER_INCLUDE_MAINTAINER_AUTHORED=true` (accepts `true`/`1`/`yes`)
  is a fleet-wide override.

The item #1851–1877 region of `src/clawsweeper.ts` documents the gate and
resolution order: protected labels still hard-block before any opt-in is
consulted.

Rollback step 4 ("restore the maintainer-author short-circuit") still applies
as the nuclear lever: clear `include_maintainer_authored` from every
configured profile and unset the env var.

## Useful URLs

- Policy commit: https://github.com/valkyriweb/clawsweeper/commit/04dcc9fb4b
- Apply-guard fix: https://github.com/valkyriweb/clawsweeper/commit/d3ea5c3019
- Selector durability fix: https://github.com/valkyriweb/clawsweeper/commit/9c53db51d6
- Smoke proof: https://github.com/valkyriweb/clawsweeper/actions/runs/25942677509
