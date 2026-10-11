# Issue review advisory labels

ClawSweeper reviews remain proposal-only. Structured review fields describe a
possible human implementation; they do not dispatch a repair worker or create a PR.

Reports store the lane fields in frontmatter:

- `item_category`
- `reproduction_status` and `reproduction_confidence`
- `requires_new_feature`, `requires_new_config_option`, and
  `requires_product_decision`
- `vision_fit`, `vision_fit_evidence`, and `implementation_complexity`
- `auto_implementation_candidate`: `none`, `strict_bug`, or `vision_fit`
- `work_candidate`: `none`, `manual_review`, or `queue_fix_pr`
- `work_status`: `none`, `manual_review`, or `candidate`
- `work_priority` and `work_confidence`
- `work_cluster_refs`, `work_validation`, and `work_likely_files`


For open issues with complete, current kept-open reviews, apply/comment-sync
also projects a small owned set of advisory GitHub labels from the same
structured fields. Comments explain the evidence; labels expose routing state
for GitHub issue lists, searches, and project views. These labels do not
dispatch repair, merge, or close work. Existing unrelated labels remain untouched.
Failed or stale reports are skipped so outdated review conclusions do not mutate
live issue labels.
Close proposals are not label-mutated during apply, so advisory label writes do
not advance an issue's `updated_at` before close eligibility gates have finished.
When ClawSweeper does sync labels, the report frontmatter records
`labels_synced_at`. The scheduler treats `updated_at` values up to that timestamp
as ClawSweeper-owned churn, similar to durable review comment syncs, so a
label-only apply pass does not immediately queue another review of the same item.

| Label                                 | Source condition                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawsweeper:current-main-repro`      | `type: issue`, `reproduction_status: reproduced`, and `reproduction_confidence: high`                                                                                                                                   |
| `clawsweeper:source-repro`            | `type: issue`, `reproduction_status: source_reproducible`, and `reproduction_confidence: high`                                                                                                                          |
| `clawsweeper:not-repro-on-main`       | `type: issue`, `reproduction_status: not_reproduced`, and `reproduction_confidence: high`                                                                                                                               |
| `clawsweeper:needs-live-repro`        | `type: issue`, `reproduction_status: source_reproducible`, and reproduction confidence below high                                                                                                                       |
| `clawsweeper:needs-info`              | `type: issue`, `reproduction_status: unclear`, and reproduction confidence below high                                                                                                                                   |
| `clawsweeper:linked-pr-open`          | the live issue has an open GitHub closing-PR reference                                                                                                                                                                  |
| `clawsweeper:no-new-fix-pr`           | an open linked PR, manual-review lane, product decision, or security review means a new automated fix PR should not be queued                                                                                           |
| `clawsweeper:queueable-fix`           | `work_candidate: queue_fix_pr`, `work_status: candidate`, and `work_confidence: high`                                                                                                                                   |
| `good first issue`                    | an unlocked, current-main reproduced, high-confidence `bug` with `small` complexity, a strict-bug repair prompt plus validation steps, and no linked-PR, feature, config, product, security, or protected-label blocker |
| `clawsweeper:fix-shape-clear`         | high-confidence `queue_fix_pr` or `manual_review` work includes a repair prompt, likely files, or validation                                                                                                            |
| `clawsweeper:needs-maintainer-review` | `work_candidate: manual_review` or `work_status: manual_review`                                                                                                                                                         |
| `clawsweeper:needs-product-decision`  | `requires_product_decision: true`                                                                                                                                                                                       |
| `clawsweeper:needs-security-review`   | `item_category: security` or a `securityReview` status of `needs_attention`                                                                                                                                             |

When the advisory sync marks an issue `clawsweeper:queueable-fix`, it also adds
the target repository's durable `no-stale` exemption and removes an existing
`stale` label. Lower-confidence, manual-review, or otherwise non-queueable
advisory states do not receive stale protection from this sync. If a later sync
clears an existing `clawsweeper:queueable-fix` advisory label, it also clears
the `no-stale` exemption added for that queueable state; existing `no-stale`
labels without prior queueable advisory state are preserved as unrelated labels.

Except for that queueable-issue stale transition, the advisory-label sync owns
only the `clawsweeper:*` and issue-rating labels in this group. Reruns add labels
that match the latest report, remove stale labels from the owned group, and
preserve unrelated labels plus `good first issue`, `clawsweeper:human-review`,
`proof: sufficient`, and `proof: telegram-e2e`.

`good first issue` uses GitHub's standard label name, color, and description.
ClawSweeper keeps the bar narrower than merely "small": the bug must reproduce
on current main with high confidence, fit one focused PR, include both a repair
prompt and validation steps, and require no new feature, config, product,
security, or protected-label decision. The label is add-only because GitHub does
not expose current-label ownership. A human removal in the GitHub label timeline
is treated as an opt-out; a later human re-add clears that opt-out.

Historical work and implementation fields remain readable in stored review
records. Automatic issue implementation and operator promotion are retired.

