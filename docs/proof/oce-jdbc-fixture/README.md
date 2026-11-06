# OCE JDBC fixture qualification

- Status: proposed host-policy change with local native-capture proof
- Owner: ClawSweeper review-input maintainers
- Source: `src/agent-input-scan-fixtures.ts`
- Baseline: `b5cb826882d5093d711ad52428aff7828dcdacb8`
- Reverify when the fixture, source bytes, scanner, attribution or staging changes

## Claim

The configuration-save test in [OCE PR 4604](https://github.com/openclaw/openclaw-enterprise/pull/4604)
contains a password-free JDBC value. It proves that an `@` outside URL authority
is accepted; it does not connect to a database. TruffleHog reports this value as
an unknown JDBC finding because verification lacks a password.

This candidate recognizes that exact finding in two complete source blobs of
`tests/integration/configuration-controller.test.mjs`. It requires JDBC detector
10, observed PLAIN decoding, the complete literal and source-line hashes, an
empty `RawV2`, the observed connection-string metadata, and the exact
missing-host-or-password verification error. The existing source path,
regular-file mode and committed base/head restrictions still apply. The reported
line must be the literal's actual source line. Changed source bytes and other
JDBC findings remain blocking.

The captured base is `0c7126dc16df1a01e2242e9bd35f9e742d6cee56`, blob
`a47ca824f479fc37a2fa63aa9205cf953cdc11a0`, line 5448. The captured head is
`35189c5da21389a6ce85255ee65d8e979e26a8e9`, blob
`f0e927f8cc0be7876b2ed845c5d5c9a95cf478c8`, line 5451. OCE head
`b926e02b274acff7b288945606d6547e57ced9a2` retains that same head blob.

## Reproduce the proof

Use Linux amd64, Node 24+, the built classifier and native TruffleHog 3.99.4.
The official Linux amd64 archive SHA-256 is
`5ae9b313342d1bfa96404064c0f59e77a2cbd1824d797ca7b11e6655aa8fd9d1`;
the executable SHA-256 is
`70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1`.
Verify both before scanning. Stage each exact Git blob in a separate private
directory under its object ID. Run once per directory with a fresh private
`HOME`, `TMPDIR`, `TMP` and `TEMP`, without ambient credentials:

```text
<verified scanner> filesystem <blob-directory> --results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color
```

Preserve complete stdout and stderr privately as `native.stdout.jsonl` and
`native.stderr.jsonl`. Beside them, save `receipt.json` with the actual
`exitCode`, `binarySha256`, complete `argv`, and a `sha256` field under each native
stream filename. Native output contains credential-shaped fixture values; do
not publish it. Both retained scans exited 183 with one unknown JDBC finding,
zero verified findings and complete native logs. Verification stayed enabled.

From the candidate checkout, pass each previously built classifier:

```sh
node docs/proof/oce-jdbc-fixture/replay.mjs baseline /baseline/dist/agent-input-scan-fixtures.js /private/base-capture /private/head-capture
node docs/proof/oce-jdbc-fixture/replay.mjs candidate dist/agent-input-scan-fixtures.js /private/base-capture /private/head-capture
node --test test/agent-input-scan-fixtures.test.ts
```

The replay verifies Git object identities, complete source hashes, stream hashes
and the scanner invocation before passing unmodified streams to the production
classifier. The baseline refuses both with `finding_not_reviewed`; the candidate
classifies both. Each candidate replay also rejects 27 changed metadata,
credential, provenance and native-completion cases. Four additional controls reject altered JDBC policy tuples.
These controls mutate copies of the captured records; they do not replace the native positive proof.
The replay withholds private input from every failure, including JSON parsing,
assertions, file reads and classifier loading. Eleven CLI controls cover
malformed receipts and native streams, plus valid JSON with unexpected scanner
arguments, source paths or lines, exit codes, binary pins and stream hashes.
They also cover a missing source file. Each uses a harmless marker and must
fail without including it in stdout or stderr. For changed native streams,
update the private receipt's stream hash so the intended validation is reached.
The prior script exposed markers in the eight valid-input controls; the fixed
failure boundary withholds them in all eleven.
[Results](results.json) bind the source and native-stream hashes without raw values.

The focused fixture suite passed all 570 tests. The full check on the first
candidate completed with 7,050 passes, 11 failures and 22 skips. Its failures
include shell startup errors, a missing npm executable, and unresolved webhook,
archive, workflow and bootstrap assertions. These remain validation gaps; the
native replay does not establish a passing full check.

## Limits

This proves classification of the two captured blobs. It does not prove a
complete hosted input scan, patch admission, model review or policy deployment.
The historical hosted diagnostic retained only its first finding and a count of
two; the second historical record was not recovered. The two new captures
establish their own findings independently.

The candidate has not changed the active runner policy or released the OCE
review hold. Maintainer acceptance and the required committed-branch review
precede publication. After the reviewed policy becomes available, OCE still
needs its normal complete exact-head review. Editing its current source alone
would leave the original base blob in the review input.
