# Chrome MCP endpoint-rejection fixture admission

Historical proof for the exact synthetic URI fixture introduced by OpenClaw
commit `3d7ef2108d9405b7a39fdb9f395ea6e47bec6e9e`. The fixture lives in
`extensions/browser/src/browser/chrome-mcp.test.ts` and tests rejection of
credential-bearing endpoint arguments without echoing credentials. Its host
uses the reserved `.example` domain and its userinfo and query are descriptive
test placeholders.

## Behavior contract

Admit this fixture only when native URI detector 17 emits its exact Raw and
RawV2 digests with PLAIN or HTML decoding, the full original source line,
the original path, mode `100644`, and committed base/head references.
The complete line binds the query even though native URI matching omits it.
Existing older Chrome MCP fixture approval remains unchanged.

Unknown values, changed source lines or paths, duplicate occurrences, verified
findings, unsupported decoders, executable files, worktree references, and
incomplete scans must remain refused. No scanner verification or source coverage
is disabled.

## Native proof

The exercised surface is the real `scanAgentInput` committed-source admission
path over [OpenClaw PR 188308](https://github.com/openclaw/openclaw/pull/188308),
base `5eda466704861324a87e05a488cb10888e66b8a7` through
head `a6a03e918820daf02b8dde092d27df7946cdc92a`.

On Node 24.20.0/Linux, checksum-qualified native TruffleHog 3.99.4 and normal
verification reproduced `literal_not_reviewed` with two findings under the
original host policy ([before.json](before.json)). The candidate admitted the
complete same range and classified the two base/head fixture findings
([after.json](after.json)). Native deduplication can choose PLAIN or HTML for
these unencoded literal bytes; the focused regression qualifies both and rejects
BASE64.

```sh
pnpm run build
node docs/proof/marketplace-telemetry-fixtures/run-proof.mjs \
  /path/to/openclaw \
  5eda466704861324a87e05a488cb10888e66b8a7 \
  a6a03e918820daf02b8dde092d27df7946cdc92a \
  /path/to/proof.json
node --test --test-name-pattern='Chrome MCP endpoint argument redaction' \
  test/agent-input-scan.test.ts
```

The focused regression failed before qualification, then passed with the
candidate. It exercises both committed roles and decoders plus source-line,
query, duplication, path, mode, role, verification, and metadata mutation controls.
Use a private host-owned scanner cache outside both repositories if the default
cache has unsafe directory ancestors; the bootstrap still validates the archive,
binary, and cache authority.

Limits: this is source-admission proof with a controlled prompt and no model
call. It does not certify the browser change or a hosted review. After this host
policy lands, hosted ClawSweeper must scan its own complete inputs and produce a
review for the current OpenClaw PR head and body.
