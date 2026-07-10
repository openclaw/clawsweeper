# Auto-Updating ClawSweeper PRs

Read when: changing ClawSweeper PR repair automation, ClawSweeper review
integration, comment routing, duplicate dispatch guards, or generated-PR
marking.

## Goal

ClawSweeper-created PRs and maintainer-opted existing PRs should keep improving
after they are opened. When ClawSweeper reviews an opted-in PR and leaves
actionable feedback, ClawSweeper can dispatch the backing job again and update
the existing branch when safe. It must not create another PR for the same issue
cluster unless the source branch cannot be safely updated, and it must not
react to ordinary contributor comments.

The loop is intentionally small:

1. ClawSweeper opens `clawsweeper/<cluster-id>` or a maintainer comments
   `/clawsweeper autofix` or `/clawsweeper automerge` on any open PR.
2. ClawSweeper dispatches ClawSweeper's item-specific `repository_dispatch` lane
   to review that PR head.
3. The comment router sees trusted ClawSweeper feedback.
4. ClawSweeper dispatches the existing or adopted job through
   `repair-cluster-worker.yml`.
5. The repair worker pushes another commit to the source branch if it finds a
   safe, narrow fix, or opens a credited replacement when the source branch
   cannot be safely updated.
6. ClawSweeper reviews the updated PR again.

For the full automerge state machine, including exact-head gating, pending
check handling, shepherd waits, router waits, and operator replay, see
[`automerge-flow.md`](automerge-flow.md).

## Trust Model

There are two accepted input lanes.

Maintainer commands:

- author association must be `OWNER`, `MEMBER`, or `COLLABORATOR` by default;
- when GitHub App tokens return a weaker association for a maintainer, the
  router falls back to repository collaborator permission and accepts `admin`,
  `maintain`, or `write` by default;
- supported commands are `/clawsweeper re-review`, `/clawsweeper fix ci`,
  `/clawsweeper address review`, `/clawsweeper rebase`, `/clawsweeper autofix`,
  `/clawsweeper automerge`, `/clawsweeper approve`, `/clawsweeper status`,
  `/clawsweeper explain`, and `/clawsweeper stop`;
- freeform maintainer mentions like `@clawsweeper why did automerge stop here?`
  dispatch a read-only assist review; action-looking prose still has to become
  an existing structured recommendation and pass deterministic gates;
- commands from contributors are ignored without a reply.

Trusted automation:

- author login must be in `CLAWSWEEPER_TRUSTED_BOTS`;
- default trusted bot logins are `clawsweeper[bot]` and
  `openclaw-clawsweeper[bot]`;
- the target must be a ClawSweeper PR or a PR labeled `clawsweeper:autofix` or
  `clawsweeper:automerge`;
- the action becomes `clawsweeper_auto_repair`.

The trusted automation lane exists only for review bots we control. It does
not treat random `@clawsweeper`, `@openclaw-clawsweeper`, or contributor prose as
permission to spend workers or push commits.

## Review Comment Shape

ClawSweeper comments are meant to be readable by maintainers and parseable by
ClawSweeper. The visible text should say whether the PR needs changes, what
change is required before merge, what acceptance criteria would prove the fix,
what evidence was checked, and what risk remains.

The hidden markers at the bottom are the automation contract. The router ignores
review prose for repair dispatch. The action marker is omitted for pass,
approved, needs-human, failed, or inconclusive reviews.

## ClawSweeper PR Markers

The router considers a PR to be from ClawSweeper when any of these are true:

- branch starts with `clawsweeper/`;
- the branch maps to a committed ClawSweeper repair job.

The branch prefix is the durable identity because it maps directly back to the
cluster id and job path. Labels are state and reporting hints, not identity.

## Autofix And Automerge Opt-In

Maintainers can opt any open PR into the bounded repair-only loop with:

```text
/clawsweeper autofix
```

The command adds `clawsweeper:autofix`, asks ClawSweeper to review the current
PR head, creates a durable adopted ClawSweeper job when the PR is not already
backed by one, and leaves an idempotent comment. Trusted repair markers can
repair or rebase the branch up to the configured round limit. Trusted pass
markers only report completion; autofix never merges.

Maintainers can opt any open PR into the bounded merge loop with:

```text
/clawsweeper automerge
/clawsweeper auto merge
```

The command adds `clawsweeper:automerge`, asks ClawSweeper to review the current
PR head, creates a durable adopted ClawSweeper job when the PR is not already
backed by one, and leaves an idempotent comment. The adopted job lives at
`jobs/<owner>/inbox/automerge-<owner>-<repo>-<pr>.md`; it lets the normal
repair worker update the contributor branch when GitHub says that is safe, or
open a credited replacement when it is not. `/clawsweeper stop` pauses the loop
by adding `clawsweeper:human-review`.

The status comment is edited in place through the whole loop. Its progress
section records review, repair, re-review, and merge rows with durations, run
links, and linked commit hashes. A branch repair that pushes a new commit also
dispatches the next exact-head review immediately from the repair worker, so the
loop does not wait for the scheduled comment-router sweep before checking the
repaired head. For base-sync-only blockers, the executor first tries a
deterministic rebase fast path and pushes that result without a Codex edit pass;
if the rebase or known mechanical conflict resolvers cannot finish cleanly, it
falls back to the normal Codex fix worker. The mechanical set includes
isolated `CHANGELOG.md` conflicts and generated config checksum conflicts where
the replayed commit changed only selected checksum entries.
If GitHub rejects a fork-branch repair push because the synchronized branch
would create or update workflow files without effective workflow permission, the
worker keeps the prepared repair and publishes it as a credited replacement PR
from the base repository instead of starting Codex over.

During Codex repair, changed-surface validation failures are loop inputs, not
immediate terminal outcomes. The executor feeds a failed `pnpm check:changed`
or diff-check result back into a narrow validation-fix prompt, checkpoints any
resulting edit, and then reruns validation plus Codex `/review`.

The status comment is also the audit surface for wait and repair decisions. It
must distinguish pending checks from failed checks: pending checks wait, while
completed terminal failures can dispatch repair.

After a successful same-branch repair push, the worker shepherds the PR for a
bounded window. It polls for the exact-head ClawSweeper pass marker and GitHub
checks on the repaired commit, then dispatches the comment router as soon as the
head is ready to merge. If checks fail terminally, the shepherd stops early and
dispatches the router for the failed-check repair path. Defaults are ten minutes
and 15-second polls; set
`CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT_MS=0` or
`CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT=0` to disable that wait.

If the repair worker completes without an executable fix artifact, the executor
posts an idempotent outcome comment on the opted-in PR. That comment records
that no branch push, rebase, replacement PR, merge, or ClawSweeper re-review
was started, and includes the worker summary plus planned/skipped actions.

Automerge has one explicit global merge gate:

```bash
CLAWSWEEPER_ALLOW_MERGE=1
```

If ClawSweeper passes the exact current head while the global merge gate is closed,
ClawSweeper labels the PR `clawsweeper:merge-ready` and comments instead of
merging.

Draft PRs can use either autofix or automerge for repair. A draft PR never
merges; an automerge-labeled draft remains fix-only until GitHub marks it ready
for review.

## ClawSweeper Trigger

Preferred ClawSweeper comments should include hidden verdict and action
markers:

```html
<!-- clawsweeper-verdict:needs-changes sha=<head-sha> finding=<id> -->
<!-- clawsweeper-action:fix-required sha=<head-sha> finding=<id> -->
```

Positive or human-only reviews should use a verdict marker without a repair
action:

```html
<!-- clawsweeper-verdict:pass sha=<head-sha> -->
<!-- clawsweeper-verdict:needs-human sha=<head-sha> -->
```

Accepted marker actions:

- `fix-required`
- `repair-required`
- `address-review`
- `fix-ci`

Accepted repair verdicts:

- `needs-changes`
- `changes-requested`
- `needs-repair`
- `fix-required`
- `repair-required`

`pass`, `approved`, and `no-changes` verdicts never repair. On a PR opted into
`clawsweeper:autofix` or `clawsweeper:automerge`, a pass verdict for the exact
current head ends the current repair round. Autofix never merges. Automerge can
merge only after required checks, mergeability, review state, non-draft status,
and the global merge gate are all green. `needs-human` and `human-review` pause
the loop by adding `clawsweeper:human-review`; a later trusted pass for the exact
current head clears stale pause labels and continues automerge. `/clawsweeper
stop` is stronger and also removes repair-loop labels so older automerge/autofix
comments cannot resume the loop. If ClawSweeper wants the bounded repair/rebase
loop to continue, it must emit an accepted repair verdict or action marker.

There is one narrow approval shortcut for existing reviews: if ClawSweeper's
`needs-human` text says no repair lane is needed and the maintainer action is to
land the canonical PR, a later maintainer `/clawsweeper automerge` on the same
head is treated as that approval. The router still applies the normal exact-head
merge gates and refuses security notes, P-severity findings, stale heads, draft
PRs, conflicts, failing checks, and the global merge gate being closed.

After a `needs-human` pause, `/clawsweeper approve` is a maintainer-only exact-head
approval. It clears pause labels and uses the same merge readiness checks and
global merge gate as a trusted ClawSweeper pass marker.

## Duplicate Guards

ClawSweeper has three layers of duplicate protection:

- job creation checks for an existing open PR or branch before writing a new
  job;
- the comment router writes an idempotency marker in its reply, records
  processed comment versions in `results/comment-router.json`, and edits one
  command-status reply in place per item, intent, and head SHA;
- scheduled router scans synthesize an internal repair-loop command for open
  PRs that still carry `clawsweeper:autofix` or `clawsweeper:automerge`, so
  stale labelled PRs can be repaired or re-reviewed without a fresh comment;
- a trusted, uniquely owned review-start marker leases an exact PR head or
  issue source revision until the worker's bounded timeout plus a ten-minute
  grace period. Scheduled label sweeps skip leased PR heads, while broad and
  event apply workers defer every leased item;
- current reports carrying an item revision plus the review lease owner and
  server comment ID acquire or reuse an owned mutation lease, revalidate the
  live revision and durable tuple before label, comment, and close phases, and
  release only that exact report-owned or transient apply lease after the item
  action. Legacy backlog reports without a complete tuple keep the prior apply
  path but still defer to active leases and newer durable verdicts;
- comment routing suppresses an older same-head verdict while a later lease is
  active, then admits only the replacement verdict carrying that lease's exact
  owner and comment identity;
- exact-event review results are published, applied, and routed only after the
  review succeeds and writes the expected fresh item artifact;
- trusted ClawSweeper repairs are capped per PR and per PR head SHA.

The default caps are ten automatic repair iterations per PR and two
auto-repair dispatches per PR head SHA:

```bash
CLAWSWEEPER_MAX_REPAIRS_PER_PR=10
CLAWSWEEPER_MAX_REPAIRS_PER_HEAD=2
```

That means many ClawSweeper comments on the same commit trigger at most two
repair runs, leaving room for one infrastructure retry without an operator
reset. If ClawSweeper pushes a new commit, the PR head SHA changes and a new
ClawSweeper finding can trigger another bounded repair run, until the PR reaches
ten automatic ClawSweeper-triggered repair iterations. The per-PR cap is total
across all head SHAs and stops the automatic review/repair loop even when every
iteration produces a new commit.

Runs for the same job path and mode share the `repair-cluster-worker.yml` concurrency
group, so repeated dispatches queue instead of racing the same branch.

For automerge activation and scheduled label sweeps, a dirty or behind merge
state is enough to dispatch repair. That lets Codex rebase or resolve conflicts
before the next exact-head review instead of waiting for a later pass marker or
new maintainer comment.

## ClawSweeper-Owned Conflict Self-Heal

The conflict self-heal lane is for open pull requests that ClawSweeper itself
owns. When enabled, it may dispatch a bounded repair for a PR only when all of these
are true:

- the author is the ClawSweeper GitHub App;
- the head branch is in the base repository and starts with `clawsweeper/`;
- the PR is open and the live merge state is `CONFLICTING`, `DIRTY`, or
  `BEHIND`;
- the exact head SHA is captured before dispatch and still matches when the
  worker starts;
- no waiting or dispatched self-heal attempt already covers that PR/head;
- the self-heal per-head and per-PR caps still allow another attempt.

Self-heal is repair-only. It does not add `clawsweeper:automerge`, it does not
request a merge, and it does not treat a successful rebase as approval. After a
successful push, the next required step is an exact-item ClawSweeper review for
the new head. The PR can merge only through the normal automerge gates or a
human maintainer path.

The self-heal scanner has dedicated attempt caps:

```bash
--max-attempts-per-pr 10
--max-attempts-per-head 2
```

The durable status comment records the detected merge state, targeted head SHA,
job path, repair run URL, and current status. The generated job uses
`job_intent: clawsweeper_self_rebase`, blocks close/merge/label actions, and
pins `expected_head_sha` so stale jobs stop without mutating. For dashboard
accounting, emit a `/api/events` payload whose event type, mode, stage, or
status contains `clawsweeper_self_rebase` or `conflict_self_heal`.

## Replacement Label Cleanup

Replacement PR labels must describe the replacement PR, not stale lifecycle
state from a source PR. Replacement creation filters source labels so it does
not copy `close:*`, `stale`, `rating:*`, `status:*`, `proof:*`,
`triage: needs-real-behavior-proof`, `triage: needs-pr-context`, `merge-risk:*`, `size:*`, or `P*`
priority labels.

Use the cleanup command to inspect existing open ClawSweeper replacement PRs
for inherited source labels:

```bash
pnpm run repair:cleanup-replacement-labels -- --repo openclaw/openclaw
```

The command writes `.artifacts/replacement-label-cleanup.json` by default. It
is dry-run by default. To remove lifecycle labels from matching PRs, pass
`--execute` with `CLAWSWEEPER_ALLOW_EXECUTE=1`; execute mode removes only
`stale` and `close:*` labels.

For dashboard accounting, publish the cleanup total through `pnpm run status`
with `--inherited-label-cleanups`, or send a `/api/events` payload whose event
type, mode, stage, or status contains `replacement_label_cleanup` or
`inherited_label_cleanup`.

ClawSweeper edits one durable review comment in place. The router keys its
ledger by comment id plus `updated_at`, and response markers include the target
PR head SHA, so an edited ClawSweeper comment can trigger a new repair after
ClawSweeper has pushed a new commit while unchanged comment versions remain
idempotent.

## Failure Behavior

The router does not dispatch when:

- the comment author is not trusted automation and is not a maintainer;
- the issue or PR is closed;
- the target is not a PR;
- the PR is neither a ClawSweeper PR nor labeled `clawsweeper:autofix` or
  `clawsweeper:automerge`;
- the PR cannot be mapped to or adopted into a job file;
- the same comment version was already processed;
- the same PR already reached the total auto-repair cap;
- the same PR head SHA already reached the per-head auto-repair cap;
- the ClawSweeper marker names a stale PR head SHA.

Automerge also refuses to merge when:

- `clawsweeper:automerge` is missing;
- `clawsweeper:human-review` is present;
- the pass marker does not name the reviewed head SHA;
- the PR is draft, not based on `main`, not mergeable, or has non-green checks;
- GitHub reports requested changes or required review;
- `CLAWSWEEPER_ALLOW_MERGE` is not `1`.

For automerge-labeled PRs, live mergeability blocks that are repairable are not
terminal. If GitHub reports `mergeable: CONFLICTING`, `mergeStateStatus:
DIRTY`, or `mergeStateStatus: BEHIND`, the router dispatches the adopted repair
worker to rebase or resolve conflicts, then requires a fresh exact-head
ClawSweeper pass before merge.

GitHub can report `mergeStateStatus: UNSTABLE` for cancelled or skipped
non-gating automation checks even when branch protection is satisfied. The
router summarizes checks first, ignores default non-gating checks such as
`auto-response`, `Labeler`, `Stale`, and `ClawSweeper Dispatch`, then allows the
exact-head merge command to try when no check blockers remain. The merge command
still pins the reviewed head SHA and GitHub branch protection remains the final
authority. Pending checks are treated as wait states, not repair triggers; only
terminal required-check failures can dispatch another repair pass. Transient
merge-state and check polling defaults to ten minutes; set
`CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS` to tune the window.

The detailed wait/repair/merge decision table lives in
[`automerge-flow.md`](automerge-flow.md#checks-wait-repair-or-merge).

For trusted automation comments, these blocked cases are silent skips. That
keeps ClawSweeper from replying to every ordinary contributor PR that
ClawSweeper reviews.

Security-sensitive reports stay out of this lane. Those should be routed to the
central OpenClaw security process rather than auto-repaired from review
comments unless the PR itself has an explicit maintainer `clawsweeper:autofix`
or `clawsweeper:automerge` opt-in. The automerge planner does not infer
security status from prose; it uses explicit security labels or structured
ClawSweeper security markers such as:

```html
<!-- clawsweeper-security:security-sensitive item=<pr> sha=<head-sha> -->
```

Opted-in security-sensitive PRs may receive bounded repair commits, including
linked replacement PRs that carry the same automation label. Merge still
requires a later clean exact-head ClawSweeper review and the normal automerge
gates.

## Implementation Map

Workflow:

- `.github/workflows/repair-comment-router.yml`

Scripts:

- `src/repair/comment-router.ts`
- `src/repair/comment-router-core.ts`
- `src/repair/comment-router-utils.ts`

Durable state:

- `results/comment-router.json`
- `results/comment-router-latest.json`

Important knobs:

- `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1` enables scheduled writes and dispatches;
- `CLAWSWEEPER_TRUSTED_BOTS` controls trusted automation authors;
- `CLAWSWEEPER_MAX_REPAIRS_PER_PR` controls total automatic repair
  iterations per PR; default `10`.
- `CLAWSWEEPER_MAX_REPAIRS_PER_HEAD` controls per-head repair caps;
  default `2`.
- `CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS` controls in-run merge-state and
  check polling before the router records a waiting automerge action; default
  `600000`.

## Verification

Syntax and workflow checks:

```bash
pnpm run check
actionlint .github/workflows/repair-comment-router.yml
```

Dry-run the router against live recent comments:

```bash
pnpm run repair:comment-router -- \
  --repo openclaw/openclaw \
  --lookback-minutes 180 \
  --max-comments 100
```

The scheduled workflow remains dry unless `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1`
is set or a maintainer manually dispatches the workflow with `execute=true`.
