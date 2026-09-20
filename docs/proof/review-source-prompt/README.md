# Source-attributed review prompt proof

Historical proof for the follow-up to https://github.com/openclaw/openclaw/pull/153274.
The source-only qualification is already on ClawSweeper main at
20e7ed8e9aab5e58217708f4aebe89d3af157b8f. Hosted run 35521264587 still refused
material kind `prompt`: production introduction evidence copied the qualified
source hunk into unassociated prompt text. No source, scanner, or attribution
exception is expanded by this repair.

## Contract and exercised owner

Claim: production prompt assembly projects source-patch records to metadata,
while full committed source remains scanned and other prompt inputs remain
scanner-visible. `serializeReviewContext` owns the pure projection; model prompt
assembly and hydrated PR cache preflight explicitly select source records.
Captured patches remain available to existing deterministic policy/hydration
consumers. Reviewers inspect the canonical hunks using the retained role-labeled
commit bounds and file metadata.

The proof calls production `buildReviewPrompt` through `reviewPromptForTest`,
then public `scanAgentInput`, with the real OpenClaw PR source and canonical
TruffleHog 3.97.4 verification enabled. Environment: Linux x64, Node 26.8.2,
pnpm 12.4.1. No model execution, hosted publication, or scanner bypass is part
of this proof.

## Results

- [Before](before.json): full production prompt refused `findings` on prompt
  material, reproducing the hosted failure class.
- [After](after.json): the same source and context admitted; original context
  objects were unchanged. Both API patch copies and introduced-hunk copies are
  omitted only from their prompt projection.
- [Maintainer request](negative-maintainer.json): inserting the same URI into
  arbitrary maintainer input still refused prompt admission.
- [Discussion body](negative-discussion.json): inserting it into discussion text
  still refused prompt admission.
- [Changed source](negative-source.json): a one-byte source mutation still refused
  committed patch admission, despite source hunks being absent from the prompt.

Records retain only hashes, identities, bounded diagnostics and notices; the
credential-shaped synthetic value and full prompt are not published.

## Reproduction

Use a disposable OpenClaw checkout at
4df6f54115cde20d9225f791805a82b4bfcf3898 with complete relevant objects, including
base d1a550d938cba934d5cf2cd7bd0dc8a06c5da073. Build ClawSweeper with its pinned
toolchain, then run:

```bash
pnpm run build:node
node docs/proof/review-source-prompt/run-proof.mjs /path/to/openclaw-source 4df6f54115cde20d9225f791805a82b4bfcf3898 source /path/to/after.json
```

Replace `source` with `maintainer` or `discussion` for the prompt-refusal controls.
The source-refusal artifact used a disposable local commit that changed one ASCII
password byte in the source line identified by SHA-256
9b986f89b4bc448cd97566a1512992e765197fe5be1333cbb79681b1c25d95e4; that synthetic
commit is not a published OpenClaw change. Run the helper with the mutated local
head and `source` mode to reproduce its refusal.

Limits: controlled captured-source context, not a replay of every hosted context
field or model response. Hosted review must still scan its own actual inputs.
The runtime contract is owned by the input serializer, review runtime and review
command workflow; recheck on source-projection, context, scanner-pin or provenance
contract changes. OpenClaw Bay is unaffected; no observer or persisted-data schema
is changed.
