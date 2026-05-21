# ClawSweeper telemetry

ClawSweeper emits one sanitized usage event for each model invocation. Events are written locally as `usage-events.jsonl` and, when configured, broadcast as OTLP trace spans for collector fan-out to SigNoz and Opik.

## Event contract

Usage events intentionally contain metadata only — no prompts, raw model output, issue bodies, comments, transcripts, auth headers, or secrets.

Core fields:

- `surface`: `clawsweeper`
- `workflow`, `mode`, `phase`
- `provider`, `model`
- `session_id`, `turn_id`
- `target_repo`, `item_number`, `commit_sha`, or `job_path`
- `github_repository`, `github_run_id`, `github_run_attempt`, `github_job`, `runner_name`
- `status`, `elapsed_ms`, `timeout_ms`
- `tokens.input`, `tokens.cache_read`, `tokens.cache_creation`, `tokens.output`, `tokens.reasoning_output`, `tokens.total`

## OTLP routing

Enable broadcast with:

```bash
CLAWSWEEPER_USAGE_TELEMETRY=1
CLAWSWEEPER_USAGE_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces
CLAWSWEEPER_USAGE_SERVICE_NAME=clawsweeper-runner
CLAWSWEEPER_USAGE_SERVICE_NAMESPACE=mac-mini
```

Accepted endpoint vars, in precedence order:

1. `CLAWSWEEPER_USAGE_OTLP_ENDPOINT`
2. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
3. `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`

Optional headers:

```bash
CLAWSWEEPER_USAGE_OTLP_HEADERS='Authorization=Bearer ...'
# or
OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer ...'
```

Recommended production shape:

```text
ClawSweeper runner → local OTLP collector → SigNoz exporter + Opik exporter
```

Keep ClawSweeper unaware of vendor-specific APIs where possible. The OTLP span attributes are sufficient for both trace search and cost/cache dashboards.

## Span shape

Each usage event becomes a `clawsweeper.<workflow>.<phase>` span.

Important attributes:

- `gen_ai.system`: `openai-codex` or `anthropic`
- `gen_ai.operation.name`: `clawsweeper.<mode>`
- `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.cached_input_tokens`
- `gen_ai.usage.cache_read_input_tokens`
- `gen_ai.usage.cache_creation_input_tokens`
- `gen_ai.usage.reasoning_output_tokens`
- `gen_ai.usage.total_tokens`
- `gen_ai.usage.cache_input_tokens`
- `gen_ai.usage.cache_read_ratio`
- `clawsweeper.session_id`, `clawsweeper.turn_id`

`traceId` is stable per `session_id`, so all turns for one GitHub run/session line up as a single trace timeline in SigNoz/Opik.

## Local aggregate and session timeline

Download `review-usage-*`, `repair-usage-*`, or `commit-review-usage-*` artifacts and run:

```bash
pnpm usage:snapshot -- /path/to/downloaded/artifacts
```

The snapshot includes:

- total calls/tokens/cache read/cache creation
- cache input and cache-read ratio
- totals by workflow, target repo, model, and session
- failed/timeout token burn
- largest invocations

For one session timeline:

```bash
pnpm usage:snapshot -- --session-id 'github:valkyriweb/clawsweeper:<run-id>' /path/to/artifacts
```

This prints ordered turns for that session, including status, target, model, provider, and token/cache usage.

## Canary verification

A healthy single-item Claude canary should produce:

1. `review-shard-0/*.md` with `review_status: complete`.
2. `review-usage-0/usage-events.jsonl` with `provider: "anthropic"` and non-zero token totals.
3. An OTLP span under `service.name=clawsweeper-runner` with non-zero `gen_ai.usage.total_tokens`.
4. Cache health fields in SigNoz/Opik: `cache_read_input_tokens`, `cache_creation_input_tokens`, and `cache_read_ratio`.

If the usage artifact is missing, the provider path is not emitting telemetry. If the artifact exists but SigNoz/Opik is empty, inspect the local collector/exporter path first.
