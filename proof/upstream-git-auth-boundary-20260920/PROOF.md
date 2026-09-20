# Git environment boundary proof

Source repository: `openclaw/clawsweeper`

Parent source head: `e80cc9a0c057d46803945b688bb29a256a6553c3`

Candidate identity: parent source head plus the relevant source/test diff below;
the implementation commit is recorded by the promotion receipts.

Relevant source/test diff SHA-256 (parent to candidate):
`4a0ca81ad021bceb32bd533fffed27775ff1e6b6ee4b0868a2dcfe50c4c145eb`

Reviewed base: `a09e6cefb31adcd12bba10e1658cae5fced08c80`

## Claim

Process-local `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, and numbered
`GIT_CONFIG_KEY_N` / `GIT_CONFIG_VALUE_N` values are not inherited by either
constructed model environment after `codexEnv()` and `codexSubprocessEnv()`
filtering. Legitimate repair Git identity and existing isolation keys remain.

## Reproduction

```sh
corepack pnpm run build:node
node proof/upstream-git-auth-boundary-20260920/prove-git-config-boundary.mjs
```

The script uses only synthetic `user.name` / `user.email` sentinels, a
synthetic token negative control, and an empty global Git configuration. It
prints only key presence, booleans, exit statuses, repository identity, and
redacted identity observations. Both the review helper and the repair model
builder are exercised.

## Observed result

Independent pre-fix confirmation on Node 24.5.0: `codexEnv()` retained no Git
sentinel keys, while `codexSubprocessEnv()` retained all eight numbered and
parameter sentinels. Repair Git identity and `GIT_CONFIG_GLOBAL` /
`GIT_CONFIG_NOSYSTEM` isolation were already preserved.

The candidate receipt reports both builders with `retainedGitKeys: []`,
`ghTokenStripped: true`, child Git identity sentinel matches false, repair
author/committer identity still `clawsweeper` / configured email,
`gitConfigGlobalPreserved: true`, repository Git status exit 0, and
`explicitCliOverrideWorks: true`.

The candidate receipt was produced on macOS Darwin 25.5.0, Node 24.5.0, and
Git 2.55.0. No Codex/OpenClaw model process was started. This
proves the ClawSweeper-owned environment construction and child inheritance
boundary, not a hosted review or a production credential exposure. It does
not claim comprehensive Git authentication isolation; other Git configuration
channels remain intentionally outside this narrow change.

The same run also exercised URL-to-path conversion. The existing normal
repository path has no space or `%`; both the old `.pathname` /
`pathToFileURL(pathname)` handling and the candidate `href` /
`fileURLToPath` handling succeeded there. A task-owned temporary path
containing both a space and a literal `%` made the old cwd nonexistent and
the old dynamic import fail with `ERR_MODULE_NOT_FOUND`; the candidate cwd
existed, the candidate import succeeded, and the copied compiled helpers
still retained no Git override keys.

## Additional checks

- `corepack pnpm run build:node` — exit 0.
- `node --test test/codex-env.test.ts test/repair/process-env.test.ts test/clawsweeper.test.ts` — 87 passed, 0 failed.
- `git diff --check` — exit 0.
- Native Cursor ACP follow-up job `72542e8c-9d35-424c-a666-a5f7db9e37b4` was
  cancelled after its bounded 15-minute window without a handoff; its source
  edits were independently verified here and are not treated as a canonical
  completed worker result.
- The initial native Cursor ACP job `9defebd0c-8c50-449b-a5dc-42ceef46744c`
  completed `pnpm run check` for the first source change.

- Final verification-only Codex review after the portability proof update found
  no actionable correctness issue.
