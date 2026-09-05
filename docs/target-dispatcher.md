# Target Repository Dispatcher

- Status: active integration reference
- Owner: ClawSweeper maintainers and target-repository maintainers
- Source of truth: the embedded dispatcher workflow, receiver workflow,
  repository profiles, and dispatcher tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: forwarded events, authentication, payloads, permissions, close
  authority, or installation steps change

`openclaw/clawsweeper` cannot receive native `issues` or `pull_request` events
from sibling repositories directly. Target repositories should forward those
events with `repository_dispatch` so ClawSweeper can run a single-job exact
one-item review, sync the durable review comment, and immediately apply a safe
close proposal for that same item.

This document covers issue and PR item dispatch via
`.github/workflows/clawsweeper-dispatch.yml`; `openclaw/openclaw` uses this
form. The separate commit-review dispatch lane was retired in July 2026.

General GitHub activity can also be forwarded to the OpenClaw-backed activity
ingest lane with `repository_dispatch` type `github_activity`. That lane does
not run ClawSweeper review/apply; it feeds compact activity to the agent, which
posts to `#clawsweeper` only when the event is surprising or actionable. See
[openclaw-event-hooks.md](openclaw-event-hooks.md#github-activity-stream).

For issue and PR dispatch, copy this workflow into each target repository as
`.github/workflows/clawsweeper-dispatch.yml`, or merge these triggers and the
`Dispatch exact ClawSweeper review` step into an existing combined dispatcher:

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

Before enabling the workflow:

1. Install the `clawsweeper` GitHub App on the target repository.
2. Add the App private key as the target repository Actions secret
   `CLAWSWEEPER_APP_PRIVATE_KEY`.
3. Install exactly one target dispatcher. Do not add separate comment, spam, and
   generic-activity dispatch workflows that forward the same event twice.
4. Keep the target write token limited to the comment acknowledgement path.
   Issue/PR review dispatch only needs the ClawSweeper installation token.

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
  group: clawsweeper-dispatch-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review' }}

jobs:
  hosted-target-admission:
    uses: openclaw/clawsweeper/.github/workflows/hosted-target-admission.yml@main
    with:
      target_repo: ${{ github.repository }}
    secrets:
      CLAWSWEEPER_APP_PRIVATE_KEY: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}

  reject-hosted-target:
    needs: hosted-target-admission
    if: ${{ always() && needs.hosted-target-admission.outputs.outcome != 'public' }}
    permissions: {}
    runs-on: ubuntu-latest
    steps:
      - name: Report hosted target admission
        env:
          ADMISSION_OUTCOME: ${{ needs.hosted-target-admission.outputs.outcome }}
        run: |
          set -euo pipefail
          if [ "$ADMISSION_OUTCOME" = "terminal" ]; then
            echo "::notice title=ClawSweeper hosted target admission::This repository is not eligible for hosted review. A maintainer can run the review locally."
          else
            echo "::warning title=ClawSweeper hosted target admission::Repository eligibility or public visibility could not be verified. Retry the workflow later."
          fi

  dispatch:
    needs: hosted-target-admission
    runs-on: ubuntu-latest
    if: ${{ needs.hosted-target-admission.outputs.outcome == 'public' && !(endsWith(github.actor, '[bot]') && (github.event.action == 'labeled' || github.event.action == 'unlabeled')) }}
    env:
      HAS_CLAWSWEEPER_APP_PRIVATE_KEY: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY != '' }}
      CLAWSWEEPER_APP_CLIENT_ID: Iv23liOECG0slfuhz093
      SUPERSEDES_IN_PROGRESS: ${{ (github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review') && 'true' || 'false' }}
    steps:
      - name: Debounce bursty metadata events
        if: ${{ github.event.action == 'labeled' || github.event.action == 'unlabeled' }}
        run: sleep 20

      - name: Create ClawSweeper dispatch token
        id: token
        if: ${{ env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true' }}
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
          owner: openclaw
          repositories: clawsweeper
          permission-contents: write

      - name: Pre-filter ClawSweeper comment
        id: comment_filter
        if: ${{ github.event_name == 'issue_comment' }}
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          if grep -Eiq '(^|[[:space:]])@(clawsweeper|openclaw-clawsweeper)\b(\[bot\])?|(^|[[:space:]])/(clawsweeper|review|re-review|rerun([[:space:]]+|-)?review|status|explain|fix|build|implement|create([[:space:]]+|-)?pr|fix([[:space:]]+|-)?issue|autofix|auto([[:space:]]+|-)?fix|automerge|auto([[:space:]]+|-)?merge|approve|stop|autoclose)\b' <<< "$COMMENT_BODY"; then
            echo "is_command=true" >> "$GITHUB_OUTPUT"
          else
            echo "is_command=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Create target comment token
        id: target_token
        if: >-
          ${{
            github.event_name == 'issue_comment' &&
            steps.comment_filter.outputs.is_command == 'true' &&
            env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true'
          }}
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          permission-issues: write
          permission-pull-requests: read

      - name: Create target PR acknowledgement token
        id: pr_ack_token
        if: >-
          ${{
            github.event_name == 'pull_request_target' &&
            env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true'
          }}
        continue-on-error: true
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          permission-issues: write

      - name: Acknowledge received pull request
        id: pr_acknowledgement
        if: >-
          ${{
            github.event_name == 'pull_request_target' &&
            env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true'
          }}
        continue-on-error: true
        env:
          ACK_TOKEN: ${{ steps.pr_ack_token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          ITEM_NUMBER: ${{ github.event.pull_request.number }}
          SOURCE_ACTION: ${{ github.event.action }}
        run: |
          set -euo pipefail
          if [ -z "$ACK_TOKEN" ]; then
            echo "::notice::Skipping ClawSweeper pull request acknowledgement because no target credential is configured."
            exit 0
          fi
          list_ack_comments() {
            local comments='[]' batch page
            for ((page = 1; page <= 10; page++)); do
              batch="$(gh api "repos/$TARGET_REPO/issues/$ITEM_NUMBER/comments?per_page=100&page=$page")" || return 1
              jq -e 'type == "array"' <<< "$batch" >/dev/null || return 1
              comments="$(printf '%s\n' "$comments" "$batch" | jq -s 'add')" || return 1
              if [ "$(jq 'length' <<< "$batch")" -lt 100 ]; then
                printf '%s\n' "$comments"
                return 0
              fi
            done
            echo "::notice::Acknowledgement lookup reached its 10-page limit; leaving existing comments untouched." >&2
            return 1
          }
          ack_comment_id() {
            jq -r \
              --arg marker_prefix "clawsweeper-pr-ack:" \
              --arg marker_suffix " item=$ITEM_NUMBER -->" \
              '[.[] | ((.user.login // "") | ascii_downcase) as $login | select(
                (["clawsweeper", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"] | index($login)) and
                ((.body // "") | contains($marker_prefix)) and
                ((.body // "") | contains($marker_suffix))
              )] as $matches |
              ([$matches[] | select(
                ((.body // "") | contains("clawsweeper-command-status:")) or
                ((.body // "") | contains("<!-- clawsweeper-command-progress:start -->")) or
                ((.body // "") | contains("<!-- clawsweeper-review-progress:start -->"))
              )] | sort_by(.updated_at // .created_at, .id) | last) //
              ($matches | sort_by(.created_at, .id) | first) | .id // empty' <<< "$1"
          }
          comments="$(GH_TOKEN="$ACK_TOKEN" list_ack_comments)"
          status_comment_id="$(ack_comment_id "$comments")"
          if [ -n "$status_comment_id" ]; then
            echo "status_comment_id=$status_comment_id" >> "$GITHUB_OUTPUT"
            echo "ClawSweeper pull request acknowledgement already exists."
            exit 0
          fi
          if [ "$SOURCE_ACTION" != "ready_for_review" ] &&
            { [ "$SOURCE_ACTION" != "opened" ] || [ "${{ github.event.pull_request.draft }}" != "false" ]; }; then
            echo "::notice::No existing ClawSweeper pull request acknowledgement is available for this event."
            exit 0
          fi
          # opened and ready_for_review can fire seconds apart for the same
          # pull request, and both runs can list comments before either
          # acknowledgement is visible. Wait, then recheck right before
          # posting; a superseding run cancels this one while it sleeps.
          sleep 15
          comments="$(GH_TOKEN="$ACK_TOKEN" list_ack_comments)"
          status_comment_id="$(ack_comment_id "$comments")"
          if [ -n "$status_comment_id" ]; then
            echo "status_comment_id=$status_comment_id" >> "$GITHUB_OUTPUT"
            echo "ClawSweeper pull request acknowledgement already exists."
            exit 0
          fi
          ack_body="$(printf '%s\n' \
            "<!-- clawsweeper-pr-ack:$SOURCE_ACTION item=$ITEM_NUMBER -->" \
            "🦞👀" \
            "ClawSweeper picked this up." \
            "" \
            "Pull request received. I will update this pull request when review starts.")"
          ack_payload="$(jq -nc --arg body "$ack_body" '{body:$body}')"
          ack_response="$(GH_TOKEN="$ACK_TOKEN" gh api \
            "repos/$TARGET_REPO/issues/$ITEM_NUMBER/comments" \
            --method POST \
            --input - <<< "$ack_payload")"
          status_comment_id="$(jq -r '.id // empty' <<< "$ack_response")"
          test "$status_comment_id" -gt 0
          echo "status_comment_id=$status_comment_id" >> "$GITHUB_OUTPUT"

      - name: Dispatch exact ClawSweeper review
        if: ${{ github.event_name != 'issue_comment' }}
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          TARGET_BRANCH: ${{ github.event.repository.default_branch }}
          ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
          ITEM_KIND: ${{ github.event_name == 'pull_request_target' && 'pull_request' || 'issue' }}
          SOURCE_EVENT: ${{ github.event_name }}
          SOURCE_ACTION: ${{ github.event.action }}
          REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: ${{ steps.pr_acknowledgement.outputs.status_comment_id }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "::notice::Skipping ClawSweeper dispatch because no dispatch credential is configured."
            exit 0
          fi
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
          const reviewAcknowledgementCommentId = Number(
            process.env.REVIEW_ACKNOWLEDGEMENT_COMMENT_ID,
          );
          if (Number.isSafeInteger(reviewAcknowledgementCommentId) && reviewAcknowledgementCommentId > 0) {
            queueClaim.review_acknowledgement_comment_id = reviewAcknowledgementCommentId;
          }
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
                      "clawsweeper:automerge",
                      "clawsweeper:autofix",
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
          payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --arg target_branch "$TARGET_BRANCH" \
            --argjson item_number "$ITEM_NUMBER" \
            --arg item_kind "$ITEM_KIND" \
            --arg source_event "$SOURCE_EVENT" \
            --arg source_action "$SOURCE_ACTION" \
            --argjson source_identity "$source_identity_json" \
            --argjson supersedes_in_progress "$SUPERSEDES_IN_PROGRESS" \
            '{event_type:"clawsweeper_item",client_payload:({target_repo:$target_repo,target_branch:$target_branch,item_number:$item_number,item_kind:$item_kind,source_event:$source_event,source_action:$source_action,supersedes_in_progress:$supersedes_in_progress} + $source_identity)}')"
          gh api repos/openclaw/clawsweeper/dispatches \
            --method POST \
            --input - <<< "$payload"

      - name: Acknowledge and dispatch ClawSweeper comment
        if: >-
          ${{
            github.event_name == 'issue_comment' &&
            steps.comment_filter.outputs.is_command == 'true'
          }}
        env:
          DISPATCH_TOKEN: ${{ steps.token.outputs.token }}
          TARGET_TOKEN: ${{ steps.target_token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          ITEM_NUMBER: ${{ github.event.issue.number }}
          COMMENT_ID: ${{ github.event.comment.id }}
          COMMENT_BODY: ${{ github.event.comment.body }}
          AUTHOR_ASSOCIATION: ${{ github.event.comment.author_association }}
          SOURCE_ACTION: ${{ github.event.action }}
        run: |
          if [ -z "$DISPATCH_TOKEN" ]; then
            echo "::notice::Skipping ClawSweeper dispatch because no dispatch credential is configured."
            exit 0
          fi
          body_file="$RUNNER_TEMP/clawsweeper-comment-body.txt"
          printf '%s\n' "$COMMENT_BODY" > "$body_file"
          if grep -Eiq '<!--[[:space:]]*clawsweeper-proof-nudge([[:space:]]|-->)' "$body_file"; then
            echo "Ignoring ClawSweeper proof-nudge comment."
            exit 0
          fi
          if [ -n "$TARGET_TOKEN" ]; then
            GH_TOKEN="$TARGET_TOKEN" gh api -X POST \
              -H "Accept: application/vnd.github+json" \
              "repos/$TARGET_REPO/issues/comments/$COMMENT_ID/reactions" \
              -f content="eyes" >/dev/null || true
          fi
          status_comment_id=""
          if [ -n "$TARGET_TOKEN" ]; then
            case "$AUTHOR_ASSOCIATION" in
              OWNER|MEMBER|COLLABORATOR)
                status_body="$(printf '%s\n' \
                  "<!-- clawsweeper-command-ack:$COMMENT_ID -->" \
                  "🦞👀" \
                  "ClawSweeper picked this up." \
                  "" \
                  "Command router queued. I will update this comment with the next step.")"
                status_payload="$(jq -nc --arg body "$status_body" '{body:$body}')"
                status_err="$(mktemp)"
                if status_response="$(GH_TOKEN="$TARGET_TOKEN" gh api \
                  "repos/$TARGET_REPO/issues/$ITEM_NUMBER/comments" \
                  --method POST \
                  --input - <<< "$status_payload" 2>"$status_err")"; then
                  status_comment_id="$(jq -r '.id // empty' <<< "$status_response")"
                else
                  cat "$status_err" >&2
                  echo "::warning::Could not create ClawSweeper queued status comment; dispatching command router without one."
                fi
                rm -f "$status_err"
                ;;
            esac
          fi
          payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --argjson item_number "$ITEM_NUMBER" \
            --argjson comment_id "$COMMENT_ID" \
            --arg status_comment_id "$status_comment_id" \
            --arg source_event "issue_comment" \
            --arg source_action "$SOURCE_ACTION" \
            '{event_type:"clawsweeper_comment",client_payload:({target_repo:$target_repo,item_number:$item_number,comment_id:$comment_id,source_event:$source_event,source_action:$source_action,max_comments:"1"} + (if $status_comment_id != "" then {status_comment_id:($status_comment_id|tonumber)} else {} end))}')"
          GH_TOKEN="$DISPATCH_TOKEN" gh api repos/openclaw/clawsweeper/dispatches \
            --method POST \
            --input - <<< "$payload"
```

`target_branch` is branch authority from the signed event repository payload,
not a guess. Carrying it lets legacy intake enqueue without an extra GitHub API
read. During a rolling upgrade, a branchless legacy payload is held in the
durable control plane until the target App resolves and validates the repository
default branch; it is never silently rewritten to `main`.

Non-draft pull request receipts get one best-effort `clawsweeper-pr-ack`
comment. Later pull-request events recover that exact trusted bot comment id and
carry it with the durable review decision, so a terminal input refusal can edit
the receipt in place instead of posting one comment per attempt. `opened` and
`ready_for_review` can fire seconds apart when a draft is
marked ready immediately after creation, and both runs can list comments before
either acknowledgement is visible. The acknowledgement step therefore matches
any existing trusted-bot `clawsweeper-pr-ack` marker for the item, then waits and rechecks
right before posting; when a superseding event arrives during that wait, the
shared concurrency group cancels the sleeping run before it posts.

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

Other commands retain the comment-router path. The target workflow reacts with
`eyes` and creates one visible queued status comment for maintainer-authored
commands when target write permission is available, but both acknowledgement
writes are best-effort. It must still dispatch `clawsweeper_comment` to the
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

For sub-5s acknowledgement, use the GitHub App webhook receiver instead of
waiting for GitHub Actions to start the target dispatcher. The hosted Worker
endpoint is `/github/webhook`; the local equivalent is
the `build:repair` package script followed by `repair:comment-webhook`. It verifies
`CLAWSWEEPER_WEBHOOK_SECRET`, accepts `issue_comment`, `issues`, and
`pull_request` events for explicitly configured public repositories plus the
eligible `openclaw/*` and `steipete/*` fallbacks, mints a target installation
token for acknowledgement/comment reactions, mints the `openclaw/clawsweeper`
installation token for repository dispatch, and queues exact
`clawsweeper_comment` or `clawsweeper_item` work. Re-review commands take the
direct durable command-intake route described above. The durable Worker queue
dispatches at most 32 leased exact-review executors, with up to 24 active
reviews per target repository. Keep the Actions
dispatcher installed as a compatibility fallback; its legacy dispatch is
bridged into the same queue before Codex starts.

The standalone Node listener limits raw request bodies to 2 MiB before verifying
their signature. Declared-length and chunked deliveries are supported. Oversized
bodies receive HTTP 400 and a closed connection; Node owns HTTP framing and
connection teardown.

The receiver keeps the review lane proposal-only, then runs exact apply for the
selected item with only immediate-safe close reasons enabled:
`implemented_on_main` and `duplicate_or_superseded`. Normal scheduled apply
still handles the broader backlog, with `stale_insufficient_info` and
`mostly_implemented_on_main` blocked until the item is at least 60 days old;
stale-insufficient-info issues also require 60 days without a non-bot comment.

## Cross-route exact-review identity

The direct GitHub App webhook and this compatibility dispatcher are independent
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

The job mints one short-lived `clawsweeper` App token scoped to
`openclaw/clawsweeper`, then sends one `clawsweeper_item` or
`clawsweeper_comment` `repository_dispatch`. For comments, the
`Pre-filter ClawSweeper comment` step runs before the target write token is
minted, so ordinary comments consume neither a target installation token nor a
dispatch. The prefilter is only an ingress guard: `/clawsweeper` may carry any
supported subcommand, while `/review`, `/autoclose`, and `/auto-merge` (with
spaces or tabs allowed between `auto` and `merge`) are the standalone aliases.
The router remains authoritative. Do not use a PAT or dispatch the same comment
through both the exact router and a second spam/generic workflow.

To verify a target installation, open a pull request or issue and confirm one
`ClawSweeper Dispatch` run. Add a maintainer comment containing `@clawsweeper`
or a supported slash command and confirm one `clawsweeper_comment` dispatch.
An ordinary comment should produce no ClawSweeper comment dispatch and no
target-token step. If the target app secret is absent, the workflow should
finish with a notice rather than fall back to a maintainer PAT.

The ClawSweeper `github-activity` workflow performs spam-candidate
classification in-process and only dispatches the scanner for an accepted
candidate. This keeps ordinary comments to one activity run instead of an
activity run plus a second intake workflow. Preserve the source delivery or
comment id in every payload so receiver-side deduplication can collapse
redeliveries.
