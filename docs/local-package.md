# Local review package candidate

- Status: active development and qualification guide; no package release
- Owner: ClawSweeper local-runtime maintainers
- Source of truth: `scripts/stage-local-package.mjs`, `src/clawsweeper-local.ts`,
  and `.github/workflows/local-package-qualification.yml`
- Verified source baseline: `118a07468663a22e9cc0e3fd76dfe2f17532eec0`; CI artifacts identify the tested source and diff
- Update when: the local entrypoint, imports, workers, assets, package format, or qualification matrix changes

The private package candidate contains the full committed-range reviewer. It
does not contain hosted admission, publication, or service state. The scoped
package stays private as `@openclaw/clawsweeper` and exposes the `clawsweeper`
command. It does not require npm registry publication.

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
npm install --prefix /tmp/clawsweeper-local-install --ignore-scripts --omit=dev --no-audit --no-fund ./openclaw-clawsweeper-0.3.2.tgz
/tmp/clawsweeper-local-install/node_modules/.bin/clawsweeper --help
/tmp/clawsweeper-local-install/node_modules/.bin/clawsweeper --version
```

Node 24 or newer and Git are required. A real review also needs the configured
Codex or optional OpenClaw executable and its operator-owned authentication.
The scanner uses the existing pinned TruffleHog bootstrap; no scanner binary,
auth file, or tool cache is packaged. Install does not log in, download a
scanner, install target dependencies, or call a review model.

Run from a clean target repository or pass its path explicitly:

```sh
clawsweeper review --base origin/main --target-repo owner/repo --target-dir /path/to/target
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

## Release rehearsal and publication

The manual `.github/workflows/release.yml` caller rehearses by default.
Leave `publish` false to verify release assets without publishing them. It
does not publish an npm package or change the Homebrew tap. The generated
package remains private and exposes the same `clawsweeper` command.

Publication is a separate maintainer action after the final source, release
notes, and assets are approved. Create and verify an SSH-signed annotated
`v<version>` tag at that source using a key in `.github/release-allowed-signers`,
then push that tag. Select that exact tag when dispatching the workflow and
set `publish` true. Publication from a branch or a different version tag
fails before package qualification. The pinned shared workflow verifies the
existing tag signature and protected-main source before publishing assets.
Before creating a draft, uploading each asset, or making the release public,
it also verifies the tag signer against the current protected default branch's
`.github/release-allowed-signers`. Removing a signer blocks the next checked
write, including a publisher-only retry. The policy read and release write
are not atomic: removal cannot revoke an already-issued write. This protects
runs selecting this workflow pin, including older tags routed through it;
runs or retries pinned to older workflow code do not gain the check.
An already-public release with exactly matching bytes remains a no-write
comparison, even after signer removal.
Publisher retries discover an existing draft by its exact tag and preserve its
release ID and existing asset bytes. Listing failures stop further writes.

Both CI and the caller reuse `.github/workflows/local-package-qualification.yml`.
Its Linux producer emits one canonical four-file envelope. Linux, Windows, and
macOS must all consume the producer's exact artifact ID successfully before the
workflow exposes that ID. A failed or skipped consumer prevents the release job.

The caller pins `openclaw/release-workflows` at
`933d6886e83ec26f29f13b3444638f0d7fd9cde3`. That shared workflow downloads the
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
declare write capability even in dry-run mode. The boolean `publish` input
defaults to false and controls `dry_run`; signed-tag and strict-CI options
remain fixed, and Homebrew handoff is disabled. Qualification
has only `contents: read`; no secrets are inherited or supplied, and the shared
build strips token environment variables before running the wrapper.

Every selected source must contain maintainer-approved dated release notes
matching its package version; an Unreleased heading does not satisfy the
shared contract. A successful rehearsal qualifies only that source and its
actual assets; later source changes need fresh qualification. Rehearsal does
not establish publication, signer policy, Homebrew dependency delivery, or
installed provider access, and does not exercise the real signed-tag or
publisher paths. Those outcomes require their own validation and authorization.
