# Proof: label names are written to a record verbatim

## Claim

A GitHub label whose name contains `$&`, `` $` ``, `$'` or `$$` is stored in a
record's `labels:` front matter exactly as given, the record around it is left
intact, and front matter keys are matched literally instead of being compiled as
regular expressions.

## Exercised surface

`createRecordMetadata(...).replaceFrontMatterValue` and the matching readers
(`.frontMatterField`, `.frontMatterValue`, `.frontMatterStringArray`) in
`dist/clawsweeper-record-metadata.js`.

`src/clawsweeper-apply-report-labels.ts` writes the synced label set with

```ts
markdown = replaceFrontMatterValue(markdown, "labels", JSON.stringify(item.labels));
```

`item.labels` is the label set returned by the label sync for the reviewed item, so
the names come from the reviewed repository. `String.prototype.replace` treats `$&`,
`` $` ``, `$'` and `$$` in its *replacement* argument as expansion patterns, so those
names were being expanded against the match instead of inserted.

## Scenario / fixture

`run-proof.mjs` starts from a record holding `repository`, `number`, `labels`,
`title` and a body, then writes label sets through the shipped writer and reads them
back through the shipped readers:

1. **Verbatim storage** — ordinary names plus every replacement pattern, including a
   mixed set (`["needs-triage", "$&"]`) that mirrors a real sync result.
2. **Valid JSON** — the stored text must still `JSON.parse` back to what was written,
   because `frontMatterStringArray` silently falls back to comma-splitting when it
   does not.
3. **Record integrity** — `title`, `number`, the body, and the `---` delimiters must
   be unchanged after the write.
4. **Literal keys** — keys containing `.`, `+`, `(`, `[`, `|` and `*` must read and
   update in place, and `a.c` must not match a line reading `aXc:`.

## Command and environment

```
bash docs/proof/record-front-matter-literal-write/stage-before.sh
crabbox run --provider local-container --local-container-image node:24 --no-hydrate \
  --artifact-glob '.artifacts/**' -- \
  bash docs/proof/record-front-matter-literal-write/run-proof.sh
```

Recorded run:

| | |
|---|---|
| provider | `local-container` (runtime `docker`) |
| image | `node:24` → `v24.19.0`, `Linux aarch64` |
| lease | `cbx_cae984baa97f` (`quick-crayfish`) |
| run | `run_26f52fe84002` |
| base staged | `5439582b` · `src/clawsweeper-record-metadata.ts` · sha256 `df480a1e…83f1` |
| exit | `0` |

`stage-before.sh` exists because container images carry no `.git`: it writes the
base version of the changed file into `before/` on the host, where rsync picks it up
as a dirty file. When git *is* available `run-proof.sh` re-derives that file, so the
staged copy cannot drift from the base commit.

The script refuses to run below Node 24, installs the pinned pnpm into a
user-writable prefix, builds the Node lane, and runs the fixtures twice: once
against the module compiled from the base commit and once against this branch.

## Observed result

Against the pre-fix module 17 assertions fail. Beyond the label sets themselves,
a label named `$'` also fails `title survives` and `delimiters are unchanged` — the
expansion pulls the text following the match into the field, so the write damages the
record body, not just the one value. Keys containing `(`, `[`, `|`, `+` or `*` either
throw `SyntaxError: Invalid regular expression` or match the wrong line, and `a.c`
matches `aXc`. Against this branch every assertion passes. The ordinary `["bug"]`
case passes in both runs, which is what shows the change is confined to names that
carry a replacement pattern; the script fails the proof if that case ever regresses.

## Artifact / trace

`.crabbox/runs/run_26f52fe84002/run_26f52fe84002-artifacts.tgz` holds
`.artifacts/record-front-matter-literal-write-proof/` with `before-output.txt`,
`proof-output.txt`, `focused-tests.txt`, and the install/build logs.

## The run cannot alter the head it is proving

The script records `package.json` and `pnpm-lock.yaml` digests plus
`git status --porcelain` at sync, then re-checks them after dependency installation
and at the end of the run; any drift aborts with a diff. The platform-native
TypeScript fallback installs into a disposable prefix outside the workspace rather
than writing tracked dependency metadata, so the recorded result does not disturb
the head it is describing.

## Limits

This proves the record reader and writer in
`src/clawsweeper-record-metadata.ts`. The same raw-interpolation shape exists in
`src/repair/workflow-utils.ts`, `src/repair/create-job.ts`,
`src/repair/target-fanout.ts`, `src/repair/comment-router-core.ts`,
`src/commit-sweeper.ts`, `src/decision-packets.ts` and two scripts; those are left
for a separate change and are tracked in the linked issue. No shipped caller passes a
key containing regex syntax today, so part 4 hardens the advertised `key: string`
contract rather than fixing an observed failure — part 1 through part 3 are the
reachable defect. The proof does not call GitHub; it starts from the label set the
sync returns.
