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
