# Red/green record

The RED phase ran after adding the loopback contract fixtures and before changing production code, from fresh `origin/main` at `9a257905e50be2dff9bb99afecb6cde50f8417f9`.

The complete operator file retained 81 passing scenarios while all four new behavior scenarios failed: an unproven mismatch still emitted the old `head_mismatch` class, positive canonical evidence resolved nothing, cap counters were absent, and dry-run did not report a supersession plan. The combined command also had one setup-only dashboard failure because this fresh worktree had not built `dist` yet.

```text
tests 86
pass 81
fail 5 (four intended behavior failures, one missing-dist setup failure)
```

After `pnpm run build:all`, the dedicated Worker RED check loaded normally and failed because a typed superseded resolution did not increment the expected publication metrics:

```text
tests 1
pass 0
fail 1
```

GREEN requires exact target and head identity from the signed canonical record, a complete review status, envelope digest integrity, the alias-guarded typed resolution, and the two bounded prefixes. The complete focused pair passes locally on Node 24:

```text
tests 223
pass 223
fail 0
```

The pre-commit Codex autoreview reported no accepted/actionable findings. The full `pnpm run check` gate passed. The initial Docker-backed Crabbox proof passed all 223 focused scenarios on committed implementation head `2cd3ab893cf7dd1c93d6db85e5673a4db26999f3`.

The first ClawSweeper PR verdict identified one accepted P1 race: the PR head could advance after canonical evidence was read but before the Worker mutation. Fix round 1 adds an immediate same-open-node/same-head GitHub recheck and a loopback fixture that advances head B to C before resolution. The row remains open as `head_mismatch_revalidation_changed`, with zero resolution or recovery calls.

The refreshed full gate passed 3,391 tests with nine platform skips and zero failures, while the paired Codex autoreview again reported no accepted/actionable findings. The refreshed Docker-backed Crabbox proof passed all 224 focused scenarios on committed implementation head `10b45760a0c0fe1adf156909e2df0d737d5fef6a`; its receipt and source-blind behavior report are recorded beside this file.
