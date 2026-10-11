# Retired automatic live proof: historical contract

This directory preserves the receipt for the earlier removal of automatic
post-review proof generation. Its original contract temporarily retained
historical artifact folding, recording publication and the Bay comparison UI.
That compatibility period has ended; the old proof drivers and Bay demo runner
are no longer supported or rerunnable from this checkout.

The retained `receipt.json` describes the historical tested head, not current
production behavior. It is not evidence of current hosted availability.

## Current contract

- Review decisions and reports do not generate `liveProofPlan` or a `Live Proof`
  section.
- The old `src/live-proof` executor, compatibility CLI, artifact folding, media
  upload and recording-retraction paths are retired.
- Historical attachments remain untouched in storage but do not affect current
  readiness, automation markers or rendered comments.
- Existing bundles may retain opaque historical files; publication ignores those attachments.
- Current inline proof, the hosted app-server worker and ordinary review/apply
  publication remain separate supported paths.

See [Live proof](../../live-proof.md) for current admission, evidence and deadline
rules. Current regression coverage lives in `test/live-proof-report.test.ts`,
`test/sweep-workflow.test.ts`, and the active hosted review scan smoke harness.
