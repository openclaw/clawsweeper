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

The [native result](native-results.json) records three runs of the original
policy (ClawSweeper `main` at the pull request base) and eight of the
candidate over the same complete range on macOS, with `policySourceSHA256`
binding the candidate runs to the committed `src/agent-input-scan-fixtures.ts`.
The original policy refused every run, through the base blob that matches
current OpenClaw `main`: `literal_mismatch` for the rewritten Postgres line
under `PLAIN`, and `finding_not_reviewed` for an `HTML` MongoDB finding. The
candidate admitted every run and classified 66 emitted findings; every
identity appeared as `HTML` in the base role, and four of the five under all
three labels. Emitted subsets varied between four and five identities per run.
An earlier replay of the same range recorded one `duplicate_finding`
refusal: the native scanner emitted the same head-blob URI record twice for a
line inside the 3 KB peek overlap after a 10 KB chunk boundary, and the existing
duplicate-record guard refused it. That scanner property is unrelated to the
added rows and unchanged here.

## Known limit: decoded findings borrow the plain witness

The exact path locates the approved plain `RawV2` literal anywhere in the
staged blob, or as a patch witness, and never establishes where an `HTML` or
`ESCAPED_UNICODE` finding originated. An entity-encoded copy of an approved
synthetic value elsewhere in the same file decodes to the same identity and is
attributed to the plain line. This is the existing behavior of every exact row
that permits `HTML`; this change extends `HTML` to one more source. What such
a borrowed attribution admits is only the same digest-bound synthetic value,
so no new secret passes.

The artifact records the limit natively with local-only OpenClaw commits that
add an entity-encoded copy (each colon as a numeric entity) of the approved
browser URI: with the copy at line 4 of both base and head blobs, and with the
copy inserted two lines above the plain fixture so the hunk context carries the
plain line as a witness. The candidate admitted 2/2 runs of each scenario, and
the recorded scanner lines show the copy's own finding (line 4, patch line 135)
classified against the plain witness.

Binding the finding to the scanner-reported line is not a fix: the pinned
scanner counts lines in decoded chunk data, so five consecutive blank lines
shift an `HTML` finding by four lines, three `\u000a` escapes shift an
`ESCAPED_UNICODE` finding by three, and block-level HTML tags in a string shift
`HTML` by three, each refusing a legitimate fixture. The sound fix is a masked
native re-scan, as already used for Cloudflare metadata, tracked in
[openclaw/clawsweeper#1724](https://github.com/openclaw/clawsweeper/issues/1724)
for every exact `HTML`/`ESCAPED_UNICODE` URI row.

This is source-admission proof, not a hosted review. Hosted runs scan their own
complete inputs. Reviews already held after a terminal scanner refusal still
need a fresh explicit re-review; this change does not bump the retry-policy
epoch. OpenClaw Bay is unaffected: no status, queue, publication, telemetry, or
observer contract changes.
