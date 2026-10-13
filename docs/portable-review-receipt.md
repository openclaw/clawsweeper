# Local review preflight summary

- Status: proposed; available in this candidate, not deployed enforcement
- Owner: ClawSweeper maintainers
- Source: `src/review-preflight.ts`, `src/clawsweeper-review-command-workflow.ts`
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
The escaped summary is limited to 512 UTF-8 bytes. `<`, `>`, and `&` are escaped
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

This candidate does **not** change hosted body normalization. Attaching a block
currently changes the body consumed by hosted prompts and digests. It does not
establish hosted reuse or guarantee that no review is triggered. The initial
handoff demonstration is limited to an existing maintainer-authored draft with
no automation opt-in, with its live admission state checked separately.

A future consumer may compare repository, current resolved diff base, and head
and report source-match, stale, or unknown. That is source identity only: body,
instructions, configuration, model, policy, and review quality are not certified.
A contributor can edit this block; it grants no trusted execution claim, role,
review exemption, or permission to bypass hosted review. General attachment,
shared hosted normalization, second-engine export, and enforcement are separate
work, not enabled by this candidate.
