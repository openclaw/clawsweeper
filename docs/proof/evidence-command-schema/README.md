# Evidence command schema proof

The generator must honor the parser's existing physical-line boundary. Multiline
commands belong verbatim in evidence detail, with a null command field, rather
than being silently flattened or rejected after a successful inference.

Send the exact evidence-item subschema from the baseline and candidate decision
schemas to the Responses API as a strict `json_schema` text format. Use a
synthetic two-line command and ask for its exact bytes in `command`, or null with
the exact command in `detail` when the schema requires one physical line. Keep
authentication and model selection in the approved private caller. Save only
the resulting synthetic evidence objects, never the response envelope or logs.

After building ClawSweeper, validate those captured outputs through the real
parser. The committed `baseline.json` and `candidate.json` are the synthetic
outputs captured from the live probe; substitute fresh captures when rerunning
generation:

```sh
node scripts/proof-evidence-command-schema.mjs docs/proof/evidence-command-schema/baseline.json docs/proof/evidence-command-schema/candidate.json /tmp/evidence-command-receipt.json
```

The baseline output must fail the parser's unchanged multiline guard. The
candidate must satisfy the current evidence schema, retain the exact command in
detail, and parse successfully. The receipt records source revision, dirty state,
schema hash, runtime and outcomes. Separate regression coverage checks all four
line separators at each position, nullable values and literal escaped newlines.

This exercises live structured generation for the changed evidence-item schema
and parsing inside a synthetic decision. It does not prove a full hosted review,
production deployment, or elimination of other content/output failures. OpenClaw
Bay continues to consume the same review contract and needs no change.
