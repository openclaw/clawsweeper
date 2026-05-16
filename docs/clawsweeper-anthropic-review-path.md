# Spec: Anthropic-via-claude-bridge review path

Status: **spec only — no implementation on the goal that produced this doc.**
Source goal: `~/Projects/personal/agent-system/docs/goals/goal-2026-05-15T23-45Z-clawsweeper-tail-cleanup.md` (slice A).
Implementation: follow-up goal.

## Why this exists

ClawSweeper's review path is hardwired to `spawnSync("codex", ...)` (see `runCodex` in `src/clawsweeper.ts`). Two pains follow:

1. **Auth-routing dead-end on slice 1b.** ChatGPT-subscription auth routes `gpt-5.5` to a Codex-tuned variant (`gpt-5.5-codex-1p-codexswic-ev3`) that rejects `reasoning_effort: minimal`. The "minimal cuts wall while preserving quality" hypothesis can't be tested under the current auth path. See `~/Projects/personal/agent-system/clawsweeper-codex-tuning.md` for the full log.
2. **No parallel-model strategy.** Outlier items (slice B escalates their Codex cap to 1200s) can't be routed to a different model with different latency characteristics. The shard tail stays single-vendor.

Routing review calls through `pi-claude-bridge` (Anthropic Messages API proxy at `127.0.0.1:9100`) unblocks (1) by giving us a model that supports a fast-classify mode on its own auth, and opens the door to (2) by introducing a second provider behind a uniform `runReview()` seam.

## Hard constraints inherited from the source goal

- Do **not** modify `prompts/review-item.md` unless this spec proves the prompt must change for Claude. (See "Tool calls" below — this is the one place where the prompt may have to change.)
- Do **not** flip `CODEX_REASONING_EFFORT` away from `low`.
- Preserve slice 1a contract: timeout failures post a notice and don't throw the shard.
- Preserve slice B contract: per-item timeout escalator still works (it's a `timeoutMs` decision; the new provider just consumes it).
- Don't expand the workflow_dispatch input list near GitHub's 25-input cap; new toggles go through `vars.CLAWSWEEPER_*` or env.

## The five questions the source goal asked

### 1. Where to inject the review-model choice

Today `reviewCommand` does, inside its per-item loop:

```ts
decision = runCodex({ item, context, git, model, …timeoutMs, prompt });
```

Cleanest seam: extract `runReview()` that returns the same `Decision`, and pick a provider per call.

```ts
type ReviewProvider = "codex" | "claude-bridge";
function runReview(provider: ReviewProvider, options: ReviewOptions): Decision { … }
```

Provider selection sources, in order of precedence (highest wins):

1. **Per-item override** (slice B integration): if `priorReview.reviewFailureReason === "timeout"` and `vars.CLAWSWEEPER_TIMEOUT_ESCALATE_PROVIDER === "claude-bridge"`, escalate by switching provider instead of (or in addition to) bumping the cap.
2. **Workflow input** (`review_provider` dispatch input — kept off by default; opt-in only) — useful for one-shot A/B dispatches without changing repo vars.
3. **Repo variable** (`vars.CLAWSWEEPER_REVIEW_PROVIDER`, default `codex`) — durable global default.
4. **Env var fallback** (`CLAWSWEEPER_REVIEW_PROVIDER`) — for local repro / runner override.

Per-call dependency injection (the `runReview(provider, …)` form) beats env-only routing because:
- Slice B's escalator decides per item, not per shard.
- Tests can hit the dispatcher directly without process-env wiring.
- Codex stays the default; Claude is opt-in until the path is proven.

Do **not** put the provider choice inside `runCodex` (single-responsibility). Build `runClaude()` as a peer and let `runReview()` dispatch.

### 2. Replace primary, or add as a secondary

Two paths:

| Path | Description | Risk | Recommendation |
|---|---|---|---|
| **Replace** | Swap default `review_provider` to `claude-bridge`; Codex becomes the secondary | Largest. Single change moves all valkyriweb review traffic. | **Not yet.** |
| **Escalate** | Default stays Codex. Items that timed out at the escalated Codex cap (slice B's "stuck" state, `review_timeout_escalated: true`) route to Claude on the next sweep. | Bounded — only outlier-of-outliers. ~0-3 items/week today. | **Ship this first.** |

Recommended sequence:

1. Land the dispatcher + Claude adapter behind a flag (default off).
2. Add the slice-B integration: when `shouldEscalateCodexTimeout` says "already escalated, still failing", switch provider to Claude on this sweep.
3. Observe for a week. If verdicts agree with Codex baseline on overlapping items, consider promoting Claude to a parallel-A/B sampler (1-in-N items routed to Claude regardless of state) to build a verdict-diff sample.
4. Only then consider flipping the default for a specific repo profile (e.g. `clip-sa/sa-clip` first, never `openclaw/openclaw` as a first move).

### 3. Auth + runner connectivity

Bridge:
- Listens on `127.0.0.1:9100` by default (`PORT`/`HOST` env).
- Handles its own upstream Anthropic auth (keychain refresh on macOS, static `_BRIDGE_OAUTH_TOKEN` on Linux/k8s, or `ANTHROPIC_API_KEY`).
- Pi/clawsweeper just speaks HTTP to the bridge — no Anthropic credentials touch the runner.

Self-hosted runner host: `luke-and-naddy-server` (Tailscale `100.92.54.116`), 6 valkyriweb runners under `actions-runner`.

Two deployment options:

| Option | Setup | Pro | Con |
|---|---|---|---|
| **Bridge co-located on runner host** | Run `pi-claude-bridge` as a systemd unit on `luke-and-naddy-server`; ClawSweeper hits `127.0.0.1:9100`. | Zero network hops. Trivial reach from any of the 6 runners on that host. | Needs a Linux-compatible auth path on the runner — `_BRIDGE_OAUTH_TOKEN` (long-lived `claude setup-token`) is the documented path (`pi-claude-bridge/index.js` `STATIC_OAUTH_TOKEN`). |
| **Bridge on luke's Mac, exposed via Tailscale** | Bridge stays on developer machine. ClawSweeper hits `http://<mac-tailscale-name>:9100`. | Keychain-refresh path already works; no new credential management. | Mac must be reachable when the runner fires (asleep Mac = sweep fails). Also exposes the bridge port over Tailscale (acceptable: ts net is private; the bridge has no destructive endpoints). |

**Recommended: bridge on runner host, static setup-token.** Mirrors how OpenClaw lifecycle programs already deploy claude-bridge on remote runners. Reaches both runners and any cluster workloads cleanly. Setup steps:

1. `claude setup-token` on a dev box → copy long-lived token.
2. On runner host: install `pi-claude-bridge` (clone + `npm i` + systemd unit). Set `_BRIDGE_OAUTH_TOKEN`, `PORT=9100`, `HOST=127.0.0.1`.
3. Smoke: `curl -s http://127.0.0.1:9100/health` returns `{"status":"ok","auth":"static"}`.
4. Optional fallback: configure `_BRIDGE_OAUTH_FALLBACK_TOKEN` so a 401 on the primary doesn't immediately bin all dispatches.

Pre-flight check from ClawSweeper before invoking Claude: `GET /health` with a 2s timeout. If unreachable, fall back to Codex with a one-line log line; never error the shard.

### 4. Output-schema compatibility

Codex uses `--output-schema CLAWSWEEPER_DECISION_SCHEMA_PATH` to enforce a JSON shape. Anthropic Messages API has two routes:

| Approach | How | Pro | Con |
|---|---|---|---|
| **Forced tool use** | Define one tool, `submit_decision`, with `input_schema = CLAWSWEEPER_DECISION_SCHEMA`. Set `tool_choice: { type: "tool", name: "submit_decision" }`. Parse `tool_use.input` from the response. | Widely supported. Anthropic enforces the schema before tokens flow back. Idiomatic. | One round-trip overhead vs raw JSON mode (negligible at our prompt sizes). |
| **Structured outputs** (beta) | Anthropic structured-outputs beta header. | Slightly cleaner shape. | Beta. Behavior changes risk. |

**Recommended: forced tool use.** Stable, observable in span attributes via the bridge (`bridge.tool_use=submit_decision`), and round-trips cleanly through prompt caching because the tool definition is part of the cached prefix.

Adapter sketch:

```ts
async function runClaude(options: ReviewOptions): Promise<Decision> {
  const tools = [{
    name: "submit_decision",
    description: "Submit the final ClawSweeper review decision for this item.",
    input_schema: clawsweepDecisionSchema(),
  }];
  const body = {
    model: options.model, // e.g. claude-sonnet-4-5-20250929
    max_tokens: 8192,
    system: claudeSystemPrompt(),
    messages: [{ role: "user", content: options.prompt }],
    tools,
    tool_choice: { type: "tool", name: "submit_decision" },
    metadata: { user_id: `clawsweeper-#${options.item.number}` },
  };
  const res = await postJSON(
    `http://127.0.0.1:9100/source/clawsweeper-review/v1/messages`,
    body,
    { timeoutMs: options.timeoutMs },
  );
  const toolUse = res.content?.find((b) => b.type === "tool_use" && b.name === "submit_decision");
  if (!toolUse) throw new Error(`Claude review returned no tool_use block for #${options.item.number}`);
  return parseDecision(toolUse.input, options.item);
}
```

Notes:
- `parseDecision` is already exported and already validates the schema shape — reuse it. If Claude returns an off-schema object, the same `codexFailureDecision("invalid structured output", …)` path applies.
- Use the bridge's `/source/<name>/v1/messages` route — tags every span with `bridge.source=clawsweeper-review` for Opik filtering.
- `metadata.user_id` is the per-item key the bridge uses for cache-break diagnostics. Per-item key gives us per-item cache-hit signal in `BRIDGE_LOG_CACHE`.

### 5. Latency expectations

For ClawSweeper's review prompt shape (10–50k tok input, ~3–5k tok output):

| Model | Cold p50 | Warm (cache hit) p50 | Worst-case |
|---|---|---|---|
| `claude-sonnet-4-5-20250929` | ~30-60s | ~15-30s | 90-120s |
| `claude-opus-4-5-20250715` (if we ever want it) | ~60-120s | ~30-60s | 180s+ |

Compared to current Codex `low`-effort: 60–105s baseline on items #5/#7/#11 (slice 1b retest, `clawsweeper-codex-tuning.md`). Claude Sonnet is in the same ballpark; the cache-hit path is materially faster.

Cap policy: reuse Codex's per-item cap (default 600s, escalator 1200s). The same `timeoutMs` flows through; Claude calls just respect it via `AbortSignal` on the HTTP request.

Open assumption: Anthropic's prompt cache (extended-cache-ttl-2025-04-11) caches per-item-context separately. Each item has a unique prompt body, so cross-item cache hits are tools+system-prompt only. That's fine for Sonnet — tools array is ~3-5kB; not the wall driver.

## ⚠ Tool-call discrepancy — open design question

Codex review runs are **agentic**: the review prompt at `prompts/review-item.md` instructs Codex to run `gh`, `git`, and `bash` inside its sandbox, gather evidence, then emit structured output. The sandbox + tool calls happen inside Codex's process.

Anthropic Messages API doesn't have an equivalent sandboxed-CLI primitive. Two real options:

### Option B1: Pre-collect context, no tool calls to Claude (recommended)

ClawSweeper already runs `collectItemContext(item)` before invoking Codex. That collection already pulls comments, related commits, file metadata. **Extend** it to also pull the evidence that Codex would have fetched via `gh`/`git` in its sandbox — full bot comment thread tail, target file blobs, related PR diffs, commit history bounded by date — then bundle into the prompt as inert text.

- Prompt for Claude becomes: "Here is the issue + all the evidence. Classify."
- No tool-use loop; one round-trip; trivial to reason about.
- Costs: bigger prompt (Anthropic cache absorbs the static parts; per-item extras are 10–30kB on average). Smaller blast radius — no ClawSweeper-side tool executor to maintain.

Trade-off: any evidence Codex would have fetched *only because of mid-flight reasoning* is lost. For the review-only path this is acceptable (most items don't need deep mid-flight exploration). For the **fix** path it's not — keep fix on Codex.

This option **requires a prompt variant** — `prompts/review-item-claude.md` or a flag in the existing template — because the Codex prompt assumes tool access. The hard-boundary constraint ("don't touch `prompts/review-item.md`") was specifically caveated with "unless slice A spec proves it must change". This proves it. Recommendation: add a sibling template `prompts/review-item-claude.md` rather than editing the existing one in place.

### Option B2: Implement a tool-use loop in ClawSweeper

Mirror Codex's tool agent: ClawSweeper accepts `tool_use` blocks from Claude, runs `gh`/`git` locally, sends results back as `tool_result` blocks, loops until `submit_decision` is the only tool_use.

- Higher complexity. Real implementation cost: tool registry + sandbox + result truncation + a hard cap on iterations + retry semantics.
- Closer behavioral parity with Codex.
- More moving parts in the failure space — every tool call is a new place for the run to wedge.

**Not recommended for the first pass.** Revisit only if Option B1 produces materially worse verdicts on a held-out sample.

### Stop-and-ask trigger from the source goal

> "Slice A spec reveals `claude-bridge` can't serve the review prompt's tool calls (gh/git) cleanly."

It doesn't, **and that's fine** — Option B1 (pre-collect context, no tool calls) sidesteps the issue. The trade-off (lose mid-flight exploration; needs a Claude-specific prompt variant) is explicit and bounded. No stop-and-ask: the spec captures the constraint and proposes a clean path.

## Recommended implementation order (next goal)

Slice each piece small. Ship in order; gate each on the previous landing.

1. **Bridge deployment** on the runner host. `_BRIDGE_OAUTH_TOKEN` only. Smoke via `curl /health`. (~0.5d)
2. **`runReview()` dispatcher** in `src/clawsweeper.ts` — extract the existing Codex call behind it. No new provider yet. Tests: dispatcher returns the same `Decision` regardless of provider id; default is `codex`. (~0.25d)
3. **`runClaude()` adapter** — forced tool use, `parseDecision` reused for schema validation, `AbortSignal` on `timeoutMs`. Tests: golden response → expected Decision; off-schema response → failure decision; HTTP 5xx → failure decision; timeout → ETIMEDOUT-flavored error (so `isCodexTimeoutError` recognizes it — keep the marker stable across providers). (~1d)
4. **`prompts/review-item-claude.md`** — sibling template that assumes pre-collected evidence (no tool guidance). Tests: prompt-builder telemetry parity. (~0.5d)
5. **Context-collector extension** — pull the extra evidence Codex would have fetched via `gh`/`git` mid-flight, bundle into the prompt. Tests: synthetic item with known repo state → expected prompt body. (~1d)
6. **Provider routing** wired through repo var + workflow input + slice-B integration. Default stays `codex`. Tests: precedence order matches this spec; missing provider falls back to `codex` with a log line. (~0.5d)
7. **Live A/B sampler.** One synthetic dispatch on items that already have a fresh Codex verdict; diff Claude's output. **No automerge, no auto-close** — propose-only. Land an eval report under `~/Projects/personal/agent-system/clawsweeper-claude-eval-<date>.md` before any default flip. (~ongoing)

Total estimate: ~3-4d focused work + 1 week of observation before any default change.

## Out of scope for the follow-up goal

- Routing the **fix** path through Claude. Fix path runs Codex with tool access; pre-collected context doesn't capture the explore-then-patch loop. Keep on Codex.
- Removing Codex. Codex stays as default and as fallback for at least one stable release cycle after Claude proves out.
- Multi-region failover. The bridge is one process on one machine; if it's down, ClawSweeper falls back to Codex. Sufficient for now.

## References

- `~/Projects/personal/pi-claude-bridge/index.js` — bridge source.
- `~/Projects/INFO/pi-claude-bridge.md` — project index entry (sparse; this spec is the durable note).
- `~/Projects/personal/agent-system/clawsweeper-codex-tuning.md` — slice 1a/1b iteration log and the auth-routing block that motivated this slice.
- `~/Projects/personal/agent-system/docs/goals/goal-2026-05-15T23-45Z-clawsweeper-tail-cleanup.md` — source goal.
- `src/clawsweeper.ts` `runCodex` — current provider; the seam the dispatcher extracts.
- `src/clawsweeper.ts` `parseDecision` — already-exported schema validator; reuse for Claude.
- `src/clawsweeper.ts` `isCodexTimeoutError` + slice-B helpers (`effectiveCodexTimeoutMs`, `shouldEscalateCodexTimeout`) — keep the timeout marker stable across providers so the escalator works either way.
