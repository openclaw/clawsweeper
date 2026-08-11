# Repair duplication merges proof

The four numbered directories contain the old-versus-new equivalence harnesses
and JSON artifacts. Merge 1 proves the intentional one-shot-to-retry change by
running the old CLI and current production notifier function over a real
loopback HTTP socket with an unchanged idempotency key. Merge 2 proves resolver
equivalence with real SQLite files and both production importer entry points.
Merges 3–4 prove byte-identical behavior.

Docker proof used Crabbox 0.41.1, `provider=local-container`, lease
`cbx_5b0de8cbba98` (`silver-barnacle-695f`), `node:24-bookworm`, and Docker
29.4.0. A clean `--fresh-pr openclaw/clawsweeper#1114` checkout at
`e94c0fbfe043545bebae5c3bf11fb961ef98a72a` built all targets, ran all four
proof scripts with `PROOF_RC=0`, and passed `format:check`. The final
provenance-only follow-up changes this README and its machine-readable
provenance artifact, not the exercised harnesses.

Corepack installed pinned pnpm 11.10.0. jq 1.8.1 was installed under
`$HOME/.local/bin`; its `jq-linux-arm64` SHA-256
`6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4` was
verified against the release's published checksum file before execution.
Fresh-PR timings were 14,128 ms sync, 9,870 ms command, and 24,023 ms total.
The lease stopped automatically. The full `test:no-build` gate ran locally on
Node 24.19.0: 3,307 tests, 3,298 passed, 9 skipped, and 0 failed. The container
run did not repeat the full suite, so no blob-hydration baseline was needed.

Machine-readable provenance is in `container-provenance.json`. OpenClaw Bay is
unaffected because no lifecycle, queue, telemetry, or dashboard contract
changed.
