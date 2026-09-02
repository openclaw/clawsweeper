# Modernize stdlib batch proof

This proof covers the behavior-preserving Node standard-library migration in this batch. It keeps the current CLI contracts—including exit codes, custom error strings, ignored `--` delimiters, and repeated scalar/array options—while requiring all seven leaf parsers to use `node:util` `parseArgs` with complete schemas.

Run from the repository root:

```sh
bash docs/proof/modernize-stdlib-batch/run-proof.sh origin/main
```

The red check extracts each parser from `origin/main` and fails because none of the seven files has adopted the stdlib parser. The green check inspects the working tree and requires the stdlib import in every migrated CLI. The committed [red log](artifacts/adoption-red.log) and [green log](artifacts/adoption-green.log) retain those outcomes.

For behavioral equivalence, the harness extracts the old `scripts/e2e/automerge.mjs` with `git show`, supplies its repository-relative fixture imports, and runs the same argv matrix through old and new sources: help, an ignored `--` delimiter, a repeated scalar option, an unknown option, and a missing value. It records exit status, stdout, and the semantic error line (excluding source-location-only stack frames). The [before transcript](artifacts/cli-before.txt) and [after transcript](artifacts/cli-after.txt) are byte-identical; [their diff](artifacts/cli-transcript.diff) is empty.

The controlled proof is local, read-only apart from its own artifacts, and uses no credentials or network calls. It does not exercise the migrated commands' external GitHub, Worker, Git, or Docker operations. Fresh pushed-head container provenance belongs in the pull request's `pr-behavior-proof` section.
