# Evidence external-URL scheme-case proof contract

## Claim

Worker evidence is stripped of every non-`github.com` `http(s)` URL before it is
published, and the result validator rejects any that survive — regardless of the
**case of the URL scheme**. Before this change, `HTTPS://host/path` matched
neither the sanitizer nor the validator, so it was published verbatim as a live
external autolink and the result still validated as `passed`.

## Exercised surface

Both shipped surfaces that share the pattern, driven against the built `dist/`:

1. **Sanitizer** — `sanitizeResultEvidence()` in `dist/repair/url-safety.js`.
   This is the pre-publication mutation applied to a worker `result.json`.
2. **Validator** — `dist/repair/review-results.js`, executed as a real CLI
   subprocess exactly as `dist/repair/run-worker.js` invokes it
   (`run-worker.ts:373`).

The two must stay in lockstep: `url-safety.ts` carries a header comment
requiring its pattern to match `evidenceHasExternalUrl` in `review-results.ts`,
because a sanitizer that emits something the validator rejects would deadlock a
worker run.

## Controlled scenario and fixture

`run-proof.mjs` builds a throwaway run directory in the OS temp dir containing a
`cluster-plan.json` and a **fully valid** `result.json` — correct `mode`,
`idempotency_key`, `target_kind`, and a `target_updated_at` that matches the
preflight item. The only thing that varies between the two cases is the scheme
case of one external URL in `actions[0].evidence`:

- control: `https://attacker.example/exfil?data=secret`
- subject: `HTTPS://attacker.example/exfil?data=secret`

Because the fixture is otherwise valid, the external-URL failure is the *only*
validator failure, so the verdict is unambiguous. `attacker.example` is a
reserved-for-documentation name; the proof contacts no network.

## Expected observation

Post-fix, both cases behave identically:

- sanitizer output is `proof: <external link>` — the host does not appear;
- validator exits `1` with exactly `["#1 evidence contains non-GitHub external URL"]`.

Pre-fix, the uppercase case reported `LEAKED` from the sanitizer and
`exit 0 / status "passed"` with `failures: []` from the validator.

A companion focused test asserts that legitimate `HTTPS://github.com/...` and
`HTTPS://GitHub.com/...` links are still preserved, so the case-insensitive
pattern does not begin discarding valid GitHub references.

## Artifact and command

```bash
pnpm run build:repair
node docs/proof/evidence-url-scheme-case/run-proof.mjs   # exit 0 = PASS
```

Focused tests:

```bash
node --test test/repair/url-safety.test.ts
```

Red/green was verified by reverting only the compiled `dist/repair/url-safety.js`
pattern to `/g` and re-running the focused tests: 3 fail pre-fix, 14/14 pass
post-fix, with no change to the pre-existing assertions.

## Limits

This proof covers the sanitizer and the validator for the `http`/`https` scheme
case only. It does not exercise a live GitHub publication, Codex worker, or
queue; the published-comment rendering claim rests on GitHub's documented
case-insensitive autolinking rather than a live post. It does not change the
allowed-host set (`github.com` only), the URL terminator character class, or any
other URL matcher in the repo — several unrelated `github.com`-specific patterns
elsewhere are deliberately untouched.
