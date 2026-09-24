# Codex app-server failed-turn error proof

Claim: when a Codex app-server turn ends with `failed` or `interrupted`, the worker
reports the turn's own error. Before the fix it exited with status 1 and no error, so
the host's managed-result check reported `ENOENT: no such file or directory, lstat
'<result>.json'` instead, and the review classifier never saw the provider message.
Failure diagnostics also did not recognise the app-server `turn/completed` error, so
any captured stderr line replaced it as the trusted diagnostic.

The driver compiles two isolated copies of `src/`: `baseline` replaces
`src/codex-app-server-worker.ts` and `src/codex-transient.ts` with the files at
`--base`, `candidate` uses the checkout. Each arm runs the compiled
`runCodexProcess` in app-server mode against a synthetic Codex peer that completes
the JSON-RPC handshake and ends one turn with the payload below; failing peers also
write one stderr warning line:

| Scenario | `turn/completed` payload |
| --- | --- |
| `completed` (control) | `status: "completed"`, agent message written |
| `failed-rate-limit` | `status: "failed"`, `error.message` = TPM rate limit |
| `failed-model-denied` | `status: "failed"`, `error.message` = model access denied |
| `interrupted` | `status: "interrupted"`, no error |

For each failure, the driver composes the failure detail exactly as `runCodex` does
for a non-native review result and passes it to the compiled `codexFailureDecision`
and `codex-transient` classifiers of the same arm.

```sh
pnpm install --frozen-lockfile
node docs/proof/codex-app-server-failed-turn-error/run-proof.mjs --base <pre-fix-rev> \
  --out .artifacts/codex-app-server-failed-turn-error
```

Expected result: `PROOF_RESULT=PASS`. Baseline reports `ENOENT` for all three failed
turns, classifies the rate limit as non-retryable `codex execution failed` and the
model denial as non-terminal. Candidate reports `Codex turn failed: <message>` or
`Codex turn interrupted.`, classifies the rate limit as retryable capacity and the
model denial as terminal even with stderr present. The completed control is identical
in both arms. `summary.json` in `--out` records every row and check.

Limits: POSIX only (the peer is a shebang script). The peer is synthetic; no model
call is made. The review-runtime composition is reproduced in the driver rather than
reached through `runCodex`, because the app-server review path requires an exact
`openclaw/openclaw` pull request lease and committed-source scan. The driver trims
stderr instead of passing it through `redactedOutputTail`, which only differs for
long output.
