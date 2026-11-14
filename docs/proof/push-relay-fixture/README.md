# Push relay synthetic value qualification

Active qualification evidence for https://github.com/openclaw/clawsweeper/pull/2195.
Maintainers own the approval in `src/agent-input-scan-approved-values.ts` and its
classifier regression in `test/agent-input-scan-classifier.test.ts`. Verified on
current owner base `03195296e1` after https://github.com/openclaw/clawsweeper/pull/2201.
Recheck when the native scanner, value pair, decoder binding or classifier changes.

The unchanged synthetic userinfo-rejection fixture from
https://github.com/openclaw/openclaw/pull/193714 remains absent from the replacement
approval table. This adds its exact detector 17/URI, Raw/RawV2 digest pair and only
three observed decoders: PLAIN, HTML and ESCAPED_UNICODE. No classifier code,
verification flags or staging guards change. Surrounding-source edits and other
material roles follow current main's deliberate value-based policy; the deleted
file/line-bound classifier is not restored.

## Current-owner proof

[current-owner-before.json](current-owner-before.json) refused the complete
original committed source range with `findings/finding_not_reviewed`.
[current-owner-after.json](current-owner-after.json) admitted the same range.
The original hosted failure disclosed only its first finding; this proof does
not retrospectively identify its undisclosed second finding.

[Native value proof](native-value-proof.json) exercises production `scanAgentInput`
and pinned TruffleHog 3.99.4 with verification enabled: unchanged value and
surrounding-source edit admit; changed password and changed path refuse. Each
runs through both prompt and committed-source staging (8/8 observations).
The focused classifier, scanner and Git-metadata suite passed 74/74 with no
skips. The new regression first failed at its admission assertion before the
approval row was added. Verified findings, unobserved decoder, altered values,
metadata drift, incomplete scans and mixed unreviewed findings still refuse.

Run with Node 24+, pinned dependencies, a checksum-verified scanner on PATH and
its cache outside the checkouts:

```sh
pnpm install --frozen-lockfile
pnpm run build:node
node --test test/agent-input-scan-classifier.test.ts test/agent-input-scan.test.ts test/agent-input-scan-git-metadata.test.ts
node docs/proof/push-relay-fixture/run-proof.mjs --out /private/task-proof.json
```

The runtime receipt identifies the pre-commit base and dirty source; the PR body
binds it to the final committed tree. No model, phone, Gateway, working credential,
live policy change or deployment was used. Native macOS arm64 proof is admission
proof, not a completed hosted code review. Trusted rollout remains separate.

## Retained historical evidence

All other JSON files in this directory are unchanged evidence from candidate
`265a06d1647acbdfd68e8cf94c045636c443dff3` against its earlier owner. Their old
file/line-bound attribution and refusal semantics are historical, not current
policy promises. In particular `native-negative.json` stopped at the old
source/patch guard. New altered-value proof above exercises the replacement.
Original raw scanner outputs and failed test logs remain private local evidence.
