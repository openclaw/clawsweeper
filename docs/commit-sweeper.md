# Local Branch Review (`local-review`)

- Status: active local/GitHub-isolated review reference; hosted commit review is
  retired
- Owner: ClawSweeper maintainers
- Source of truth: `src/commit-sweeper.ts`, `prompts/review-commit.md`, package
  scripts, and local-review tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: local range selection, network/token isolation, model-service
  requirements, output artifacts, or the retired hosted boundary changes

The hosted commit-review lane (per-commit main reviews, GitHub Checks, and
commit-finding dispatch) was retired in July 2026 after producing zero
successful runs in its final month. What remains is the local, GitHub-isolated
review engine in `src/commit-sweeper.ts`, used two ways:

- `pnpm local-review`: a manual pre-PR self-review of the current branch.
- `clawsweeper review --local-range`: the main sweeper reuses the same local
  envelope for committed-range reviews.

## Usage

Install a trusted TruffleHog executable on the host `PATH`, outside the source
checkout and ClawSweeper checkout, before running either review command. Hosted
setup pins version 3.97.1; local workers do not provision it. The mandatory scan
covers the explicit initial payload and complete introduced before/after source
bytes, independently of prompt truncation. See the [safety model](../README.md#safety-model)
for refused inputs, the 256 MiB staging cap, deadline, and coverage limits.

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

For `review --local-range`, per-file line counts come from complete Git numstat
metadata for the resolved merge-base-to-HEAD range, independently of bounded
review patches and introduction evidence. NUL-framed paths preserve rename and
copy identities. Unreadable, malformed, or over-limit metadata fails the review;
binary line counts remain unknown, while a pure rename or mode-only change can
have verified zero counts. Reports preserve unknown counts as JSON nulls. The
OpenClaw PR surface renders numeric totals only for a complete file list with
known counts for every file; otherwise it explains why statistics are unavailable.
Historical reports are unchanged. OpenClaw Bay needs no update because its
observer data, routes, and controls do not consume these file statistics.

## Related Files

- `src/commit-sweeper.ts`: local review engine and `local-review` CLI
- `prompts/review-commit.md`: Codex review prompt
