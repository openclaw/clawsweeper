# Notifier completion proof

Status: active validation recipe. Owner: ClawSweeper notifications.
Source: the shared OpenClaw hook client and four notifier CLIs.
Update when completion classification, ledger persistence or report output changes.

```sh
pnpm run build:node
node docs/proof/notifier-completion/run-proof.mjs
```

The real built merge, event, maintainer-report and GitHub-activity CLIs talk to a
local HTTP server using synthetic hook responses and fixture inputs. Thirty-six
scenarios cover delivered, silent and channel-transform suppression, failure, ambiguous completion,
attempted-but-unacknowledged empty and visible replies, legacy admission and no
requested delivery. Merge/event ledger files survive
separate CLI invocations: conclusive outcomes deduplicate, while inconclusive
ones retry the same idempotency key. Event dashboard publication remains
independent of an inconclusive completion. GitHub activity writes its summary.

The receipt records runtime, source hash and outcomes in `.artifacts/`.
No production credentials or mutations are used. This proves notifier behavior,
not a deployed Gateway or Discord send. The upstream completion protocol must
still be verified on the actual configured OpenClaw endpoint before landing.
