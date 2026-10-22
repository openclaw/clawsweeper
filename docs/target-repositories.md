# Target Repositories

- Status: active configuration and onboarding reference
- Owner: ClawSweeper maintainers
- Source of truth: `config/target-repositories.json`, repository profiles,
  target inventory, dashboard/apply configuration, and profile tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: profile policy, supported owners, inventory, dashboard targets,
  apply membership, or onboarding requirements change

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured runtime profiles in `config/target-repositories.json`
- conservative generic fallbacks for exact event/manual reviews of configured
  owner inventories such as `openclaw/*` and `steipete/*`

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Every other configured profile declares its own issue and PR
close rules in `apply_close_rules`; do not infer those rules from whether the
repository appears in the dashboard or receives scheduled work. The current
configured profiles allow `implemented_on_main` for issues and PRs, and some
profiles additionally allow age-gated `mostly_implemented_on_main` for PRs.

Review guidance belongs to the selected profile's `promptNote` in
`src/repository-profiles.ts` or `config/target-repositories.json`; a built-in
profile can add `kindPromptNotes` for guidance that applies only to issues or
only to PRs. The production prompt assembler selects them with
`repositoryProfileFor(item.repo)`, using the
normalized exact owner/repository, not the organization, display name, PR body,
linked repository, or author association, and renders them as the prompt's
`Repository Policy` section. The same profile's `apply_close_rules` for the item
kind select which entries of `prompts/review-close-reasons.md` the prompt shows.
The built-in `openclaw/openclaw` profile alone supplies its release-owned
`CHANGELOG.md` review restriction, Telegram proof routing, and maturity-label
guidance.
`openclaw/clawsweeper`, ClawHub, and generic targets follow their own release-note
policies; being a non-core target does not grant contributors or workers
permission to edit release-owned files.

## Repository-owned review configuration

Admitted PR reviews may opt in through `.clawsweeper/review.json` on the target
repository’s default branch. Issue triage is unchanged. The host reads this
strict configuration once from an authenticated default-branch commit, not the
PR head, PR base, or webhook/dispatch payload. Missing or empty configuration
keeps the ordinary prompt, invocation, review cadence and cache identity.

```json
{
  "version": 1,
  "skills": ["domain-review"],
  "additionalPrompt": "Repository-specific review instructions."
}
```

`skills` selects at most eight exact names under `.agents/skills/<name>/SKILL.md`;
frontmatter names must match. `additionalPrompt` appends at most 5,000 characters
to the normal review contract. Unknown keys and versions are rejected.

The optional `multiModel` key selects two to four independent full assessments and
one full consolidation, with at most two independent workers running at once:

```json
{
  "version": 1,
  "multiModel": {
    "reviewers": [
      { "runner": "codex", "model": "<operator-authorized-model>" },
      { "runner": "openclaw", "model": "<provider>/<operator-authorized-model>" }
    ],
    "coordinator": { "runner": "codex", "model": "<operator-authorized-model>" }
  }
}
```

These placeholders are not working model bindings. OpenClaw references split the
provider at the first slash and preserve the remaining model ID, including vendor
namespaces; valid syntax does not establish access or model availability. Each selection may include
`reasoningEffort` and `contextTier: "default"`. Explicit `long_context` is rejected:
neither adapter has a qualified long-context selector. Each runner environment
is filtered for its selected role before launch, using only credentials already
provisioned by the operator. Configuration never grants missing workflow secrets;
an unprovisioned provider remains unavailable. Configuration cannot
supply credentials, endpoints, executables, CLI arguments or mutation authority.
Skills and model selection are independent: skills alone keep one assessment;
models alone fan out; both use the same selected guidance in each host-assigned
phase without another skill-owned model pair. No extra baseline assessment runs.

Every worker uses the normal scanner, checkout inspection, strict Decision parser
and host postprocessing. Model-authored results are scanned before they can become
durable member evidence. Any scanner refusal is terminal, discards private model
slots and prevents publication of the rejected batch. Codex source setup is serialized once per private role before that batch of
workers runs in parallel. A surviving host owns each worker's
private temporary root and removes native adapter, scanner and skill state after
all workers settle, including timeout-killed workers. Independent workers and consolidation share the original
source/configuration snapshot and one absolute deadline. Output budgets are split
across all assessments, rather than multiplied. The consolidation model receives
full validated member Decisions as untrusted evidence and selects the canonical
priority, relevance and labels through the existing parser/publication owners.
A small reject-only guard prevents dropping explicit contributor, proof,
compatibility, owner, product or security holds, or creating new automation
eligibility. Failure or veto means incomplete review, not a synthetic consensus.
Host-owned failure class, terminal status and retry disposition cross the worker
boundary without raw diagnostics; a terminal, unknown or vetoed outcome does not
authorize another potentially paid batch. Hosted producers exit 82 for a nonretryable
batch and complete the queue lease with the closed terminal reason
`batch_nonretryable`. The queue retains the failed input without automatically
retrying it; a fresh source or explicit request is required. Deploy the updated
queue Worker and completion/status readers **before** enabling this producer or
repository opt-in: the workflow will not strip this terminal reason to work around
an older Worker. Diagnostic `retryable: false` alone is not retry authority.
Unverified Git process settlement retains
owned recovery state and aborts ordinary item conversion; settled host failures
retain completed advisory assessments without granting retry permission.

The one review comment shows the final assessment and collapsed, escaped,
section-budgeted individual assessments. Full typed member Decisions remain in
the durable record even when diagnostic output retention is none. Such records
use review-record version 2; upgraded readers also accept version 1. Old strict
readers reject version 2 rather than silently losing the individual assessments.
The top-level record Decision remains authoritative. Requested settings, native
runtime selection and terminal facts are separate; absent native facts are
reported as unreported, not inferred from the model's own answer. Assessment
completion describes content only; the durable `executionQualification` remains
`unverified`, and neither completion nor native runtime facts qualify an exact
actual-model/high-effort pair. The exact
Codex 0.162.1 human startup header supplies runtime configuration only, never
terminal selection or provider-observed reasoning effort. OpenClaw's successful
native envelope supplies only the bounded allowlisted execution receipt fields.
Actual-provider execution and the requested Windows pair remain qualification
gates; this configuration example does not assert either has passed.

Configuration, selected skills and relative references use the same pinned
revision. Bundles are limited to 64 regular UTF-8 files and 256 KiB; symlinks,
submodules, binary files, case-colliding or Windows-aliasing paths, escaping/missing
Markdown references, nested skills and native tool-provisioning dependencies are
rejected. When prompt retention is budgeted, the complete repository/native/schema
prompt must fit the existing
per-item allocation before retention or full assessment; deterministic prompt
overruns are not retryable. Missing configuration and
skill blobs require pinned size metadata and object-store disk admission before
hydration; unavailable or truncated metadata fails closed. Their digest participates
in hydrated content-cache identity, not the global admission policy. Configured
reviews skip structural-only reuse because that receipt does not bind config
bytes; unchanged hydrated content can still reuse its verdict. This does not
request another review. The ordinary scanner also inspects the selected bytes.

Codex already loads skills natively. The adapter materializes only the selected
pinned bundle in an isolated native working directory and invokes its exact
native skill paths. The reviewed checkout remains unchanged and is referenced
for source inspection, not native skill discovery. Skill instructions cannot
grant writes, helper execution, installation, delegation or additional models.
Unsupported methodology must be reported, not claimed complete. Selected Codex
skills preserve the normal same-thread structured-decision repair lifecycle.

Every multi-model role, including models-only configuration, receives its own
pinned working copy and independent Git config/index/refs; immutable Git objects
are borrowed from the admitted host store, never hardlinked. The existing byte,
file, disk, attribute and shared-time admission checks still run before checkout.
Before acceptance or mode restoration, the host verifies the complete private
source fingerprint, including ignored files and Git metadata. Replacement
file/directory/ancestor identities are retained for recovery, never followed by
permission restoration. A bounded internal recovery receipt preserves cause
identity/digests and owned paths across worker termination; raw provider
diagnostics never enter advisory Decisions. Temporary state is private per role.

OpenClaw uses the existing managed review-tree parent as its isolated native
workspace, with pinned skills outside the reviewed checkout. This does not enable
optional Codex-source provisioning in jobs where the existing setup is absent.
When present, the host-owned Codex-source sibling is permitted only after
successful preparation and exact
symlink-target verification. Its referent uses the existing read-only mode guard;
original modes are restored only on the same filesystem identities. Before
acceptance, a bounded streaming fingerprint checks the entire owned clone, including
Git metadata, modification/change timestamps and ignored/untracked files. On every
assessment exit, drift or an unverifiable snapshot requires recovery and preserves
the reference and review workspace, including the original failure cause. Git
optional index writes are disabled for selected native reviews;
worktree-style Git pointers and escaping reference links are unsupported. This is
post-execution verification, not a new OS sandbox. Unrelated siblings remain
rejected. Its name
allowlist selects only the approved skills;
the read-only checkout probe allows none. Filesystem workspace-only restrictions
remain enabled. A missing/shared parent (including ordinary offline user
checkouts) is unsupported for selected OpenClaw skills and fails before inference;
unconfigured and append-only operation is unchanged. No source copy or move is
performed on user checkouts. Adding an extra skill directory to the PR checkout alone is not safe.
The checkout probe uses only the direct read tool, not Code Mode, and still requires
the exact challenge and paired successful read receipt. It reads legacy transcripts or the current local `sessions export-trajectory`
output from its own isolated state; unavailable or mismatched receipts fail closed.
New siblings written in the owned native workspace are removed during cleanup;
an otherwise successful review that wrote them is rejected before acceptance.
Changed original workspace/source/sibling identities instead preserve the workspace
for recovery and reject acceptance, rather than deleting relocated source.
Host-provided Node CA roots are preserved for verified TLS through managed egress.
Harness selection remains operator-owned: a native runtime that cannot honor the
read-only probe is unsupported, not automatically replaced.

Offline local-range review instead trusts the operator-selected `--base` ref
(default `origin/main`), resolved to its exact commit, not the diff’s merge-base
or the reviewed `HEAD`. Choose a trusted base: this local input is not a PR or
webhook field and does not assert live GitHub default-branch freshness. No remote
or `origin/HEAD` is required when a valid local base proves configuration absence.
A missing/invalid base fails before inference; head deletion cannot disable its
configuration. Hosted reviews always use the authenticated default branch above.

This active contract is owned by ClawSweeper maintainers; source owners are
`src/repository-review-config.ts`, `src/clawsweeper-review-runtime.ts` and
`src/agent-runner.ts`, `src/multi-model-review.ts` and `src/review-record.ts`.
Verified scope: the compiled worker path and synthetic process fixtures, not live
provider qualification (2026-10-22). Update it when configuration, native harness isolation,
source pinning, scanner, budgets or cache identity change.

All profiles share the hidden-payload security guard in
`src/repair/security-signals.ts`. It checks the raw item body and discussion
before prompt compaction, inspecting rendered HTML comments for remote shell
substitution, download-to-shell pipelines, or encoded environment dumps. Visible
fenced and inline code examples are excluded. A signal becomes a typed security
review requiring human moderation, P1 (or an existing P0), and `impact:security`;
it blocks every automatic close reason. Apply also checks current source before
closing, including paired closes and older proposals without a recorded signal.

OpenClaw’s generated locale PRs are publisher-owned. Automatic apply and repair
close paths leave PRs open when live GitHub metadata identifies
`openclaw-mantis[bot]` as author, both head and base repositories as
`openclaw/openclaw`, base branch `main`, and head branch
`automation/native-app-locale-refresh` or `automation/control-ui-locale-refresh`.
GraphQL reports the same App author as `app/openclaw-mantis`. Titles and labels
do not grant this exemption, nor do matching branches in forks. The publisher
owns freshness reconciliation and auto-merge; this close guard grants no merge
authority and preserves normal review and CI requirements. Existing kept-open,
blocked, and skipped outcomes explain the decision, with no Bay schema or
control changes.

Toolchain and setup ownership is also per repository. The explicit
`openclaw/crabbox` profile selects npm and installs its nested worker package
with `npm ci --prefix worker` from the target root. It retains the generic
OpenClaw fallback's close rules, empty validation commands, and absent changed
gate; selecting target-native setup does not broaden apply policy or inherit
the core OpenClaw policy.

`openclaw/openclaw-enterprise` uses an explicit review-only profile. Its prompt
preserves the repository's platform-design, IAM, audit, persistence, deployment,
and integration-proof boundaries, while its baseline repair validation follows
the target repository's workspace, lint, formatting, OpenAPI, and typecheck
gates. Issue and pull-request close rules remain empty; enabling the target
dispatcher does not grant automatic close authority. The profile keeps review
and read-only comment commands available but rejects issue implementation,
autofix, automerge, CI/review repair, rebase, and trusted repair/merge automation
before the router can create a repair job. The repair worker independently
rechecks the same profile before planning or execution effects, so a job queued
before the policy changed and a replayed execute job cannot mutate the target.

Repair validation defaults to 480,000 ms per command. Set `validation_timeout_ms`
in an exact repository entry (or `core_target_overrides`) to override it:
`openclaw/openclaw` uses 3,000,000 ms (50 minutes) for its cold changed gate.
When a change selects every core test graph, that gate typechecks 27 graphs one
at a time from a cold cache and then runs three Knip dead-export scans. On the
16-vCPU execution runner (2026-10-03 to 10-09), finished runs took 19 to 24
minutes before the Knip scans, and slower runners were on pace for up to 36
minutes. The Knip scans add about 7 to 8 minutes.
Other repositories retain eight minutes. The repair workflow's optional
`target_validation_timeout_ms` input takes precedence over the ClawSweeper
repository variable `CLAWSWEEPER_FIX_TARGET_VALIDATION_TIMEOUT_MS`, then this
configuration, then the eight-minute default. Local executor calls use the
same environment variable. Blank or invalid values fall back to configuration.
Each top-level validation command receives a fresh budget. OpenClaw's
`pnpm check:changed` is one command whose internal typecheck, lint, and other
stages share that budget. The overall executor budget is the larger of 70 minutes
and 10 minutes of setup + the configured edit-worker budget + twice the validation
budget + 10 minutes for review/reporting, capped at 110 minutes. With the default
30-minute worker budget, OpenClaw receives the 110-minute ceiling. An explicit
`CLAWSWEEPER_FIX_STEP_TIMEOUT_MS` overrides that derivation within the existing
15-minute floor and new 110-minute ceiling. Actions resolves the same budget and
adds two minutes for executor shutdown. The job allows 130 minutes, so a step at
that ceiling still leaves time for setup (at most 2.2 minutes measured) and for
publication and post-flight, whose check wait is capped at 10 minutes.
Checkout identity proof
reserves a small part of its budget. The lower-level
`CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS` can further shorten that budget.
The repair executor requests OpenClaw's `--timed` summary and records core
typecheck, core-test typecheck, and core lint durations in Actions logs, including
successful validation. Other command output is not echoed by this timing logger.
Outside strict validation, a failed changed gate gets one retry
(`CLAWSWEEPER_VALIDATION_RETRIES`) inside the same command budget, and only when
the remaining budget can fit the failed attempt again. Otherwise the executor
reports that failure, which the issue or repair worker can still fix.

Edit, validation-fix, and review-fix workers run focused checks and return the
patch for one full executor acceptance pass. Worker claims and shell transcripts
are not acceptance receipts. The contained executor gate and checkout identity
checks remain required; a failed gate, subsequent edit, or final base synchronization
can require another pass. The doubled validation allowance covers such a repeat,
not a mandatory worker/executor duplicate.

On a confirmed timeout, the containment supervisor terminates and reaps the
command tree before the validator removes newly created OpenClaw ownership
directories (`.artifacts/dist-artifacts.lock` and `.artifacts/vitest-workers`).
Pre-existing ownership, unrelated artifacts, unsafe path replacements, and
unverified process completion retain the existing recovery and identity guards.
If post-timeout identity verification is inconclusive, the timeout remains the
primary diagnostic, both errors are retained, and the checkout requires recovery
before reuse. A proven checkout mutation still takes precedence.

Dashboard targets are configured separately with `TARGET_REPOS` in
`dashboard/wrangler.toml`. Scheduled target selection comes from
`target_inventory`, and apply-enabled targets use the dashboard's
`APPLY_TARGET_REPOS` and `APPLY_OPTIONAL_TARGET_REPOS`. A runtime profile alone
does not enable any of those surfaces.

`PUBLIC_BAY_REPOS` is a separate public-output allowlist for the minimal
repository/item reference cards shown by Overview. Add a
repository only after confirming that it is public and intended to be visible
on the unauthenticated dashboard. The Worker treats an absent or malformed
allowlist as empty. Membership does not authorize titles, URLs, queries,
failure data, opaque keys, credentials, tokens, or any private-repository data.

## Generic Fallbacks

The fallback lets a newly installed repository dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be listed in `generic_fallbacks`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- scheduled fanout is public-only unless a private state publication path exists
- auto-close policy comes from that owner fallback
- `live_test` configuration and its post-review executor are retired
- generic `openclaw/*` issues can auto-close only for
  `implemented_on_main`; PRs can auto-close for `implemented_on_main` or
  age-gated `mostly_implemented_on_main`
- `steipete/*` starts review/comment-only for issues and PRs
- scheduled dashboard/backfill rows are added only through target fanout

This is enough for event-driven review after the target repo has the dispatcher
workflow and GitHub App installation.

## Add One Repository

1. Install the ClawSweeper GitHub App on the target repository.
2. Add or merge the target dispatcher from
   [`docs/target-dispatcher.md`](target-dispatcher.md).
3. Verify the App receives Issues, Pull requests, and Issue comments webhooks.
   The target workflow uses OIDC and needs no ClawSweeper secret.
4. Open, edit, or comment on a target issue/PR and confirm a dispatcher run
   appears in the target repo.
5. Confirm direct Worker intake succeeds and the queued review appears in
   `https://github.com/openclaw/clawsweeper/actions`; no relay run is expected.
6. Confirm the target item gets one durable ClawSweeper review comment.

Add a `config/target-repositories.json` entry when a repository needs explicit
review guidance, toolchain configuration, or close rules. Dashboard and
scheduled-queue membership are separate changes; update their owning
configuration only when that rollout is intended. Keep close rules narrow
unless the repository has a documented reason for broader policy.

## Add Many Repositories

Batch rollout should use target fanout:

- install the app and dispatcher on a small group first
- leave auto-close disabled unless the owner/repo profile explicitly enables it
- verify event review/comment sync on one issue or PR per repo
- use `pnpm run target-fanout -- plan --mode hot-intake --limit 10 --dry-run`
  to inspect the current owner inventory and selected dispatch commands
- let the scheduled fanout cursor dispatch small batches across
  `target_inventory.owners`; the cursor is stored in the authenticated
  ExactReviewQueue Durable Object rather than `clawsweeper-state`
- fanout passes each repository's default branch as `target_branch`, so repos
  that use `master` or another branch do not fall back to `main`
- add config entries only for repos that need repo-specific guidance or broader
  close policy

If a target dispatch reaches ClawSweeper but receiver token creation fails, the
App is usually not installed on that target repo. If the target workflow warns before intake, check its OIDC permission,
canonical workflow filename, and default-branch ref. The independent App webhook
route remains enabled; see [failure semantics](target-dispatcher.md#failure-semantics-and-legacy-receivers).
