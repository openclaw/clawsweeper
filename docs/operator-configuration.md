# Operator configuration ownership

- Status: active operator reference
- Owner: ClawSweeper deployment and workflow maintainers
- Source of truth: `dashboard/wrangler.toml` and `.github/workflows/`
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: an audited name is removed, renamed, or changes responsibility, or a source-verified ownership gap is added to this inventory
- Checked by: `pnpm run check:docs`

This page records names and ownership boundaries only. Never copy secret values
into documentation, issues, logs, or pull requests. The committed Wrangler file
is authoritative for selected deployment values; GitHub repository or
environment settings are authoritative for workflow variables and secrets.

## Dashboard Worker variables

| Name                              | Responsibility                                                             |
| --------------------------------- | -------------------------------------------------------------------------- |
| `CLAWSWEEPER_REPO`                | Repository used by ClawSweeper-specific projections.                       |
| `PUBLIC_BAY_REPOS`                | Verified-public repositories eligible for minimal Overview references.     |
| `WORKER_DETAIL_RUN_LIMIT`         | Maximum workflow-run detail set fetched for dashboard assembly.            |
| `WORKER_JOB_FETCH_CONCURRENCY`    | Concurrency for workflow-job detail fetching.                              |
| `WORKER_JOB_CACHE_TTL_SECONDS`    | Workflow-job cache lifetime.                                               |
| `WORKER_HEALTH_CACHE_TTL_SECONDS` | Workflow-health cache lifetime.                                            |
| `WORKER_HEALTH_FETCH_CONCURRENCY` | Concurrency for workflow-health fetching.                                  |
| `RECENT_CLOSED_CACHE_TTL_SECONDS` | Recently closed item cache lifetime.                                       |
| `INCLUDE_CI_STATUS`               | Enables CI status in dashboard assembly when selected.                     |
| `REVIEW_OBSERVABILITY_REQUIRED`   | Selects whether review observability is required for status assembly.      |
| `REVIEW_RECOVERY_ENABLED`         | Selects review recovery behavior in the deployed Worker.                   |

## Workflow credential names

Provider keys used by the optional OpenClaw runner are `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `KIMI_API_KEY`, and `OPENROUTER_API_KEY`. Maintainer-report
and Cloudflare access workflows reference `CLOUDFLARE_ACCESS_CLIENT_ID`,
`CLOUDFLARE_ACCESS_CLIENT_SECRET`,
`OPENCLAW_REPORTS_ACCESS_CLIENT_ID`, and `OPENCLAW_REPORTS_ACCESS_CLIENT_SECRET`.
Their consuming workflows own whether they are required; no values are recorded
here.

`config/operator-documentation.json` pins this deliberately scoped audited set so
`pnpm run check:docs` fails if a name disappears from its owning source or this
page. It does not require every repository workflow secret or dashboard setting
to be duplicated here. [Automation limits](limits.md) remains canonical for
capacity and timing values.

## GitHub App token scopes

Dashboard REST reads mint a token for the requested repository and read permission
(actions, checks, contents, issues, pull requests, or metadata). GraphQL title
reads use the named repository with issues/pull-requests read. Issue searches use
the query's explicit repositories and item kind (issues or pull requests); a query
without repository qualifiers falls back to the configured triage repository set. Cache
identity includes the App, installation/repository identity, normalized repository
set, and permission set. Expired entries are discarded before minting.

The dead-letter operator caches successful tokens per repository, batches GraphQL
reads within that repository, and retains owner-wide setup-throttle suppression.
It requests issues and pull-requests read only. An inaccessible repository
must not cause a token for a different repository to be reused.

Workflow and webhook token requests name their target, central, or state repository
and request only their API permissions. Target publication tokens read contents;
issue/PR permissions own comment, label, and closure writes. State-token callers
pass an empty Actions grant except audit, which dispatches the state dashboard.
The state-size-only reconcile caller omits both optional grants; the composite
always requests metadata read so empty grants cannot inherit App permissions.
The comment router enqueues through Worker HMAC, so its unused legacy central
dispatch token is restricted to metadata read. The four metadata-only inventory/coverage
mints in `target-fanout.yml` are intentionally owner-scoped: their first read is
`GET /installation/repositories`, which discovers the repository set itself.
They cannot select that unknown set before minting. No token requests workflows,
checks write, secrets, members, organization administration, or security events.

## Submission triage

Preliminary intake reuses the existing repository secret `OPENAI_API_KEY` and
is enabled by default in native OpenAI modes. The separate OpenClaw runner can
also use that key. Private ClawRouter Codex routes keep upstream keys withheld;
intake never forwards their private workload credentials. Without a native key,
full review runs normally and preliminary intake is disabled.

The default backend is `decisions`, using `gpt-6-luna`. Set the repository
variable `CLAWSWEEPER_DECISION_MODEL` to override the intake model, or to `off`
to disable intake. Unset and blank values use the default. Set
`CLAWSWEEPER_INTAKE_BACKEND=responses` for deployments without Decisions access;
the selected model must be supported by that API. There is no automatic retry
on another backend. See [intake triage](intake-triage.md) for scope, budgets and
label lifecycle.
