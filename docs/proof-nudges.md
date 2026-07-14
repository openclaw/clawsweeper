# ClawSweeper Proof Nudges

Read when changing the ClawSweeper lane that reminds pull request authors to add real behavior proof.

## Scope

The proof-nudge lane is read-mostly triage hygiene. It can post a polite reminder comment when the latest ClawSweeper review still requires real behavior proof, but it does not close pull requests, merge pull requests, change labels, request reviews, or modify review records.

The lane uses the latest ClawSweeper review report plus the live pull request state. It does not scrape the visible review comment for policy.

## Eligibility

A pull request is eligible only when all of these are true:

- The live item is an open pull request.
- The latest report still says real behavior proof blocks merge.
- The report head SHA matches the live pull request head SHA.
- The pull request is past the first-nudge age gate, defaulting to 5 days.
- The author has not commented recently and the head commit is not recent.
- There is no same-head proof nudge inside the cooldown window, defaulting to 7 days.

The lane skips maintainer-authored, bot-authored, security-sensitive, and release-style pull requests. It also skips pull requests with `proof: sufficient` or `proof: override`, because those need review or policy handling rather than another contributor reminder. OpenClaw's `triage: needs-pr-context` label is separate contributor-body hygiene and does not decide real-proof sufficiency.

## Bot-Owned Proof Handling

Bot-owned replacement PRs are deliberately outside the contributor nudge lane.
Do not make normal proof nudges comment on bot-authored PRs as if a contributor
needs to respond. The `bot-proof` lane handles ClawSweeper-owned PRs that are
blocked on real behavior proof.

The bot-owned lane is status-only unless an approved Mantis proof suggestion is
available. It is eligible only when the live PR is open and not draft, the
author is the ClawSweeper GitHub App, the latest
ClawSweeper review says real behavior proof blocks merge, and that review head
SHA still matches the live head SHA. It must skip PRs with `proof: sufficient`
or `proof: override`.

When the review includes an approved Mantis-style proof suggestion, the lane
posts a durable Mantis proof request comment. Otherwise it updates one durable
status comment asking maintainers to choose proof capture, proof override, or
pause. It does not post contributor reminders.

Mantis requests are proof-only. They may ask Mantis to reproduce or inspect
supported Telegram, Discord, or web UI chat behavior and return redacted
screenshots, transcripts, logs, or interaction results. Code changes, CI fixes,
branch updates, commits, PR repair, labels, comments, closes, and merges stay in
ClawSweeper's deterministic repair, apply, and automerge lanes.

For dashboard accounting, status-only maintainer requests use
`bot_proof_decision_planned` or `bot_proof_decision_posted`. Mantis proof
requests use `bot_proof_mantis_request_planned` or
`bot_proof_mantis_request_posted`. Hosted dashboard events with those tokens are
counted in the proof operation counters.

## Mutation Freshness And Receipts

Execute mode establishes one exact-head baseline before proof eligibility reads.
Immediately before every proof comment, label creation, label addition, and
label removal request, ClawSweeper reads two consecutive live snapshots and
requires both to match the baseline:

- the exact pull request head SHA, read before and after activity hydration;
- at most 1,000 combined reviews, inline comments, and review threads,
  including thread resolution state;
- at most 1,000 pull request conversation comments.

The activity snapshots are SHA-256 cursors. Raw comment and review bodies are
never written to reports or receipts. Activity beyond either bound, an
incomplete read, or any head, review, thread, or conversation drift blocks the
request. The same boundary also revalidates open, unlocked, non-draft, and
non-protected proof eligibility from live state. Nudge author comments, PR body
edits, and review activity are hydrated inside that boundary instead of reused
from the earlier planning read. Bot-proof label plans start from the bound live
label set, and the expected label cursor advances only after an accepted owned
label operation. A successful earlier label request does not authorize the next
one; each request gets its own freshness check.

The production proof workflow enables the action ledger before either command.
Every request writes an immutable pre-request receipt and then one accepted,
rejected-before-write, or outcome-unknown receipt. Retries retain one business
idempotency key while each request attempt has a distinct receipt pair. An
outcome-unknown response is not automatically retried, even when it resembles a
transient GitHub error. The workflow finalizes, imports, and publishes the exact
proof-job shards to the state repository before completing.

Proof comments contain same-head markers, and bot-proof comments use a stable
body plus the desired label state. After a response loss or process crash, a
later run checks those public facts before another write. A match records
`proof_nudge_reconciled` or `bot_proof_decision_reconciled` without claiming a
new mutation. An open pre-request receipt and its later reconciliation share
the same hashed business idempotency key. Label recovery uses the exact
`label_create`, `issue_label_add`, or `issue_label_remove` request identity that
the public postcondition satisfies. Existing same-head nudge markers are
reconciled even after their cooldown expires, before a new reminder is posted.

Contributor nudges also write one bounded per-PR recovery record before the
comment request. It contains only repository, PR number, head SHA, and the
original marker timestamp. If the outcome is unknown and the marker is still
not visible, later runs report `proof_nudge_reconciliation_pending`, reuse the
same hashed business identity, and do not send another POST. The record is
cleared only after rejection, confirmed publication, reconciliation, or a head
change. Recovery-state publication runs after immutable receipt publication and
does not advance the proof scan cursor.

Reports expose only bounded status and reason strings:

- `skipped_changed_before_mutation` when head or bounded activity changed;
- `proof_nudge_outcome_unknown` or `bot_proof_mutation_outcome_unknown` when
  GitHub may have accepted a request but public state cannot confirm it;
- the reconciliation actions above when public state confirms completion.

Receipts and reports do not contain raw prompts, command logs, comment bodies,
or review bodies.

## Marker

Cooldown state lives in the reminder comment body:

```html
<!-- clawsweeper-proof-nudge item="123" sha="abc123" at="2026-05-18T12:00:00.000Z" v="1" -->
```

The marker records the pull request number, reviewed head SHA, timestamp, and marker version. This avoids label churn and keeps the reminder state tied to the exact head that was nudged.

## Command

Dry-run is the default:

```bash
pnpm run proof-nudges -- --target-repo openclaw/openclaw
```

Post comments only with an explicit execute flag:

```bash
pnpm run proof-nudges -- --target-repo openclaw/openclaw --execute --limit 10
```

Useful options:

- `--limit`: maximum nudges to plan or post, default `10`.
- `--processed-limit`: maximum records to inspect in one run, minimum `1`.
- `--cursor-path`: optional JSON cursor path used to rotate untargeted candidate scans after execute runs.
- `--min-age-days`: first-nudge age gate, default `5`.
- `--cooldown-days`: same-head cooldown, default `7`.
- `--item-numbers`: comma-separated pull request numbers for a targeted dry-run or execute run.
- `--report-path`: JSON output path, default `proof-nudge-report.json`.
- `--max-runtime-ms`: optional hard runtime stop.

## Workflow Use

The `ClawSweeper Proof Nudges` workflow exposes this as a manual `workflow_dispatch` lane. It defaults to dry-run. Use `execute=true` only after reviewing a dry-run report.

The workflow also includes one daily scheduled lane at `0 10 * * *`, but it is off by default. That UTC schedule runs at 5:00 AM Central during daylight saving time and 4:00 AM Central during standard time. GitHub may start scheduled workflows late; scheduled runs no longer use a local-time guard, so an enabled scheduled run continues once GitHub starts it.

Scheduled operation uses repository variables:

- `CLAWSWEEPER_PROOF_NUDGES_SCHEDULED=1`: enable the scheduled lane. Without this, the daily schedule is skipped.
- `CLAWSWEEPER_PROOF_NUDGES_EXECUTE=1`: allow the scheduled lane to post comments. Without this, scheduled runs remain dry-run only.
- `CLAWSWEEPER_PROOF_NUDGES_TARGET_REPO`: optional target repo, default `openclaw/openclaw`.
- `CLAWSWEEPER_PROOF_NUDGES_LIMIT`: optional scheduled batch size, default `10`.
- `CLAWSWEEPER_PROOF_NUDGES_PROCESSED_LIMIT`: optional positive scheduled scan size before the cursor advances; the CLI default is `max(limit * 20, 50)`.
- `CLAWSWEEPER_PROOF_NUDGES_MIN_AGE_DAYS`: optional first-nudge age gate, default `5`.
- `CLAWSWEEPER_PROOF_NUDGES_COOLDOWN_DAYS`: optional same-head cooldown, default `7`.
- `CLAWSWEEPER_BOT_PROOF_SCHEDULED=1`: include the bot-owned proof lane in scheduled runs.
- `CLAWSWEEPER_BOT_PROOF_EXECUTE=1`: allow scheduled bot-owned proof runs to post status comments and labels. Without this, scheduled bot-proof runs remain dry-run only.

Untargeted scheduled runs rotate through durable cursor files under
`results/proof-nudge-cursors/` and `results/bot-proof-cursors/`. A skip-heavy
run that spends its processed-record budget advances the cursor to the last
processed candidate, so later runs inspect the next bounded window instead of
repeating the same prefix. Targeted `--item-numbers` runs do not use or update
those cursors.

The workflow publishes only the exact target cursor files, for example
`results/proof-nudge-cursors/openclaw-openclaw.json`, and only after the
corresponding lane executed and wrote that file. Dry-runs do not publish cursor
paths, and one target repo run does not replace another target's cursor file.

Suggested rollout:

1. Run the proof-nudge workflow manually with `execute=false`.
2. Set `CLAWSWEEPER_PROOF_NUDGES_SCHEDULED=1` to collect scheduled dry-run reports.
3. Set `CLAWSWEEPER_PROOF_NUDGES_EXECUTE=1` only after the scheduled reports look correct.
4. Run the bot-owned proof lane manually with `bot_proof=true` and `bot_proof_execute=false`.
5. Set `CLAWSWEEPER_BOT_PROOF_SCHEDULED=1` only after dry-run reports look correct.
6. Set `CLAWSWEEPER_BOT_PROOF_EXECUTE=1` only after generated comments and labels have been reviewed.

This first version intentionally has no auto-close behavior. Any escalation after repeated proof nudges needs a separate maintainer policy decision.
