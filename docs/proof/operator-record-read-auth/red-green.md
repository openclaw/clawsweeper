# RED/GREEN record

The RED router test ran from fresh `origin/main` at `ae36d608d01701af7e06c313be96689068b5c890` after adding the distinct-secret fixture and before changing production code. After the required full build, the operator-signed canonical-record GET returned `401` instead of the required `200`:

```text
tests 1
pass 0
fail 1
AssertionError: 401 !== 200
```

The first direct test attempt also documented a fresh-worktree setup dependency: the dashboard harness imports built repair modules, so `pnpm run build:all` is required before the focused test. That setup-only failure is not counted as the behavior RED result above.

GREEN requires the same router fixture to return 200 for the operator only on `items`, 401 for the operator on `closed`, `plans`, and `decision-packets`, 200 for the webhook on all four collections, 401 for garbage on all four, and the existing 503 behavior when a required credential is not configured. The real-Worker proof independently requires merge-base operator auth to remain 401 everywhere while the candidate unlocks only `items`, with full Wrangler process-tree shutdown between the two boots.
