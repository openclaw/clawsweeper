# Target Repository Dispatcher

- Status: active integration reference
- Owner: ClawSweeper maintainers and target-repository maintainers
- Source of truth: the embedded dispatcher workflow, receiver workflow,
  repository profiles, and dispatcher tests
- Last verified: this revision (keyless template and local Worker/queue proof)
- Update when: forwarded events, authentication, payloads, permissions, close
  authority, or installation steps change

`openclaw/clawsweeper` cannot receive native `issues` or `pull_request` events
from sibling repositories directly. Target repositories forward those events so
ClawSweeper can run a single-job exact one-item review, sync the durable review
comment, and immediately apply a safe close proposal for that same item. The
dispatcher first enqueues the event directly with its GitHub Actions OIDC
identity (see [Direct queue intake](#direct-queue-intake)). It holds no
ClawSweeper credential and never sends `repository_dispatch`; failures warn and
leave delivery to the independent GitHub App webhook route.

This document covers issue and PR item dispatch via
`.github/workflows/clawsweeper-dispatch.yml`; `openclaw/openclaw` uses this
form. The separate commit-review dispatch lane was retired in July 2026.

General GitHub activity can also be forwarded to the OpenClaw-backed activity
ingest lane with `repository_dispatch` type `github_activity`. That lane does
not run ClawSweeper review/apply; it feeds compact activity to the agent, which
posts to `#clawsweeper` only when the event is surprising or actionable. See
[openclaw-event-hooks.md](openclaw-event-hooks.md#github-activity-stream).

For issue and PR dispatch, copy this workflow into each target repository as
`.github/workflows/clawsweeper-dispatch.yml`. Keep that canonical dispatcher filename
when combining it with other triggers: OIDC rejects other workflow paths.

Target repositories no longer need a TypeScript profile before exact event
review can run. Any installed `openclaw/*` repository that is not denied in
`config/target-repositories.json` uses the conservative generic profile:
issues can auto-close only when already implemented on the default branch, and
PRs can also use the age-gated `mostly_implemented_on_main` rule. Add a config
entry only when the repo needs explicit review guidance, toolchain settings, or
different close rules. Dashboard and scheduled-fanout membership are configured
separately.

Exact event reviews enable related issue GitHub Search by default so newly
opened issues get stronger duplicate and adjacent-report context. Set repository
variable `CLAWSWEEPER_RELATED_GITHUB_SEARCH=0` on `openclaw/clawsweeper` to turn
that enrichment off without editing the target dispatcher.

This workflow forwards maintainer-authored items like everyone else's. The queue
applies the maintainer rule: items created from 2026-10-15 03:50 UTC get the
ordinary first review, and older maintainer items are held until someone
requests `@clawsweeper review`, without starting a review run. Old opt-in
reminder comments cannot trigger the command router.

Before enabling the workflow:

1. Install the `clawsweeper` GitHub App on the target repository.
2. Verify the App webhook subscribes to Issues, Pull requests, and Issue comments
   and reaches `/github/webhook`; see [required subscriptions](github-webhook-read-model.md#required-github-app-event-subscriptions).
3. Install exactly one dispatcher using the canonical filename below. Do not add
   separate comment, spam, or generic-activity dispatch workflows for the same event.
4. Grant only `contents: read` and job-scoped `id-token: write`. Do not configure
   a ClawSweeper secret, token action, hosted-admission reusable job, or PAT.
   The Worker owns eligibility, visibility checks, and all acknowledgement writes.

```yaml
name: ClawSweeper Dispatch

on:
  issues:
    types: [opened, reopened, edited, labeled, unlabeled]
  issue_comment:
    types: [created, edited]
  pull_request_target: # zizmor: ignore[dangerous-triggers] maintainer-owned external dispatch; no checkout or untrusted PR code execution
    types: [opened, reopened, synchronize, ready_for_review, edited, labeled, unlabeled]

permissions:
  contents: read

concurrency:
  group: clawsweeper-dispatch-${{ github.repository }}-${{ github.event_name }}-${{ github.event.comment.id || github.event.issue.number || github.event.pull_request.number || github.run_id }}-${{ endsWith(github.actor, '[bot]') && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.actor || 'dispatchable' }}
  cancel-in-progress: ${{ github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review' }}

jobs:
  dispatch:
    runs-on: ubuntu-latest
    # id-token proves this repository, event, branch, and run to the queue.
    # The job never checks out or executes pull request code.
    permissions:
      contents: read
      id-token: write
    if: ${{ !(endsWith(github.actor, '[bot]') && (github.event.action == 'labeled' || github.event.action == 'unlabeled')) }}
    env:
      SUPERSEDES_IN_PROGRESS: ${{ (github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review') && 'true' || 'false' }}
    steps:
      - name: Debounce bursty metadata events
        if: ${{ github.event.action == 'labeled' || github.event.action == 'unlabeled' }}
        run: sleep 20

      - name: Pre-filter ClawSweeper comment
        id: comment_filter
        if: ${{ github.event_name == 'issue_comment' }}
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          if [[ "$COMMENT_BODY" == *"<!-- clawsweeper-maintainer-opt-in:"* ]]; then
            echo "is_command=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if grep -Eiq '(^|[[:space:]])@(clawsweeper|openclaw-clawsweeper)\b(\[bot\])?|(^|[[:space:]])/(clawsweeper|review|re-review|rerun([[:space:]]+|-)?review|status|explain|fix|build|implement|create([[:space:]]+|-)?pr|fix([[:space:]]+|-)?issue|autofix|auto([[:space:]]+|-)?fix|automerge|auto([[:space:]]+|-)?merge|approve|stop|autoclose)\b' <<< "$COMMENT_BODY"; then
            echo "is_command=true" >> "$GITHUB_OUTPUT"
          else
            echo "is_command=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Dispatch exact ClawSweeper review
        if: ${{ github.event_name != 'issue_comment' }}
        env:
          TARGET_REPO: ${{ github.repository }}
          TARGET_BRANCH: ${{ github.event.repository.default_branch }}
          ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
          ITEM_KIND: ${{ github.event_name == 'pull_request_target' && 'pull_request' || 'issue' }}
          SOURCE_EVENT: ${{ github.event_name }}
          SOURCE_ACTION: ${{ github.event.action }}
          TARGET_DISPATCH_URL: https://clawsweeper.openclaw.ai/github/target-dispatch
        run: |
          set -euo pipefail
          source_identity_json="$(node <<'NODE'
          const crypto = require("node:crypto");
          const fs = require("node:fs");
          const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
          const pullRequest = event.pull_request && typeof event.pull_request === "object"
            ? event.pull_request
            : {};
          const issue = event.issue && typeof event.issue === "object" ? event.issue : {};
          const source = process.env.ITEM_KIND === "pull_request" ? pullRequest : issue;
          const headSha = String(pullRequest.head?.sha || "").trim().toLowerCase();
          const baseSha = String(pullRequest.base?.sha || "").trim().toLowerCase();
          const updatedAt = String(pullRequest.updated_at || "").trim();
          const queueClaim = {};
          const result = { queue_claim: queueClaim };
          const sourceUpdatedAt = String(source.updated_at || "").trim();
          if (sourceUpdatedAt && Number.isFinite(Date.parse(sourceUpdatedAt))) {
            queueClaim.source_updated_at = sourceUpdatedAt;
          }
          if (
            typeof source.title === "string" &&
            (source.body === null || typeof source.body === "string") &&
            typeof source.locked === "boolean" &&
            Array.isArray(source.labels)
          ) {
            const labels = [
              ...new Set(
                source.labels
                  .map((label) => String(label?.name || "").trim().toLowerCase())
                  .filter((label) => {
                    if (!label) return false;
                    if (label === "proof: override") return true;
                    if (/^(?:status|rating|proof|merge-risk|impact|issue-rating):/.test(label)) return false;
                    if (/^p[0-3]$/.test(label)) return false;
                    if ([
                      "maturity:stable",
                      "feature: ✨ showcase",
                      "good first issue",
                      "mantis: telegram-visible-proof",
                      "proof: telegram-e2e",
                      "triage: needs-real-behavior-proof",
                      "clawsweeper-recovery-stuck",
                      "no-stale",
                      "stale",
                    ].includes(label)) return false;
                    return !label.startsWith("clawsweeper:") || [
                      "clawsweeper:autofix",
                      "clawsweeper:automerge",
                      "clawsweeper:human-review",
                      "clawsweeper:manual-only",
                      "clawsweeper:bulk-filed",
                    ].includes(label);
                  }),
              ),
            ].sort();
            queueClaim.source_content_revision = crypto
              .createHash("sha256")
              .update(
                JSON.stringify({
                  version: 2,
                  title: source.title,
                  body: source.body || "",
                  locked: source.locked,
                  close_guard_labels: labels,
                }),
              )
              .digest("hex");
          }
          if (process.env.ITEM_KIND === "pull_request") {
            if (/^[0-9a-f]{40}$/.test(headSha)) queueClaim.source_head_sha = headSha;
            if (/^[0-9a-f]{40}$/.test(baseSha)) queueClaim.source_base_sha = baseSha;
            if (typeof pullRequest.draft === "boolean") {
              queueClaim.source_is_draft = pullRequest.draft;
            }
          }
          if (
            process.env.ITEM_KIND !== "pull_request" ||
            !/^[0-9a-f]{40}$/.test(headSha) ||
            !updatedAt
          ) {
            process.stdout.write(JSON.stringify(result));
          } else {
            result.ingress_route = "target_dispatcher";
            result.ingress_fingerprint = crypto
              .createHash("sha256")
              .update(
                JSON.stringify({
                  version: 1,
                  target_repo: String(process.env.TARGET_REPO || "").toLowerCase(),
                  item_number: Number(process.env.ITEM_NUMBER),
                  action: String(process.env.SOURCE_ACTION || ""),
                  head_sha: headSha,
                  updated_at: updatedAt,
                  body: typeof pullRequest.body === "string" ? pullRequest.body : "",
                  label: String(event.label?.name || ""),
                }),
              )
              .digest("hex");
            process.stdout.write(JSON.stringify(result));
          }
          NODE
          )"
          client_payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --arg target_branch "$TARGET_BRANCH" \
            --argjson item_number "$ITEM_NUMBER" \
            --arg item_kind "$ITEM_KIND" \
            --arg source_event "$SOURCE_EVENT" \
            --arg source_action "$SOURCE_ACTION" \
            --argjson source_identity "$source_identity_json" \
            --argjson supersedes_in_progress "$SUPERSEDES_IN_PROGRESS" \
            '{target_repo:$target_repo,target_branch:$target_branch,item_number:$item_number,item_kind:$item_kind,source_event:$source_event,source_action:$source_action,supersedes_in_progress:$supersedes_in_progress} + $source_identity')"
          # The App webhook remains an independent delivery route.
          if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] &&
            [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] &&
            oidc_token="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
              --header "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
              --get --data-urlencode "audience=$TARGET_DISPATCH_URL" \
              "$ACTIONS_ID_TOKEN_REQUEST_URL" | jq -er '.value | strings | select(length > 0)')" &&
            [ -n "$oidc_token" ]; then
            echo "::add-mask::$oidc_token"
            direct_body="$RUNNER_TEMP/clawsweeper-direct-intake.json"
            if direct_status="$(curl --silent --show-error --connect-timeout 5 --max-time 20 \
              --request POST \
              --header "authorization: Bearer $oidc_token" \
              --header "content-type: application/json" \
              --data "$client_payload" \
              --output "$direct_body" \
              --write-out '%{http_code}' \
              "$TARGET_DISPATCH_URL")" &&
              [[ "$direct_status" == 2[0-9][0-9] ]]; then
              echo "Queued ClawSweeper intake directly: $(jq -c . "$direct_body" 2>/dev/null || echo '{}')"
              exit 0
            fi
            # Only non-transient 4xx is a deliberate refusal; the App webhook covers it.
            # Timeouts, throttling, and verifier/Worker failures must stay re-runnable.
            if [[ "${direct_status:-}" == 4[0-9][0-9] && "$direct_status" != 408 && "$direct_status" != 429 ]]; then
              echo "::warning::ClawSweeper intake declined this event (HTTP $direct_status); the App webhook route still applies."
              exit 0
            fi
            echo "::error::ClawSweeper intake unavailable (HTTP ${direct_status:-none}); re-run this job after the Worker recovers."
          else
            echo "::error::ClawSweeper OIDC token unavailable; the dispatch job needs id-token: write."
          fi
          exit 1
      - name: Dispatch ClawSweeper comment
        if: >-
          ${{
            github.event_name == 'issue_comment' &&
            steps.comment_filter.outputs.is_command == 'true'
          }}
        env:
          TARGET_REPO: ${{ github.repository }}
          ITEM_NUMBER: ${{ github.event.issue.number }}
          COMMENT_ID: ${{ github.event.comment.id }}
          SOURCE_ACTION: ${{ github.event.action }}
          TARGET_DISPATCH_URL: https://clawsweeper.openclaw.ai/github/target-dispatch
        run: |
          set -euo pipefail
          client_payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --argjson item_number "$ITEM_NUMBER" \
            --argjson comment_id "$COMMENT_ID" \
            --arg source_action "$SOURCE_ACTION" \
            '{target_repo:$target_repo,item_number:$item_number,comment_id:$comment_id,source_event:"issue_comment",source_action:$source_action}')"
          # The App webhook remains an independent delivery route.
          if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] &&
            [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] &&
            oidc_token="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
              --header "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
              --get --data-urlencode "audience=$TARGET_DISPATCH_URL" \
              "$ACTIONS_ID_TOKEN_REQUEST_URL" | jq -er '.value | strings | select(length > 0)')" &&
            [ -n "$oidc_token" ]; then
            echo "::add-mask::$oidc_token"
            direct_body="$RUNNER_TEMP/clawsweeper-direct-intake.json"
            if direct_status="$(curl --silent --show-error --connect-timeout 5 --max-time 20 \
              --request POST \
              --header "authorization: Bearer $oidc_token" \
              --header "content-type: application/json" \
              --data "$client_payload" \
              --output "$direct_body" \
              --write-out '%{http_code}' \
              "$TARGET_DISPATCH_URL")" &&
              [[ "$direct_status" == 2[0-9][0-9] ]]; then
              echo "Queued ClawSweeper intake directly: $(jq -c . "$direct_body" 2>/dev/null || echo '{}')"
              exit 0
            fi
            # Only non-transient 4xx is a deliberate refusal; the App webhook covers it.
            # Timeouts, throttling, and verifier/Worker failures must stay re-runnable.
            if [[ "${direct_status:-}" == 4[0-9][0-9] && "$direct_status" != 408 && "$direct_status" != 429 ]]; then
              echo "::warning::ClawSweeper intake declined this event (HTTP $direct_status); the App webhook route still applies."
              exit 0
            fi
            echo "::error::ClawSweeper intake unavailable (HTTP ${direct_status:-none}); re-run this job after the Worker recovers."
          else
            echo "::error::ClawSweeper OIDC token unavailable; the dispatch job needs id-token: write."
          fi
          exit 1
```

`target_branch` is branch authority from the signed event repository payload,
not a guess. Carrying it lets legacy intake enqueue without an extra GitHub API
read. During a rolling upgrade, a branchless legacy payload is held in the
durable control plane until the target App resolves and validates the repository
default branch; it is never silently rewritten to `main`.

## Direct queue intake

Each `repository_dispatch` to `openclaw/clawsweeper` starts a
`Review event item` workflow run whose only job relays the payload into the
exact-review queue. The dispatcher therefore posts the same `client_payload`
directly to `https://clawsweeper.openclaw.ai/github/target-dispatch`,
authenticated by a GitHub Actions OIDC token whose audience is that URL. The
Worker accepts it only when the signed token proves all of the following:

- the token was issued for the payload's `target_repo`;
- the run was triggered by `issues`, `pull_request_target`, or `issue_comment`,
  matching the payload's `source_event` (and item payloads' `item_kind`);
- its `ref` is `refs/heads/<target_branch>` and the running workflow is that
  repository's `.github/workflows/clawsweeper-dispatch.yml` at that ref; other
  workflows, including reusable-workflow callers, are refused.

The payload may carry only the copied dispatcher's fields (`target_repo`,
`target_branch`, `item_number`, `item_kind`, `source_event`, `source_action`,
`supersedes_in_progress`, `queue_claim` identity fields, and the PR ingress
fingerprint). The Worker builds the same queue decision as the relay, keeps the
`target_dispatcher` ingress route, and runs the same hosted-target eligibility
and public-visibility admission before `/enqueue`. Its delivery id is
`target-dispatch:<repository_id>:<run_id>:<run_attempt>`, so a replayed or
retried request from the same run is an exact delivery dedupe, and the
cross-route identity below still collapses it against the direct App webhook.

Comment payloads contain only `target_repo`, `item_number`, `comment_id`,
`source_event: issue_comment`, and `source_action: created|edited`. The Worker
rejects extra fields, including payload-supplied author, association, or body.
It uses its own App credentials to resolve the installation, read the repository's
live default branch, verify the token ref against it, fetch the live comment,
bind its ID and `issue_url` to the requested item, and read that live item.
The existing App-webhook classifier and shared comment handler then decide
command authorization, acknowledgement, and routing from those API responses.
The inert [review authority classifier](review-authority.md) is not activated.

OIDC validation checks RS256 against GitHub's JWKS, exact issuer and audience,
bounded `iat`/`nbf`/`exp`, repository and repository ID, supported event, branch ref,
canonical `workflow_ref`, absent or identical `job_workflow_ref`, and positive
run ID/attempt. Repository, event, and ref are bound to payload/live authority;
OIDC never grants authority to a payload-provided comment body or association.

### Failure semantics and legacy receivers

A Worker `401` or `403` answer is a definitive rejection. These and other
non-transient `4xx` answers emit `::warning::` and exit zero; the independent App
webhook route still applies. A `503` means the OIDC verifier or Worker is
unavailable, including JWKS fetch failures or key-rotation propagation. Verifier
unavailability includes a `Retry-After` header. A missing or unavailable OIDC
token, network failure, redirect, `408`, `429`, or `5xx` emits `::error::` and
fails the job, leaving a visible, re-runnable record instead of silently dropping
the event. The App webhook does not depend on OIDC JWKS, but shares other Worker
failure modes. The keyless template has no `repository_dispatch` fallback and
makes no target GitHub
writes. These cases previously fell back and now rely solely on the App webhook
route (or a re-run once the Worker recovers):

- every configured issue, PR, or command event during OIDC or Worker failure;
- PRs targeting a non-default base branch (their token ref is that base branch);
- combined dispatchers installed under another filename, reusable-workflow callers,
  or runs whose workflow/ref claims differ from the canonical default-branch file;
- legacy/custom payloads with relay-only fields such as `installation_id`,
  `additional_prompt`, or command markers, and malformed or oversized payloads;
- events during a default-branch rename when the dispatched ref no longer matches.

The App handles `issues`, `pull_request` (the counterpart of `pull_request_target`),
and `issue_comment` created/edited independently of workflow filename or PR base.
Non-command comments, unauthorized commands, and label-only observations retain
the existing classifier/admission policy. They do not gain review authority.
Verify the three subscriptions before migrating any target; do not migrate an
installation missing one. Outages affecting both routes can delay or lose an
individual delivery; the failed dispatcher run is the record to re-run, not a
durable admission receipt.

Receiving `clawsweeper_item` and `clawsweeper_comment` `repository_dispatch`
handlers are **legacy compatibility** for unmigrated target copies. Keep them
until all 83 copies and the `openclaw/openclaw` variant have migrated and no
remaining dispatcher relies on them. Existing item payloads and receiver protocols
remain supported. No SQLite/Durable Object schema or configuration changes are
needed. Deploy the compatible Worker first in a separately approved operation;
updating a target before that deployment can lose its dispatcher-route delivery.

Non-draft PR receipt comments are owned by the App-webhook Worker path. The
keyless item workflow no longer creates or recovers them. Comment concurrency
still uses the source comment ID, and ignored bot label events use their own
actor-specific suffix, so neither can cancel an unrelated item admission.

Comments are a lightweight trigger only when the body contains a ClawSweeper
command, and generated proof-nudge comments are explicitly ignored before
command matching. Eligible open-item `review` and `re-review` command versions
go directly into the ExactReviewQueue Durable Object before any acknowledgement
or Actions dispatch. The identity binds the comment id, GitHub update timestamp,
and body digest. The queue verifies that exact live comment, binds a live PR head,
and retries GitHub dependencies with bounded 15-second-to-15-minute backoff.
Only after durable admission does it converge the marker-backed status comment
and `eyes` reaction. Redelivery is therefore idempotent, and App-token throttling
cannot leave an optimistic “router queued” comment as the only record of intent.

Other commands retain the comment-router path. The shared Worker handler reacts
with `eyes` and creates a marker-backed queued status comment only for live
OWNER/MEMBER/COLLABORATOR association. Both acknowledgement writes are best-effort.
It still dispatches `clawsweeper_comment` to the
comment router when acknowledgement or queued-comment creation gets a
target-repository 403. The dispatch carries the exact source comment id and,
when available, the queued status comment id. The router edits that queued
comment in place instead of posting a second reply.
Exact comment dispatches scan only that comment and use a per-comment receiver
concurrency group, so one maintainer command does not wait behind an unrelated
command on the same repository. The scheduled sweep remains a five-minute
fallback. Bot-authored label churn is also ignored. Label changes never
directly trigger an exact review. Content-changing events
such as issue edits and PR synchronizes update the desired review revision. The
receiver coalesces by repository and item number, then dispatches only a leased
executor for the newest revision.

For sub-5s acknowledgement, use the hosted GitHub App webhook at
`/github/webhook` instead of waiting for GitHub Actions. The Worker verifies
`CLAWSWEEPER_WEBHOOK_SECRET`, accepts `issue_comment`, `issues`, and
`pull_request` events for explicitly configured public repositories plus the
eligible `openclaw/*` and `steipete/*` fallbacks, mints a target installation
token for acknowledgement/comment reactions, mints the `openclaw/clawsweeper`
installation token for repository dispatch, and queues exact
`clawsweeper_comment` or `clawsweeper_item` work. Re-review commands take the
direct durable command-intake route described above. The durable Worker queue
dispatches at most 80 leased exact-review executors, with up to 64 active
reviews per target repository. Keep the Actions
dispatcher installed as an independent reliability route; it enqueues through
[direct queue intake](#direct-queue-intake). Only unmigrated dispatchers use the legacy relay.

For a local receiver, run `pnpm run build:repair` followed by
`pnpm run repair:comment-webhook`. It preserves the same signed review-command
admission boundary as the hosted webhook.
The Node listener limits raw request bodies to 2 MiB before signature validation.
Declared-length and chunked deliveries are supported; oversized bodies receive
HTTP 400 and a closed connection.


The receiver keeps the review lane proposal-only, then runs exact apply for the
selected item with only immediate-safe close reasons enabled:
`implemented_on_main` and `duplicate_or_superseded`. Normal scheduled apply
still handles the broader backlog, with `stale_insufficient_info` and
`mostly_implemented_on_main` blocked until the item is at least 60 days old;
stale-insufficient-info issues also require 60 days without a non-bot comment.

## Cross-route exact-review identity

The direct GitHub App webhook and this keyless dispatcher are independent
reliability routes. Do not disable either one. For pull requests, the template
above emits an opaque SHA-256 fingerprint of the immutable event snapshot
(repository, number, action, head SHA, update timestamp, body, and label). The
ClawSweeper durable queue coalesces only the matching fingerprint and resolved
target branch when it has seen it from the other route. A target default-branch
change therefore does not cross-route-coalesce. It also cannot let an unverified
fallback replace an already verified direct source decision; that fallback is
recorded as stale source. If the fallback arrives first, the later verified
direct decision promotes that same queue item instead of creating another one.
A route with no valid fingerprint remains admissible when no verified direct
decision exists, so a legacy-only delivery stays a safe fallback. The durable
receipt remains after a completed review, so a delayed matching counterpart is
also suppressed rather than recreating the completed review. A fallback that
the queue rejects as stale is not an admission receipt, so it cannot suppress
the later verified direct event.

Comment review commands share the existing `command-<comment-id>-<timestamp>-<body-digest>`
identity from `directReReviewIntake`, regardless of transport. The queue coalesces
OIDC/App counterparts before acknowledgements and after completion. An edit or
changed digest creates a new version. Other commands carry the live update timestamp
and body digest with `comment_event_auth: github_webhook_v1` to the existing router
ledger; router coalescing and marker-based acknowledgement convergence remain the
owners of that path, rather than a second Worker receipt table.

Before enabling this protocol for a target repository, roll out the dispatcher
and verify direct-only, legacy-only, cross-route duplicate, later body/revision,
and maintainer-command cases. The hash is an opaque queue receipt, not a
head-SHA dedupe key; body and metadata updates therefore produce a new event
identity.

`openclaw/clawhub` dispatches are intentionally skipped while the receiver
variable `CLAWSWEEPER_ENABLE_CLAWHUB` is not `1`. Enable it only after the
ClawSweeper GitHub App is installed on `openclaw/clawhub`; otherwise the
receiver cannot mint the target read/write tokens.

The event job creates only a target read token before Codex runs. The target
write token and the repository push token are introduced after Codex exits, and
the same `apply-decisions` guard path still re-fetches the item before any
comment or close mutation.

## Rate-limit-safe CI setup

Install one dispatcher workflow per target repository. Keep the event fanout
inside that workflow; do not add separate comment, spam, or generic-activity
dispatch workflows in the target repository.

The full dispatcher example above is the copy-pasteable job definition and the
canonical reference for its rate-limit behavior.

The job requests only a short-lived OIDC token for the Worker audience.
Ordinary comments consume no OIDC request or GitHub token. The env-quoted command
prefilter remains an ingress guard; the live Worker classifier and router are
authoritative. Do not use a PAT or add another comment dispatcher.

To verify a migrated target, confirm one `ClawSweeper Dispatch` run with
`Queued ClawSweeper intake directly`, no relay workflow run for the item, and one
canonical command acknowledgement/review when both routes deliver. An ordinary
comment should produce no command POST. Exercise a Worker rejection (`401`/`403`) and
verify warning plus successful workflow exit while the App route still admits the
event, and a timeout (`408`), throttling (`429`), or verifier/Worker outage (`503`)
and verify a failed, re-runnable run.

### Rollout checklist (separate operation)

1. Deploy the compatible Worker after approval, then verify all three App event
   subscriptions and signed deliveries on each installation.
2. Inventory the 83 copies and the separate `openclaw/openclaw` variant; preserve
   repository-specific triggers/concurrency while using the canonical filename.
3. Remove every ClawSweeper secret reference, token action, reusable admission
   secret handoff, target ack shell step, and relay fallback. Grant only the two
   documented permissions and send comment locators through OIDC.
4. For `openclaw/openclaw`, apply the same keyless item/comment POSTs and Worker
   ownership; retain unrelated activity routing only under its own authorization.
5. Canary direct-only, App-only, duplicate, edited command, ordinary comment,
   non-default-base PR, and failure-warning scenarios. Do not disable either route.
6. Migrate remaining copies, verify acknowledgements converge, and remove target
   access to the org App-key secret after checking all consumers. Keep the central
   Worker App credential. Retire legacy receivers only after every copy is migrated.

The ClawSweeper `github-activity` workflow runs the fact-only spam admission
in-process and dispatches the scanner only for an admitted comment (an
unprotected author with a body of at least 12 characters, a link, or a GitHub
minimization). Protected authors stay at one activity run. Preserve the source delivery or
comment id in every payload so receiver-side deduplication can collapse
redeliveries.
