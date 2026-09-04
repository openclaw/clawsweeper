# Private inference through ClawRouter

Set the repository variable `CLAWSWEEPER_CODEX_AUTH_MODE=clawrouter` to route
Codex lanes through ClawRouter's isolated `/private/v1` endpoint. Provision and
prove that private deployment before enabling the variable. This selects the
Codex runner; deployments using the separate OpenClaw runner must first choose
`CLAWSWEEPER_RUNNER=codex`.

The `CLAWSWEEPER_CLAWROUTER_CONFIG` Actions secret contains exactly three fields:
`baseUrl` (an HTTPS URL ending in `/private/v1`), `token` (the dedicated
`private-workload-` credential), and `modelInfo` (the complete native Codex
ModelInfo object, with `slug: "internal"` and `display_name: "Codex"`). Supply
verified, alias-only metadata for the entitled upstream; discovery's reduced
model row is insufficient. Preserve genuine reasoning, context, Lite, tool,
review, and safety requirements. Never put real upstream model identifiers or
subscription credentials in this secret, workflow inputs, source, or reports.

Setup uses the built-in OpenAI provider and native API-key credential storage
with the opaque workload credential. Missing or invalid private configuration
fails the job; it does not fall back to a direct provider. Upstream API keys and
model secrets are withheld from Codex setup in this mode. Session cache keys
include the authentication mode so legacy sessions cannot reintroduce upstream
identifiers when switching to private inference.

ClawRouter owns upstream authentication, routing, response identity containment,
and any configured availability fallback. It must run under a separate private
administrative boundary, with an owner-managed subscription token lifecycle.
ClawSweeper continues to report only `internal`. Its existing review scanner,
sandbox checks, proof requirements, and deterministic publication gates remain
in force. Validate the deployed route with the pinned native Codex client,
including tools and failure paths, before enabling live jobs.

The default `proxy` mode and explicit legacy `login` mode retain their existing
API-key configuration. Changing the authentication-mode variable affects new
jobs; it does not stop or reconfigure jobs already running.
