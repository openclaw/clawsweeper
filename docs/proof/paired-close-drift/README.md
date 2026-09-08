# Paired-close drift proof

Active proof owned by apply close-policy and terminal mutation guards. Run from
the repository root after `pnpm run build`:

```sh
node docs/proof/paired-close-drift/run-proof.mjs
```

The command runs the actual compiled `apply-decisions` CLI in non-dry-run mode
with the native GitHub CLI against a strict, stateful local HTTP service.
The disposable gh configuration uses its documented `http_unix_socket` option;
all REST and GraphQL requests go through a private Unix socket. There is no
replacement gh executable and no inherited credential. Only a synthetic token
is provided, with public-network proxies disabled by an unreachable local proxy.
The server rejects unknown routes and mutations. It models GitHub's response
shapes, so native gh performs real request serialization and response parsing. Reports, runtime
artifacts, items, closed records, plans and canonical baselines are private
fixtures. The inherited private `TMPDIR` is preserved, including the short socket paths. The synthetic target
namespace is `openclaw/openclaw`, whose profile admits the minimal
`not_actionable_in_repo` fixture; no external repository is read or changed.

Both main and the candidate execute the same scenarios. The HTTP service triggers
counterpart drift only when it observes the parent's actual closeout-note write:

- A stable pair closes both synthetic items.
- A newly locked counterpart must prevent the parent close.
- A fresh counterpart read failure must preserve its known pair identity and
  prevent the parent close.
- A previously closed counterpart that reopens with a new timestamp must be
  re-evaluated and prevent the parent close.

Main closes the parent in the drift scenarios. The candidate performs terminal
revalidation and skips it. The read-failure run exits nonzero when the CLI later
tries to process the independently selected, unreadable issue; the decisive
observation is that the parent close was suppressed. Its partial apply report
contains the explanatory pair skip.

The output directory (default `.artifacts/paired-close-drift`) contains JSON
mutation traces, apply results, stdout/stderr and a concise summary. Temporary
runtime copies are removed on completion. Pass an output directory and one
scenario name to run a focused case.

This is a general same-author pair proof using supported reports with current review-activity cursors and without
lease tuples. Current lease and implementation-linked issue-first paths retain
their focused regression coverage. The change revalidates eligibility before
mutations; it does not provide a remote two-item transaction or guarantee against
changes after the final read. OpenClaw Bay has no schema or observer change.

Update this proof when pair admission, terminal policies or mutation sequencing
changes. Verified with this repair on Node 24.20.0 and native gh 2.100.0 on macOS.
This proof requires POSIX Unix sockets; set `PAIR_NATIVE_GH` for a different
native gh binary path. TLS and live GitHub availability are outside its scope.
