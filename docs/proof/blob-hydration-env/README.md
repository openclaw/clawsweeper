# Blob-hydration old-Git compatibility proof

## Claim

Restricted PR review hydration detects missing promisor blobs without an implicit lazy fetch on
Git 2.39.5, resolves their sizes through the existing bounded metadata callback, explicitly fetches
only blobs within the per-review byte limit, and leaves the repository usable offline afterward.

## Root-cause verification

On unmodified `origin/main` (`ae04c61896effe1fb7795ef021c4feac99ddaea3`), the focused test file
inside `node:24-bookworm` reported Git 2.39.5, 2 passes, and the three expected failures. An
isolated genuine blobless clone showed why: `GIT_NO_LAZY_FETCH=1 git cat-file --batch-check`
exited 128 with zero output rather than emitting a `missing` row for the unavailable promised blob.

Git's [2.45.0 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.45.0.adoc)
place the correct client-side `--no-lazy-fetch` behavior in that release. The first replacement
probe incorrectly retained `--no-walk=unsorted`. On Git 2.39.5, its path-limiting fallback spawned
an implicit promisor fetch; the integration test counted that fetch without proving it was the
production path's explicit bounded fetch. That masked the missing traversal and let the old proof
appear green.

The repaired probe starts from the exact tree objects instead:

```text
git rev-list --objects --missing=print <base>^{tree} <head>^{tree} -- <bounded-paths>
```

Tree recursion emits the selected blobs while commit-history traversal is impossible. A fixture
with an earlier history-only blob and a separately fetched unrelated ref proved that neither was
observed. The same real blobless-clone scenario passed on Git 2.39.5 and Git 2.55.0: all four
expected blob IDs were observed, two were reported missing, no fetch ran under the probe, and the
later explicit `--stdin` fetch ran exactly once.

## Chosen option

This is the production-path fix from option 1 of the work order, not a test skip. Hydration now
uses `rev-list` to classify the object IDs reached from the exact base/head trees and bounded
changed paths. `cat-file` receives only IDs already proven local. Existing GraphQL size resolution,
the 4 MiB aggregate limit, explicit one-request fetch, unsafe-path rejection, and fail-closed
behavior remain unchanged.

Hosted production does not currently depend on this compatibility path. Recent
[run 31466811047](https://github.com/openclaw/clawsweeper/actions/runs/31466811047) records Ubuntu
24.04 runner image `20260720.247`; its
[software manifest](https://github.com/actions/runner-images/blob/ubuntu24/20260720.247/images/ubuntu/Ubuntu2404-Readme.md)
records Git 2.54.0. The fix matters for older self-hosted and container deployments and lets the
Bookworm proof suite exercise real behavior instead of carrying three environmental failures.

## Tree-traversal repair proof

The after-fix traversal trace used a genuine local filter-capable bare origin, a `blob:none` main
clone, a depth-one PR-head fetch, and a depth-one unrelated-ref fetch. The selected base and head
trees contained four distinct review blobs; two head-side blobs were absent locally before
hydration. The probe reported every expected blob ID without fetching, excluded both the
history-only and unrelated-ref blobs, and the production hydration function then completed its
single explicit bounded fetch.

The current-Git trace is retained in
[`artifacts/current-git-tree-traversal.log`](artifacts/current-git-tree-traversal.log). The matching
Git 2.39.5 trace is retained in
[`artifacts/git-2.39.5-tree-traversal.log`](artifacts/git-2.39.5-tree-traversal.log). The latter ran
inside `node:24-bookworm` through Crabbox provider `aws`, lease `cbx_7e3080158c5c`
(`coral-lobster-9594`), run `run_0a87aaf605e6`; Crabbox reported exit 0 and `leaseStopped=true`.

The strengthened integration test now separately asserts that the probe output includes every
known blob ID, that production invokes the two `^{tree}` roots without `--no-walk`, that no nested
promisor fetch occurs, and that the one counted fetch is the explicit `--stdin` fetch.

## Original full-suite scenario and command

Crabbox checked out pushed PR
[`openclaw/clawsweeper#1118`](https://github.com/openclaw/clawsweeper/pull/1118) at code head
`964d9d8d88b7e0a2394f7d555fa9b6d5cf0f923e` with `--fresh-pr` inside a Docker-backed
`local-container` using `node:24-bookworm`. The unprivileged lease installed Corepack shims under
`$HOME/.local/bin`; jq 1.8.1 was downloaded from its official release and verified against the
published SHA-256 checksum before installation in the same directory.
The retained `worktree_changes=1` is the uploaded `.crabbox/scripts/` proof harness; the remote PR
checkout itself was clean before Crabbox installed that harness.

The proof ran these gates in order:

```text
pnpm install --frozen-lockfile
pnpm run build:all
pnpm run test:no-build
pnpm run lint
pnpm run format:check
pnpm run check:active-surface
```

## Original observed result

Every gate passed. The full suite reported 3,318 tests, 3,310 passes, 8 platform skips, and zero
failures. All three named blob-hydration tests passed on Git 2.39.5 rather than being skipped. The
verbatim retained result is in
[`artifacts/full-suite-result.log`](artifacts/full-suite-result.log), and the gate markers and
runtime/tool checks are in [`artifacts/gates.txt`](artifacts/gates.txt) and
[`artifacts/runtime.txt`](artifacts/runtime.txt).

This original run predates the tree-traversal repair and is retained only as regression history; it
does not establish the repaired behavior. Crabbox reported provider `local-container`, lease
`cbx_553522239697` (`quick-crab-969a`), command
time 375,055 ms, total time 401,893 ms, exit 0, and automatic lease cleanup. Full machine-readable
details are in [`artifacts/crabbox-provenance.json`](artifacts/crabbox-provenance.json); the
captured remote streams and generated proof receipt are retained alongside it.

## Limits

The proof uses genuine partial clones and real local Git transport, but the fixture's bounded size
callback reads blob sizes from its source repository rather than GitHub GraphQL. Existing metadata
request tests cover the one-request GraphQL mapping. The run does not mutate GitHub items, queues,
production state, or deployment configuration.

## OpenClaw Bay

No Bay change is needed. This is local review-context Git compatibility; lifecycle, publication,
queue, telemetry, dashboard data contracts, and the observer-only action boundary are unchanged.
