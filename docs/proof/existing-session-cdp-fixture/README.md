# Existing-session CDP fixture admission

Status: historical native proof. The owner is `src/agent-input-scan-fixtures.ts`;
the entry point is `scanAgentInput` in `src/agent-input-scan.ts`.

The unchanged synthetic loopback CDP endpoint in OpenClaw's
`extensions/browser/src/browser/server-context.existing-session.test.ts`
was refused before model review. Its mocked profile-status test repeats the
placeholder URI in configuration and an expected-result assertion.

The candidate qualifies only URI detector 17 with the observed PLAIN and HTML
decoders, both exact raw digests, both complete source lines in order, the original
path, regular-file mode, and committed base/head references. No entire file or
loopback domain is exempted. Other sources retain their existing policy.

On Node 24.20.0/Linux and checksum-qualified TruffleHog 3.99.4 with normal
verification, the complete committed range for
[the browser PR](https://github.com/openclaw/openclaw/pull/191271)
was [refused before](before.json) and [admitted after](after.json).
The base is `70243cfd580764701b57321f03c29b322bb505d2` and the head is
`d3a9b11d11d21a6b51b7e4004c0e9a781f8452bd`.

```sh
node docs/proof/marketplace-telemetry-fixtures/run-proof.mjs \
  /path/to/openclaw 70243cfd580764701b57321f03c29b322bb505d2 \
  d3a9b11d11d21a6b51b7e4004c0e9a781f8452bd /path/to/proof.json
node --test --test-name-pattern='existing-session loopback CDP endpoint' \
  test/agent-input-scan.test.ts
```

The focused regression fails under the original policy and passes with the
candidate. It covers both roles and decoders and refuses changed or reordered
lines, missing or duplicate occurrences, changed query text, wrong source or mode,
uncommitted roles, verified findings, unsupported decoding and mismatched native
metadata. A separate native scan of the original blob observed HTML with identical
raw digests; the complete-range proof observed PLAIN.

Limits: this source-admission proof uses a controlled prompt and no model.
A real review must scan its own complete prompt, schema, and source inputs.
Requalify when the fixture, scanner version, or source-binding contract changes.
