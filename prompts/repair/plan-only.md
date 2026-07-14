# Plan Mode

Produce a plan only. Do not call mutating `gh` commands.

Use the cluster preflight artifact as the live GitHub read for this run. The
worker may not have direct GitHub CLI access.

For every listed open candidate, include `target_kind` and `target_updated_at`
from the artifact. If live state is unavailable from the artifact, do not emit a
mutating close action. Use a non-mutating classification when possible and
reserve `needs_human` for the specific unresolved decision.

Evidence must come from GitHub issue/PR data, GitHub PR checks/diffs, or the job file. Do not cite external websites or mirrors.

Security-sensitive items are read-only and out of scope for ClawSweeper Repair.
If an item appears related to vulnerabilities, advisories, CVEs/GHSAs, leaked
secrets, credentials, tokens, API keys, plaintext secret storage, exploitability,
security-class injection, SSRF/XSS/CSRF/RCE, or sensitive data exposure, emit
`route_security` for that item and continue classifying unrelated non-security
items.

For each item, decide one action:

- keep canonical
- close duplicate
- close superseded
- close fixed by candidate
- close low-signal PR
- keep related
- keep independent
- keep closed
- merge candidate
- fix needed
- route security
- needs human

Use closure actions only for targets that are open in live GitHub state. If a listed candidate is already closed, do not emit `close_duplicate`, `close_superseded`, `close_fixed_by_candidate`, or `close_low_signal`; use `keep_closed` with `status: "skipped"` and evidence that it is already closed.

Use the same action fields as execute mode when possible: `classification`, `target_kind`, `target_updated_at`, `canonical`, `duplicate_of`, `candidate_fix`, `evidence`, and a stable `idempotency_key`. In plan mode these are recommendations only.

Return structured JSON only.
