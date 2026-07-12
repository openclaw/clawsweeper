# ClawSweeper Automerge Flow

Read when: changing automerge routing, exact-head review gates, repair worker
shepherd waits, pending-check handling, merge comments, or operator replays.

## Purpose

Automerge is the bounded version of "review, fix, re-review, and merge" for a
single opted-in PR. It must be fast when the branch only needs a rebase, but it
must still be conservative: every merge is pinned to a reviewed head SHA, waits
for GitHub checks, and uses the comment router as the only final merge owner.

This page is the canonical behavior map. Shorter pages can summarize it, but
should not redefine the state machine.

## Actors

- **Comment router:** Reads maintainer commands and trusted ClawSweeper verdict
  comments. It owns labels, adopted job creation, repair dispatch, and final
  merge.
- **Event review workflow:** Reviews exactly one PR head and syncs one durable
  ClawSweeper review comment with hidden verdict markers.
- **Repair cluster worker:** Performs branch repair. For same-branch automerge
  repairs, it may push a deterministic rebase or a Codex-authored fix.
- **Shepherd wait:** A post-push wait inside the repair worker. It polls the new
  head for exact-head review and GitHub checks, then wakes the router.
- **Transient router wait:** A final pre-merge wait inside the comment router.
  It absorbs GitHub mergeability and check-status lag before deciding whether
  to merge, wait, block, or dispatch another repair.

## Happy Path

1. A maintainer comments `/clawsweeper automerge`.
2. The router adds `clawsweeper:automerge`, creates or reuses the adopted job,
   acknowledges in one status comment, and dispatches an exact-head review.
3. ClawSweeper posts a trusted pass marker for the current PR head.
4. The router verifies the pass marker names the current head SHA.
5. The router waits for required checks and transient mergeability.
6. If merge gates are open and the live PR is ready, the router squash-merges
   the exact reviewed head and edits the same status comment to the final merge
   result.

The final merge comment should summarize:

- what merged;
- any repair/fixup commits that were needed;
- the final merge commit link;
- the automerge progress timeline.

## Repair Path

If ClawSweeper finds an actionable issue, or GitHub reports a repairable live
state, the router dispatches the adopted repair worker instead of merging.

Repairable states include:

- `mergeable: CONFLICTING`;
- `mergeStateStatus: DIRTY`;
- `mergeStateStatus: BEHIND`;
- missing `CHANGELOG.md` entry for user-facing OpenClaw `fix`, `feat`, or
  `perf` PRs;
- terminal required-check failures such as `FAILURE`, `ERROR`,
  `ACTION_REQUIRED`, `STARTUP_FAILURE`, or `TIMED_OUT`;
- accepted ClawSweeper repair verdicts or action markers for the exact current
  head.

For base-sync-only work, the executor first tries the deterministic fast path:

1. fetch current `main`;
2. rebase the PR branch onto latest `main`;
3. apply known mechanical conflict resolvers;
4. push the repaired branch;
5. dispatch exact-head review for the new head;
6. shepherd until the head is ready or terminally blocked.

Known mechanical resolvers currently cover isolated `CHANGELOG.md` conflicts
and generated config checksum conflicts where the replayed commit changed only
selected checksum entries. That deterministic fast path is only for explicit
base-sync-only artifacts.

For adopted PR repairs that add only docs or changelog files after the reviewed
source head, ClawSweeper runs repair-delta validation and skips the internal
Codex `/review`. The exact-head ClawSweeper review and GitHub checks still gate
the pushed head before merge.

For adopted automerge/autofix PR repairs, the cluster worker skips the
read-only Codex planning pass after it hydrates the live PR. It writes a generic
structured `build_fix_artifact` result deterministically: repair the contributor
branch, keep the source PR credited, rebase onto latest `main`, address PR
comments/review findings/check failures, add the changelog entry when required,
and validate. This removes one model round trip from every opted-in repair while
keeping live evidence, permissions, security boundaries, push, review, checks,
and merge gating in deterministic code.

For automerge, failed exact-head checks are repair scope even when the failing
file is outside the original PR's changed files. The Codex edit pass should
first rebase to latest `main`, inspect the check logs, then either fix the
narrow failure on the branch or prove that current `main` is independently
blocked.

The executor fetches the current base and contributor branch, prepares the
target toolchain, then prompts Codex to do the edit work directly. Codex may use
read-only `gh` for comments, review threads, check status, and check logs; it
must keep iterating until the checkout is merge-ready or an external blocker is
proven. GitHub mutations still stay with the deterministic executor.

The Codex prompt treats artifact validation commands as hints for automerge
repair, with the local gate driven by each target repository's
`config/target-repositories.json#changed_gate`: `pnpm check:changed` for
`openclaw/openclaw`, and the project's own commands (e.g. `bun run check` for
`openclaw/clawhub`) when `changed_gate` is `null`. Adopted
OpenClaw automerge repairs strengthen that local gate to strict validation and
also require `pnpm lint` plus `pnpm check:test-types` before push, because
maintainer automerge opt-in means ClawSweeper should keep fixing terminal CI
failures rather than handing back another red head. The executor still re-runs
the normalized gate as the authority before push; if anything remains, it feeds
the full failure back into a dedicated validation-fix pass before spending the
next review attempt.

The executor materializes those commands as a deterministic staged proof DAG.
Exact argv are deduplicated, narrow path-scoped tests run before broader gates,
and elevated-risk surfaces retain stronger configured or artifact-supplied
proof. Repository integrity and the canonical changed-surface gate are
mandatory. Broad, live, docker, or e2e commands run last, and can be skipped
only by an exact repository-owned subsumption contract. A failed prerequisite
stops later work and writes bounded digest-only trace entries to the repair
report and merge preflight.

## Exact-Head Rule

Every automerge decision is bound to a concrete PR head SHA.

- A trusted pass marker can merge only the SHA it names.
- A repair push changes the head SHA and invalidates older pass markers.
- A re-review is required after every repair push.
- The router skips stale trusted markers instead of merging a later head.
- A later trusted pass for the exact current head can clear stale pause labels
  from an earlier failed or cancelled review; `/clawsweeper stop` still wins.
- Merge commands use the reviewed head SHA so GitHub cannot merge a moved head
  accidentally.

This is why repair workers dispatch an immediate exact-head review after a
branch push instead of waiting for the normal scheduled sweep.

## Checks: Wait, Repair, Or Merge

Pending checks are wait states. They are not repair reasons.

The check summarizer separates three concepts:

- `pending`: required or relevant checks still running, such as
  `check-lint:IN_PROGRESS`;
- `terminalBlockers`: completed non-green checks, such as
  `check-lint:FAILURE`;
- ignored non-gating checks: default ignored automation such as
  `ClawSweeper Dispatch`, `Labeler`, `Stale`, and `auto-response`.

Rules:

- pending checks keep the router or shepherd waiting;
- terminal required-check failures can dispatch a repair;
- ignored non-gating checks do not block the merge attempt;
- if no check data exists yet, the router treats that as transient and waits;
- GitHub branch protection is still the final authority at merge time.

Pending checks must not appear in public status as "failed required checks".
That wording is reserved for completed terminal failures. Misclassifying
`IN_PROGRESS` as failure causes unnecessary repair runs and delays an otherwise
merge-ready PR.

## Two Wait Windows

There are two independent wait windows because the system can be woken from two
places.

**Repair worker shepherd**

- runs after the worker pushes an automerge branch repair;
- waits for exact-head review plus GitHub checks;
- default: `CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT_MS=600000`;
- poll: `CLAWSWEEPER_AUTOMERGE_SHEPHERD_POLL_MS=15000`;
- exits early on terminal check failure and dispatches the router so a focused
  failed-check repair can start;
- dispatches the router immediately when the repaired head is ready.

**Router transient wait**

- runs inside final merge preflight;
- waits for pending checks, no-checks-yet states, `mergeable: UNKNOWN`,
  `mergeStateStatus: UNKNOWN`, `mergeStateStatus: UNSTABLE`, and
  `reviewDecision: REVIEW_REQUIRED` lag;
- default: `CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS=600000`;
- poll: `CLAWSWEEPER_AUTOMERGE_TRANSIENT_POLL_MS=15000`;
- returns `waiting` if the transient window expires without a terminal decision;
- dispatches repair only for terminal check failures or known repairable
  mergeability states.

The two waits make the fast path responsive without keeping a Codex edit session
alive for normal GitHub CI latency.

## Duplicate And Race Guards

The loop is intentionally idempotent.

- One adopted job path per opted-in PR:
  `jobs/<owner>/inbox/automerge-<owner>-<repo>-<pr>.md`.
- One mutable automerge status comment per PR/head/intent family.
- One durable review comment edited in place.
- Comment-router ledger keys use comment id plus `updated_at`.
- Response markers include the PR head SHA.
- Before dispatching repair, the router and repair dispatchers check for an
  active run with the same adopted job path. If one exists, the router records
  the dispatch action as `active` and keeps the command open without enqueueing
  another repair; batch dispatchers skip that job.
- Repair workers still keep a workflow concurrency group for the same job path
  as a last-resort race guard.
- Automatic repairs are capped by
  `CLAWSWEEPER_MAX_REPAIRS_PER_PR` and
  `CLAWSWEEPER_MAX_REPAIRS_PER_HEAD`.

If a stale queued repair was created from an old interpretation of check state,
it is safe to cancel it once a newer exact-head pass and green checks are
visible. Do not repair foreign PR branches manually; wake or fix ClawSweeper.

## Operator Replay

After a router or parser fix, replay the exact trusted comment instead of
posting another maintainer command:

```bash
gh workflow run repair-comment-router.yml \
  --repo openclaw/clawsweeper \
  --ref main \
  -f execute=true \
  -f force_reprocess=true \
  -f target_repo=openclaw/openclaw \
  -f item_numbers=<pr-number> \
  -f comment_ids=<trusted-comment-id>
```

Use this when the durable ClawSweeper review comment already has the right
exact-head pass marker. The replay should either merge, wait, or report a true
terminal blocker. It should not create another repair worker for pending checks.

## Verification Checklist

Before shipping automerge routing changes:

```bash
pnpm run build:repair
pnpm exec node --test test/repair/comment-router-core.test.ts test/repair/comment-router-utils.test.ts test/repair/automerge-shepherd.test.ts
pnpm run check
```

Live verification for an opted-in PR:

1. Confirm the PR head SHA.
2. Confirm the durable ClawSweeper review comment has a pass marker for that
   exact SHA.
3. Confirm required checks are green or pending, not failed.
4. Run or wait for the router.
5. Confirm the status comment was edited in place.
6. Confirm the final merge commit is linked when merged.

If a PR is green and exact-head reviewed but does not merge, inspect the router
report and logs before dispatching another repair.
