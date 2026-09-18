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
