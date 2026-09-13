# Notifier completion proof

Status: active validation recipe. Owner: ClawSweeper notifications.
Source: the shared OpenClaw hook client and four notifier CLIs.
Update when completion classification, ledger persistence or report output changes.

```sh
pnpm run build:node
node docs/proof/notifier-completion/run-proof.mjs
```

The real built merge, event, maintainer-report and GitHub-activity CLIs talk to a
local HTTP server using synthetic hook responses and fixture inputs. Fifty-two
scenarios cover delivered, silent and channel-transform suppression, failure, ambiguous completion,
explicit channel suppression with later errors, attempted-but-unacknowledged empty and visible replies, omitted delivery flags,
legacy admission and no requested delivery. Merge/event ledger files survive
separate CLI invocations: conclusive outcomes deduplicate, while inconclusive
ones retry the same idempotency key. Event dashboard publication remains
independent of an inconclusive completion. GitHub activity writes its summary.

The receipt records runtime, source hash and outcomes in `.artifacts/`.
No production credentials or mutations are used. This proves notifier behavior,
not a deployed Gateway or Discord send. Completion observability requires a
Gateway with the [completion protocol](https://github.com/openclaw/openclaw/pull/139155).
The client remains safe with admission-only Gateways: the
[older payload normalizer](https://github.com/openclaw/openclaw/blob/d0137988844d201423fbe1918e8c5acef8ddfa8e/src/gateway/hooks.ts#L689)
ignores the added field, and the client preserves terminal `admitted` outcomes
without retrying them. Either deployment order is supported; this recipe does
not claim which protocol a configured production Gateway currently serves.
