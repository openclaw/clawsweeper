# Hidden payload security proof

Status: historical proof for the hidden-payload security guard. Owner: ClawSweeper maintainers. Runtime owners: `src/repair/security-signals.ts`, `src/clawsweeper-item-context.ts`, `src/clawsweeper-review-item.ts`, and `src/clawsweeper-apply-close-execution.ts`. Re-run when these boundaries change.

The claim is that an issue with a harmless feature request and a comment containing concealed shell content receives a deterministic security review and cannot be automatically closed, even if the model proposes an implemented-on-main close. The fixture uses only documentation IP `203.0.113.7` and a fake collector ID; its shell text is never executed.

Run from the repository root on Node 24 or newer:

```sh
pnpm run build
node docs/proof/hidden-payload-security/run-proof.mjs
```

The driver starts a loopback HTTP fixture that rejects GitHub mutations. Production GitHub context hydration reads that fixture through the CLI transport boundary. Production review preparation builds the actual prompt and consumes a deliberately payload-blind, fixed model result. The production report writer and public comment renderer preserve the resulting security review. The real `apply-decisions` CLI runs against isolated `items/` and `closed/` directories with `--skip-dashboard --item-number 1054 --dry-run`. It checks both a close proposal containing the security review and a legacy proposal without that review; both must remain open with a security moderation reason.

Artifacts are written to `.artifacts/hidden-payload/proof/`: `summary.json`, the prepared prompt, each report and public comment, apply output, and the HTTP request trace. The summary records the current head and local Node/platform provider. This is a local process proof on macOS, not a Windows/container lease. It does not contact GitHub, execute the payload, validate model judgment, or test a production deployment. The fixed model result isolates the host-owned guarantee from model variance. No credentials are supplied to the fixture.

Historical diagnosis: the September 1 review code at `04ab85792ab56e8ae51459f3d959bd085f26bdf3` retained comment bodies through `src/clawsweeper-item-context.ts:214` and `src/clawsweeper-context-hydration.ts:205`. The small campaign comment fit within its 6,000-character limit. Both profiles used that path. `prompts/review-item.md:470` defaulted non-PR security review to not applicable absent a security-sensitive report, while `src/repair/security-signals.ts:82` recognized only existing security markers and advisory IDs. `src/clawsweeper-close-decision.ts:291` checked protected labels, then high-confidence close evidence, without a general unresolved-security veto. The model recognized the ClawHub payload but missed the gogcli payload; no deterministic owner corrected that omission. `issue-source-guard.ts` hashed raw body/comment content for freshness; it did not classify it.

The source records are the durable review comments on [gogcli issue 1054](https://github.com/openclaw/gogcli/issues/1054#issuecomment-5493708494) and [ClawHub issue 3569](https://github.com/openclaw/clawhub/issues/3569#issuecomment-5493714348). Their raw collector text is intentionally absent from this proof.
