# Unconfirmed Product Direction Close Policy

Read when changing automatic handling for technically correct feature-like pull
requests.

ClawSweeper can propose `unconfirmed_product_direction` only for
`openclaw/openclaw` pull requests that meet every deterministic review gate:

- external, non-maintainer author
- `item_category: feature`
- `requires_product_decision: true`
- new feature or configuration surface
- correct patch with no review findings
- dedicated security review status is `cleared`, with no concerns
- sufficient or overridden real behavior proof
- PR quality tier C or better
- no `clawsweeper:human-review`, `clawsweeper:manual-only`,
  `clawsweeper:autofix`, or `clawsweeper:automerge` label

The review lane only writes a durable close proposal. Apply is default-off and
requires the repository variable
`CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED=true`.
When the gate is disabled, apply records the skip without consuming or
rewriting the durable proposal.

Even when enabled, apply fails closed unless the PR is older than 14 days and
the source snapshot was inactive for seven days before review. It re-fetches
live state and keeps the PR open when it finds an assignee, requested reviewer
or team, maintainer issue comment, maintainer review, maintainer inline review
comment, an exemption label, changed source state, missing pagination data, or
any GitHub fetch failure.

The policy does not merge a PR, add public labels, infer product acceptance
from passing tests, or treat an existing issue as permission to add product
surface. Maintainer calibration remains explicit and reversible.
