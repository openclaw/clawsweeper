# Trailing HTML comment parsing proof contract

## Claim

`trailingHtmlComments` returns the final contiguous block of HTML comments, and
every entry it returns is a single well-formed comment. Before this change a stray
`-->` in visible prose bridged back to an earlier `<!--` and produced an entry that
spanned prose — swallowing any real marker inside that span.

The fix does **not** change parsing for bodies with a clean trailing block.

## Exercised surface

`dist/review-comment-markers.js`, the parser that recovers ClawSweeper's durable
state markers from a published comment body. Its consumers are
`src/clawsweeper-review-comment-state.ts` (durable review version, verdict
attributes) and `src/review-recovery-label-backfill.ts` (recovery-label cleanup).

## Controlled scenario and fixture

`run-proof.mjs` asserts three claims against the built `dist/`:

1. **Well-formed** — across six bodies (clean block, prose ending in an arrow,
   marker/prose/marker, arrow before markers, no markers, unterminated opener),
   every returned entry opens with `<!--`, closes with `-->`, and contains **no
   interior terminator**. An entry spanning prose fails that last condition.
2. **Bounded** — the mid-body `<!-- clawsweeper-review-history -->` marker that
   `renderReviewHistorySection` emits is never dragged into the trailing block,
   and the durable review marker is still recovered.
3. **No loss** — seven clean bodies parse **byte-identically** to a pre-fix build
   compiled from the base commit inside the lease. This is the important one: a
   stricter parser must not make a previously-recoverable marker unrecoverable.
   If the pre-fix build is unavailable the claim reports SKIPPED and **fails**.

The fixture bodies are shaped like the real renderer's output — a Mermaid
`flowchart` (whose edge syntax is literally `-->`), a `<details>` review-history
block carrying its own marker, then the trailing marker block.

## Expected observation

19 checks, all PASS, exit 0, plus the measured contrast:

```
defect case: marker, prose ending in an arrow, marker
  pre-fix : ["<!-- clawsweeper-verdict:needs-human item=321 sha=head -->\nrenders as -->",
             "<!-- clawsweeper-review item=321 -->"]
  post-fix: ["<!-- clawsweeper-review item=321 -->"]
```

Pre-fix, the first entry spans visible prose and has swallowed the verdict marker.
Post-fix the verdict marker is simply **not** part of the trailing block — which is
correct, because prose separates it. Either way that marker was unusable; the fix
stops fabricating a malformed entry from it.

## Artifact and command

```bash
MARKER_PROOF_BASE="$(git merge-base HEAD origin/main)" \
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --allow-env MARKER_PROOF_BASE \
  --artifact-glob '.artifacts/trailing-html-comment-proof/**' \
  --script docs/proof/trailing-html-comment-parsing/run-proof.sh
```

The script runs `pnpm run build:node`, **not** `build`: `test/helpers.ts` (used by
the recovery suites) imports `dist/clawsweeper.js` and
`dist/review-activity-cursor.js` from the main build.

### How the base ref is resolved

Never a pinned SHA — that goes stale on the first rebase and would silently compare
the no-loss claim against an obsolete revision. Resolution order:

1. `MARKER_PROOF_BASE`, computed on the host and passed in with `--allow-env`
   (the pattern `docs/proof/openclaw-bay` uses for `BAY_PROOF_SOURCE_SHA`);
2. `git merge-base HEAD main`, falling back to `origin/main`, inside the lease;
3. otherwise the committed `before/` fixture, whose sha256 is printed.

A container image carries no `.git`, so the pre-fix source cannot be recovered
inside the lease. `before/review-comment-markers.ts` is therefore committed as a
verbatim copy of the base-commit blob, and `stage-before.sh` regenerates it on the
host. Wherever git *is* reachable the script rewrites that file from the base blob
before anything is built — so a stale fixture cannot quietly weaken the contrast.
The tracked-state guard below runs immediately after that rewrite, which turns a
stale fixture into a hard failure.

### The run cannot alter the head it is proving

An earlier revision of this script installed the platform-native TypeScript
package with `pnpm add -D`, which writes `package.json` and `pnpm-lock.yaml`. That
made the recorded result describe a tree that no longer matched the submitted head.
Two changes fix it:

- The fallback now installs into a disposable prefix outside the workspace
  (`npm install --prefix "$(mktemp -d)" --no-save`) and copies the result into
  `node_modules/`, which is untracked build state. This mirrors how
  `docs/proof/openclaw-bay/run-proof.sh` provisions Playwright under `/tmp`.
- The script records `package.json` and `pnpm-lock.yaml` digests plus
  `git status --porcelain` at sync, then re-checks them after the fixture step,
  after dependency installation, and at the end of the run. Any drift aborts with
  a diff instead of reporting a result.

Untracked paths are excluded from that comparison, so build output and artifacts
do not trip it — only a change to the committed tree does.

Host-only quick check (supply a pre-fix build for claim 3):

```bash
pnpm run build
node docs/proof/trailing-html-comment-parsing/run-proof.mjs /path/to/pre-fix/review-comment-markers.js
```

Focused tests:

```bash
node --test test/review-comment-markers.test.ts \
            test/review-recovery-label-backfill.test.ts \
            test/review-placeholder-recovery.test.ts
```

## Provenance

- provider: Crabbox `local-container` (runtime `docker`, OrbStack)
- image: `node:24` → container node `v24.19.0`, `Linux aarch64`
  (satisfies `engines.node >= 24`)
- lease: `cbx_23dc3b4da489` (`silver-crab`)
- run: `run_84923c2ac419`
- base ref: `0588bda9` · `src/review-comment-markers.ts` · sha256 `0f4ca5a5…1fc0`
- artifact: `.crabbox/runs/run_84923c2ac419/run_84923c2ac419-artifacts.tgz`
- result: exit `0`; 19/19 proof checks PASS; focused suites `40/40`
- tracked state: identical at sync and at end of run —
  `package.json` sha256 `db731331…0c67`, `pnpm-lock.yaml` sha256 `845314ce…16e3`,
  `git status --porcelain` empty of tracked entries at all three checkpoints
- the fallback path was exercised, not skipped: the lease reported
  `@typescript/typescript-linux-arm64 missing after install`, provisioned it at
  `/tmp/tmp.9ywi1eEiZu`, and the tracked-state check immediately afterwards passed
- privacy and network access: synthetic fixtures only. The **assertions** contact
  nothing — no GitHub API, no queue, and no production mutation of any kind. The
  lease **setup** around them is not network-free: `run-proof.sh` runs
  `pnpm install --frozen-lockfile`, and may run `corepack`, `npm install -g`, and
  an out-of-tree `npm install --prefix` against the public package registry to
  obtain pnpm and the platform-native TypeScript binary. That traffic goes to the
  registry only. Nothing reads or writes GitHub state, and no credential is
  present in the lease.

## Reachability — read this before rating severity

I could **not** construct a body from the real renderer that triggers the defect,
and I looked hard. The trigger needs all three of:

1. an earlier `<!--` in the body to bridge back to;
2. visible prose ending in `-->` after it;
3. the trailing marker block immediately after that prose.

Four realistic bodies — a Mermaid diagram in a closed fence, the same with an
unclosed fence, prose ending in an arrow, and a table cell ending in an arrow — all
parse **correctly** even pre-fix, because condition 1 is missing: the durable
comment's only mid-body opener is the review-history marker, and `</details>`
always follows it before any trailing prose.

Both consumers are also **fail-safe today**, and I verified that:

- `clawsweeper-review-comment-state.ts` anchors both ends with `[^>]*`, so a blob
  containing `>` simply fails to match and the marker is ignored;
- `review-recovery-label-backfill.ts` matches `^<!--\s*clawsweeper-<kind>\b` and
  then scans the whole entry for `name=value`, but its `canonical` check is
  strictly anchored, so a blob makes the recovery label be **retained** rather than
  wrongly cleared.

So this is a **correctness fix to a parser that is currently safe by accident of
its consumers' regexes**, not a live incident. The backfill's loose matcher is one
refactor away from making a blob's attributes authoritative, which is the risk
being removed.

## Limits

Covers the trailing-block scan only. It does not change marker syntax, attribute
parsing, `neutralizeReviewControlMarkers`, or any consumer regex.

Claim 3 covers seven clean bodies, not an exhaustive enumeration. The pairing rule
is now "an HTML comment ends at its first `-->`", which matches the HTML spec, so
divergence from the old behavior is confined to inputs where prose sits between an
opener and the matched terminator — exactly the defect.

No live GitHub comment is published or read.
