# Hosted terminal query race

Claim: after a validated DONE receipt, an empty successful tmux query is accepted
only when fresh matching receipts and server/socket quiescence prove that the
controller completed teardown. A live server or altered receipt still fails,
and no extra kill command is sent after the mismatched query.

On Linux with Node 24+, tmux, and a built checkout:

```sh
node docs/proof/hosted-terminal-query-race/run-proof.mjs
```

The driver creates real private tmux sessions and a foreign sentinel process.
A query wrapper injects tmux's empty successful result while the owner session
exits, remains live, or its receipt changes. It invokes the production cleanup
helper, verifies each result, and cleans up only its own sessions. The output is
three scenario receipts. No hosted service, credentials, GitHub, or model calls
are used. This is controlled teardown proof, not a claim to reproduce the
scheduler timing of every production race. OpenClaw Bay is unaffected.

For a paired baseline, place the pre-fix helper alongside the current helper
in `scripts/` and pass `--module <baseline-helper> --expect-unfixed`; remove that
temporary copy afterward. The baseline rejects the completed empty-query case.
