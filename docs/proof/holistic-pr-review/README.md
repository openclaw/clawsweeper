# Engineering-review proof

- Status: historical execution, retained for the unchanged production inputs below
- Owner: ClawSweeper review maintainers
- Verified source: `97fd08368e2f1b6e797663ff419cfcd67ac396eb`; base: `291ab8a0090a8f76c08e4d0e39ea4cf1fdcbe0c0`
- Update trigger: any production source, prompt, schema, or dependency change

## Claim and execution

The production PR compositor adds the engineering opening without replacing
canonical policy; OpenClaw scans and delivers the same bounded schema message.
On October 15, native Linux x64 / Node26.8.2 / Codex0.147.0 ran both actual
production local-range reviewers with `gpt-6-astra`, normal medium effort,
read-only sandbox and 180-second budgets. No container image or lease was used.
The three fixtures covered queued cancellation, clean forwarding, and a callback
false-positive control. Both baseline and candidate found the one P2 defect and
returned no findings for either control; all six runs completed with clean targets.
The separate real scanner → OpenClaw worker → controlled CLI proof delivered
78,987 bytes with matching diagnostics; absent schema, quota and malformed-schema
checks passed. This tests transport, not live OpenClaw model compliance.

Production inputs are unchanged by the subsequent evidence-only reduction.
The run occurred during a staged rebase; its exact HEAD, diff, source/prompt
hashes, commands and observations remain in the immutable [execution receipt][receipt].
It was bound to the verified source above by matching all recorded hashes.
For example, the schema SHA-256 is `85502de3a4d7e309b1ea09a9be2d3b9e23eea8916ca55df7cd21445efa2752b4`.
This is evidence reuse by source equality, not a new model execution.

## Reproduction and limits

In a separate checkout of the verified source with admitted dependencies, use
`pnpm run build`, then the retained [native harness][native] and [delivery harness][delivery]:

```bash
node docs/proof/holistic-pr-review/run-proof.mjs .artifacts/review-proof-new
node docs/proof/holistic-pr-review/schema-delivery.mjs .artifacts/delivery-proof-new
```

The opt-in harnesses have no production or CI consumer; they and raw outputs
remain at that commit instead of being duplicated in the current patch.
Six controlled observations are not a review-quality, speed or cost benchmark.
Tests, current-head review and gate status are reported separately in the PR body.

[receipt]: https://github.com/openclaw/clawsweeper/blob/97fd08368e2f1b6e797663ff419cfcd67ac396eb/docs/proof/holistic-pr-review/rebase-20261015-receipt.json
[native]: https://github.com/openclaw/clawsweeper/blob/97fd08368e2f1b6e797663ff419cfcd67ac396eb/docs/proof/holistic-pr-review/run-proof.mjs
[delivery]: https://github.com/openclaw/clawsweeper/blob/97fd08368e2f1b6e797663ff419cfcd67ac396eb/docs/proof/holistic-pr-review/schema-delivery.mjs
