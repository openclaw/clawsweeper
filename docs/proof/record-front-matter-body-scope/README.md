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

It then asserts every shape that must keep failing closed: a bare second block, a
delimiter-first second block, a block naming only one key, and — the case that
matters most — a **complete `---`-delimited block appended after review prose**, in
five variants (after one line, after several paragraphs, after a findings row, after
a fenced sample, after a thematic break). A key-shaped run with no closing `---` is
prose, not a record, so the leading value stands.

### Where the boundary sits, and why

| Body shape | Treated as | Why |
| --- | --- | --- |
| `title: quoted text` in a paragraph | prose | one line is not a record |
| a fenced ` ```yaml ` sample | illustration | quoted text no reader acts on |
| a run of `key:` lines with no closing `---` | prose | never completes a block |
| a complete `---`-delimited block, anywhere | **competing record** | indistinguishable from the real thing |

The scan covers the whole body, not a prefix. An earlier revision of this change
stopped at the first ordinary line, which let a complete block appended after prose
escape the guard — a spoofing gap, and the reason this proof now asserts the
appended-block cases explicitly and checks that they already passed before the fix.

### Relationship to `scripts/audit-report-metadata-spoofing.mjs`

The audit still flags promotion keys **anywhere** after the leading block, and that
is deliberate: it is an advisory report read by a human, so a false positive costs a
glance. This parser sits on the apply path, where the same conservatism costs a
record — every field it calls `ambiguous` is a field the lane treats as missing, so
a review that quotes a PR field takes the item offline. The two are intentionally
different scopes: the audit may over-report; the parser fails closed on exactly the
shape that can impersonate a record.

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
| lease | `cbx_4cc800adeaa2` (`coral-barnacle`) |
| run | `run_cae9b50152dd` |
| base staged | `5439582b` · `src/clawsweeper-record-metadata.ts` · sha256 `df480a1e…83f1` |
| exit | `0` |

`stage-before.sh` exists because container images carry no `.git`: it writes the
base version of the changed file into `before/` on the host, where rsync picks it up
as an untracked file. It is deliberately not committed — it is a verbatim copy of a
blob git already stores. When git *is* available `run-proof.sh` re-derives it, so the
staged copy cannot drift from the base commit.

The run also proves it did not disturb the head it is describing: `package.json` and
`pnpm-lock.yaml` digests plus `git status --porcelain` are recorded at sync and
re-checked after dependency installation and at the end of the run. The
platform-native TypeScript fallback installs into a disposable prefix outside the
workspace rather than writing tracked dependency metadata.

The script refuses to run below Node 24, installs the pinned pnpm into a
user-writable prefix (the lease runs as an unprivileged user), builds the Node lane,
and then runs the fixtures twice: once against the module compiled from the base
commit, and once against the built module on this branch.

## Observed result

Against the pre-fix module, four of the five bodies make at least one field
unreadable — `title`, `type`, `url`, and both `number` and `reviewed_at` come back
`ambiguous` — the unterminated-run case reads the wrong value, and a fenced example
takes the record offline. Against this branch all fixtures pass.

The line that matters for the security question:

```
fail-closed guards intact before the fix: 8 assertions
```

All eight fail-closed assertions — the three competing-record shapes plus the five
appended-block variants — pass in **both** runs. The script aborts the proof if any
of them regress, so the contrast shows the guard was narrowed to exclude prose and
fenced illustration, not weakened against competing records.

## Artifact / trace

`.crabbox/runs/run_cae9b50152dd/run_cae9b50152dd-artifacts.tgz` holds
`.artifacts/record-front-matter-body-scope-proof/` with `before-output.txt`,
`proof-output.txt`, `focused-tests.txt`, and the install/build logs.

## Limits

This proves the parser, not the lanes that call it. It does not exercise GitHub, and
it does not enumerate every front matter key — it covers the keys whose values steer
apply decisions. Reports that legitimately embed a second record still resolve to
`ambiguous`, which is unchanged behavior.
