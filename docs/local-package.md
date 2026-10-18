# Local review package candidate

- Status: active development and qualification guide; no package release
- Owner: ClawSweeper local-runtime maintainers
- Source of truth: `scripts/stage-local-package.mjs` and `src/clawsweeper-local.ts`
- Last verified: platform integration candidate based on `fb06a964d837740bef1b8db0ad89d8083d92e9a7`
- Update when: the local entrypoint, imports, workers, assets, package format, or qualification matrix changes

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

The harness seeds a fresh npm cache, preserves the install manifest and lock,
and performs a clean offline installation before checking declared imports.

CI runs the installed-package harness on Linux, Windows, and macOS with Node
24. Each run builds and packs the candidate, installs it outside the checkout,
and invokes the installed bin from a target path containing spaces and Unicode.
On Windows, the committed-range fixtures use the real npm `.cmd` launcher;
help, errors, retained reports, history, and preflight summaries use that same
installed entry. The harness prints the actual Node version, OS, architecture,
and tarball hash. Runner labels do not qualify other architectures or every
Node 24 patch release.

The committed-range suite expects 18 tests; Windows intentionally skips two
POSIX Git fault wrappers and one case whose filenames Windows cannot represent.
Scanner fixtures validate file types and excluded secret variables, and read
materialized input files on Windows; permission-bit assertions apply only on
POSIX. The Windows test fixture is a native executable built with Windows
PowerShell 5; this compiler
is a CI prerequisite, not a package requirement. Codex and scanner
processes are deterministic fixtures, so these checks do not establish live
provider access, native scanner coverage, a published release, or global install.
Keep the original target, reports, and operator authentication separate from the
disposable install.
