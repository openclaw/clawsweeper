# Work Lane

ClawSweeper reviews remain proposal-only. A review may now mark an open item as
a `queue_fix_pr` work candidate when the report looks valid, narrow, and safe
for a single ClawSweeper repair PR.

Reports store the lane fields in frontmatter:

- `item_category`
- `reproduction_status` and `reproduction_confidence`
- `requires_new_feature`, `requires_new_config_option`, and
  `requires_product_decision`
- `work_candidate`: `none`, `manual_review`, or `queue_fix_pr`
- `work_status`: `none`, `manual_review`, or `candidate`
- `work_priority` and `work_confidence`
- `work_cluster_refs`, `work_validation`, and `work_likely_files`

The dashboard shows fresh `queue_fix_pr` reports whose `work_status` is
`candidate`. This is a manual promotion queue for the repair lane. For each
fresh candidate, apply/reconcile also generates
`records/<repo-slug>/plans/<number>.md` from the existing report fields. The
dashboard links both the source report and the generated coding plan so
maintainers can promote from a concise implementation view without editing the
durable report.

For open issues with complete, current kept-open reviews, apply/comment-sync
also projects a small owned set of advisory GitHub labels from the same
structured fields. Comments explain the evidence; labels expose routing state
for GitHub issue lists, searches, and project views. These labels do not
dispatch repair, merge, or close work, and they do not replace maintainer-owned
action labels such as `clawsweeper:autofix` or `clawsweeper:automerge`.
Failed or stale reports are skipped so outdated review conclusions do not mutate
live issue labels.
Close proposals are not label-mutated during apply, so advisory label writes do
not advance an issue's `updated_at` before close eligibility gates have finished.
When ClawSweeper does sync labels, the report frontmatter records
`labels_synced_at`. The scheduler treats `updated_at` values up to that timestamp
as ClawSweeper-owned churn, similar to durable review comment syncs, so a
label-only apply pass does not immediately queue another review of the same item.

| Label                                 | Source condition                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clawsweeper:current-main-repro`      | `type: issue`, `reproduction_status: reproduced`, and `reproduction_confidence: high`                                         |
| `clawsweeper:source-repro`            | `type: issue`, `reproduction_status: source_reproducible`, and `reproduction_confidence: high`                                |
| `clawsweeper:not-repro-on-main`       | `type: issue`, `reproduction_status: not_reproduced`, and `reproduction_confidence: high`                                     |
| `clawsweeper:needs-live-repro`        | `type: issue`, `reproduction_status: source_reproducible`, and reproduction confidence below high                             |
| `clawsweeper:needs-info`              | `type: issue`, `reproduction_status: unclear`, and reproduction confidence below high                                         |
| `clawsweeper:linked-pr-open`          | the live issue has an open GitHub closing-PR reference                                                                        |
| `clawsweeper:no-new-fix-pr`           | an open linked PR, manual-review lane, product decision, or security review means a new automated fix PR should not be queued |
| `clawsweeper:queueable-fix`           | `work_candidate: queue_fix_pr`, `work_status: candidate`, and `work_confidence: high`                                         |
| `clawsweeper:fix-shape-clear`         | high-confidence `queue_fix_pr` or `manual_review` work includes a repair prompt, likely files, or validation                  |
| `clawsweeper:needs-maintainer-review` | `work_candidate: manual_review` or `work_status: manual_review`                                                               |
| `clawsweeper:needs-product-decision`  | `requires_product_decision: true`                                                                                             |
| `clawsweeper:needs-security-review`   | `item_category: security` or a `securityReview` status of `needs_attention`                                                   |

The advisory-label sync owns only this label group. Reruns add labels that match
the latest report, remove stale labels from this group, and preserve unrelated
labels plus action/proof labels such as `clawsweeper:autofix`,
`clawsweeper:automerge`, `clawsweeper:human-review`,
`clawsweeper:merge-ready`, `proof: sufficient`, and
`mantis: telegram-visible-proof`.

Plan artifacts are generated state. They are removed when the item closes,
archives, becomes stale, or is reclassified away from `queue_fix_pr`; regenerate
them from the source report instead of editing them by hand.

## Reproducible Bug Auto-Implementation

The automatic issue implementation lane is stricter than the manual work queue.
It can create a PR only for reviewed issues that are exactly:

- `item_category: bug`, `regression`, or `docs`
- `reproduction_status: reproduced`
- `reproduction_confidence: high`
- `work_candidate: queue_fix_pr`
- `work_confidence: high`
- `requires_new_feature: false`
- `requires_new_config_option: false`
- `requires_product_decision: false`

This intentionally excludes mixed feature/config/product work. If a fix would
add a flag, setting, new mode, provider support, broad UX behavior, dependency,
or maintainer policy choice, the review must not classify it as an automatic
bug implementation candidate.

`regression` is accepted alongside `bug` so reviewer-tagged regressions such as
CI-break or generated-file-drift issues can flow through the same strict lane.
Fork divergence from upstream `openclaw/clawsweeper`, which restricts the lane
to `bug` only.

After review publish, `sweep.yml` scans the just-produced artifacts and dispatches
`repair-issue-implementation-intake.yml` for eligible reports when
`CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS=1`. The intake workflow re-fetches the
live issue, rejects protected/security/locked items, skips issues that already
have an open PR reference or existing ClawSweeper implementation PR, writes the
normal `source: issue_implementation` job, commits the ledger, then dispatches
`repair-cluster-worker.yml` in autonomous mode.

### Verify-Reproduction Lane

The strict lane above requires the reviewer to have already executed the
reproduction (`reproduction_status: reproduced`). Reviewer sandboxes do not
always run the target's build/test commands, so many otherwise-eligible
reports stop at `reproduction_status: source_reproducible` — confident from
source inspection but unverified live.

The verify-reproduction lane closes that gap. After review publish, `sweep.yml`
also dispatches `verify-reproduction.yml` for reports that match the strict
gate in every other way and have `reproduction_status: source_reproducible`
with `reproduction_confidence: high`. The verify worker:

1. Checks out the target repo at `main`.
2. Bootstraps its toolchain (`prepareTargetToolchain`).
3. Runs the reviewer's `work_validation` commands
   (`runAllowedValidationCommands`).
4. If any command fails: patches the report frontmatter to
   `reproduction_status: reproduced` plus `reproduction_verified_at` and
   `reproduction_verified_evidence`, commits the patch to the state repo, and
   dispatches `repair-issue-implementation-intake.yml`.
5. If all commands pass: leaves the report untouched and posts a
   could-not-reproduce comment on the source issue.

The verify lane reuses the strict intake invariants — only the accepted
`reproduction_status` differs. Every other blocker (protected labels,
security signal, attached PR, missing repair prompt, manual-review work
candidate, etc.) applies identically.

Comment-triggered issue implementation uses the same durable job format. If a
worker starts before the new state commit is visible in its checkout, the worker
reconstructs the minimal `source: issue_implementation` job from the job path
and continues instead of treating the dispatch as stale.

PRs created from this path are labeled `clawsweeper` and
`clawsweeper:autogenerated`. The lane is PR-only: it does not merge or close the
source issue. When a worker opens the PR from a maintainer command, it edits the
existing ClawSweeper command status comment with the generated PR link so the
same comment moves from queued to opened.

Promote a candidate from this checkout:

```bash
cd ~/Projects/clawsweeper
pnpm run repair:create-job -- \
  --from-report records/openclaw-openclaw/items/123.md
pnpm run repair:validate-job -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md
```

Commit and push the generated job, then dispatch `mode: autonomous` when the
execution window is intentionally open. The repair lane checks for an existing
open PR/body match and the `clawsweeper/<cluster-id>` branch before creating a
duplicate job.
