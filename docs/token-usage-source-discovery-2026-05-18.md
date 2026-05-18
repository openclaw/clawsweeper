# ClawSweeper Codex token usage source discovery

Date: 2026-05-18

## Recommendation

Use Codex JSONL `token_count` events as the first-class token source.

- `codex exec --json` already emits parseable stdout JSONL for repair paths and is persisted to run artifacts (`src/repair/run-worker.ts:206-221`, `src/repair/run-worker.ts:276-283`, `src/repair/execute-fix-artifact.ts:1758-1788`).
- For item review and disabled commit review, add `--json` while keeping `--output-last-message`; current code only keeps final model output, not transcript JSONL (`src/clawsweeper.ts:4598-4616`, `src/commit-sweeper.ts:303-317`).
- Instrument `src/repair/run-worker.ts` first: it is active, already `--json`, already writes `codex.jsonl`, and the prior audit names it as the first implementation target (`/Users/luke/Projects/infra/openclaw-claude/docs/clawsweeper-token-usage-instrumentation-2026-05-18.md:190-195`).

## Codex event schema to parse

Parse newline-delimited JSON events from Codex stdout/transcript. Usage events observed locally are:

```ts
type CodexTokenCountEvent = {
  type: "token_count";
  payload?: {
    info?: {
      last_token_usage?: CodexTokenUsage;
      total_token_usage?: CodexTokenUsage;
    };
  };
};

type CodexTokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};
```

Use the last seen `payload.info.total_token_usage` as the invocation total; retain `last_token_usage` for optional per-response diagnostics. Normalize to `tokens.input`, `tokens.cache_read`, `tokens.output`, `tokens.reasoning_output`, and `tokens.total`. The existing plan already says JSON paths should parse Codex JSONL, non-JSON paths should add `--json` or use proxy fallback, and fields must be normalized (`.../clawsweeper-token-usage-instrumentation-2026-05-18.md:112-127`).

## Per-call-site notes

### `src/clawsweeper.ts` item review: active sweep/repository_dispatch path

- Invocation: `spawnSync("codex", ["exec", ...])` with model, config, `-C`, schema, `--output-last-message`, sandbox, add-dir, stdin prompt (`src/clawsweeper.ts:4551-4627`).
- `--json`: no; current args omit it (`src/clawsweeper.ts:4598-4616`).
- Persistence: prompt is written to `<workDir>/<item>.prompt.md`, final JSON to `<workDir>/<item>.json`; stdout/stderr are kept only in memory and only tailed on errors (`src/clawsweeper.ts:4570-4577`, `src/clawsweeper.ts:4635-4678`). Review workflow uploads only `review-artifacts/shard-*/*.md`, not Codex stdout/transcripts (`.github/workflows/sweep.yml:986-1005`).
- Parse point: after `spawnSync`, parse `result.stdout` if `--json` is added; optionally write a sanitized `usage-events.jsonl` beside the review artifact instead of storing raw transcript.
- Metadata available: item number, target repo, model, reasoning effort, service tier, sandbox, work dir, openclaw dir, prompt chars via existing telemetry, GitHub env (`src/clawsweeper.ts:4551-4565`; prior telemetry fields in `.../clawsweeper-token-usage-instrumentation-2026-05-18.md:44-52`).

### `src/commit-sweeper.ts` commit review: currently disabled workflow

- Invocation: `spawnSync("codex", ["exec", ...])` with model/config, target dir, `--output-last-message`, sandbox, stdin prompt (`src/commit-sweeper.ts:268-326`).
- `--json`: no (`src/commit-sweeper.ts:303-317`).
- Persistence: prompt `<workDir>/<sha>.prompt.md`, final markdown `<workDir>/<sha>.md`; stdout/stderr only used in failure report (`src/commit-sweeper.ts:282-348`).
- Parse point: same as item review after adding `--json`; not first priority because `.github/workflows/_disabled/commit-review.yml` is disabled though it would run `dist/commit-sweeper.js review` if re-enabled (`.github/workflows/_disabled/commit-review.yml:371-417`).
- Metadata available: target repo, commit sha/base sha, commit metadata, model, reasoning effort, service tier, sandbox (`src/commit-sweeper.ts:268-280`).

### `src/repair/run-worker.ts` repair cluster worker: active plan/execute/autonomous path

- Invocation: `spawn("codex", args)` where args include `exec`, `--cd`, model, read-only sandbox, schema, `--output-last-message`, `--ephemeral`, `--json`, stdin (`src/repair/run-worker.ts:199-231`, `src/repair/run-worker.ts:252-256`).
- `--json`: yes (`src/repair/run-worker.ts:206-221`).
- Persistence: stdout always written to `codex.jsonl` or `codex-repair-<attempt>.jsonl`; stderr written to matching logs (`src/repair/run-worker.ts:74-78`, `src/repair/run-worker.ts:276-283`, `src/repair/run-worker.ts:369-375`).
- Parse point: inside `finish()` before/after `fs.writeFileSync(codexTranscriptPath, stdout)`; parse stdout even on non-zero/timeout to capture burned tokens (`src/repair/run-worker.ts:276-315`).
- Metadata available: job path/frontmatter repo+cluster+mode, model, reasoning effort/service tier env, target checkout, run dir, transcript path, timeout, GitHub env (`src/repair/run-worker.ts:23-31`, `src/repair/run-worker.ts:63-79`, `src/repair/run-worker.ts:325-331`).

### `src/repair/execute-fix-artifact.ts` repair execution/fix path: active execute/autonomous second job

- Invocation wrapper: `spawnCodexSyncWithHeartbeat()` calls `spawnSync("codex", args, options)` (`src/repair/execute-fix-artifact.ts:304-314`).
- `--json`: yes for edit worker, final base reconcile, write preflight, Codex review, review-fix, and validation-fix (`src/repair/execute-fix-artifact.ts:1758-1775`, `src/repair/execute-fix-artifact.ts:2102-2118`, `src/repair/execute-fix-artifact.ts:2186-2203`, `src/repair/execute-fix-artifact.ts:2599-2617`, `src/repair/execute-fix-artifact.ts:2723-2739`, `src/repair/execute-fix-artifact.ts:2811-2827`).
- Persistence: each stdout JSONL is written under `workRoot` with mode/attempt-specific names, with stderr logs when present (`src/repair/execute-fix-artifact.ts:1785-1793`, `src/repair/execute-fix-artifact.ts:2129-2137`, `src/repair/execute-fix-artifact.ts:2214-2216`, `src/repair/execute-fix-artifact.ts:2627-2636`, `src/repair/execute-fix-artifact.ts:2750-2758`, `src/repair/execute-fix-artifact.ts:2838-2846`).
- Parse point: immediately after each spawn result is returned and before status/timeout handling; stdout is already in memory and persisted.
- Metadata available: result repo/cluster/mode, target dir, workRoot, model, sandbox configs, attempt, timeout, validation/review/reconcile phase labels, GitHub env.

## Active workflows and auth mode

Only enabled workflows containing Codex wiring are:

- `.github/workflows/sweep.yml`: active item reviews. Uses `setup-codex` with `auth-mode: subscription` for repository_dispatch and shard reviews (`.github/workflows/sweep.yml:269-272`, `.github/workflows/sweep.yml:861-864`). Runs `node dist/clawsweeper.js review` with model/reasoning/sandbox/timeouts (`.github/workflows/sweep.yml:932-947`).
- `.github/workflows/repair-cluster-worker.yml`: active repair worker. Both cluster and execute jobs set `OPENAI_API_KEY`, but `setup-codex` explicitly uses `auth-mode: subscription`; therefore billing/auth path is ChatGPT subscription, not proxy/login, unless the action input changes (`.github/workflows/repair-cluster-worker.yml:64-79`, `.github/workflows/repair-cluster-worker.yml:146-150`, `.github/workflows/repair-cluster-worker.yml:236-257`, `.github/workflows/repair-cluster-worker.yml:316-321`).
- `.github/workflows/repair-issue-implementation-intake.yml`: active intake/dispatcher. It does not call `setup-codex` or `codex` directly; it records jobs and dispatches `repair-cluster-worker.yml` via `pnpm run repair:dispatch`, passing model/runner inputs (`.github/workflows/repair-issue-implementation-intake.yml:61-66`, `.github/workflows/repair-issue-implementation-intake.yml:166-198`). Auth is inherited downstream: subscription.

`setup-codex` supports `proxy`, `login`, and `subscription`; subscription symlinks the runner ChatGPT `~/.codex/auth.json` and asserts `Logged in using ChatGPT` (`.github/actions/setup-codex/action.yml:7-9`, `.github/actions/setup-codex/action.yml:67-108`, `.github/actions/setup-codex/action.yml:113-135`).

## Risks / open questions

- Need verify a current GitHub Actions `codex.jsonl` artifact contains `token_count`; local Codex does, but CI subscription mode should be confirmed before Opik work.
- Item review lacks `--json` today; adding it may change stdout volume/format, so keep `--output-last-message` as the decision source and parse usage separately.
- Do not upload raw transcripts to Opik; existing instrumentation rules prohibit prompt/output/body/secrets (`.../clawsweeper-token-usage-instrumentation-2026-05-18.md:110`).
- Proxy fallback cannot cover today’s main flows because active workflows intentionally use subscription auth, not proxy.

## Exact next implementation step

Create `src/usage-telemetry.ts` with a `parseCodexTokenUsageFromJsonl(stdout: string)` helper plus local `usage-events.jsonl` writer, then wire it into `src/repair/run-worker.ts` `finish()` to emit one sanitized usage event for primary and result-repair Codex invocations. Validate by running a small repair dry/non-mutating target and checking the local usage event has non-zero totals before adding Opik upload.

## Step 4 Opik upload blocker

Direct Opik ingestion is deferred. This repo has no existing `OPIK_*` ingest client or verified REST payload shape, and the local evidence only proves Codex JSONL token extraction plus sanitized local `usage-events.jsonl` writing. Workflows now export non-secret telemetry routing values and upload usage-event artifacts for backfill/debugging, but do not set `OPIK_API_KEY` or send events to Opik until the trace/span ingestion API shape is verified with a mocked client or documented SDK path.

## Step 5 Opik ingest shape status

Local SDK inspection on 2026-05-18 found an Opik Python SDK shape that can represent the required sanitized ClawSweeper span without raw text:

- SDK: `opik==1.9.77` under `/Applications/Xcode.app/Contents/Developer/usr/bin/python3`.
- Client: `Opik(host="https://opik.bermont.digital/api")`.
- Trace call: `client.trace(name=..., project_name="clawsweeper", metadata={...}, tags=[...])`.
- Span call: `client.span(trace_id=..., name=..., type="llm", project_name="clawsweeper", metadata={sanitized event metadata}, usage={input, output, cache_read, reasoning_output, total}, model=..., provider="openai-codex")`.

Live ingest is still deferred because proving the write path requires a real Opik credential/API key (expected env: `OPIK_API_KEY`) or existing local Opik config access. That is credential-sensitive and was not executed without explicit approval. Until approved, use local `usage-events.jsonl` artifacts plus `pnpm usage:snapshot -- <artifact-dir-or-file>` for aggregate 48h audits.
