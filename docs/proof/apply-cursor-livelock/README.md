# Apply cursor livelock proof

## Claim

The automatic `openclaw/openclaw` comment-sync batch always executes its numeric cursor frontier
before opportunistic urgent repairs. Per-pass-terminal outcomes can therefore advance the durable
cursor, while a runtime yield on the frontier itself leaves the cursor unchanged for a truthful
retry.

This fixes the livelock observed in production run
https://github.com/openclaw/clawsweeper/actions/runs/31544381133. That run selected 39 urgency-ranked
records before frontier `#105870`, exhausted its 300-second budget at urgent record `#85937`, and
never reached the only record that could advance cursor `#105854`.

## Controlled scenario and fixture

`run-proof.mjs` uses the exact 40-number selection from the production run and a synthetic action
mix matching its terminal classes: durable comment sync, changed-since-review, stale-sync skip,
kept-open, an already-closed canonical record, and a runtime-clipped record.

The same unchanged cursor-completion helper is exercised three ways:

1. The old urgency-first order examines the terminal urgent prefix but not frontier `#105870`; it
   reports `cursor_count=0` and leaves the cursor at `#105854`.
2. The new batch selector places `#105870` first. After that frontier and the same terminal urgent
   prefix complete, a yield at `#85937` advances the cursor exactly to `#105870`.
3. A yield on the first frontier records no examined item and leaves the cursor at `#105854`.

The proof also runs the repository's focused wrap/cycle tests. The implementation changes only
execution order inside the selected batch; it does not change `cycle_start_after_number`,
`cycle_wrapped`, their reset rules, or the special automatic-policy branch.

## Run

```bash
docs/proof/apply-cursor-livelock/run-proof.sh
```

The container entrypoint additionally installs jq 1.8.2 only after verifying the official release
checksum:

```bash
docs/proof/apply-cursor-livelock/container-proof.sh
```

## Result

`fixture-result.json` is the committed machine-readable fixture result. `behavior-report.json`
records the source-blind behavior validation. The fresh-PR Crabbox receipt is recorded in
`container-provenance.json` after the pushed PR checkout completes.

## Limits and Bay impact

The fixture reproduces the cursor ownership and runtime-yield boundary without GitHub credentials
or production mutation. It does not reproduce the live API latency or claim that urgent records no
longer require later repair.

OpenClaw Bay is unaffected. This changes only internal apply-lane batch execution order and removes
a redundant pre-lease cleanup attempt; it does not change lifecycle publication or the
observer-only dashboard contract.
