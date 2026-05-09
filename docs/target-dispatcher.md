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
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
          owner: openclaw
          repositories: clawsweeper
          permission-contents: write

      - name: Create target comment token
        id: target_token
        if: ${{ github.event_name == 'issue_comment' && env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
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
        if: ${{ github.event_name == 'issue_comment' }}
        env:
          DISPATCH_TOKEN: ${{ steps.token.outputs.token }}
          TARGET_TOKEN: ${{ steps.target_token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          ITEM_NUMBER: ${{ github.event.issue.number }}
          COMMENT_ID: ${{ github.event.comment.id }}
          COMMENT_BODY: ${{ github.event.comment.body }}
          SOURCE_ACTION: ${{ github.event.action }}
        run: |
          if [ -z "$DISPATCH_TOKEN" ]; then
            echo "::notice::Skipping ClawSweeper dispatch because no dispatch credential is configured."
            exit 0
          fi
          body_file="$RUNNER_TEMP/clawsweeper-comment-body.txt"
          printf '%s\n' "$COMMENT_BODY" > "$body_file"
          if ! grep -Eiq '(^|[[:space:]])@clawsweeper\b|(^|[[:space:]])/(clawsweeper|review|re-review|rerun[ -]?review|status|explain|fix|build|implement|create[ -]?pr|fix[ -]?issue|autofix|auto[ -]?fix|automerge|auto[ -]?merge|approve|stop|autoclose)\b' "$body_file"; then
            echo "No ClawSweeper command found in comment."
            exit 0
          fi
          if [ -n "$TARGET_TOKEN" ]; then
            GH_TOKEN="$TARGET_TOKEN" gh api -X POST \
              -H "Accept: application/vnd.github+json" \
              "repos/$TARGET_REPO/issues/comments/$COMMENT_ID/reactions" \
              -f content="eyes" >/dev/null || true
          fi
          payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --argjson item_number "$ITEM_NUMBER" \
            --argjson comment_id "$COMMENT_ID" \
            --arg source_event "issue_comment" \
            --arg source_action "$SOURCE_ACTION" \
            '{event_type:"clawsweeper_comment",client_payload:{target_repo:$target_repo,item_number:$item_number,comment_id:$comment_id,source_event:$source_event,source_action:$source_action}}')"
          GH_TOKEN="$DISPATCH_TOKEN" gh api repos/openclaw/clawsweeper/dispatches \
            --method POST \
            --input - <<< "$payload"
```

Comments are a lightweight trigger only when the body contains a ClawSweeper
command. The target workflow reacts with `eyes` immediately and dispatches
`clawsweeper_comment` to the comment router with the exact comment id, so it
does not need to wait for the scheduled sweep. Bot-authored label churn is also
ignored. Human label changes are debounced and may run after an active
dispatcher, but they must not cancel a content-changing dispatch before it posts
to ClawSweeper. Content-changing events such as issue edits and PR synchronizes
cancel stale target-side dispatch jobs and mark their receiver dispatch as
superseding. On the receiver, event-item runs are keyed by repository and item
number and the newest event cancels any older receiver run for that same item,
because the review always fetches the current live item state.

The receiver keeps the review lane proposal-only, then runs exact apply for the
selected item with only immediate-safe close reasons enabled:
`implemented_on_main` and `duplicate_or_superseded`. Normal scheduled apply
still handles the broader backlog, with `stale_insufficient_info` and
`mostly_implemented_on_main` blocked until the item is at least 60 days old.

`openclaw/clawhub` dispatches are intentionally skipped while the receiver
variable `CLAWSWEEPER_ENABLE_CLAWHUB` is not `1`. Enable it only after the
ClawSweeper GitHub App is installed on `openclaw/clawhub`; otherwise the
receiver cannot mint the target read/write tokens.

The event job creates only a target read token before Codex runs. The target
write token and the repository push token are introduced after Codex exits, and
the same `apply-decisions` guard path still re-fetches the item before any
comment or close mutation.
