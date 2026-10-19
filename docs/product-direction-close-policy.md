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

The review lane may recommend closing, with
`maintainer_decision.required: true` and `kind: product_direction`. This packet
records an outstanding decision; it is not authenticated human approval.
Apply always preserves the proposal and keeps the PR open. Neither
`CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED=true` nor an `all`
close-reason allowlist authorizes an automated product rejection.

A maintainer evaluates the specific item and uses the ordinary manual GitHub
close workflow if they reject the direction. A model's `required: false`,
passing tests, or a repository-wide flag cannot make that decision. The same
manual route applies to `unsponsored_feature_request`, `clawhub`, and
`not_actionable_in_repo` recommendations. No new approval command or automatic
close route is introduced.
