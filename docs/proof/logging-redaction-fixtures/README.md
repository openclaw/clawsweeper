# OpenClaw logging redaction fixture admission

## Behavior contract

Requalify the synthetic connection-string fixtures in OpenClaw's
`src/logging/redact.test.ts` after [OpenClaw #160879](https://github.com/openclaw/openclaw/pull/160879)
rewrote that file. The values use reserved `example.test` hosts and descriptive
placeholder userinfo inside a redaction test; they are not operational
credentials.

The rewrite kept four of the five remaining fixture lines byte-for-byte, but
changed the scan result in two ways. The `secret:***` Postgres fixture moved
into a differently indented assertion, so its complete-line digest no longer
matched. The new chunk contents also let pinned TruffleHog 3.97.4 label every
remaining identity `HTML` as well as `PLAIN` or `ESCAPED_UNICODE`. The label is
nondeterministic between runs of the same bytes, and the exact attribution table
never permitted `HTML` for this path. Any pull request touching the file was
refused before review, including through its unchanged base blob.

The host policy adds seven exact rows and permits `HTML` for this one source.
Each row still binds detector ID and name, decoder, `Raw`, `RawV2`, the complete
source-line digest, path, mode `100644`, and committed base/head roles. `HTML`
rows exist only for the five post-rewrite identities; the pre-rewrite rows stay
unchanged because pull requests whose merge base predates #160879 still stage
the old blob. Verified findings, changed lines, extra occurrences, unknown
decoders, other paths or modes, uncommitted roles, duplicate records, and
incomplete scans remain refused. Patch-embedded MongoDB/Postgres findings keep
their existing refusal.

## Native proof

The hosted refusal came from [run 36514869480](https://github.com/openclaw/clawsweeper/actions/runs/36514869480)
for [OpenClaw #160888](https://github.com/openclaw/openclaw/pull/160888): finding
2 of 10, URI detector 17, `HTML`, `finding_not_reviewed`, head blob `a2d4c9ad`.
Replay that exact range with the existing source-admission runner, which drives
host staging and admission through the checksum-pinned native scanner with
normal verification and no model call. The target checkout needs `HEAD` at the
head commit with a clean index; a sparse checkout of the four touched paths is
enough.

```sh
pnpm run build:node
node docs/proof/marketplace-telemetry-fixtures/run-proof.mjs \
  /path/to/openclaw \
  9b5b439dcb6e11b929c982d9b40e8ddcb4c9b2e5 \
  08d64d3b5ec802237eff61e10e0f1a3aeb8761b0 \
  /path/to/proof.json
```

The [native result](native-results.json) records five runs of the original
policy (ClawSweeper `main` at the pull request base) and twelve of the
candidate over the same complete range on macOS, with `policySourceSHA256`
binding the candidate runs to the committed `src/agent-input-scan-fixtures.ts`.
The original policy refused every run: three times `finding_not_reviewed` for
an `HTML` URI, MongoDB, or Postgres finding (once through the base blob that
matches current OpenClaw `main`), and twice `literal_mismatch` for the
rewritten Postgres line. The candidate admitted eleven runs and classified 86
emitted findings.
Across those runs every post-rewrite identity appeared under more than one
decoder label, and the MongoDB, `secret:secret` Postgres, and empty-username
URI identities appeared as `HTML`. Emitted subsets varied between four and
five identities per run.

One candidate run was refused with `duplicate_finding`: the native scanner
emitted the same head-blob URI record twice (eleven findings instead of ten).
That line sits inside the 3 KB peek overlap after a 10 KB chunk boundary, so
both chunks carry it and TruffleHog's cross-chunk deduplication occasionally
races. The existing duplicate-record guard refused it, unrelated to the added
rows; 24 direct scans of the same blobs emitted no duplicate. Relaxing that
guard is a separate policy decision and is not part of this change.

This is source-admission proof, not a hosted review. Hosted runs scan their own
complete inputs. Reviews already held after a terminal scanner refusal still
need a fresh explicit re-review; this change does not bump the retry-policy
epoch. OpenClaw Bay is unaffected: no status, queue, publication, telemetry, or
observer contract changes.
