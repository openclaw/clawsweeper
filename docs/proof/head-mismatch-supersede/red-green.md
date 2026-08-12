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

The pre-commit Codex autoreview reported no accepted/actionable findings. The full `pnpm run check` gate passed. The final Docker-backed Crabbox proof then passed all 223 focused scenarios on committed implementation head `2cd3ab893cf7dd1c93d6db85e5673a4db26999f3`; its receipt and source-blind behavior report are recorded beside this file.
