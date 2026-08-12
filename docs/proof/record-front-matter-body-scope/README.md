# Proof: report prose no longer hides a record's front matter

## Claim

A ClawSweeper record's front matter stays readable when the report body happens to
start a line with one of the front matter keys, and a genuine second front matter
block is still reported as `ambiguous`.

## Exercised surface

`createRecordMetadata(...).frontMatterField` / `.frontMatterValue` in
`dist/clawsweeper-record-metadata.js`. Every apply and review lane reads record
fields (`type`, `title`, `url`, `number`, `reviewed_at`, `close_reason`, the review
cache keys, the lease fields) through this one parser, so a field that reads back as
`ambiguous` is a field the lane treats as missing.

## Scenario / fixture

`run-proof.mjs` builds a record whose front matter holds six real fields and then
varies only the body:

| Body | Why it is realistic |
| --- | --- |
| clean prose | control |
| quotes a PR field (`title:`) | a review that echoes the pull request body |
| a fenced ` ```yaml ` sample containing `type:` | a review that shows configuration |
| a findings row starting `url:` | a review that lists evidence links |
| several keys on their own lines | a review that summarizes record state |

It then asserts the competing-record cases that must keep returning `ambiguous`:
a bare second block, a delimiter-first second block, and a second block that names
only one of the keys. A key-shaped run of lines with no closing `---` is prose, not
a record, so the leading value must stand.

## Command and environment

```
bash docs/proof/record-front-matter-body-scope/stage-before.sh
crabbox run --provider local-container --local-container-image node:24 --no-hydrate \
  --artifact-glob '.artifacts/**' -- \
  bash docs/proof/record-front-matter-body-scope/run-proof.sh
```

Recorded run:

| | |
|---|---|
| provider | `local-container` (runtime `docker`) |
| image | `node:24` → `v24.19.0`, `Linux aarch64` |
| lease | `cbx_f8ac8532ac35` (`golden-crayfish`) |
| run | `run_348d6c5961fe` |
| base staged | `5439582b` · `src/clawsweeper-record-metadata.ts` · sha256 `df480a1e…83f1` |
| exit | `0` |

`stage-before.sh` exists because container images carry no `.git`: it writes the
base version of the changed file into `before/` on the host, where rsync picks it up
as a dirty file. When git *is* available `run-proof.sh` re-derives that file, so the
staged copy cannot drift from the base commit.

The script refuses to run below Node 24, installs the pinned pnpm into a
user-writable prefix (the lease runs as an unprivileged user), builds the Node lane,
and then runs the fixtures twice: once against the module compiled from the base
commit, and once against the built module on this branch.

## Observed result

Against the pre-fix module, four of the five bodies make at least one field
unreadable — `title`, `type`, `url`, and both `number` and `reviewed_at` come back
`ambiguous` — and the unterminated-run case reads the wrong value. Against this
branch all fixtures pass. The three competing-record guards pass in *both* runs,
which is what shows the change narrows the ambiguity check rather than deleting it;
the script fails the proof if any of them regress.

## Artifact / trace

`.crabbox/runs/run_348d6c5961fe/run_348d6c5961fe-artifacts.tgz` holds
`.artifacts/record-front-matter-body-scope-proof/` with `before-output.txt`,
`proof-output.txt`, `focused-tests.txt`, and the install/build logs.

## Limits

This proves the parser, not the lanes that call it. It does not exercise GitHub, and
it does not enumerate every front matter key — it covers the keys whose values steer
apply decisions. Reports that legitimately embed a second record still resolve to
`ambiguous`, which is unchanged behavior.
