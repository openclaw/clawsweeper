# Repair duplication merges proof

The four numbered directories contain the old-versus-new equivalence harnesses
and JSON artifacts. Merge 1 proves the intentional one-shot-to-retry change
with an unchanged idempotency key; merges 2–4 prove byte-identical behavior.

Docker proof used Crabbox `0.38.3-5-g2a79805d`, `provider=local-container`,
lease `cbx_182ee21fa80c` (`quick-krill-f6cc`), `node:24-bookworm`, and Docker
29.4.0. A clean `--fresh-pr openclaw/clawsweeper#1114` checkout at
`1b53811246d6bf5a001f8db6d1de81db280c2015` reported 3,307 tests: 3,296 passed,
8 skipped, and only the three known blob-hydration failures. Exact merge-base
`51ac499c741b7b4b9b2bd1b7d78686055f8f3738` reproduced those same three and no
others: 3,304 tests, 3,293 passed, 8 skipped. The focused baseline verifier
exited zero with `BASELINE_RESULT=known_environmental_3`.

Corepack installed pinned pnpm 11.10.0. jq 1.8.1 was installed under
`$HOME/.local/bin` and verified against SHA-256
`020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d`.
Fresh-PR timings were 9,217 ms sync, 83,295 ms command, 92,512 ms total. The
lease was deleted. OpenClaw Bay is unaffected because no lifecycle, queue,
telemetry, or dashboard contract changed.
