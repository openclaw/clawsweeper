# Push relay userinfo fixture qualification

- Status: executed native qualification proof; trusted rollout and hosted review remain separate.
- Owner: `src/agent-input-scan-fixtures.ts`; regression: `test/agent-input-scan-push-relay.test.ts`.
- Last verified baseline: `openclaw/clawsweeper@eae7a713e211392f2a57ab91880a761efa1ae359`; candidate policy source digest is in [identities.json](identities.json).
- Update when: the pinned scanner, native identities, complete source line, source path/mode or staging/provenance contract changes.

## Claim and boundary

The existing synthetic relay-URL userinfo rejection fixture in [OpenClaw PR #193714](https://github.com/openclaw/openclaw/pull/193714) admits through exact host-owned attribution. The qualification binds detector 17/URI, observed decoder, both native value digests, complete source-line digest, canonical source path and regular-file mode. Unknown or verified findings, altered lines/values/paths, mutable roles, duplicate findings and incomplete native scans remain refused. Scanner invocation, verification, source acquisition, metadata validation and patch eligibility are unchanged.

The original [hosted run 42547842177](https://github.com/openclaw/clawsweeper/actions/runs/42547842177) refused the unchanged base fixture. Its diagnostics counted two findings but exposed only the first. Native reproduction now observes that same synthetic fixture in both base/head blobs; this does not retroactively prove the undisclosed hosted second finding's identity. Every hosted input still undergoes complete scanning.

## Controlled real-behavior proof

Environment: native macOS arm64, Node 26.7.0, pinned pnpm 12.15.0 and checksum-pinned TruffleHog 3.99.4; local host, no container or cloud lease. Verification remains enabled with the production flags, including `--fail-on-scan-errors`. No model, phone, Gateway, account credential or live policy operation is involved.

The complete committed source range was scanned through production `scanAgentInput` with a controlled 71-byte prompt and no schema. [Before](native-before.json), original head 81b5e47967a refused with `literal_not_reviewed`. [After](original-after.json), the same source range admitted. The [validated current head](https://github.com/openclaw/openclaw/commit/c91c36dfbdc2fded615c860f1eb68d28c4aea0eb) independently [refused before](current-before.json) and [admitted after](current-after.json). The post-qualification original-range run used the production entry point without any observation hook.

Canonical full-input observations emitted PLAIN and HTML identities. A separate native scan of the two exact source blobs, with the same verification flags, observed ESCAPED_UNICODE with identical Raw/RawV2 digests. [Safe observations](native-observations.json) retain no raw values. The observer preserved arguments, bytes and exit status; it only copied local evidence before source cleanup. That two-blob observation establishes decoder identity, not complete-input admission.

In a separate disposable Git fixture, changing one credential byte while preserving path/mode [still refused through the real native entry point](native-negative.json). The native failure was `material_not_reviewed`; it is a refusal at the earliest applicable source/patch guard, not a claim that a specific later digest guard executed.

The added classifier regression initially failed at the three intended admission assertions while negative cases passed. After qualification, 23 focused cases pass, including 17 refusal subcases and a policy-validation check that rejects widened rows. The existing fixture suite and the original 22-case regression also passed 592 cases before the final additional guard check. Raw scanner output and original failed logs remain private local evidence; only hashes and bounded notices are checked in.

## Reproduce admission

Use a disposable trusted OpenClaw checkout whose HEAD is the selected exact source revision. Keep the scanner cache outside both checkouts. From this ClawSweeper branch:

```bash
pnpm install --frozen-lockfile
pnpm run build:node
node --test test/agent-input-scan-push-relay.test.ts test/agent-input-scan-fixtures.test.ts
CLAWSWEEPER_REVIEW_TOOLS_DIR=/private/task-scanner-cache node docs/proof/agent-input-scan-context/run-proof.mjs /path/to/disposable/openclaw-at-81b5e47967a 154d60ec2bc612db80a39c13b61466a64acfc527 81b5e47967a092c610bdcb456549a7a633270f36 /private/original-admission.json
CLAWSWEEPER_REVIEW_TOOLS_DIR=/private/task-scanner-cache node docs/proof/agent-input-scan-context/run-proof.mjs /path/to/disposable/openclaw-at-c91c36dfbdc 154d60ec2bc612db80a39c13b61466a64acfc527 c91c36dfbdc2fded615c860f1eb68d28c4aea0eb /private/current-admission.json
```

The existing bootstrap validates the pinned official archive and executable. Native labels can vary; policy permits only the three actually observed identities. No decoder family, path pattern, fixture-name pattern or verification-status-only exception was added.

## Limits and ownership

This proof does not execute a model or replace hosted review of its own prompt/schema/source. The original hosted refusal and all OpenClaw passes remain retained. This branch does not merge or deploy itself: production stays held until the trusted policy owner lands/rolls out the reviewed qualification, followed by one deliberate hosted re-review. OpenClaw Bay is unaffected: no dashboard API, queue lifecycle, telemetry contract or public-action surface changes.
