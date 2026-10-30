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

The review lane may recommend closing, but apply keeps the issue open for the
item-specific maintainer decision. `maintainer_decision.required: true` records
that outstanding decision, never approval. The
`CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED` repository variable remains
false; setting it true or selecting all close reasons cannot bypass the manual
guard. Do not restore an old enabled value during rollout.

A maintainer can reject or park the specific request through the ordinary
manual GitHub close workflow. Apply does not add the idea-archive label or
close it on the recommendation alone. Existing archived issues retain their
state; ClawSweeper does not reopen them automatically from comments or reactions.
