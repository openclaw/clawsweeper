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
2. **No loss and no widening** — five genuine author spellings are still trusted
   across casing, three untrusted logins stay rejected, and four **whitespace-padded**
   logins are rejected. GitHub logins never contain whitespace, so a padded value is
   malformed data; trimming it would widen the trust boundary rather than normalize
   it.
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

28 checks, all PASS, exit 0, plus the measured contrast:

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
bash docs/proof/trusted-status-comment-fail-open/stage-before.sh
PROOF_HEAD="$(git rev-parse HEAD)" \
crabbox run \
  --allow-env PROOF_HEAD \
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
bash docs/proof/trusted-status-comment-fail-open/stage-before.sh
node docs/proof/trusted-status-comment-fail-open/run-proof.mjs \
  docs/proof/trusted-status-comment-fail-open/before/comment-router.ts
```

Focused tests:

```bash
node --test test/repair/comment-router-core.test.ts
```

## The run cannot alter the head it is proving

An earlier revision of this script installed the platform-native TypeScript
package with `pnpm add -D`, which writes `package.json` and `pnpm-lock.yaml`, and
recovered the pre-fix source with `git show` — which cannot work in a container
image that carries no `.git`. Both are fixed:

- The fallback installs into a disposable prefix outside the workspace
  (`npm install --prefix "$(mktemp -d)" --no-save`) and copies the result into
  `node_modules/`, which is untracked build state. This mirrors how
  `docs/proof/openclaw-bay/run-proof.sh` provisions Playwright under `/tmp`.
- `stage-before.sh` writes the base-commit copy of `comment-router.ts` to
  `before/` on the host, where rsync picks it up as an **untracked** file. It is
  not committed: a 5,400-line verbatim duplicate of a blob git already stores is
  exactly the kind of payload the docs/ retention rule asks proof records to avoid,
  and an earlier revision of this branch did commit it. Because it is untracked,
  writing it cannot alter the head under test — the tracked-state guard ignores
  untracked paths and aborts if a tracked file moves. Where git *is* reachable the
  script re-derives it, so a stale copy cannot weaken the contrast, and it fails
  with the exact staging command if the copy is missing.
- The script records `package.json` and `pnpm-lock.yaml` digests plus
  `git status --porcelain` at sync, then re-checks them after the fixture step,
  after dependency installation, and at the end of the run. Any drift aborts with
  a diff instead of reporting a result.

Untracked paths are excluded from that comparison, so build output and artifacts
do not trip it — only a change to the committed tree does.

## Proof contract

This is what a passing run must show. The **observed run for the current head —
lease, run id, artifact, and redacted output — lives in the PR body**, which is
where AGENTS.md requires current proof to sit. Deliberately no lease id is pinned
here: editing this file changes the head, which would immediately make any pinned
run describe a different commit than the one under review.

| | |
|---|---|
| provider | Crabbox `local-container` (runtime `docker`) |
| image | `node:24`; the script refuses to run below Node 24 |
| base ref | `0588bda9` · `src/repair/comment-router.ts` |
| checks | **28**, all PASS |
| focused suites | `201/201` |
| exit | `0` |

A run is only valid evidence if it also reports:

- the head it describes. A container has no `.git`, so `PROOF_HEAD` is computed on
  the host and forwarded with `--allow-env`; verify `git status` is clean before
  the run, or the echoed head names a commit the synced tree no longer matches;
- `tracked state unchanged` at all three checkpoints, with identical `package.json`
  and `pnpm-lock.yaml` digests at sync and at end of run;
- the pre-fix contrast, either re-derived from git or from the staged copy with its
  sha256 printed.

**Privacy and network access.** Synthetic fixtures only. The *assertions* contact
nothing — no GitHub API, no queue, no production mutation of any kind. The lease
*setup* around them reaches the public package registry to obtain pnpm and the
platform-native TypeScript binary, and nothing else. No credential is present in
the lease.

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

**Regression direction, stated without overclaiming:** in normal operation every
ClawSweeper-authored comment carries a login, so failing closed costs nothing. But
this guard exists precisely because GitHub types the author as nullable — and if
that case ever occurs for a genuine ClawSweeper comment, the guard will decline to
adopt it and ClawSweeper will post a **duplicate status comment** instead of editing
in place. That is the intended direction to fail, not a guarantee that nothing is
lost.

Claim 3 scans built output for the `return !author ||` shape specifically; a
differently-spelled fail-open would not be caught by that regex.

No live GitHub comment is read, adopted, or edited.
