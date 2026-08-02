# CSW-099 Workstream 6 proof contract

## Claim

Only a caller that holds the established `EXACT_REVIEW_OPERATOR_SECRET` can
read the redacted, paginated lifecycle audit inventory. The inventory is a
short-lived frozen snapshot of reducer-derived lifecycle facts; it is not a
public Bay API and it never derives `Completed` from workflow activity.

## Exercised surface

- Admin Worker route: `POST /internal/exact-review/lifecycle-audit/inventory`
- Durable Object route: `POST /lifecycle-audit/inventory`
- Public Bay page: `/bay-demo`, to prove it does not call the admin route

## Controlled scenario

The focused Worker/DO test seeds synthetic durable lifecycle rows, verifies
operator HMAC authentication, captures a two-record page, changes the live
projection, then reads the next page from the frozen snapshot. It also proves
redaction, invalid-page rejection, and stale-snapshot fail-closed behavior.

The Linux proof starts the real local Wrangler Worker with only a disposable
operator secret. It initializes the disposable DO through an existing public
aggregate read, posts a correctly signed empty inventory request, rejects a
shared-secret signature, and confirms that the public guessed API path is not
available. Playwright then loads the built Bay page and confirms it makes no
request to the admin inventory route.

## Contract

- Request: signed `POST` body `{ "page_size": 1..100, "cursor"?: "<uuid>.<offset>" }`.
- First page creates a snapshot from at most `10,000 + 1` source rows. More
  than 10,000 rows returns `Unknown/over_cap`, never a partial inventory.
- At most four snapshots may exist, each for five minutes. A late cursor returns
  `Unknown/stale`; expired snapshot rows are deleted when the next snapshot is
  created. A metadata-only tombstone lasts one further five-minute window solely
  to preserve that stale result, then is removed.
- Records expose the reducer card fields only: target/revision, reducer state
  and lane, coarse durable facts, timestamps, and fixed provenance. They never
  expose fence, delivery, status-marker, comment, receipt, run, claim, or
  digest identifiers.
- Source unavailability, malformed rows, mixed rows, over-cap input, or an
  expired snapshot returns an all-null `Unknown` envelope. `Completed` remains
  solely the existing reducer result.

## Limits

This is controlled local Worker/DO and browser evidence. It uses synthetic
tests and an empty disposable local Worker snapshot; it does not access a
production secret, lifecycle record, queue, R2 object, deployment, workflow,
gate, or GitHub API.
