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

Local review first uses a trusted TruffleHog executable on the host `PATH`,
outside the source checkout and ClawSweeper checkout. If it is absent,
ClawSweeper bootstraps the checksum-pinned 3.97.1 release asset into its
user-owned cache outside both checkouts before it scans; run
`pnpm setup:review-tools` to preflight that one-time cache setup. It accepts no
scanner URL or version override and verifies both the downloaded archive and
cached executable before a clean-environment version check. The mandatory scan
covers the explicit initial payload and complete introduced before/after source
bytes, independently of prompt truncation. See the [safety model](../README.md#safety-model)
for refused inputs, the 256 MiB staging cap, deadline, and coverage limits.

```text
pnpm run build
pnpm local-review -- --base main
# reviews merge-base(<base>, HEAD)..HEAD as one unit
# prints the review and retains no ClawSweeper output by default
```

It is GitHub-isolated by contract, not air-gapped: it still calls the configured
Codex model service and requires model authentication and network connectivity.
On first use without a trusted host scanner, it also fetches the one pinned
scanner release into the documented local cache before review admission. The
review requires a clean checkout, uses private run-owned scratch,
withholds all GitHub token env vars, skips `gh` API commit-metadata hydration,
points `GH_CONFIG_DIR` at an empty directory, disables Codex web search, and
forbids other review-time network lookups. Repositories without a configured
profile are rejected (no foreign-profile fallback). It never writes to GitHub.
Ordinary completion and caught failures remove the run-owned scratch. Signals
retain their default operating-system termination behavior, so an unhandled
signal or `SIGKILL` can leave that bounded private scratch behind.
Use `--output-retention summary` to retain only `local-review.md`, or
`--output-retention debug` for the existing per-run engine output. An explicit
legacy `--report-dir` remains debug-compatible. `--result-format json` emits a
valid JSON result with a nullable artifact path. Summary destinations are
exclusive to the current invocation. Managed transient output is capped at 96 MiB/256
files and debug output at 1 GiB/4,096 files, with at most 128 selected items per
invocation. Required PR checkouts are isolated from retained output in private
run scratch. Before materialization, ClawSweeper admits at most 200,000 tracked
paths and conservatively doubles complete Git blob-size metadata for bounded EOL
expansion. It refuses active filters, working-tree encodings, and ident expansion,
disables checkout hooks, then requires the projected bytes plus a 1 GiB disk
reserve. Missing-object acquisition is admitted against the real Git object
store; checkout materialization is admitted against its workspace filesystem.
When they share a filesystem, the combined requirement reserves space once.
Projected and actual usage must stay within 200,000 files/2 GiB.
When media preparation applies, debug items can use at most 64 MiB for downloads
and 16 MiB for derived output, subject to the remaining run byte and file
allowances. Non-debug items use at most 32 MiB and 8 MiB respectively.
These limits bound retained managed output, not arbitrary model writes or peak
child-process disk use. ClawSweeper does not prune older or unrelated retained runs.

For `review --local-range`, per-file line counts come from complete Git numstat
metadata for the resolved merge-base-to-HEAD range, independently of bounded
review patches and introduction evidence. NUL-framed paths preserve rename and
copy identities. Complete file enumeration is mandatory and retains the prior
runtime command contract (128 MiB capture budget and no read deadline); an
unreadable, malformed, or over-limit required file list still fails the review.
Statistics are best-effort metadata bounded to 1 MiB and five seconds:
unreadable, over-limit, timed-out, malformed, or mismatched numstat leaves all
file counts unknown without stopping review. Binary line counts remain unknown,
while a pure rename or mode-only change can have verified zero counts when
metadata is valid. Reports preserve unknown counts as JSON nulls. The
OpenClaw PR surface renders numeric totals only for a complete file list with
known counts for every file; otherwise it explains why statistics are unavailable.
Historical reports are unchanged. OpenClaw Bay needs no update because its
observer data, routes, and controls do not consume these file statistics.

## Related Files

- `src/commit-sweeper.ts`: local review engine and `local-review` CLI
- `prompts/review-commit.md`: Codex review prompt
