# Low-Signal PR Triage

Use this policy only when the job explicitly asks for manual backlog cleanup,
low-signal PR triage, or garbage PR review. It is not the default dedupe policy.

Close only when the PR is open, live state was re-fetched, and the evidence is
boringly clear. Prefer `needs_human` for anything with a plausible current bug,
owner discussion, green checks, or a focused fix that should be preserved.

## Strong close signals

- Blank or mostly untouched PR template: placeholder lines such as
  `Problem:`, `Why it matters:`, or `Describe the problem and fix` remain empty,
  and the title/files do not supply a concrete OpenClaw problem.
- Random docs-only change: root README translations, generic wording tweaks,
  drive-by guide additions, or community-plugin discoverability docs that should
  be handled through ClawHub instead.
- Low-signal test-only change: broad coverage additions, snapshot churn, or
  tests for trivial helpers without a linked bug, maintainer request, or product
  change in the same PR.
- Churn/refactor-only change: variable renames, formatting, generated/baseline
  edits, or "cleanup" without a requested fix.
- Third-party capability in core: new channel, provider, skill, tool, or plugin
  surface that should be published and maintained externally on ClawHub.
- Risky ops/infra drive-by: new external CI service, release workflow, Docker
  base migration, host upgrade script, apt retry/fix-missing tweak, or service
  manager behavior without owner request and green validation.
- Dirty branch: stated change is narrow, but files include unrelated docs,
  generated baselines, other extensions, runtime surfaces, or review artifacts.
- Bot/review spam: repeated bot pings or copied bot output without author-owned
  fixes, especially when checks are still red.
- Missing or mock-only real behavior proof: an external PR claims a behavior fix
  but provides no after-fix evidence from a real setup, or only lists unit tests,
  mocks, snapshots, lint, typechecks, or CI. Ask for screenshots, terminal
  screenshots, console output, copied live output, linked artifacts, recordings,
  or redacted runtime logs instead.

## Evidence bar

Do not close for red CI alone. Combine red/stale state with at least one strong
low-signal category above, or leave it for a human.

Use these checks before recommending close:

- PR is open in live GitHub state.
- `target_updated_at` is recorded.
- Action is `close_low_signal` with `classification: "low_signal"`.
- `target_kind` is `pull_request`.
- `canonical`, `duplicate_of`, and `candidate_fix` are `null`; low-signal cleanup is not dedupe.
- The latest author activity does not show an active fix in progress.
- No maintainer has approved, assigned, or requested the work.
- The close comment preserves a reopen path.

## Comment shapes

Blank template:

```md
Thanks for the contribution. I am closing this because the PR title/body do not
explain a concrete OpenClaw problem or reviewable fix, and the template is
effectively blank. Please reopen from a clean branch with a scoped summary,
linked issue or rationale, and validation if this is still needed.
```

Random docs / ClawHub:

```md
Thanks for the contribution. I am closing this because this is a low-signal
docs-only discoverability change. Community skills and plugins should be
published on ClawHub instead of added to the core repo/docs queue.
```

Low-signal tests:

```md
Thanks for the contribution. I am closing this because it is test-only coverage
without a linked bug, owner request, or behavior change, and it is stale/red.
We are keeping the queue focused on fixes with clear product value and current
validation.
```

Dirty branch:

```md
Thanks for the contribution. I am closing this because the branch appears dirty:
the stated change is narrow, but the diff includes unrelated files. Please
recreate the PR from current main with one scoped change.
```

Risky infra:

```md
Thanks for the contribution. I am closing this because it changes repo
infrastructure/operations without owner approval and current green validation.
Please open an issue or maintainer-approved design first if this is still
needed.
```

## Never close under this policy

- Security reports or security-sensitive code that should go through the
  security triage path.
- Security-sensitive PRs are not low-signal cleanup. Route them to central
  OpenClaw security handling instead of ClawSweeper Repair.
- A green PR with a focused bug fix and clear reproduction.
- A PR with sufficient after-fix real behavior proof from a real setup, even if
  the proof is a terminal screenshot, console excerpt, or redacted runtime log.
- A PR with recent maintainer review, assignment, or active author follow-up.
- A unique bug report with reproduction detail, even if noisy.
- Anything that would require technical judgment about correctness beyond the
  low-signal category.
