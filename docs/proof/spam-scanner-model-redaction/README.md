# Spam scanner model redaction proof

The spam scanner sends the configured internal model id
(`CLAWSWEEPER_INTERNAL_MODEL`, a workflow secret) to the OpenAI Responses API.
When that call fails, OpenAI echoes the id back in the error body ("The model
`x` does not exist or you do not have access to it", "Rate limit reached for
x on tokens per min"), and the scanner stored that text verbatim as
`model_error` in every published output: the per-comment audit record, the
`spam-scanner-latest.json` report, the `spam-scanner.json` ledger, and the
`reasons` list of each entry. The records already mask the model as
`internal`; the review runtime redacts these exact messages with
`redactInternalCodexModel`. This proof shows the scanner now applies the same
redaction before anything is written.

[`run-proof.mjs`](run-proof.mjs) runs the real compiled scanner CLI end to
end for two arms and two failure shapes. `GH_BIN` points at a fake `gh` that
answers only the single comment read (`--comment-ids 1`) and the minimization
batch query; an import-time transport shim redirects only
`https://api.openai.com/v1/responses` to a loopback server that records the
requested model and returns a 404 model-access error or a 429 rate-limit
error carrying a synthetic secret id. Each arm compiles its own copy of `src/`
under the output directory (baseline: `src/repair/spam-scanner.ts` and
`spam-scanner-core.ts` from the base commit), so `results/` is isolated per
arm and the tracked checkout is never modified. No live credential, model
call, or GitHub write is involved. The driver runs on Linux, macOS, and
Windows.

```sh
pnpm run build:repair
node docs/proof/spam-scanner-model-redaction/run-proof.mjs --out .artifacts/spam-scanner-model-redaction
```

`--base <rev>` selects the baseline commit (default: the merge base with
`origin/main`, or `HEAD~1` once the change is on `main`). The driver writes
`summary.json` with, per arm and case, the scanner exit code, elapsed time,
the model id the loopback endpoint received, the report's public `model`
field, and for each published file its size and the number of occurrences of
the secret id and of `[REDACTED_INTERNAL_MODEL]`; it also copies each audit
record next to the summary. It exits non-zero unless every baseline run
publishes the secret id in all three files and every candidate run publishes
none while carrying the redaction marker in all three.

Expected result: both arms send the secret id to the endpoint and exit 0 with
`model: "internal"` in the report. The baseline arm writes the raw error text
into the audit record (1 occurrence), the latest report (3: `model_error`,
the entry's `model_error`, and its `reasons`), and the ledger (2), and prints
it on stdout and in the stderr warning. The candidate arm writes
`[REDACTED_INTERNAL_MODEL]` in the same positions and the secret id nowhere.

Limits: synthetic comment and synthetic OpenAI error bodies on a loopback
endpoint; the redirect is an import-time `fetch` shim, so the request path,
headers, timeout, and body are the scanner's own. The thrown error inside the
scanner still carries the raw body; only what the scanner stores and prints
is redacted. OpenClaw Bay is unaffected: no lifecycle, queue, telemetry, or
dashboard contract changes.
