# Unsponsored Feature Request Close Policy

Read when changing automatic handling for old feature requests that still need
a maintainer product decision.

ClawSweeper can propose `unsponsored_feature_request` only for
`openclaw/openclaw` issues that meet every deterministic review gate:

- `item_category: feature`;
- `requires_product_decision: true`;
- `maintainer_decision.required: true` with `kind: product_direction`;
- no security label recognized by `isSecurityLabel`
  (`src/repair/security-signals.ts`), such as `security`,
  `security-sensitive`, or `type: security`. The match is exact after
  whitespace normalization and lowercase.

The separate automation holds in `CLOSE_PROTECTED_LABEL_NAMES` remain enforced,
including `impact:security` and explicit security-review-required statuses.

The review lane only writes a durable close proposal. Apply is default-off and
requires the repository variable
`CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED=true`. When the gate is disabled,
apply records the skip without consuming or rewriting the durable proposal.

Even when enabled, apply fails closed unless the issue is older than 90 days.
It re-fetches live state and keeps the issue open when it is assigned,
milestoned, no longer open, already meets the positive-reaction threshold
(`CLAWSWEEPER_IDEA_REVIVAL_REACTIONS`, default 5), has 20 or more total reactions, has a
`clawsweeper:linked-pr-open` label, has any security label, has any
maintainer comment, or has any non-bot comment from the last 60 days.

GitHub reads are mandatory evidence. Any issue or paginated-comment read
failure becomes a recorded keep-open reason. Snapshot drift and the standard
protected-label gates still apply.

Successful closes use GitHub's `not_planned` state reason but are reversible
idea-archive parks, not rejections. Apply creates and adds the
`clawsweeper:idea-archive` label before closing. A maintainer can reopen an issue
after reconsidering it. ClawSweeper no longer watches reactions or comments to
reopen archived ideas automatically; `@clawsweeper revive` and
`@clawsweeper sponsor` are not supported commands.

The archive label remains after an uncertain close so the record is not lost.
Existing issue state is not rewritten when automatic revival is retired.
