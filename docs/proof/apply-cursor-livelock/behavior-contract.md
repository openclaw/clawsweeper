# Apply cursor livelock behavior contract

## User-visible goal

A scheduled comment-sync pass makes durable cursor progress whenever its numeric frontier completes,
without skipping a frontier clipped by the runtime budget.

## Target

- Type: CLI fixture
- Access: `docs/proof/apply-cursor-livelock/run-proof.sh`
- Allowed fixtures: synthetic records using the public item numbers and outcome classes from run
  `31544381133`
- Credentials: none

## User tasks

1. Replay the production urgency-first ordering through the cursor completion command.
2. Replay the same outcomes through the current batch selector and completion command.
3. Pass an ascending-sorted request with the numeric frontier last through the real apply loop,
   stop after its first examined record, and complete the cursor from the trusted trace.
4. Clip the current batch at its first frontier and inspect the persisted cursor.
5. Run the focused wrap/cycle regression probes.

## Expected observable behavior

- The old ordering reports zero cursor progress and persists `#105854`.
- The current selector places frontier `#105870` first and the completed-frontier replay persists
  `#105870` even though later urgent work is clipped.
- The apply loop executes `#105870` first when ascending input places it last, and cursor completion
  still persists `#105870` while every lower urgent record remains unexamined.
- A clipped frontier reports zero progress and persists `#105854`.
- Wrapped selection and cycle bookkeeping probes pass unchanged.
- No GitHub API or credential is used.

## Anti-cheat probes

- Use the same completion helper for old and current orderings; vary only selected execution order.
- Remove the frontier from the examined trace and require the cursor to remain unchanged.
- Include terminal outcomes other than comment sync: kept-open, changed-since-review, stale-sync
  skip, and already-closed reconciliation.
- Assert the current selector's reported `next_cursor` is the executed first item.
- Assert the apply trace, rather than incoming list position, determines the completed prefix.

## Evidence required

- `fixture-result.json`
- Focused test output with zero failures
- Fresh-PR container provider, lease, head, jq checksum, and exit status

## Out of scope

Live GitHub latency, production mutation, budget increases, dashboard rendering, and OpenClaw Bay.
