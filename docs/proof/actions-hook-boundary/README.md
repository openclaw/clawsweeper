# GitHub activity hook-boundary proof

Status: historical proof for PR [2064](https://github.com/openclaw/clawsweeper/pull/2064). Owner: ClawSweeper maintainers. Runtime owners: `.github/workflows/github-activity.yml`, `src/repair/notify-github-activity.ts`, and `src/repair/openclaw-hook.ts`. Re-run when the job condition or hook boundary changes.

Claim: the actual `notify` job condition rejects a fork-origin `workflow_run` failure before the authenticated agent hook, while a same-repository failure reaches that hook exactly once.

Run from the repository root with Node 24 or newer and existing dependencies:

```sh
pnpm run build:repair
node docs/proof/actions-hook-boundary/run-proof.mjs
```

The driver reads and pins the real YAML `if:` expression, then evaluates it with a minimal, exact-expression evaluator. Assertions cover case-insensitive GitHub string comparisons and `contains`, absent properties, routine conclusions, both synchronize filters, and unrelated events. A changed expression fails closed and requires an evaluator update. The string-only fixture domain needs no mixed-type coercion; the implicit job `success()` condition is assumed true.

For each synthetic failure event, the evaluator controls invocation of the real `repair:notify-github-activity` script's compiled CLI entry. The admitted event calls `runGithubActivityNotifier` and `postOpenClawAgentHook` using the real HTTP transport against a loopback server. The server records method, path, payload, idempotency key, and whether the bearer token matches. The token is synthetic and its value is redacted from artifacts. The fork event must skip the CLI with zero requests; the same-repository event must produce exactly one authenticated `POST /hooks/agent` and a successful notifier result.

Artifacts default to `.artifacts/actions-hook-boundary/`: `summary.json` records head, workflow and fixture hashes, local provider/Node version, decisions, and request counts; `requests.json` records the redacted final-effect trace. Event fixtures, the notifier report, and its step summary are also retained. An optional first argument selects another output directory.

Limits: this is offline job admission followed by real local CLI/HTTP behavior, not a hosted Actions scheduler execution. Successful setup and sufficient API budget are assumed. It does not exercise checkout, secret provisioning, GitHub API access, a production hook, or Discord delivery. No container image or lease is used on this macOS host; no real credentials, external writes, or workflow dispatches are needed.
