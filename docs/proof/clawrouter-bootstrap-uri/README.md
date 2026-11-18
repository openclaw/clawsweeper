# ClawRouter bootstrap fixture qualification

Historical proof, owned by ClawSweeper maintainers. Owning policy:
`src/agent-input-scan-approved-values.ts`; classifier:
`src/agent-input-scan-classifier.ts`. Recheck when this value, its detector or
decoder, the scanner pin, classifier, or Git staging changes.

The review of https://github.com/openclaw/clawrouter/pull/1129 stopped before
model execution in
https://github.com/openclaw/clawsweeper/actions/runs/44260073171. Its bootstrap
negative test intentionally supplies synthetic credentials to a reserved invalid
origin and asserts rejection without leaking them. The test remains unchanged.

On macOS arm64 with Node 26.4.0, freshly built ClawSweeper
`4be04201a28b893207fdea219c951ec0dd143291` and checksum-pinned TruffleHog 3.99.4
[refused the complete committed source](before.json). The
[native identity reproduction](native-identities.json) found the same unverified
PLAIN URI pair in the new test blob at line 29 and full patch at line 586.
Adding that one exact pair [admitted the unchanged complete range](after.json).
The compiled classifier, scan entrypoint and bootstrap hashes stayed identical;
only the approved-value module hash changed. The after receipt records a dirty
policy candidate, whose exact compiled inputs are retained in that receipt.

The approval retains both native value digests, detector identity, PLAIN decoder,
verification failure and native credential-part checks. Focused regression tests
refuse changed values, verified findings, another decoder, inconsistent metadata,
incomplete scans and a mixed unapproved finding. No hostname rule or scanner
verification setting changes.

To repeat the full-source admission check, build this policy revision and use a
disposable ClawRouter checkout at the exact reviewed head with both commits
available. Run from the ClawSweeper checkout:

```sh
pnpm run build
node --input-type=module - /path/to/clawrouter-at-reviewed-head <<'NODE'
import { scanAgentInput } from './dist/agent-input-scan.js';
scanAgentInput({
  cwd: process.argv[2],
  prompt: 'Read-only review of the committed native cutover and rehearsal repair.',
  source: {
    kind: 'committed',
    baseSha: '6605ddd8730d3626d358b22643277a59ae5b3e65',
    headSha: 'e3bfa63b8bd162d2bfd632bafec8842902f74a28',
  },
  timeoutMs: 180000,
});
console.log('Complete committed source admitted.');
NODE
```

The receipts contain no raw credential, scanner output, prompt or completion.
This proves native input admission, with verification enabled and no model call.
Hosted review must still rescan its own prompt, schema and source after the policy
lands. No ClawRouter runtime, Cloudflare deployment, queue control or dashboard
surface changes.
