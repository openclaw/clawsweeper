# Exact fixture and unchanged-context admission

The scanner must admit a reviewed synthetic URI in unchanged patch context while
continuing to scan the complete patch. The context line must match both committed
regular-file blobs through canonical path, full object ID, and hunk coordinates.
Every literal occurrence and every logical source reference must qualify.

The regression suite exercises the public classifier with complete source blobs
and matching Git object IDs. It rejects coherent added/removed occurrences,
unapproved sources, malformed coordinates/counts, mismatched bytes, mode/role
changes, encoded-only content, verified results, and duplicate exact-attribution
records. It preserves separate decoder/line attribution and legacy duplicate
counts. CRLF bytes and files without a final newline are covered.

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
