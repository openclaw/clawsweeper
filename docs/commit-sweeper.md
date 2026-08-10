# Local Branch Review (`local-review`)

The hosted commit-review lane (per-commit main reviews, GitHub Checks, and
commit-finding dispatch) was retired in July 2026 after producing zero
successful runs in its final month. What remains is the local, GitHub-isolated
review engine in `src/commit-sweeper.ts`, used two ways:

- `pnpm local-review`: a manual pre-PR self-review of the current branch.
- `clawsweeper review --local-range`: the main sweeper reuses the same local
  envelope for committed-range reviews.

## Usage

```text
pnpm run build
pnpm local-review -- --base main
# reviews merge-base(<base>, HEAD)..HEAD as one unit
# writes ~/.clawsweeper-local-reviews/run-<sha>-<ts>-<pid>/local-review.md
```

It is GitHub-isolated by contract, not air-gapped: it still calls the configured
Codex model service and requires model authentication and network connectivity.
The review requires a clean checkout, uses a unique per-run output directory,
withholds all GitHub token env vars, skips `gh` API commit-metadata hydration,
points `GH_CONFIG_DIR` at an empty directory, disables Codex web search, and
forbids other review-time network lookups. Repositories without a configured
profile are rejected (no foreign-profile fallback). It never writes to GitHub;
the local Markdown report is the only output.

## Related Files

- `src/commit-sweeper.ts`: local review engine and `local-review` CLI
- `prompts/review-commit.md`: Codex review prompt
