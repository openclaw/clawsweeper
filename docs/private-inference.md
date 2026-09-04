# Private inference through ClawRouter

Set the repository variable `CLAWSWEEPER_CODEX_AUTH_MODE=clawrouter` to route
Codex lanes through ClawRouter's isolated `/private/v1` endpoint. Provision and
prove that private deployment before enabling the variable. This configures the
Codex runner; deployments using the separate OpenClaw runner must first choose
`CLAWSWEEPER_RUNNER=codex`.

The `CLAWSWEEPER_CLAWROUTER_CONFIG` Actions secret contains exactly three fields:
`baseUrl` (an HTTPS URL ending in `/private/v1`), `token` (the dedicated
`private-workload-` credential), and `modelInfo` (the complete native Codex
ModelInfo object, with `slug: "internal"` and `display_name: "Codex"`). Supply
verified, alias-only metadata for the entitled upstream; discovery's reduced
model row is insufficient. Preserve genuine reasoning, context, Lite, tool,
review, and safety requirements. Never put real upstream model identifiers or
upstream credentials in this secret, workflow inputs, source, or reports.

When full metadata exceeds GitHub's 48 KiB secret limit, gzip the complete JSON
document, base64-encode it, and prefix the result with `gzip:`. Setup accepts both
plain JSON and this packed format, with a 256 KiB decompression limit. Do not
remove native instructions or safety capabilities to make the secret smaller.
Setup registers the decoded workload credential with GitHub's log masker before
invoking the native client.

Setup uses the built-in OpenAI provider and native API-key credential storage
with the opaque workload credential. Missing or invalid private configuration
fails the job; it does not fall back to a direct provider. Upstream API keys and
model secrets are withheld from Codex setup in this mode. Session cache keys
include the authentication mode so legacy sessions cannot reintroduce upstream
identifiers when switching to private inference.

ClawRouter owns upstream authentication, routing, response identity containment,
and any configured availability fallback. It must run under a separate private
administrative boundary, with owner-managed upstream credentials. Its explicit
API transport uses an API key held only by the broker; subscription transport
requires a token refresh lifecycle.
ClawSweeper continues to report only `internal`. Its existing review scanner,
sandbox checks, proof requirements, and deterministic publication gates remain
in force. Validate the deployed route with the pinned native Codex client,
including tools and failure paths, before enabling live jobs.

After storing the Actions secret, run the hosted canary before changing the
repository routing variable:

```bash
gh workflow run ci.yml --ref main -f codex_auth_mode=clawrouter
```

This override affects only the dispatch-only native review smoke job. It proves
scanner refusals, native sandbox execution, and a structured review against a
synthetic repository without GitHub mutation. The default `configured` choice
uses the repository's current authentication mode.

The default `proxy` mode and explicit legacy `login` mode retain their existing
API-key configuration. Changing the authentication-mode variable affects new
jobs; it does not stop or reconfigure jobs already running.
