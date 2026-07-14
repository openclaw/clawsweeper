# Autonomous Mode

Autonomous mode is stricter than execute mode. You may do broader reasoning, but you still must not mutate GitHub directly.

Scope:

- Start only from refs in the job file and refs linked from those item bodies, comments, review threads, closing refs, commits, or PR descriptions.
- For `source: clawsweeper_commit` jobs, start from the embedded ClawSweeper
  commit report instead of issue/PR refs. Do not perform a broad second audit of
  the commit; verify the reported finding on latest `main`, then either emit one
  cluster-scoped `build_fix_artifact` for a narrow PR or return
  `needs_human`/blocked evidence explaining why no PR should be created.
- Do not run broad GitHub search unless the job explicitly says so.
- If the job includes `maintainer_calibration`, treat it as an explicit maintainer decision for that cluster. Use it to avoid stale `needs_human` outcomes, but do not bypass the normal merge gates, security boundary, review comments, Codex `/review`, or validation requirements.
- For a maintainer-calibrated open canonical PR that is not merge-ready yet, do not return only `keep_canonical`. Emit `fix_needed` plus `build_fix_artifact` with `status: "planned"`, `repair_strategy: "repair_contributor_branch"`, and `source_prs` containing that PR URL so the executor can rebase, fix, review, and push the existing PR branch.
- If any hydrated item is security-sensitive, quarantine that item with `route_security` and route it to central OpenClaw security triage. Do not mutate that item. Continue classifying unrelated non-security items, duplicate pairs, provider gaps, and ordinary bugs.
- Use the provided cluster preflight artifact and fix artifact as your starting inventory. It should include hydrated issue comments, PR review summaries, inline PR review comments, check state, merge state, touched files, and linked refs.
- Treat closed context refs as evidence, not targets. Do not emit close actions for them.
- If the cluster changed materially since preflight, block only the affected mutation. Keep classifying other items when the artifact is still current enough for non-mutating decisions.

Before drive mode:

1. Use the artifact's current `main` SHA when recommending a fix, merge, `fixed_by_candidate`, or post-merge closeout. For pure issue-dedupe against a still-open canonical issue, prove the canonical issue and duplicate targets are live and current instead of claiming current `main` behavior is fixed.
2. Use the preflight artifact hydration for every provided and linked issue/PR: bodies, issue comments, labels, state, checks, review state, inline review comments, merge state, linked refs, and touched files. Do not claim comments are missing when `comments_hydrated` or `review_comments_hydrated` shows they are present.
3. For every canonical or candidate PR, inspect review comments and issue comments from review bots including Greptile, Codex, Asile, CodeRabbit, Copilot, and similar automated reviewers when they are present in the artifact.
4. Address every actionable bot review finding in the fix path, prove it is non-actionable from the artifact, or mark only that PR/action `needs_human` with the exact unresolved comment/blocker. Do not treat a PR as merge-ready while an actionable bot finding is unresolved.
5. Classify each item as `canonical`, `duplicate`, `related`, `superseded`, `independent`, `fixed_by_candidate`, or `needs_human`.
   - Emit one action object per GitHub issue/PR ref. Never put comma-separated refs, ranges, or grouped target lists in `target`.
   - For related follow-up subclusters, either emit one `keep_related` action per open ref with that ref's `target_kind` and `target_updated_at`, or emit one cluster-scoped `fix_needed` action with `target: "cluster:<cluster_id>"` when the follow-up is a new cluster-level work item.
6. Identify the canonical path:
   - still-open canonical issue for pure duplicate routing;
   - already merged PR/commit on `main`;
   - open PR that is mergeable or repairable;
   - new fix PR needed because the bug is real and no viable PR exists.
7. For each useful open contributor PR, choose the repair path before merge or close:
   - if `pull_request.branch_writable` is true and the diff is narrow enough, plan to update that PR branch, address review/bot findings, rebase, run checks, then emit `merge_canonical` only after it is clean. A same-repo head branch is writable even when the raw `maintainer_can_modify` flag is false;
   - if `branch_writable` is false, the branch is unsafe, or the PR contains broad/unrelated churn, do not merge it and do not ask whether to wait. Emit a replacement `build_fix_artifact` / `open_fix_pr` plan that preserves the contributor's credit in `credit_notes`, PR body, and release-note context. Put every original contributor PR in `fix_artifact.source_prs` as a full `https://github.com/<owner>/<repo>/pull/<number>` URL;
   - when replacing a useful contributor PR, emit a blocked `close_superseded` comment that says ClawSweeper cannot safely update that branch, will carry the narrow fix forward separately, and will credit the contributor by username and PR URL. Keep `candidate_fix` null until the replacement PR exists; do not point `candidate_fix` at the same PR being closed.
8. Do not emit closure actions until the canonical path is explicit. If the cluster is over-broad, split it into subfamilies in the action matrix and use `keep_related`/`keep_independent` for clear non-targets instead of making the whole result `needs_human`.
9. When `require_fix_before_close` blocks an otherwise-clear duplicate/superseded closeout, use `status: "blocked"` and `blocked_by: "fix_first"`, then say the close is blocked on the canonical fix path or fix PR. Use `blocked_by: null` for every other action. If the item is clearly covered by an already-merged candidate PR or current `main`, `close_fixed_by_candidate` may stay `planned` with that merged candidate evidence. Prose alone never marks a fix-first blocker.
10. If an item is not a true duplicate, run a single-item review/check/decide path: keep it related or independent when that is clear, emit a narrow fix artifact when it is a real bug or provider gap with no viable PR, and use `needs_human` only for product-direction or trust-boundary decisions that remain after checking the artifact.

Low-signal PR cleanup:

- Use this path only when the job sets `triage_policy: low_signal_prs` and includes the low-signal PR policy.
- Emit `close_low_signal` only for open pull requests with boringly clear low-signal evidence from `instructions/low-signal-prs.md`.
- Use `classification: "low_signal"` and `target_kind: "pull_request"`.
- Do not require `canonical`, `duplicate_of`, or `candidate_fix` for `close_low_signal`; set them to `null`.
- Never close security-sensitive PRs, maintainer-authored/maintainer-reviewed PRs, assigned PRs, focused bug fixes, or PRs with active author/maintainer signal.
- If the PR needs technical correctness judgment beyond the low-signal category, keep it open as `keep_related` or `keep_independent` when that classification is clear; use `needs_human` only when the maintainer decision itself is unclear.

Instant close actions:

- Emit `close_duplicate`, `close_superseded`, `close_fixed_by_candidate`, or `close_low_signal` only for high-confidence covered items.
- Emit close actions with `status: "planned"` unless `require_fix_before_close` blocks the close. `close_fixed_by_candidate` is not blocked when the `candidate_fix` is an already-merged PR or the evidence proves the fix is already present on current `main`. In a true fix-first block, use `status: "blocked"` plus `blocked_by: "fix_first"` and explicitly mention the canonical fix path, replacement fix, or fix PR in `reason`, `comment`, or `evidence`. Set `blocked_by: null` otherwise. Do not use `executed`; execution is recorded by the applicator after it posts the comment and closes the item.
- Never emit close actions for targets whose live state is closed. If a closed target needs to appear in the matrix, use `keep_closed` with `status: "skipped"`.
- Include `target_updated_at`, `target_kind`, `canonical` or `candidate_fix`, contributor-credit preserving `comment`, evidence, and a stable `idempotency_key`.
- Set `depends_on` to `null` unless the closure must wait for other planned closure targets in the same canonical group. When ordering is required, list only refs that have their own planned closure action; never list the canonical root or an unrelated item.
- In action fields, `canonical`, `duplicate_of`, and `candidate_fix` must be explicit refs like `#61741`. Do not put a year, timestamp fragment, unrelated number, or only a prose URL in those fields.
- Do not put an unhydrated ref in `canonical`, `duplicate_of`, or `candidate_fix`. If a PR is mentioned only in comments or prior ClawSweeper Repair notes but is not present in the preflight item matrix, mention it in evidence or the fix artifact instead and leave `candidate_fix` null until the planner hydrates it.
- `target` must be exactly one issue/PR ref like `#61741` or one cluster fix target like `cluster:<cluster_id>`. Do not group multiple refs in one action.
- Leave independent or related reports open as `keep_independent` or `keep_related`. Use `needs_human` only when choosing among viable canonical paths, merge paths, or contributor-credit tradeoffs requires maintainer judgment.
- Do not suppress duplicate closeout only because another linked ref is security-sensitive. `route_security` the security ref and close only unrelated non-security duplicates that satisfy all closure gates.

Fix artifact actions:

- If no viable canonical PR exists and the bug still appears real from the artifact, emit `fix_needed` plus `build_fix_artifact` even when the current job cannot open the fix PR. Do not escalate solely because `allow_fix_pr` is false.
- If the best canonical PR is useful but not merge-ready because it is draft, unmergeable, stale, uneditable, has `maintainer_can_modify=false`, or has broad/unrelated churn, treat it as non-viable for automation and replace it with a narrow credited fix PR. This is not a `needs_human` decision when the job allows fix PRs; maintainers already chose the replacement policy.
- Provider support gaps, missing model capability routing, and ordinary feature gaps reported as bugs should become a fix artifact when the artifact shows expected behavior and the patch can stay narrow.
- `validation_commands` must be executable commands using the target repo's package manager. The hard local gate is whichever command the target repository declares in `config/target-repositories.json#changed_gate` — for `openclaw/openclaw` that is `pnpm check:changed`, and for repositories with `changed_gate: null` (e.g. `openclaw/clawhub`, which is bun-based) emit only the project's own validation commands such as `bun run check`. Do not emit `pnpm check:changed` against non-`openclaw/openclaw` repos. Focused tests may be listed as helpful context but the executor may normalize them to the configured changed gate to avoid blocking on unrelated flaky main CI. Do not emit `npm run validate` because that script does not exist in `openclaw/openclaw`. Put manual browser checks and prose test plans in `pr_body`, `credit_notes`, or action evidence, not in `validation_commands`.
- For `openclaw/openclaw`, do not ask the executor to edit `CHANGELOG.md` during normal repair work. Preserve release-note context in `credit_notes`, PR body/history, source links, commit messages, or co-author trailers instead. Never add forbidden `Thanks @codex`, `Thanks @openclaw`, or `Thanks @steipete` changelog attribution.
- The `build_fix_artifact` action target is the cluster, not an issue or PR; set `target` to `cluster:<cluster_id>` and `target_kind`/`target_updated_at` to `null`. The action must include affected surfaces, likely files, linked issues/PRs, validation commands, release-note context, credit notes, and a PR title/body plan.
- If replacing a contributor PR, `fix_artifact.repair_strategy` must be `replace_uneditable_branch`, `fix_artifact.source_prs` must include the original full PR URL, `fix_artifact.branch_update_blockers` must explain why the branch cannot be safely updated, `fix_artifact.credit_notes` must name the original author and PR URL when known, `pr_body` must explain the borrowed/credited idea, and `changelog_required` should be false for `openclaw/openclaw` because release automation generates `CHANGELOG.md`.
- Set `fix_artifact.allow_no_pr` to `false` for normal fix/replacement PRs. Use `true` only for an explicitly audited no-PR outcome.
- The fix plan must be narrow: list only the files expected to change, focused tests, review-bot findings to address, and the exact branch/PR that could not be updated if applicable.
- Do not emit an executable fix PR path for broad feature/config/docs rewrites. If the fix needs many implementation files plus config/schema/docs/tests, split it into narrower follow-up jobs or mark the implementation blocked with exact sub-scopes; ClawSweeper Repair should not spend a 30-minute executor window on a broad product feature.
- If a target checkout is unavailable or unsafe, do not pretend to patch. Return the artifact and mark only implementation as blocked; keep classification decisions non-mutating when possible.

Merge and post-merge close:

- Recommend `merge_canonical` only when security-sensitive concerns are cleared, all actionable PR comments and review threads are resolved, review state, conflicts, release-note context, and changed-surface validation are clean, and the job permits merge. Unrelated flaky main CI does not block if `pnpm check:changed` and diff checks pass for the current branch. Failing checks block merge/fixed-by-candidate closeout only when the failure is plausibly caused by the candidate branch; they do not automatically block `keep_related`, `keep_independent`, or `fix_needed`.
- If the job is calibrated for finalization, treat stale branches, unknown/unstable merge state, failing relevant checks, and missing review proof as repair work for the executor: rebase/refactor narrowly, rerun review, address bot/human comments, and only then merge or block with concrete proof.
- A calibrated canonical PR that needs repair must produce an executable fix artifact. Use `repair_contributor_branch` when `maintainer_can_modify=true`; use `replace_uneditable_branch` or `new_fix_pr` only when the existing branch cannot be safely updated.
- Before recommending a merge, review actionable PR comments, address required changes or state why they are blocked, prefer a narrower refactor over broad churn, and rebase against current `main` when the branch is stale.
- Bot review comments count as required review comments. Greptile, Codex, Asile, CodeRabbit, Copilot, and similar automated reviewer findings must be addressed, proven non-actionable, or escalated.
- Run a Codex review first using `/review`, address every finding, and include the clean result in `merge_preflight.codex_review`. Do not recommend merge from a stale or missing Codex review.
- For every merge action, include `merge_preflight` for that target proving `security_status: "cleared"`, `comments_status: "resolved"`, `bot_comments_status: "resolved"`, a passed `/review`, addressed findings, validation commands, and concrete evidence.
- After a canonical PR lands, reclassify duplicate closeout against the landed PR or commit instead of assuming the pre-merge plan is still valid.
- Recommend `post_merge_close` only after a canonical fix is merged or already present on current `main`.
- Preserve contributor credit in all closeout comments.

Required result shape:

- `canonical`, `canonical_issue`, or `canonical_pr` with full URL when known.
- Per-item action matrix in `actions`.
- `merge_preflight` object for every merge action.
- Evidence and command/result summary in action evidence.
- `fix_artifact` object when a fix path is needed.
- `needs_human` entries only for decisions that remain ambiguous after using the hydrated artifact. Missing permissions or failing checks should usually become blocked/non-mutating actions with exact evidence, not blanket cluster escalation.

Return structured JSON only. Do not close, comment, label, merge, push, or open PRs directly.
