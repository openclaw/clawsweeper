# Local review package candidate

- Status: active development and qualification guide; no package release
- Owner: ClawSweeper local-runtime maintainers
- Source of truth: `scripts/stage-local-package.mjs`, `src/clawsweeper-local.ts`,
  and `.github/workflows/local-package-qualification.yml`
- Verified source baseline: `a8ed845bfdad2467c4d73d8b470f4284dce625f0`; CI artifacts identify the tested source and diff
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
The tarball has the same relative filename in both install directories, so the
lock-driven installation also verifies relocation.

To retain the verified inputs, set `CLAWSWEEPER_TEST_PACKAGE_OUTPUT` to an
absolute, nonexistent directory outside the source checkout and run:

```sh
CLAWSWEEPER_TEST_PACKAGE_OUTPUT=/tmp/clawsweeper-package-envelope node --test test/local-package-install.test.ts
```

Build the Node entrypoints first. After every package and parity assertion
passes, the harness exports `clawsweeper-local.tgz`, `package.json`,
`package-lock.json`, and `manifest.json`. The manifest records input hashes,
staged files, source commit and diff hash, tool versions, platform, and the
observed dependency resolution with public npm URLs and integrity values.
An existing output directory is rejected and never overwritten.

To qualify the same envelope on another supported platform, build the Node
entrypoints there and pass its directory as the input instead:

```sh
CLAWSWEEPER_TEST_PACKAGE_INPUT=/tmp/clawsweeper-package-envelope node --test test/local-package-install.test.ts
```

The consumer verifies the producer's source commit, tree, diff hash and input
hashes before installing. It seeds an isolated cache with `npm ci` using the
original manifest and lock, removes that installation, then installs offline in
a fresh directory. Installed bytes must match the producer's staged inventory;
the original four files and resolved graph must remain unchanged. Input and
output modes cannot be combined.

CI uploads one canonical Linux-produced envelope, then downloads that exact
artifact ID for Linux, Windows and macOS consumers. These are private package
qualification artifacts, not published releases. They freeze the observed npm
resolution; dependency tarballs still need a populated cache or registry access.
This is not an empty-cache offline bundle or a Homebrew-ready distribution.
A future release must choose and qualify its dependency delivery contract.

CI runs the installed-package harness on Linux, Windows, and macOS with Node 24. Each consumer builds local entrypoints for source-unit assertions and
negative import probes, but installs the unchanged producer tarball outside
the checkout and invokes its bin from a target path containing spaces and Unicode.
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

## Proposed release rehearsal

The manual `.github/workflows/release.yml` caller is preparation only. It has
no publishing mode and cannot create a version tag, npm package, or tap change.
The existing package and command names remain private and provisional.

Both CI and the caller reuse `.github/workflows/local-package-qualification.yml`.
Its Linux producer emits one canonical four-file envelope. Linux, Windows, and
macOS must all consume the producer's exact artifact ID successfully before the
workflow exposes that ID. A failed or skipped consumer prevents the release job.

The caller pins `openclaw/release-workflows` at
`9d81ab3d2877f9900ef787e6dbcf4d9af96eb013`. That shared workflow downloads the
same-run ID into `RELEASE_ASSET_INPUT_DIR`. The dependency-free
`scripts/release-local-package-envelope.mjs` validates the original four files,
their hashes and locked resolution, and their source commit, tree, and clean
diff against the shared workflow's frozen checkout. A newer-main envelope
cannot stand in for an older tagged source. The wrapper never installs,
resolves, rebuilds, or repacks the inner npm package.

On Ubuntu, GNU tar and gzip wrap the original files as
`clawsweeper-local-envelope.tar.gz` at `RELEASE_ASSET_PATH`. Fixed file order,
ownership, modes, timestamps, and `gzip -n` make that outer archive independent
of downloaded file metadata. The original envelope bytes and checkout must
remain unchanged. The shared inventory and two verifier jobs check transport
integrity; the three consumers provide the package behavior proof.

The caller grants `actions: read`, `checks: read`, `contents: write`, and
`statuses: read` only to the pinned shared call. Its tag and publication jobs
declare write capability even in dry-run mode. `dry_run: true`, signed-tag and
strict-CI options are fixed, and Homebrew handoff is disabled. Qualification
has only `contents: read`; no secrets are inherited or supplied, and the shared
build strips token environment variables before running the wrapper.

A protected-main rehearsal is still blocked until the release maintainer
approves dated release notes matching package version `0.3.1`. The current
`0.3.1 - Unreleased` heading does not satisfy the shared metadata contract.
Do not dispatch an expected failure or invent release metadata. Public naming,
signer policy for a future real release, dependency delivery for Homebrew, and
publication require separate decisions. This caller does not establish those
outcomes or a full shared-workflow rehearsal.
