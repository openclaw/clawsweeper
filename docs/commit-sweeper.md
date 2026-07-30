# Local Branch Review (`local-review`)

The hosted commit-review lane (per-commit main reviews, GitHub Checks, and
commit-finding dispatch) was retired in July 2026 after producing zero
successful runs in its final month. What remains is the offline review engine
in `src/commit-sweeper.ts`, used two ways:

- `pnpm local-review`: a manual, offline pre-PR self-review of the current
  branch.
- `clawsweeper review --local-range`: the main sweeper reuses the same offline
  envelope for committed-range reviews.

## Usage

```text
pnpm run build
pnpm local-review -- --base main
# reviews merge-base(<base>, HEAD)..HEAD as one unit
# writes ~/.clawsweeper-local-reviews/run-<sha>-<ts>-<pid>/local-review.md
```

It is offline by contract and never contacts GitHub: it requires a clean checkout,
uses a unique per-run output directory, withholds all GitHub token env vars, skips
the `gh`-api commit-metadata hydration, points `GH_CONFIG_DIR` at an empty directory,
disables Codex web search, and explicitly forbids network lookups. Repositories
without a configured profile are rejected (no foreign-profile fallback). It never
writes to GitHub — the local Markdown report is the only output.

## Related Files

- `src/commit-sweeper.ts`: offline review engine and `local-review` CLI
- `prompts/review-commit.md`: Codex review prompt
