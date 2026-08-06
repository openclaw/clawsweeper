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

Supported-environment run (Node 24, Crabbox `local-container`):

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --artifact-glob '.artifacts/evidence-url-scheme-proof/**' \
  --script docs/proof/evidence-url-scheme-case/run-proof.sh
```

`run-proof.sh` installs the pinned pnpm into a user-writable prefix (the lease
runs as the unprivileged `crabbox` user, so `corepack enable` cannot symlink into
`/usr/local/bin`), builds the repair lane, runs `run-proof.mjs`, and then runs the
focused suite.

Host-only quick check:

```bash
pnpm run build:repair
node docs/proof/evidence-url-scheme-case/run-proof.mjs   # exit 0 = PASS
```

## Provenance

- provider: Crabbox `local-container` (Docker/OrbStack)
- crabbox: `0.15.0`
- image: `node:24` @ `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
- container node: `v24.19.0` (satisfies `engines.node >= 24`)
- lease: `cbx_9546d1539ae1` (`brisk-krill`)
- run: `run_f0123d90f1c3`
- artifact: `.crabbox/runs/run_f0123d90f1c3/run_f0123d90f1c3-artifacts.tgz`
- result: exit `0`; sanitizer REDACTED both schemes, validator REJECTED both;
  focused suite `14/14`
- privacy: the fixture uses the reserved documentation name `attacker.example`.
  The proof makes no network calls, contacts no GitHub API, and performs no
  queue, GitHub, or production mutation. No credential is present in the lease.

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
