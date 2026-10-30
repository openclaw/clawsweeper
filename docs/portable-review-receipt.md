# Local review preflight summary

- Status: proposed; available in this candidate, not deployed enforcement
- Owner: ClawSweeper maintainers
- Source: `src/review-preflight.ts`, `src/review-preflight-contract.ts`, `src/review-preflight-body.ts`, `src/review-preflight-display.ts`
- Update when: local output, source checks, block format, or hosted body handling changes

## Generate a summary

From a built ClawSweeper checkout, review a clean committed target range:

```sh
pnpm run review -- --local-range --target-repo owner/repo \
  --target-dir ../target-checkout --base origin/main \
  --result-format json --output-retention summary --preflight
```

This runs the normal native review once. The JSON keeps its existing `status`,
`retention`, and `reports` fields and adds `preflight.block`. The report contains
native findings and detailed context; the block is a small advisory summary for
an existing PR body. No additional model call summarizes the result, and no
GitHub read, write, upload, or PR creation is performed by this export.

`review --preflight --help` prints usage without running a review. Without
`--preflight`, output is unchanged. The option requires `--local-range` and
`--result-format json`; exact-item and hosted exports are not supported.

The target must be clean, including staged and untracked files. The producer
uses the actual `merge-base(<base>, HEAD)` and `HEAD`, then checks both and the
working tree again at export. Changed or unavailable source produces
`preflight: {"block": null, "error": "..."}` and a nonzero exit status; the native
report and its native status remain available. No validated native assessment
also means no block. No old result is restamped with a new head.

## Block format

```text
<!-- openclaw-preflight:v1
{"v":1,"repo":"owner/repo","base":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tool":{"name":"clawsweeper","version":"1.2.3"},"completion":"complete","summary":"Native review complete; 0 reported findings. No summary priority filter. See the native report for coverage and policy caveats. Self-reported completion is not a clean verdict."}
-->
```

The example is illustrative, not an executed review. Version comes from the
running ClawSweeper package, not the target repository. Repository is the target
selected for the review; it is a self-reported identity, not authenticated remote
ownership. Base and head are full SHA-1 commit IDs; unsupported formats fail
export. The summary is generated from native status and finding count, without
copying model prose or file paths. It does not filter native findings by priority.
Native `complete` does not mean no findings, complete coverage, or approval;
`failed` explicitly warns that findings may be incomplete. This producer has no
separate native partial status and does not invent one.

The entire block is limited to 4 KiB after JSON/HTML escaping, including markers.
The decoded summary is limited to 512 UTF-8 bytes. `<`, `>`, and `&` are escaped
inside JSON so content cannot terminate the comment. Only the fixed fields above
are emitted. No report hash, source manifest, model, usage, role, or signature is
included. The detailed native report stays local under its existing retention
policy; keep it when a reviewer needs details. This summary cannot recover a lost
report or prove that a review ran honestly.

## Attach to an existing PR

Attaching is a separate explicit operation using the existing PR-edit workflow.
Preserve the rest of the body. Re-read the current canonical target, head, base,
body, and permissions first; require the same resolved range and a clean target.
Stop if a block already exists or the body changed during preparation. Read back
the exact edited body and recheck source afterward. These checks detect observed
conflicts, but GitHub body edits are not an atomic compare-and-swap operation.
Never write to a fork target; an existing PR from a fork into the canonical
upstream is attached only at that upstream PR. Private results stay private.

## Review-content normalization

The reader removes exactly one valid v1 annotation from PR review content before
body compaction, prompt construction, and semantic source and structural hashes.
It does not normalize issue bodies or comments. The complete raw body is checked
before compaction, so a second marker outside a displayed excerpt still prevents
exclusion. Bodies above 131,072 UTF-16 code units remain unchanged.

The reader accepts bounded descriptive tool names and versions, completion
`complete`, `partial`, or `failed`, and an optional lowercase SHA-256 report hash.
The local ClawSweeper producer still emits only its native completion states and
does not add a report hash. The reader does not fetch or verify a report. A hash
without its exact report bytes cannot verify those bytes or prove execution.

Unknown versions or fields, duplicate JSON keys (including escaped aliases),
invalid field types, malformed strings, oversized blocks, and multiple or nested
markers leave the entire body unchanged. The annotation must occupy a top-level
CommonMark HTML-comment block. Fenced, quoted, indented, inline, and enclosing
HTML-block examples remain review content. This is Markdown token recognition,
not browser-DOM validation: blank-line-separated Markdown inside `<details>` can
contain an eligible annotation.

Only the comment's exact interval is removed. All surrounding text and whitespace
remain material. Replacing a valid block in place preserves semantic content;
appending new separator blank lines also changes content. An attachment client
must not trim or rewrite the rest of the body.

This does not change raw event/admission identity, updated-at scheduling,
concurrency cancellation, or raw stored bodies.
Metadata edits can still enqueue work, run CI, or invalidate those raw guards.
Older stored semantic hashes can miss once when this reader is rolled out; no
compatibility fallback accepts their old identity. Independently deployed
components must use the same reader before claiming matching semantic hashes.
This candidate is not a deployment, a hosted-reuse guarantee, or a zero-cost edit
guarantee.

## Local source comparison

Existing exact-PR local reviews (`review --local-only --item-number <number>`)
add a **Local preflight source** section to their report/stdout output. It compares
the PR body's valid summary with the canonical target repository, exact head,
and actual merge base of the observed PR source snapshot. An advanced target
branch tip is not itself a changed diff base. A fork's head repository does not
replace the upstream PR target.

The section reports only `matches`, `stale`, or `unknown`. Missing or invalid
summaries, unsupported identities, unavailable or ambiguous local ancestry, and
known source drift produce `unknown`. A valid summary for another target, diff
base, or head is `stale`. Cached reports replace this section from the current
observation instead of retaining an earlier match. No extra GitHub request,
history download, scan, or model call is made for this display.

The comparison is scoped to the observed source snapshot, not a promise that
the PR stays unchanged afterward. It does not display contributor text, tool
names, completion values, links, or report digests. Completion remains
self-reported, and missing report bytes remain unverified. Matching source
does not certify the body, instructions, configuration, model, policy, tests,
execution, or review quality. Ordinary review identity checks still apply.

A contributor can edit this block; it grants no trusted execution claim, role,
review exemption, or permission to bypass hosted review. General attachment,
hosted comment/dashboard display, second-engine export, scheduling suppression,
and enforcement remain separate work. Local display adds no repository write
and does not copy private payload text to a public surface.
