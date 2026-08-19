# Durable command intake behavior contract

## User-visible goal

An eligible `@clawsweeper re-review` comment becomes durable before ClawSweeper
acknowledges or dispatches it. Target GitHub App throttling may delay processing,
but it must neither lose the command nor enqueue the same comment version twice.

## Target

- Type: Cloudflare Worker HTTP API and ExactReviewQueue Durable Object.
- Launch: `wrangler dev --local` from both the pinned main baseline and candidate.
- Fixtures: a signed pull-request `issue_comment` webhook and a loopback GitHub
  API that accepts acknowledgement writes but throttles the old Actions dispatch
  path and the candidate's deferred source verification.

## User tasks

1. Submit the same eligible re-review webhook to the main baseline.
2. Submit it to the candidate Worker.
3. Stop the complete Worker process group after each boot and inspect its local
   Durable Object SQLite state.

## Expected observable behavior

- Baseline: the optimistic acknowledgement can be created before the throttled
  repository dispatch fails, and no durable command-intake row exists.
- Candidate: the webhook returns HTTP 202 without first writing an optimistic
  acknowledgement; all four command tables exist and the throttled command
  remains pending for retry.
- Redelivery of the same version resolves through its existing receipt.

## Anti-cheat probes

- Use a real loopback HTTP listener through `GITHUB_API_URL`, not an in-process
  fetch stub.
- Boot a real local Worker twice with separate persistence roots.
- Kill the full process group between boots so no Worker or alarm state leaks
  from baseline to candidate.
- Assert the ExactReviewQueue Durable Object was instantiated by finding its
  command-intake SQLite schema and pending receipt.

## Evidence required

- Baseline and candidate commit SHAs, HTTP results, loopback request counts,
  process-group termination results, SQLite table inventory, and receipt state.
- Crabbox provider and lease id in the committed receipt.

## Out of scope

- Live GitHub credentials, production mutation, executor completion, and final
  public review publication.
