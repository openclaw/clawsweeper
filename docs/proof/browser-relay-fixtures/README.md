# Browser relay fixture qualification

Historical proof, owned by ClawSweeper maintainers. Owning policy:
`src/agent-input-scan-approved-values.ts`; classifier:
`src/agent-input-scan-classifier.ts`. Recheck when these values, decoder coverage,
scanner pin, classifier, or Git staging changes.

The review of https://github.com/openclaw/openclaw/pull/203159 stopped before model
execution in https://github.com/openclaw/clawsweeper/actions/runs/44923658232.
Two existing browser test fixtures require qualification:

- The status redaction fixture in `extensions/browser/src/browser/routes/basic.existing-session.test.ts`
  is already qualified for PLAIN. Native scanning also reports HTML for the same
  exact value pair.
- The process-only relay token fixture in `extensions/browser/src/browser/config.test.ts`
  is a literal dummy token used to assert configuration URL construction. The
  scanner's native value ends at the IPv4 host, before the template's dynamic port.
  Both PLAIN and HTML report this same pair.

Both fixtures exist at the base and head below. The tests use mocked browser
state/configuration, not credentials read from an operator or service. They stay
unchanged. The proposal qualifies these exact native values, not a hostname,
file, arbitrary credential, verification success, or detector wildcard.

## Executed real behavior proof

On macOS arm64, Node 24.22.3, with checksum-pinned TruffleHog 3.99.4 and
ClawSweeper base `fb7b06fad55acdadbf8dc69071da137a7f79b170`:

1. Production `scanAgentInput` [refused the unchanged complete committed source](before.json).
2. A separate native scan of the full patch and changed base/head blobs produced
   [11 unverified findings across five native pairs](native-identities.json).
   The other three pairs are already qualified. Finding order and decoder choice
   can vary, so the first refused local finding differs from the hosted run.
3. After the policy-only change, production `scanAgentInput`
   [admitted the same complete committed source](after.json), with verification
   enabled and no model call. No source rewrite or scanner flags changed.

The receipts identify the policy base; `after.json` was captured against the
working candidate in this PR. The final committed policy is the PR diff, not a
claim that its base already admits the source. Raw scanner output is not published.

To reproduce, build this policy and supply a clean OpenClaw checkout at the exact
head with both commits available:

```sh
corepack pnpm run build
node --input-type=module - /path/to/openclaw-at-reviewed-head <<'NODE'
import { scanAgentInput } from './dist/agent-input-scan.js';
scanAgentInput({
  cwd: process.argv[2],
  prompt: 'Read-only review of headless user-agent compatibility.',
  source: {
    kind: 'committed',
    baseSha: '165f1297b8c0e139257f85597dafd9127b983499',
    headSha: '37ddf036b04bf56f2b4eddfdb2569dfc9f9b99bc',
  },
  timeoutMs: 180000,
});
console.log('Complete committed source admitted.');
NODE
```

Focused regression coverage rejects altered native values, verified findings,
other detectors/decoders, inconsistent credential parts, incomplete scans, and
mixed unapproved findings. This proves local input admission only: hosted review
must still rescan its own prompt, schema and source after maintainer acceptance
and deployment. This PR neither releases a queue hold nor requests re-review.
