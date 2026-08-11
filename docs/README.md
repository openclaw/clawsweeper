# ClawSweeper documentation

- Status: active documentation index
- Owner: ClawSweeper maintainers
- Source of truth: the linked repository files and their owning code,
  configuration, workflows, and tests
- Last verified: `openclaw/clawsweeper@9c32c14c65b0551b43a10c2086c0031338ae41e7`
- Update when: a document is added, retired, moved, changes lifecycle, or gains a
  new canonical owner

ClawSweeper reviews GitHub issues and pull requests, publishes durable results,
and applies or repairs only through guarded maintainer-controlled paths. Start
with the task or audience below; this page is a map, not another operator
manual.

## Start here

| Goal                                                | First page                                    | Next step                                           |
| --------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Understand the product boundary                     | [Project vision](../VISION.md)                | [Orchestration](orchestration.md)                   |
| Set up a development checkout                       | [Contributing](../CONTRIBUTING.md)            | [Local run](../README.md#local-run)                 |
| Understand review and scheduling                    | [Scheduler](scheduler.md)                     | [Automation limits](limits.md)                      |
| Add or operate a target repository                  | [Target repositories](target-repositories.md) | [Target dispatcher](target-dispatcher.md)           |
| Inspect production without mutation                 | [Live dashboard](live-dashboard.md)           | [OpenClaw Bay](openclaw-bay-demo.md)                |
| Inspect observer routes and configuration ownership | [Public observer API](public-api.md)          | [Operator configuration](operator-configuration.md) |
| Operate repair or automerge                         | [Repair entry point](repair/README.md)        | [Repair operations](repair/operations.md)           |
| Prepare proof for a change                          | [Contributing](../CONTRIBUTING.md)            | [Agent instructions](../AGENTS.md)                  |
| Review a local committed range                      | [Local branch review](commit-sweeper.md)      | `pnpm local-review -- --base origin/main`           |

Production mutation commands are intentionally not repeated here. Follow the
linked runbook, confirm its status and source of truth, and keep all execution,
fix, merge, automerge, deployment, and queue gates closed unless the current
operator has explicit authority to open them.

## Document lifecycle

Every evergreen page belongs to one of these states:

- **active**: current guidance for a supported surface
- **proposed**: a future design or runbook that grants no execution approval
- **compatibility-only**: retained for still-readable state or a supported
  migration boundary, but not for creating new work
- **historical**: completed proof or decision history, not current procedure

Active runbooks and volatile configuration references should begin with status,
role owner, owning source, last-verified revision, and update triggers. “Owner”
is a responsibility role until maintainers approve a stable GitHub CODEOWNERS
individual or team. Generated or checked values should name their checker;
everything else requires human comparison with current main.

## Concepts and architecture

- [Project vision](../VISION.md) — active; product goals and boundaries
- [Orchestration](orchestration.md) — active; planner, review, publish, apply,
  and repair shape
- [Scheduler](scheduler.md) — active and volatile; scheduled and exact-event
  execution behavior
- [State storage](state-storage.md) — active; Worker, R2, and Git-backed state
  ownership
- [Action ledger](action-ledger.md) — active; mutation receipts and replay
  boundaries
- [Work lane](work-lane.md) — active; bounded workflow admission
- [Review cache](review-cache.md) — active; reusable review-state contract

## Configuration and repository onboarding

- [Automation limits](limits.md) — active; validated by
  `pnpm run check:limits`
- [Target repositories](target-repositories.md) — active; profiles, generic
  fallbacks, inventory, and apply membership
- [Target dispatcher](target-dispatcher.md) — active; exact-event integration
- [OpenClaw event hooks](openclaw-event-hooks.md) — active; event routes
- [Local branch review](commit-sweeper.md) — active local/GitHub-isolated
  replacement for hosted commit review

## Operations and runbooks

- [Live dashboard](live-dashboard.md) — active; public observer surface and
  operator diagnostics
- [Queue-service split runbook](queue-service-split-runbook.md) — proposed;
  unapproved production migration plan
- [Repair operations](repair/operations.md) — active; canonical repair operator
  procedures, trust checks, gates, and token boundaries
- [Local ClawSweeper skill](local-clawsweeper-skill.md) — active; read-only
  local exact-item or committed-range review

## Dashboards and observability

- [Live dashboard](live-dashboard.md) — active; Worker status and operational
  telemetry
- [OpenClaw Bay](openclaw-bay-demo.md) — active; public six-lane visualization
- [Triage dashboard](triage-dashboard.md) — active; cached issue triage
- [PR proof triage](pr-proof-triage-dashboard.md) — active; maintainer proof
  inspection

## Contributor, review, and proof guidance

- [Contributing](../CONTRIBUTING.md) — active; setup, scope, PR evidence, and
  author-owned review loop
- [Agent instructions](../AGENTS.md) — active and binding for coding agents
- [PR review comments](pr-review-comments.md) — active; review-thread handling
- [Related issue discovery](related-issue-discovery.md) — active; duplicate and
  adjacent-report context

`docs/proof/**` contains inspectable artifacts for specific changes. Those
files support their recorded claim but do not override current runbooks.

### Proof media retention

Commit lightweight, diffable proof records: the claim and limits, exact source
or head SHA, reproduction command, provider/image/lease provenance, fixture
hashes, observable assertions, and compact normalized JSON. Full-resolution
screenshots, videos, and traces may be committed while a pull request is under
review, but prune them from `main` after merge once the durable review and proof
record exist; git history retains the review-time bytes.

Keep a heavy binary only when an active canonical document embeds or links it,
or when runtime or test tooling consumes it. Prefer one current compressed
poster or WebP over accumulated before/after sets.

## Repair and automerge

- [Repair entry point](repair/README.md) — active; concepts, task map, and local
  command reference
- [Repair operations](repair/operations.md) — active; canonical operator
  procedures
- [Internal feature map](repair/internal-features.md) — active implementation
  reference, not an operator runbook
- [Steerable repair architecture](steerable-repair-automation.md) — active;
  end-to-end protocol and control boundaries
- [Trusted PR repair](repair/auto-update-prs.md) — active; autofix/automerge
  contract
- [Automatic issue PRs](repair/automatic-issue-prs.md) — active; guarded issue
  implementation intake
- [Automerge flow](repair/automerge-flow.md) — active; state machine
- [Automerge proof](repair/automerge-e2e.md) — active; controlled proof harness
- [Containment validation history](repair/containment-validation-todo.md) —
  historical; completed July 2026 work

## Close policy

- [Obsolescence policies](obsolescence-close-policies.md) — active policy map
- [Unsponsored feature policy](unsponsored-feature-close-policy.md) — active
- [Product direction policy](product-direction-close-policy.md) — active
- [Author PR budget policy](author-pr-budget-close-policy.md) — active
- [Stalled PR policies](stalled-pr-close-policies.md) — active

## Security and special-purpose surfaces

- [Spam scanner](spam-scanner.md) — active; trust and classification boundary
- Security-sensitive work must use maintainer security handling rather than a
  normal public PR or public documentation page.

## Update triggers

Review the relevant pages in the same change when any of these surfaces move:

- `config/automation-limits.json` or workflow limit literals: automation limits
  and scheduler
- `config/target-repositories.json`, repository profiles, target inventory, or
  apply membership: target-repository and dispatcher docs
- exact-review queue schema, retry classification, publication capacity,
  batching, direct publication, or state writing: scheduler, limits, dashboard,
  Bay, and queue runbooks
- dashboard route, projection, or public-field changes: dashboard and Bay docs
- mutation, close, proof, repair, or merge policy changes: policy pages,
  CONTRIBUTING, AGENTS, and repair operations
- workflow retirement or replacement: every command example and compatibility
  page that names the workflow

## Automated drift checks

`pnpm run check:docs` validates exact-case relative links and Markdown anchors,
documented package scripts, workflow files, repository source paths, and the
selected configuration-derived claims in
`config/documentation-sync.json`. It runs through the existing static check and
CI path. Add a manifest claim when volatile production configuration is quoted
as a concrete value in prose. Stage newly added files before running the check
so its repository inventory matches the proposed commit rather than unrelated
untracked workspace contents.

The check deliberately does not crawl external URLs, infer policy, assign
ownership, or treat historical proof commands and paths as current contracts.
The index, lifecycle labels, and whether a configuration claim should become
policy remain human-reviewed.

The public documentation build reads `config/documentation-site.json` as its
exhaustive lifecycle manifest. Active pages appear in navigation, search, the
sitemap, and `llms.txt`. Proposed, historical, and proof pages remain available
at stable generated paths for evidence links, but carry a visible lifecycle
banner and `noindex` metadata and are excluded from canonical discovery. The
documentation check fails when a page is unclassified or classified twice.
