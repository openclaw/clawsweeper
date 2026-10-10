# Reviewed generated event UUID

Ship PR https://github.com/dinkuskit/ship/pull/19 is unchanged:
base `9be08279694a7cdba55bd35b813641eae75aca3f`,
head `77d22efdc90594981ef9b5e71983c9abadb8df0c`.
Native receiver 37966569102 refused before generation: detector 938 (Privacy)
matched the generated `event_id` after the word privacy in a decision reason.
The installed GrillTrack ledger generates that field with `uuid.uuid4()`.
The safe failure manifest and an in-memory match comparison identified the same
UUID in the blob and introduced patch; raw matches were not retained.

The host policy qualifies this one occurrence using both native value digests,
full line digest, full blob digest, original path, regular mode, committed
reference, detector identity, plain decoder, and unverified result. The JSON
line must identify that value as a `decision_reopened` event ID. Native patch
findings must resolve against the original complete scanned blob. No runtime
flag, target-controlled allowlist, scanner exclusion, or verification setting
changes. Other event UUIDs remain findings and require their own adjudication.

## Executed behavior

On macOS arm64, Node 24.16.0, checksum-qualified TruffleHog 3.97.4:

- Upstream baseline `fe750d1779` refuses the complete source range with findings:
  [baseline receipt](native-baseline.json).
- Candidate admits the identical range and retains two source/patch notices:
  [candidate receipt](native-candidate.json).
- Candidate refuses an additional fresh, unreviewed Privacy-shaped UUID with
  verification enabled: [negative receipt](native-negative.json).

Commands from each respective engine worktree:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  <hydrated-ship-checkout> <base> <head> <receipt.json>
node docs/proof/ship19-event-uuid/run-negative.mjs \
  <hydrated-ship-checkout> <base> <head> <negative.json>
node --test test/agent-input-scan-event-uuid.test.ts test/agent-input-scan-fixtures.test.ts
pnpm run check
```

Focused regression coverage includes add/remove/context blob and patch
witnesses, changed values/content/path/mode/role/metadata, additional references,
duplicate occurrences, and an additional unreviewed finding. It also rejects
broadened policy rows. Existing scanner checks remain required.

This is scan-only proof with a controlled prompt, not model/native publication
clearance. Full checks and fresh Codex reviews are reported in the PR body.
The live Dinkus engine is still `9d90452b2b70db072888bd6830fdbc6208f35d36`;
no engine deployment or Ship modification is part of this PR. After maintainer
approval, a separately reviewed integration/pin update must qualify this change
on the live engine lineage before an owner-authorized native retry. OpenClaw
Bay is unaffected: no queue, publication, lifecycle, or status schema changes.
