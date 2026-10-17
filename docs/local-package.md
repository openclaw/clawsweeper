# Local review package candidate

- Status: active development and qualification guide; no package release
- Owner: ClawSweeper local-runtime maintainers
- Source of truth: `scripts/stage-local-package.mjs` and `src/clawsweeper-local.ts`
- Last verified: integration candidate based on `7bcab824b1493fbb2eda8aa71835d36759095410`
- Update when: the local entrypoint, imports, workers, assets, or package format changes

The private package candidate contains the full committed-range reviewer. It
does not contain hosted admission, publication, or service state. Its package
name and `clawsweeper-review` bin are provisional; nothing is published to npm.

From a development checkout with dependencies installed, build and stage into
a new directory outside the checkout:

```sh
pnpm run package:local /tmp/clawsweeper-local-stage
npm pack /tmp/clawsweeper-local-stage --ignore-scripts --json
```

The staging command prints the files, sizes, and SHA-256 hashes. It follows the
compiled ESM imports and the three explicit worker entrypoints, then adds the
review prompts, decision schema, configuration, and scanner setup script.
Missing or unresolved imports fail staging. The generated manifest is private
and has no install hooks or development dependencies. It declares the production
dependencies reached by those imports; npm installs their dependency closure.
The source service package remains private and unchanged in scope.

Install the resulting tarball into a disposable directory to qualify it:

```sh
npm install --prefix /tmp/clawsweeper-local-install --ignore-scripts --omit=dev --no-audit --no-fund ./openclaw-clawsweeper-0.3.1.tgz
/tmp/clawsweeper-local-install/node_modules/.bin/clawsweeper-review --help
/tmp/clawsweeper-local-install/node_modules/.bin/clawsweeper-review --version
```

Node 24 or newer and Git are required. A real review also needs the configured
Codex or optional OpenClaw executable and its operator-owned authentication.
The scanner uses the existing pinned TruffleHog bootstrap; no scanner binary,
auth file, or tool cache is packaged. Install does not log in, download a
scanner, install target dependencies, or call a review model.

Run from a clean target repository or pass its path explicitly:

```sh
clawsweeper-review review --base origin/main --target-repo owner/repo --target-dir /path/to/target
```

That command runs a real model review. `--help` and `--version` do not.
Provider-free diagnostics remain deferred; `--diagnostics` currently fails
with an explanatory message. The source checkout's `codex:local:check` command
is a model smoke test, not a free diagnostic.

Candidate qualification covers isolated installation and deterministic review
fixtures. It seeds a fresh npm cache, preserves the install manifest and lock,
and performs a clean offline installation before checking declared imports.
The committed-range suite expects 18 tests; Windows intentionally
skips three POSIX or filesystem-specific cases. It does not establish a
published release, global install, live provider access, or support across every
platform. Keep the original target, reports, and operator authentication separate
from the disposable install.
