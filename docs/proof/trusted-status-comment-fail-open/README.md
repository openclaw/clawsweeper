# Trusted status comment fail-open proof contract

## Claim

A comment whose author cannot be read is **not** trusted as a ClawSweeper status
comment. Before this change the predicate returned `true` for an absent author, so
a comment ClawSweeper could not attribute was eligible to be adopted — read for
durable state, and edited in place.

Genuine ClawSweeper and configured trusted-bot authors are unaffected.

## Exercised surface

`isTrustedStatusCommentAuthor` in `dist/repair/comment-router-core.js`, the shared
comparator that now backs both consumers:

- `dist/repair/comment-router.js` (status-comment lookup, ack convergence)
- `dist/repair/execute-fix-artifact.js` (automerge and issue-implementation status)

Before this change each module carried its own private copy, and the two had
already drifted — one consulted the configurable `trustedBots` set, the other
hardcoded two bot logins.

## Controlled scenario and fixture

`run-proof.mjs` asserts three claims against the built `dist/`:

1. **Fails closed** — seven unreadable shapes (`user: null`, no `user` key, `user`
   without `login`, empty login, whitespace login, null comment, and the `ghost`
   login a deleted account is reattributed to) are all rejected.
2. **No loss** — six genuine author spellings are still trusted across casing and
   surrounding whitespace, and three untrusted logins stay rejected.
3. **Deduplicated** — the built output of both consumers is scanned: each must
   reference the shared comparator and must **not** contain the `return !author ||`
   fail-open shape. A private copy reintroduced later fails the proof.

### How the before/after contrast is measured

The pre-fix predicate was module-private, so it cannot be imported. It is also not
`eval`'d from source — that would put a code-injection pattern into a committed
script. Instead the proof:

1. reads the predicate's source text from the base commit;
2. asserts that text actually contains the `return !author ||` clause and the same
   author read;
3. runs an explicit reimplementation of it.

Step 2 is what makes step 3 trustworthy: the reimplementation is proven faithful to
the code that shipped, rather than assumed.

## Expected observation

25 checks, all PASS, exit 0, plus the measured contrast:

```
the predicate as it shipped at the base commit:
  function isTrustedStatusComment(comment: LooseRecord) {
    const author = String(comment.user?.login ?? "").toLowerCase();
    return !author || author === "clawsweeper" || trustedBots.has(author);
  }

  { user: null }  pre-fix: true   post-fix: false
```

## Artifact and command

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --artifact-glob '.artifacts/trusted-status-comment-proof/**' \
  --script docs/proof/trusted-status-comment-fail-open/run-proof.sh
```

Host-only quick check:

```bash
pnpm run build:node
git show 0588bda9:src/repair/comment-router.ts > /tmp/pre.ts
node docs/proof/trusted-status-comment-fail-open/run-proof.mjs /tmp/pre.ts
```

Focused tests:

```bash
node --test test/repair/comment-router-core.test.ts
```

## Provenance

- provider: Crabbox `local-container` (Docker/OrbStack)
- crabbox: `0.15.0`
- image: `node:24` @ `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
- container node: `v24.19.0` (satisfies `engines.node >= 24`)
- lease: `cbx_7a849d5a91ea` (`tidal-shrimp`)
- run: `run_691f050226af`
- artifact: `.crabbox/runs/run_691f050226af/run_691f050226af-artifacts.tgz`
- result: exit `0`; 25/25 proof checks PASS; focused suites `201/201`
- privacy: synthetic fixtures only. The proof makes no network call, contacts no
  GitHub API, and performs no queue, GitHub, or production mutation.

## Reachability — read this before rating severity

**I could not demonstrate a path where `user.login` is absent.** Every consumer
sources comments from `gh api /repos/{repo}/issues/{n}/comments` or
`/issues/comments/{id}` — full REST objects with no `--jq` projection dropping
`user`. No consumer uses `gh pr view --json comments`, which would supply `author`
instead. Deleted accounts are reattributed to `ghost`, a real login the guard
rejects on its own merits. No test constructs a comment without `user`.

The one remaining vector is GitHub's own contract: its OpenAPI schema types
`issue-comment.user` as nullable — which is precisely what the defensive
`comment.user?.login ?? ""` read in the shipped code was written for.

So this is a **latent fail-open default, not a demonstrated exploit**, and it should
be rated accordingly (P3). It is worth closing because the cost is one clause and
because "no author" can never be evidence of ClawSweeper authorship — not because
there is a live incident.

## Limits

Covers the trust predicate only. It does not change the marker, issue-number, or
ack checks that run after the guard, nor the configurable `trustedBots` set.

**Regression direction:** if an absent author *is* reachable for a genuine
ClawSweeper comment, failing closed means ClawSweeper stops recognising its own
status comment and posts a duplicate instead of editing it. That is visible but
harmless, and it needs the same unproven precondition as the defect.

Claim 3 scans built output for the `return !author ||` shape specifically; a
differently-spelled fail-open would not be caught by that regex.

No live GitHub comment is read, adopted, or edited.
