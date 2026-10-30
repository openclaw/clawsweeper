# Keyless target dispatcher behavior proof

- Status: historical local proof
- Owner: ClawSweeper maintainers
- Source of truth: the named Worker, queue, workflow, and executable fixtures
- Update when: intake claims, routing, acknowledgements, or the fixtures change

## Contract and environment

Claim: a keyless target workflow can submit a command locator through OIDC;
the Worker derives command authority from live GitHub data, shares the App
webhook handler, and coalesces review commands across both routes before the
queue acknowledges and admits one verified item.

Provider: local Node Worker harness on macOS; Node v26.12.0, pnpm 12.4.1.
No remote lease or container image was used. This is not the Windows host.
The repository's existing harness runs the actual Worker request handler,
ExactReviewQueue, alarm, and SQLite store. HTTP GitHub responses come from a
loopback server; RS256 test keys are generated in memory, and GitHub's JWKS
fetch returns the local test public key. No live GitHub credentials or network
writes are used. Hosted eligibility is a controlled harness predicate; the
Worker's visibility probe reads the stub GitHub repository API.
The non-review addendum runs the compiled production comment router and its
runner in isolated temporary state, using a loopback-only `gh` transport shim.
The shim translates the router's reads and label/comment operations into the
stub API; authorization, classification, execution, and ledger decisions remain
in the actual router.

Base HEAD: `ea6d72efc0a2e2c0683ad984b060b5c22008ce57` (the source hashes below bind the uncommitted candidate).

## Reproduction

With Node >=24 and the pinned package manager on PATH:

```sh
pnpm install
pnpm run build:node
node --test test/dashboard-target-dispatch-ingress.test.ts test/dashboard-worker-command-intake.test.ts test/target-dispatcher-workflow.test.ts
```

For the individual end-to-end proof:

```sh
node --test --test-name-pattern='keyless OIDC' test/dashboard-worker-command-intake.test.ts
```

## Observed result

The focused run passed 24 tests, with zero failures, cancellations, or skips.
The executable shell fixture submits item and comment payloads to a loopback
HTTP intake; 401, 503, redirects, failed token acquisition, missing OIDC, and
connection refusal all warn and exit zero without any `gh` dispatch.
The old committed template fails the new keyless assertion: it contains both
`secrets.` references and `create-github-app-token` steps.

The Worker proof rejected a wrong repository, workflow filename, branch ref,
event name, item binding, and payload-provided association/body/author. It
read the live comment before admitting a review, performed no optimistic ack,
and coalesced the matching App delivery. The queue alarm verified the comment
and PR head, admitted one item, and wrote one status comment and one eyes reaction.
It also coalesced an App-first edited command with the same timestamp and a
changed body digest. The non-review command reused the existing acknowledgement
and router path; an ordinary or unauthorized live comment did not dispatch.
A simulated acknowledgement 403 still dispatched the router without a status ID.

The hosted review identified that capturing a non-review dispatch alone did not
prove authorization at asynchronous execution. The added proof takes the actual
OIDC-produced `@clawsweeper stop` payload into the production router. A non-author
COLLABORATOR with live `write` permission removes `clawsweeper:automerge` and
`clawsweeper:autofix`, then adds `clawsweeper:human-review`. Delivering the matching
App webhook and running its router payload again produces no further label
writes. For a new comment version admitted while the collaborator is authorized,
the fixture revokes permission to `read` before starting the router. Both delayed
delivery and retry perform a fresh permission read, classify the command as
`ignored`, and leave the repair labels unchanged. This closes the requested
authorization-chain evidence gap without changing authorization policy.

Normalized output:

```json
{"proof":"keyless-comment-intake","oidc":"locally signed RS256 + test JWKS","liveCommentReads":16,"crossRouteDeduped":true,"verifiedQueueItem":"openclaw/openclaw#42","reviewAcknowledgements":1,"reviewReactions":1,"authority":"live GitHub comment","schemaChanges":false,"routerAllowedStop":"labels removed and human-review added","routerAllowedReplay":"coalesced","routerRevokedNonAuthor":"delayed delivery and retry ignored; zero label writes"}
```

Full local output: `.artifacts/keyless-target-dispatcher/focused-addendum.log` (ignored).
The source fixture and normalized output above are the portable evidence.

## Limits

This proves the actual local Worker/queue paths, not GitHub's token minting,
Cloudflare deployment, production subscriptions, or the 83 installed target
copies. External GitHub APIs, the CLI transport, and JWKS are controlled fixtures.
Non-review cross-route dedupe remains owned by the existing router ledger and is
exercised through the actual local router. This does not run GitHub Actions or
prove a permission change during one already-running router process; the
revocation scenario covers the Worker-to-router delay and separate retry jobs.
No workflow, target repository, live queue, or deployment was changed.

## Source hashes

- `dashboard/worker.ts`: `8f28543323b4e0815cff071917f73602ca8b119432c92f56ee4b739a4dbc8008`
- `dashboard/target-dispatch-ingress.ts`: `99fa8bd1181d56da81fa082a07a674a446688dd1ebfbe580b97dc4a51d338e2f`
- `.github/workflows/clawsweeper-dispatch.yml`: `dced71b9a5c0ce39933b7f35c348e30d17f299d321075bb39fba50f3883f2318`
- `test/dashboard-worker-command-intake.test.ts`: `b7303347f8c4484b7051bcb936d0bab5a9bb3b3860f712d4e1b4899981f10c11`
- `test/helpers/keyless-comment-router.ts`: `2211eccf648edf94e4391378cf5cc05daf36fb28e73f10c0a283d164a61c274a`
