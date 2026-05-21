# Target Repositories

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured dashboard targets in `config/target-repositories.json`
- a conservative generic fallback for exact event/manual reviews of
  `openclaw/*` repositories

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Other configured targets default to safer repo-local rules:
issues are review/comment-only, and PRs may auto-close only when the same
change is certainly already implemented on `main`.

## Generic OpenClaw Fallback

The fallback lets a newly installed OpenClaw repo dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be `openclaw`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- issues cannot be auto-closed
- PRs can auto-close only for `implemented_on_main` or age-gated
  `mostly_implemented_on_main`
- scheduled dashboard/backfill rows are not added automatically

This is enough for event-driven review after the target repo has the dispatcher
workflow and GitHub App installation. It is not a blanket scheduled rollout.

## Add One Repository

1. Install the ClawSweeper GitHub App on the target repository.
2. Add or merge the target dispatcher from
   [`docs/target-dispatcher.md`](target-dispatcher.md).
3. Ensure the target repo can read the org or repo
   `CLAWSWEEPER_APP_PRIVATE_KEY` secret.
4. Open, edit, or comment on a target issue/PR and confirm a dispatcher run
   appears in the target repo.
5. Confirm the receiver run appears in
   `https://github.com/openclaw/clawsweeper/actions`.
6. Confirm the target item gets one durable ClawSweeper review comment.

For a repo that should appear in the README dashboard or scheduled queues, add
it to `config/target-repositories.json` with an explicit prompt note and
close-policy block. Keep the default policy unless the repo has a documented
reason to allow broader issue closes.

## Add Many Repositories

Batch rollout should be incremental:

- install the app and dispatcher on a small group first
- leave scheduled backfill off
- verify event review/comment sync on one issue or PR per repo
- add config entries for repos that should show in the dashboard
- enable scheduled backfill/apply only after repo-specific safety rules exist

If a target dispatch reaches ClawSweeper but receiver token creation fails, the
App is usually not installed on that target repo. If the target workflow skips
before dispatch, the target repo usually cannot access
`CLAWSWEEPER_APP_PRIVATE_KEY`.

## Review provider

ClawSweeper supports four review providers. The active provider is resolved
per run by `resolveReviewProvider()` (see `src/clawsweeper.ts`) with this
precedence:

1. `profile.review_provider` (per-target override in
   `config/target-repositories.json`)
2. `vars.CLAWSWEEPER_REVIEW_PROVIDER` (repo variable, fleet-wide default)
3. compiled fallback (`codex`)

| id | how it talks to the model | runner prereqs |
|---|---|---|
| `codex` | spawns the OpenAI Codex CLI (`codex exec --output-schema ...`) | `setup-codex` action; ChatGPT subscription JWT at `~/.codex/auth.json` |
| `claude-bridge` | curl POST to `pi-claude-bridge` (`127.0.0.1:9100`) | bridge running on the runner |
| `claude-code` | spawns Anthropic's Claude Code CLI (`claude -p --output-format json --json-schema ...`) | `setup-claude-code` action; `~/.claude/credentials.json` or macOS keychain entry on self-hosted |
| `pi` | spawns the pi-mono-fork coding-agent CLI (`pi -p --mode json --no-session`) | `setup-pi` action; pi binary on PATH; `~/.pi/` initialised |

The `claude-code` and `pi` providers were added alongside the existing two to
enable per-item provider routing (latency / cost). All providers share the
same `Decision` schema (`schema/clawsweeper-decision.schema.json`), so
downstream observability and telemetry do not have to branch on which one ran.

Pi has no `--json-schema` enforcement — the schema is inlined in the prompt
and the response is post-validated with the same Zod parser the other
providers use. Expect a higher `schema_invalid` rate than codex / claude-code,
so reach for `pi` on items where speed matters more than strict structure.
