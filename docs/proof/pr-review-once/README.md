# One automatic PR review after a quiet window

## Claim and exercised surface

Ordinary PRs receive their first automatic review after ten quiet minutes.
Source changes restart the window. A completed canonical PR answer suppresses
later automatic webhook and scheduled work, including after a Worker restart.
Explicit review requests and opted-in repair automation remain available.

The proof executes the production `ExactReviewQueue` and direct publication
store in workerd with persisted SQLite. A loopback HTTP fixture supplies GitHub
PR reads, installation tokens, and repository-dispatch responses. It exercises
the real queue admission, alarm, dispatch, claim, publication, and restart paths.

## Command and environment

Run from the source checkout with Node 24 or newer and a separate tool prefix
containing `wrangler@4.131.1` (Miniflare 5.20260911.0-alpha and workerd
1.20260911.1) and its esbuild dependency. Extract the previous implementation
into a temporary fixture to exercise its actual writer and pruning code:

```sh
git show adf080a6318b96e9665cc46de87f97641f3cfa23:dashboard/exact-review-direct-publication.ts > "$LEGACY_PUBLICATION_SOURCE"
node scripts/proof-pr-review-policy.mjs "$TOOL_PREFIX" "$FRESH_OUTPUT_DIR" "$LEGACY_PUBLICATION_SOURCE"
```

Executed on macOS arm64 with Node 26.7.0. AWS Crabbox source transfer failed;
the local container service subsequently became unavailable. Validation used
an isolated temporary source copy with its own frozen-lockfile dependencies.
No dependencies were installed in the shared checkout or managed worktree.

## Observed results

The checked-in [result.json](result.json) records a passing run and SHA-256
identities for all nine policy source files and the legacy fixture.

- Minute 0: enqueue succeeds; alarm holds the initial review until minute 10.
- Minute 10: an intervening body edit extends the hold to minute 20.
- Minute 20: exactly one dispatch occurs. Publishing the completed answer then
  rejects that old workflow's claim with `review_request_required`.
- After a fresh workerd instance opens the same SQLite store, synchronize,
  hot-intake, and normal-backfill events produce no additional dispatch.
- Failed and stale-source reports leave first-review admission available.
- Canonical archive/reopen mutations preserve completion provenance: a stale-source
  report remains eligible, while a completed answer still suppresses automatic work.
- The previous implementation writes and prunes legacy records. After a fresh
  Worker opens that database, unverified and already-pruned reports remain
  eligible. A verified report with retained completion provenance stays answered.
  Pruning first after upgrade also records that answer before deleting its receipt.
- An explicit request and an autofix opt-in each dispatch successfully.
- Removing the autofix label after dispatch rejects the delayed automatic claim.

Focused tests additionally cover push/revert activity between observations,
comment-only timestamps, legacy report seeding, failed replacements, tombstones,
and preservation of a newer explicit request when rejecting an old lease.

## Limits

GitHub responses and the clock are controlled fixtures. The proof does not call
a model, mutate a live PR, or establish deployment of the Worker. Source hashes
bind the result to the tested implementation; production deployment remains a
separate observable event.
