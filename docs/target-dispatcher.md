# Target Repository Dispatcher

`openclaw/clawsweeper` cannot receive native `issues` or `pull_request` events
from sibling repositories directly. Target repositories should forward those
events with `repository_dispatch` so ClawSweeper can run a single-job exact
one-item review, sync the durable review comment, and immediately apply a safe
close proposal for that same item.

This document covers issue and PR item dispatch. Commit review dispatch is
documented separately in [commit-dispatcher.md](commit-dispatcher.md). A target
repository can keep the two lanes in separate workflow files or combine them in
one `.github/workflows/clawsweeper-dispatch.yml`; `openclaw/openclaw` uses the
combined form.

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
issues stay open, and PRs can auto-close only when already implemented on
`main`. Add a config entry only when the repo should appear in the dashboard or
needs repo-specific review guidance.

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
  dispatch:
    runs-on: ubuntu-latest
    if: ${{ !(endsWith(github.actor, '[bot]') && (github.event.action == 'labeled' || github.event.action == 'unlabeled')) }}
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
          if grep -Eiq '(^|[[:space:]])@(clawsweeper|openclaw-clawsweeper)\b(\[bot\])?|(^|[[:space:]])/(clawsweeper|review|autoclose|auto([[:space:]]+|-)?merge)\b' <<< "$COMMENT_BODY"; then
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

      - name: Dispatch exact ClawSweeper review
        if: ${{ github.event_name != 'issue_comment' }}
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          ITEM_NUMBER: ${{ github.event.issue.number || github.event.pull_request.number }}
          ITEM_KIND: ${{ github.event_name == 'pull_request_target' && 'pull_request' || 'issue' }}
          SOURCE_EVENT: ${{ github.event_name }}
          SOURCE_ACTION: ${{ github.event.action }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "::notice::Skipping ClawSweeper dispatch because no dispatch credential is configured."
            exit 0
          fi
          payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --argjson item_number "$ITEM_NUMBER" \
            --arg item_kind "$ITEM_KIND" \
            --arg source_event "$SOURCE_EVENT" \
            --arg source_action "$SOURCE_ACTION" \
            --argjson supersedes_in_progress "$SUPERSEDES_IN_PROGRESS" \
            '{event_type:"clawsweeper_item",client_payload:{target_repo:$target_repo,item_number:$item_number,item_kind:$item_kind,source_event:$source_event,source_action:$source_action,supersedes_in_progress:$supersedes_in_progress}}')"
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

Comments are a lightweight trigger only when the body contains a ClawSweeper
command, and generated proof-nudge comments are explicitly ignored before command
matching. The target workflow reacts with `eyes` and creates one visible queued
status comment for maintainer-authored commands when target write permission is
available, but both acknowledgement writes are best-effort. It must still dispatch
`clawsweeper_comment` to the comment router when acknowledgement or queued-comment
creation gets a target-repository 403. The dispatch carries the exact source
comment id and, when available, the queued status comment id. The router edits
that queued comment in place instead of posting a second reply.
Exact comment dispatches scan only that comment and use a per-comment receiver
concurrency group, so one maintainer command does not wait behind an unrelated
command on the same repository. The scheduled sweep remains a five-minute
fallback. Bot-authored label churn is also ignored. Human
Label changes never directly trigger an exact review. Content-changing events
such as issue edits and PR synchronizes update the desired review revision. The
receiver coalesces by repository and item number, then dispatches only a leased
executor for the newest revision.

For sub-5s acknowledgement, use the GitHub App webhook receiver instead of
waiting for GitHub Actions to start the target dispatcher. The hosted Worker
endpoint is `/github/webhook`; the local equivalent is
`pnpm run build:repair && pnpm run repair:comment-webhook`. It verifies
`CLAWSWEEPER_WEBHOOK_SECRET`, accepts eligible public `openclaw/*` and
`steipete/*` `issue_comment`, `issues`, and `pull_request` events, mints a
target installation token for acknowledgement/comment reactions, mints the
`openclaw/clawsweeper` installation token for repository dispatch, and queues
exact `clawsweeper_comment` or `clawsweeper_item` work. The durable Worker
queue dispatches at most 64 leased exact-review executors, with up to 60 active
reviews per target repository. Keep the Actions
dispatcher installed as a compatibility fallback; its legacy dispatch is
bridged into the same queue before Codex starts.

The receiver keeps the review lane proposal-only, then runs exact apply for the
selected item with only immediate-safe close reasons enabled:
`implemented_on_main` and `duplicate_or_superseded`. Normal scheduled apply
still handles the broader backlog, with `stale_insufficient_info` and
`mostly_implemented_on_main` blocked until the item is at least 60 days old;
stale-insufficient-info issues also require 60 days without a non-bot comment.

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

The full dispatcher example above is the copy-pasteable job definition. Its
important rate-limit properties are:

```yaml
name: ClawSweeper Dispatch

on:
  issues:
    types: [opened, reopened, edited, labeled, unlabeled]
  issue_comment:
    types: [created, edited]
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review, edited, labeled, unlabeled]

permissions:
  contents: read

concurrency:
  group: clawsweeper-dispatch-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event.action == 'edited' || github.event.action == 'synchronize' || github.event.action == 'ready_for_review' }}
```

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
