# Website URL rejection fixture admission

Status: historical native proof. Owner: `src/agent-input-scan-fixtures.ts`;
entry point: `scanAgentInput` in `src/agent-input-scan.ts`.

The existing password-only URL rejection case in OpenClaw's
`ui/src/lib/board/widgets/website.test.ts` blocked the review of
[OpenClaw PR #192881](https://github.com/openclaw/openclaw/pull/192881)
before model execution. The fixture is unchanged between base
`e81ab22955018b2f15adf50eac6bfcb86ea56ae3` and head
`20c3e28aedae00fa3ce334fae6c02e7b05980078`.

On macOS arm64, Node 26.13.0 and checksum-qualified TruffleHog 3.99.4,
the complete committed range was [refused before](before-full-range.json)
and [admitted after](after-full-range.json), with normal verification enabled.
Both native findings are URI detector 17 / PLAIN at line 62, one in each
committed source blob. Raw and RawV2 have the same SHA-256:
`040dc8c3fadea20ff28b67c13648a45e001f231c496b404a17de54426060d03d`.
The complete source-line SHA-256 is
`2ac91a04945f735283120e3d37c3879183f5e7343dab5f45e605f19ffb76b3c2`.

```sh
pnpm run build
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/openclaw e81ab22955018b2f15adf50eac6bfcb86ea56ae3 \
  20c3e28aedae00fa3ce334fae6c02e7b05980078 /path/to/proof.json
node --test test/agent-input-scan*.test.ts
```

The binary installed by `scripts/setup-review-tools.mjs` was selected on PATH.
The unchanged scan runner staged the full diff and original source blobs;
no scan exclusions, custom findings, or disabled verification were used.

Native controls used separate clean Git repositories containing the complete
original website test, with an unrelated trailing comment added in the head.
The [exact source](control-exact.json) was admitted. Changing
`example-password` to `example-passwore` was [refused](control-password.json);
adding one leading space to the password-only source line was
[refused](control-line.json); moving the file to the original path plus `.other`
was [refused](control-path.json). Each refusal came from actual scanner findings.

The three new addition/removal/context regression cases fail against the base
policy and pass with this qualification. Constructed classifier records also
cover changed literal, line, path, file mode, verified status, and decoder.
The preexisting question fixture shares this test setup and retains both of its
decoders. The website qualification permits only observed PLAIN decoding, the
exact raw identities and complete line, original path, regular-file mode, and
committed base/head references. The username-only URL produced no native finding
and receives no qualification.

Limits: this is source-admission proof using a controlled prompt, without model
execution or a production queue/deployment claim. A hosted review must rescan
its own complete prompt, schema, and source inputs. Requalify if the fixture,
scanner version, or source-binding contract changes.
