# Exact fixture admission in committed patches

The scanner admits reviewed synthetic URIs in context, added, and removed patch
lines while continuing to scan the complete patch. Context binds both committed
regular-file blobs; added and removed lines bind the head and base respectively.
Changed lines require exact ordered full-line attribution policy. Legacy rows
remain context-only. Every literal occurrence and every retained source reference
must qualify through canonical paths, full object IDs, and hunk coordinates.

New and deleted files also require an unambiguous host-captured raw Git A/D
record proving the absent endpoint. The full present-file hunk and rehashed blob
must agree. Missing blobs and textual `/dev/null` headers alone cannot qualify.

The regression suite uses the public classifier and real Git-generated patches
for additions, removals, new files, and deletions. It rejects missing, conflicting,
and malformed raw endpoint evidence; incomplete hunks; wrong newline markers;
unapproved full lines, aliases, modes, roles, and revisions; encoded-only content;
verified or mixed findings; and duplicate exact-attribution records. It preserves
legacy changed-line refusal, separate decoder/line attribution, and legacy
duplicate counts. CRLF bytes and files without a final newline are covered.

```bash
pnpm build:node
node --test test/agent-input-scan.test.ts test/agent-input-scan-fixtures.test.ts
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/trusted/openclaw \
  05c501ab7ebead40dc13b6758c80a5583d9b71c1 \
  b8382f64ea7db05db1b0a6ac3c7ae80b68025fc3 \
  /path/to/admission-proof.json
```

The proof uses `scanAgentInput`, its pinned native scanner, isolated environment,
canonical verification, complete committed source range, and a controlled prompt.
Only safe classifier notices and a bounded result are retained. It does not run
a model or replace the hosted review's own prompt/schema/source admission.

OpenClaw PR [149354](https://github.com/openclaw/openclaw/pull/149354) supplies the
real regression source. Hosted runs
[35012046356](https://github.com/openclaw/clawsweeper/actions/runs/35012046356)
and [35014912047](https://github.com/openclaw/clawsweeper/actions/runs/35014912047)
independently refused the unchanged create-profile fixture and unchanged patch
context respectively. The original source-row fixture dates to
[103139](https://github.com/openclaw/openclaw/pull/103139); its complete line did
not change in this browser repair.

OpenClaw Bay is unaffected: this changes scanner admission and host-side proof
notices, not the dashboard API or public action surfaces.

The plugin settings stack adds a committed-range case with both a new test file
and added fixture lines in an existing test file:

```bash
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/trusted/openclaw \
  3a4f9db62ee46701c3e7c494d981b07c74170c8f \
  598dc5aebd5aee9488f39898b2d6041f3993cc46 \
  /path/to/plugin-fixture-admission-proof.json
```

This is the complete source range for OpenClaw PR
[149330](https://github.com/openclaw/openclaw/pull/149330) at that head. It exercises
both exact source-blob attribution and added-line attribution, including the
new file's captured absence evidence. Native verification and completion checks
remain unchanged.

## Autoreview hardening fixtures

Claim: the maintainer-reviewed synthetic URI fixtures in the canonical autoreview
hardening test and its OpenClaw mirror admit through exact source attribution,
including Git-generated changed lines; a one-byte literal change still refuses.
This qualifies six identities at both exact paths without changing scanner,
verification, completion, source, mode, or patch-provenance gates.

The canonical file at agent-skills
`a7e91e188fa0c3d692ac69b3137f24c6c3a2d2c9` and the mirror in OpenClaw PR
[152039](https://github.com/openclaw/openclaw/pull/152039) at
`b2d3d0f86be704f80a04c11110aa1a7082a961a6` are byte-identical: 325358 bytes,
SHA-256 `87f42dcab4063224e75202ea0b47520c56ed7e283772a63572b332a1394893d8`.
[The identity evidence](autoreview-hardening/identities.json) records full
Raw/RawV2 and complete source-line digests, source paths, modes, and decoders.
Every identity occurs once in that file. The encoded-newline and encoded-NUL
identities share one complete source line.

Native scans emitted different finding subsets for identical bytes. In addition
to the four originally reported identities, they observed the empty-username
proxy fixture on head line 6596 and the encoded-NUL rejection fixture on line
6609. Both are in `AuthenticatedProxyTests`; neither comes from material outside
the reviewed autoreview test. These additional rows permit only observed PLAIN
decoding. Native evidence retained here is PLAIN; HTML coverage for the original
four identities uses constructed classifier records, not recovered native evidence.

The controlled runtime proof uses the complete committed range, the canonical
pinned TruffleHog 3.97.4 scanner, and enabled verification. It ran on September 18,
2026 using native macOS arm64, Node 26.8.2, and pnpm 12.4.1 (provider: local host;
no container image or lease). The trusted OpenClaw checkout stayed unchanged;
a disposable shared-object checkout was pinned to the PR head because committed
admission requires the checkout HEAD to match. The base is the merge base obtained
from the trusted checkout's origin/main.

```bash
pnpm build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/disposable/openclaw-at-pr-head \
  a9fea70fcba242ff715cf248291c19c2e469de4c \
  b2d3d0f86be704f80a04c11110aa1a7082a961a6 \
  /path/to/admission-proof.json
```

[Before qualification](autoreview-hardening/before.json), the proof refused with
`findings / literal_not_reviewed` and no success notices. After qualification,
three consecutive runs of the same range admitted with zero refusals:
[run 1](autoreview-hardening/after-1.json),
[run 2](autoreview-hardening/after-2.json), and
[run 3](autoreview-hardening/after-3.json). They retained four, three, and three
bounded success notices respectively. An external observation hook recorded only
native finding hashes and line witnesses; it left scanner arguments, output,
exit status, and classification unchanged.

The regression suite separately exercises additions and removals using real Git
patches at both paths, all qualified decoder variants, every one-byte literal
mutation, and changed source lines for the existing legacy value. Retaining the
legacy row for review-context omission does not restore value-only changed-line
admission.

Limits: this proof runs no model and does not replace admission of the hosted
review's own prompt, schema, and source inputs. Three successful repetitions
establish the requested bounded repeatability evidence, not a guarantee about
every future scanner finding. OpenClaw Bay is unaffected: only host-side fixture
attribution changes; there is no dashboard API, telemetry, or public-action change.

## Question URL rejection fixture

Maintainer-approved qualification: admit only the existing
synthetic userinfo-rejection fixture in `ui/src/app/question-prompt.test.ts`.
The fixture was introduced by OpenClaw commit
`a37eb17fdfd688e0ed7e7be31950381cf15fb9bd` and is unchanged at line 220 in both
endpoints of [PR 152096](https://github.com/openclaw/openclaw/pull/152096).
[Identity evidence](question-prompt/identities.json) records both full blob IDs,
the regular-file mode, complete source-line digest, and native match digests.

Native TruffleHog 3.97.4 reports the same fixture through PLAIN or HTML decoding.
Its Raw value omits the path and RawV2 stops before the hyphen in `/sign-in`.
Both proposed attribution tuples therefore bind the complete original source
line as well as the native Raw/RawV2 pair, detector 17, exact path, and mode
`100644`. No value-only fixture row, scanner option, verification check, source
binding, or patch-attribution rule changes.

The controlled native proof ran on macOS arm64 with Node 24.21.0 and pnpm 12.4.1,
using a disposable OpenClaw worktree pinned to the requested head. It exercises
the complete PR source range with verification enabled:

```bash
pnpm build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/disposable/openclaw-at-pr-head \
  24caac494ee4858989e58300925c5775a4dd45b2 \
  1db1bd5c9289f5c348e2c06ce0253aa9f5533584 \
  /path/to/question-fixture-proof.json
```

[Before qualification](question-prompt/before.json), the native proof refuses
with `literal_not_reviewed`, matching the hosted review diagnostic. The same
range admits in three consecutive runs:
[run 1](question-prompt/after-1.json), [run 2](question-prompt/after-2.json), and
[run 3](question-prompt/after-3.json). Adjacent `.native.json` observations retain
only finding hashes, coordinates, and bounded native metadata; the observation
hook does not alter scanner arguments, results, exit status, or classification.

The focused regression exercises real Git-generated added, removed, and context
lines for both decoders. It also refuses a one-byte literal change, changed full
source line, different path, executable mode, verified finding, and unqualified
decoder. Existing scanner tests retain all other admission guards.

Limits: no model runs, no hosted review is bypassed, and no runtime policy is
published by this proof. Hosted review must scan its own complete inputs after
an approved rollout. OpenClaw Bay is unaffected; only host-side fixture
qualification changes, with no dashboard API or action surface change.

## GitHub unsafe-check-link fixture

Maintainer-approved qualification for the single synthetic userinfo-rejection
fixture in `extensions/github/src/detail-checks.test.ts`, introduced by
[OpenClaw PR 153274](https://github.com/openclaw/openclaw/pull/153274). The test
asserts that unsafe check-run and commit-status URLs are omitted. Its reserved
example hostname and synthetic userinfo are test data, not live credentials.

[Identity evidence](pr153274/identities.json) binds the complete source line,
regular-file mode, source blob, native Raw/RawV2 hashes, and captured Git A record
for this new file. The qualification adds only the observed URI detector's PLAIN
and HTML variants at that exact source path. It does not add a value-only row or
a directory-wide exemption.

The controlled proof ran on Linux x64 with Node 26.8.2, pnpm 12.4.1, and the
canonical pinned TruffleHog 3.97.4 scanner, with verification enabled. A disposable
shared-object checkout was pinned to the real PR head; the canonical source
checkout was not changed. From a built ClawSweeper checkout:

```bash
pnpm run build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/disposable/openclaw-at-pr-head \
  6f3aa8d6bc409bd4502902382c0055ed489ace38 \
  4df6f54115cde20d9225f791805a82b4bfcf3898 \
  /path/to/fixture-admission-proof.json
```

[Before qualification](pr153274/before.json), the full committed range refused
with `findings / material_not_reviewed`. Native observations retained only
finding hashes and coordinates; scanner arguments, output, status, and
classification were unchanged. All observed findings had the same Raw/RawV2
identity. HTML decoding can report patch line 511 while the literal is on line
512; the existing owner resolves that literal to committed source line 388.
The qualification binds the actual complete source line, never the neighboring
line or the scanner coordinate alone.

The same range admitted in three consecutive runs:
[run 1](pr153274/after-1.json), [run 2](pr153274/after-2.json), and
[run 3](pr153274/after-3.json). Adjacent `.native.json` files record the bounded
observations. Each successful scan retained exact source-attribution notices.

A separate disposable commit changed one ASCII byte of the fixture password,
with the path, mode, and test structure otherwise unchanged. The canonical native
scan [refused that mutation](pr153274/negative-one-byte.json) with
`findings / literal_not_reviewed`; that local proof commit is not a published
OpenClaw change. The focused scanner/fixture suite passes 365 tests, including
new real-Git added, removed, and context-line cases for both observed decoders
and refusal controls for literal, full-line, path, mode, role, verified status,
unqualified decoder, and an additional occurrence.

Limits: no model runs and no hosted review is replaced. Hosted ClawSweeper must
rescan its own current prompt, schema, and complete source inputs after the
normal policy landing. Existing scanner, verification, completion, source,
mode, and patch-provenance gates remain enabled. OpenClaw Bay is unaffected: no
dashboard API, telemetry schema, or public action surface changes.

## Browser CDP discovery fixture

Claim: the approved synthetic credentialed-CDP discovery fixture in
`extensions/browser/src/browser/pw-session.connections.test.ts` admits through
exact source attribution; a one-byte mutation still refuses. This unblocks
[OpenClaw PR 153597](https://github.com/openclaw/openclaw/pull/153597), whose
browser changes retain the existing fixture unchanged.

[Identity evidence](browser-session/identities.json) records the two observed
URI detector 17 tuples, for `PLAIN` and `HTML`. Each binds both native value
digests, the complete source line,
original path, regular-file mode, and committed base/head references. The
scanner's verification and complete-input admission checks stay enabled.

The controlled proof runs the actual `scanAgentInput` entry point with pinned
TruffleHog 3.97.4 against the complete committed PR range on macOS arm64,
Node 26.8.2, and pnpm 12.4.1. Provider: local host; no image or lease.

```bash
pnpm run build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/disposable/openclaw-at-pr-head \
  ca128370df1057f5d1169e5918dfe551ac212a81 \
  2d674c57c1d9e5e174c0cecc6961763cf4230157 \
  /path/to/browser-session-admission.json
```

[Before qualification](browser-session/before.json), ClawSweeper main
`20e7ed8e9aab5e58217708f4aebe89d3af157b8f` refused with
`findings / literal_not_reviewed`. [After qualification](browser-session/after-1.json),
the identical range admitted in 6.4 seconds, classifying the browser fixture at
both endpoints and the separately approved browser documentation fixture. This
run observed PLAIN; the earlier native fixture scan observed HTML as well.

A disposable commit changed exactly one byte of the fixture, preserving the
path and mode. The same canonical scan [refused it](browser-session/negative.json)
with `findings / literal_not_reviewed`.
[The negative-control record](browser-session/negative-control.json) binds its
original and changed blobs and line digests; the mutation was not published.

The regression suite uses real Git-generated added, removed, and context lines
for both qualified decoders. Negative controls cover changed values, full lines,
paths, modes, uncommitted roles, verified findings, other decoders, and extra
occurrences. The three positive browser cases fail on the unqualified policy.

Limits: no model runs. Hosted review must rescan its own complete prompt, schema,
and source inputs. OpenClaw Bay is unaffected; there is no dashboard API,
telemetry, or public action surface change.

## TypeSafe local transport fixture

Claim: the approved synthetic loopback credential-rejection fixture in
`extensions/typesafe/src/local.transport.test.ts` admits through exact source
attribution, while a one-byte mutation still refuses. This unblocks the
input scan for [OpenClaw PR 154059](https://github.com/openclaw/openclaw/pull/154059).
It adds no model-side instructions or scanning bypass.

[Native identity evidence](typesafe/native-observed.json) records URI detector 17,
both observed `PLAIN` and `HTML` decoders, and the exact Raw/RawV2 digests.
The policy also pins the complete source line, original path, regular-file mode,
and committed base/head witnesses. No other fixture in the file is qualified.

The actual `scanAgentInput` entry point scanned the complete committed range
with pinned TruffleHog 3.97.4 and enabled verification on macOS arm64,
Node 26.8.2, pnpm 12.4.1 (local host, no container or lease):

```bash
pnpm run build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/disposable/openclaw-at-pr-head \
  7d14778dc23424b7763f4e47e87aca2b63d6b363 \
  3ee5b1050b7f94ba65dc596ef13188b6ea7a602f \
  /path/to/typesafe-admission.json
```

[Before qualification](typesafe/before.json), ClawSweeper
`a09e6cefb31adcd12bba10e1658cae5fced08c80` refused with
`findings / literal_not_reviewed`. [After qualification](typesafe/after.json),
the same range admitted in 2.24 seconds, with independently attributed source
and added-patch findings. A disposable commit changed one byte in the fixture;
[that control](typesafe/negative-control.json) was [refused](typesafe/negative.json).
The control commit is not published.

The shared real-Git fixture suite covers added, removed, and context lines plus
changed literal, line, path, mode, role, verification status, decoder, and extra
occurrence refusals. Scanner completion and verification checks remain unchanged.
No model runs in this proof; hosted review must rescan its current prompt, schema,
and complete source inputs. OpenClaw Bay is unaffected: no dashboard API,
telemetry, or public action surface changes.
