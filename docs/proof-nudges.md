# ClawSweeper Proof Nudges

Read when changing the ClawSweeper lane that reminds pull request authors to add real behavior proof.

## Scope

The proof-nudge lane is read-mostly triage hygiene. It can post a polite reminder comment on open pull requests that are stuck on `triage: needs-real-behavior-proof`, but it does not close pull requests, merge pull requests, change labels, request reviews, or modify review records.

The lane uses the latest ClawSweeper review report plus the live pull request state. It does not scrape the visible review comment for policy.

## Eligibility

A pull request is eligible only when all of these are true:

- The live item is an open pull request.
- The live pull request still has `triage: needs-real-behavior-proof`.
- The latest report still says real behavior proof blocks merge.
- The report head SHA matches the live pull request head SHA.
- The pull request is past the first-nudge age gate, defaulting to 5 days.
- The author has not commented recently and the head commit is not recent.
- There is no same-head proof nudge inside the cooldown window, defaulting to 7 days.

The lane skips maintainer-authored, bot-authored, security-sensitive, and release-style pull requests. It also skips pull requests with `proof: supplied`, `proof: sufficient`, or `proof: override`, because those need review or policy handling rather than another contributor reminder.

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
- `--processed-limit`: maximum records to inspect in one run.
- `--min-age-days`: first-nudge age gate, default `5`.
- `--cooldown-days`: same-head cooldown, default `7`.
- `--item-numbers`: comma-separated pull request numbers for a targeted dry-run or execute run.
- `--report-path`: JSON output path, default `proof-nudge-report.json`.
- `--max-runtime-ms`: optional hard runtime stop.

## Workflow Use

The `ClawSweeper Proof Nudges` workflow exposes this as a manual `workflow_dispatch` lane. It defaults to dry-run. Use `execute=true` only after reviewing a dry-run report.

The workflow also includes daily scheduled lanes at `0 10 * * *` and `0 11 * * *`, but it is off by default. Those UTC schedules are guarded by the scheduled cron string and the current `America/Chicago` timezone abbreviation, so only the 5:00 AM Central candidate continues across daylight saving time changes even if GitHub starts the run late.

Scheduled operation uses repository variables:

- `CLAWSWEEPER_PROOF_NUDGES_SCHEDULED=1`: enable the scheduled lane. Without this, the daily schedule is skipped.
- `CLAWSWEEPER_PROOF_NUDGES_EXECUTE=1`: allow the scheduled lane to post comments. Without this, scheduled runs remain dry-run only.
- `CLAWSWEEPER_PROOF_NUDGES_TARGET_REPO`: optional target repo, default `openclaw/openclaw`.
- `CLAWSWEEPER_PROOF_NUDGES_LIMIT`: optional scheduled batch size, default `10`.
- `CLAWSWEEPER_PROOF_NUDGES_MIN_AGE_DAYS`: optional first-nudge age gate, default `5`.
- `CLAWSWEEPER_PROOF_NUDGES_COOLDOWN_DAYS`: optional same-head cooldown, default `7`.

Suggested rollout:

1. Run the proof-nudge workflow manually with `execute=false`.
2. Set `CLAWSWEEPER_PROOF_NUDGES_SCHEDULED=1` to collect scheduled dry-run reports.
3. Set `CLAWSWEEPER_PROOF_NUDGES_EXECUTE=1` only after the scheduled reports look correct.

This first version intentionally has no auto-close behavior. Any escalation after repeated proof nudges needs a separate maintainer policy decision.
