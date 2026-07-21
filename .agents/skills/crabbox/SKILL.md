---
name: crabbox
description: Use the Crabbox wrapper for validation across Linux, macOS, Windows, and WSL2, including delegated Blacksmith Testbox proof. Report the actual provider and id.
---

# Crabbox

## Provider Selection Contract

Provider selection is configuration resolution, not testing policy. Run
`crabbox config show` from the exact worktree being tested; a session may have
started in another checkout whose repository config or skill text is stale. A
request to "use Crabbox" does not authorize a provider override. When the user
does not name a backend, omit `--provider` and preserve the resolved provider,
including values supplied by user config or `CRABBOX_PROVIDER`.

Test scope, expected duration, and hydration failures do not select a provider.
Override the resolved provider only when the user explicitly names a different
backend. If that provider cannot perform the requested test, report the blocker
instead of silently selecting another backend.

Use the Crabbox wrapper for validation execution, environment lifecycle, sync,
logs/results, cache inspection, and lease cleanup.

Crabbox is the transport/orchestration surface. The actual backend can be:

- local Docker isolation: `provider=local-container`, lease ids like `cbx_...`
- brokered AWS Crabbox: direct provider, `provider=aws`, lease ids like
  `cbx_...`, `syncDelegated=false`
- Blacksmith Testbox through Crabbox: delegated provider,
  `provider=blacksmith-testbox`, ids like `tbx_...`, `syncDelegated=true`

The provider-specific sections below document capabilities and commands after
configuration or an explicit user request has selected a backend. They are not
provider-selection policy. Their validation commands intentionally omit
`--provider`; add it only to carry out an explicit user override of the resolved
configuration.

Provider identity must remain attached to a lease after creation. A lease
created through the resolved configuration can keep using provider-neutral
commands while that configuration is unchanged. If the user explicitly
overrode the provider, or the resolved configuration has changed since the
lease was created, pass the provider reported by Crabbox to every later command
that targets that lease, including hydrate, rerun, desktop/WebVNC, status,
inspect, SSH, and stop. This preserves resource identity; it does not select a
provider for unrelated work.

When the resolved configuration selects Blacksmith Testbox, or the user
explicitly requests it, do not describe the run as "AWS Crabbox". Report it as
Testbox-through-Crabbox with the `tbx_...` id and Actions run.

Direct AWS supports persistent leases, `--fresh-pr`, `--full-resync`,
environment forwarding, capture/download, and provider-comparison workflows.
Blacksmith Testbox provides a prepared CI environment and delegated broad/heavy
`pnpm` gates. These capabilities do not override the resolved configuration.

## First Checks

- Run from the repo root. Crabbox sync mirrors the current checkout.
- Check the wrapper and providers before Crabbox work:

```sh
command -v crabbox
../crabbox/bin/crabbox --version
../crabbox/bin/crabbox run --help | sed -n '1,120p'
../crabbox/bin/crabbox desktop launch --help
../crabbox/bin/crabbox webvnc --help
```

- OpenClaw scripts prefer `../crabbox/bin/crabbox` when present. The user PATH
  shim can be stale.
- Read `.crabbox.yaml`, then run `crabbox config show` from the repository root
  before selecting a provider. The resolved provider can come from the user's
  Crabbox config or environment as well as the repository file.
- Omitting `--provider` means "use the resolved configuration". Pass it only
  when the user explicitly requests a different backend, and report the
  provider from Crabbox output rather than inferring it from bootstrap wording.
- Treat `CRABBOX_PROVIDER` as part of that resolved provider configuration. The
  provider reported by `crabbox config show` is authoritative; a hydration or
  test failure is not permission to switch backends. Override it only when the
  user explicitly names another provider.
- Some package-manager wrappers insert a command delimiter before Crabbox
  options. If the printed command looks like `crabbox run -- --provider ...`
  or `crabbox run -- --no-hydrate ...`, call the trusted Crabbox binary
  directly so lifecycle flags are parsed by Crabbox.
- The brokered AWS default is a Linux developer image in `eu-west-1`; the repo
  config pins hot `eu-west-1a/b/c` placement so Fast Snapshot Restore can apply.
  If warmup drifts well past the minute-scale path, verify image promotion,
  region/AZ placement, and FSR state before blaming OpenClaw.
- Targeted and broad `pnpm` gates both use the resolved provider. Test size does
  not authorize a provider override.
- Always report the provider field and id. Both local-container and direct
  providers can use `cbx_...`, so the id prefix alone does not prove AWS;
  `tbx_...` identifies Blacksmith Testbox through Crabbox. If the output only
  says `blacksmith testbox list`, use `blacksmith testbox list --all` before
  concluding no box exists.
- If a warm direct-provider lease smells stale, retry with `--full-resync`
  (alias `--fresh-sync`) before replacing the lease. This resets the remote
  workdir, skips the fingerprint fast path, reseeds Git when possible, and
  uploads the checkout from scratch.
- For live/provider bugs, use the configured secret workflow before downgrading
  to mocks. Copy only the exact needed key into the remote process environment
  for that one command. Do not print it, do not sync it as a repo file, and do
  not leave it in remote shell history or logs. If no secret-safe injection path
  is available, say true live provider auth is blocked instead of silently using
  a fake key.
- Targeted versus broad describes test scope only; it does not imply local,
  remote, host, or container execution.
- Do not treat unrelated inherited shell controls as operator intent. In
  particular, `OPENCLAW_LOCAL_CHECK_MODE=throttled` from the local shell is not
  permission to move broad `pnpm check:changed`, `pnpm test:changed`, full
  `pnpm test`, or lint/typecheck fan-out onto the laptop. This does not negate
  provider-selection variables such as `CRABBOX_PROVIDER`, which are resolved
  and reported by `crabbox config show`.
- `OPENCLAW_LOCAL_CHECK_MODE=throttled|full` controls direct host execution; it
  is separate from Crabbox provider selection and must not override the provider
  reported by `crabbox config show`.

## macOS And Windows Targets

Use these only when the task needs an existing non-Linux host. OpenClaw Linux
validation uses the resolved Crabbox configuration unless the user explicitly
requests another provider or target.

Native Windows is available when the resolved provider supports that target.
For providers other than AWS, keep placement and capacity in their resolved
configuration:

```sh
../crabbox/bin/crabbox warmup \
  --target windows \
  --windows-mode normal \
  --timing-json
```

AWS has a provider-specific placement requirement: the OpenClaw Windows
developer image and Docker cache are available in `us-west-2`, and native
Windows leases must use on-demand capacity. After `crabbox config show` confirms
`provider=aws` (or the user explicitly selects AWS), use:

```sh
CRABBOX_AWS_REGION=us-west-2 \
CRABBOX_CAPACITY_REGIONS=us-west-2 \
../crabbox/bin/crabbox warmup \
  --target windows \
  --windows-mode normal \
  --market on-demand \
  --timing-json
```

The region variables pin both the AWS image lookup and the capacity candidate
set because `warmup` does not expose a generic `--region` flag. These placement
and market settings are AWS availability constraints applied after provider
selection; they are not a reason to select AWS for other runs. If the user
explicitly requests AWS while `crabbox config show` resolves another provider,
add `--provider aws` to this command to carry out that explicit override.

The hydrate workflow assumes Docker should already be baked into Linux images
and only installs it as a fallback. Do not add per-run Docker installs to proof
commands unless the image probe shows Docker is actually missing.

When the user explicitly asks for brokered macOS runners, use Crabbox AWS
macOS only after confirming the deployed coordinator supports EC2 Mac host
lifecycle/image routes and the operator has AWS EC2 Mac Dedicated Host quota
and IAM. Prefer `CRABBOX_HOST_ID` for a known Crabbox-managed Dedicated Host,
or run the no-spend preflight first:

These administration commands specify AWS because they inspect or allocate an
AWS EC2 Dedicated Host. The explicit provider is a billing and resource-scope
safety boundary, not a validation default.

```sh
crabbox admin hosts quota --provider aws --target macos --region eu-west-1 --type mac2.metal --json
crabbox admin hosts allocate --provider aws --target macos --region eu-west-1 --type mac2.metal --dry-run --json
CRABBOX_MACOS_TYPES=all scripts/macos-host-region-preflight.sh
```

Do not silently substitute AWS macOS for normal OpenClaw Linux proof. Report
paid-host blockers as quota, IAM, coordinator deployment, or host availability
instead of falling back to local macOS.

Crabbox supports static SSH targets:

These commands specify `ssh` because the user-supplied static host selects that
transport explicitly; they do not establish an SSH preference for other runs.

```sh
../crabbox/bin/crabbox run --provider ssh --target macos --static-host mac-studio.local -- xcodebuild test
../crabbox/bin/crabbox run --provider ssh --target windows --windows-mode normal --static-host win-dev.local -- pwsh -NoProfile -Command "dotnet test"
../crabbox/bin/crabbox run --provider ssh --target windows --windows-mode wsl2 --static-host win-dev.local -- pnpm test
```

- `target=macos` and `target=windows --windows-mode wsl2` use the POSIX SSH,
  bash, Git, rsync, and tar contract.
- Native Windows uses OpenSSH, PowerShell, Git, and tar; sync is manifest tar
  archive transfer into `static.workRoot`. Direct native Windows runs support
  `--script*`, `--env-from-profile`, `--preflight`, and PowerShell `--shell`.
- `crabbox actions hydrate/register` are Linux-only today; use plain
  `crabbox run` loops for static macOS and Windows hosts.
- Live proof needs a reachable, operator-managed SSH host. Without one, verify
  with `../crabbox/bin/crabbox run --help`, config/flag tests, and the Crabbox
  Go test suite.

## Direct Brokered AWS Backend

This section applies only after the resolved configuration or an explicit user
request selects direct AWS Crabbox.

Changed gate:

```sh
../crabbox/bin/crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
```

Full suite:

```sh
../crabbox/bin/crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test"
```

Focused rerun:

```sh
../crabbox/bin/crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test <path-or-filter>"
```

Read the JSON summary. Useful fields:

- `provider`: `aws`
- `leaseId`: `cbx_...`
- `syncDelegated`: `false`
- `commandPhases`: populated when the command prints `CRABBOX_PHASE:<name>`
- `commandMs` / `totalMs`
- `exitCode`

Crabbox should stop one-shot AWS leases automatically after the run. Verify
cleanup when a run fails, is interrupted, or the command output is unclear:

```sh
../crabbox/bin/crabbox list --provider aws
```

The explicit provider keeps cleanup attached to the AWS lease recorded by the
run, including when AWS was a user-requested override of another configured
default.

## Blacksmith Testbox Through Crabbox

This section applies only after the resolved configuration or an explicit user
request selects Blacksmith Testbox:

A fresh Testbox requires a repository-specific workflow. Crabbox resolves it
from `blacksmith.workflow`, falling back to `actions.workflow`; job and ref use
the equivalent Blacksmith values with Actions fallbacks. The workflow must
contain a `useblacksmith/testbox`, `useblacksmith/begin-testbox`, or
`useblacksmith/run-testbox` step. Confirm both the effective config and the
actual workflow before using the provider-neutral command below; nonempty
fields alone do not prove that an ordinary Actions workflow is Testbox-capable.

For a local workflow path, validate it with:

```sh
rg -n 'useblacksmith/(testbox|begin-testbox|run-testbox)' <workflow-path>
```

For a workflow name or id, inspect its YAML through GitHub before dispatch. Do
not guess a Testbox workflow from another repository.

If the user explicitly supplies a Blacksmith override, carry those exact values
on the command instead:

```sh
../crabbox/bin/crabbox run \
  --provider blacksmith-testbox \
  --blacksmith-workflow <repository-workflow> \
  --timing-json -- <test-command>
```

Add `--blacksmith-org`, `--blacksmith-job`, and `--blacksmith-ref` only when the
user supplies those overrides. The explicit provider and workflow flags in this
form implement the user's repository-specific selection; they are not defaults
for other runs.

```sh
../crabbox/bin/crabbox run \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 pnpm check:changed
```

Read the JSON summary and the Testbox line. Useful fields:

- `provider`: `blacksmith-testbox`
- `leaseId`: `tbx_...`
- `syncDelegated`: `true`
- `syncPhases`: delegated/skipped because Blacksmith owns checkout/sync
- Actions run URL/id from the Testbox output
- `exitCode`

`blacksmith testbox list` may hide hydrating or ready boxes. Use:

```sh
blacksmith testbox list --all
blacksmith testbox status <tbx_id>
```

## Observability Flags

Use these on debugging runs before inventing ad hoc logging:

- `--preflight`: prints run context, workspace mode, SSH target, remote user/cwd,
  and target-specific tool probes. Defaults cover `git`, `tar`, `node`, `npm`,
  `corepack`, `pnpm`, `yarn`, `bun`, `docker`, plus POSIX
  `sudo`/`apt`/`bubblewrap` and native Windows
  `powershell`/`execution_policy`/`longpaths`/`temp`/`pwsh`. Add
  `--preflight-tools node,bun,docker`, `CRABBOX_PREFLIGHT_TOOLS`, or repo
  `run.preflightTools` to replace the list. `default` expands built-ins; `none`
  prints only the workspace summary. Preflight is diagnostic only; install
  toolchains through Actions hydration, images, devcontainer/Nix/mise/asdf, or
  the run script. On `blacksmith-testbox`, this prints a delegated-unsupported
  note because the workflow owns setup.
- `CRABBOX_ENV_ALLOW=NAME,...`: forwards only listed local env vars for direct
  providers and prints `set len=N secret=true` style summaries. On
  `blacksmith-testbox`, env forwarding is unsupported; put secrets in the
  Testbox workflow instead.
- `--env-from-profile <file>` plus `--allow-env NAME`: loads simple
  `export NAME=value` / `NAME=value` lines from a local profile without
  executing it, then forwards only allowlisted names. `--allow-env` is
  repeatable and comma-separated. Profile values override ambient allowlisted
  env values for that run. Direct POSIX, WSL2, and native Windows runs are
  supported; delegated providers are not. Crabbox probes the uploaded profile
  remotely and prints redacted presence/length metadata before the command.
- `--env-helper <name>`: with `--env-from-profile` on POSIX SSH targets,
  persists `.crabbox/env/<name>` and `.crabbox/env/<name>.env` so follow-up
  commands on the same lease can run through `./.crabbox/env/<name> <command>`.
  Use only on leases you control; the profile stays until cleanup, lease reset,
  or `--full-resync`.
- `--script <file>` / `--script-stdin`: upload a local script into
  `.crabbox/scripts/` and execute it on the remote box. Shebang scripts execute
  directly on POSIX; scripts without a shebang run through `bash`. Native
  Windows uploads run through Windows PowerShell, and Crabbox appends `.ps1`
  when needed. Arguments after `--` become script args.
- `--fresh-pr owner/repo#123|URL|number`: skip dirty local sync and create a
  fresh remote checkout of the GitHub PR. Bare numbers use the current repo's
  GitHub origin. Add `--apply-local-patch` only when the current local
  `git diff --binary HEAD` should be applied on top of that PR checkout.
- `--full-resync` / `--fresh-sync`: reset a stale direct-provider workdir
  before syncing. Use after sync fingerprints look wrong, SSH times out before
  sync, or rsync watchdog output suggests it. It is redundant with
  `--fresh-pr`, incompatible with `--no-sync`, and unsupported by delegated
  providers.
- `--capture-stdout <path>` / `--capture-stderr <path>`: write remote streams to
  local files and keep binary/noisy output out of retained logs. Parent
  directories must already exist. These are direct-provider only.
- `--capture-on-fail`: on non-zero direct-provider exits, downloads
  `.crabbox/captures/*.tar.gz` with `test-results`, `playwright-report`,
  `coverage`, JUnit XML, and nearby logs. Treat as secret-bearing until reviewed.
- `--keep-on-failure`: leave a failed one-shot lease alive for live debugging
  until idle/TTL expiry. Useful on direct providers and delegated one-shots.
- `--timing-json`: final machine-readable timing. Add
  `echo CRABBOX_PHASE:install`, `CRABBOX_PHASE:test`, etc. in long shell
  commands; direct providers and Blacksmith Testbox both report them as
  `commandPhases`.

Live-provider debug template for the resolved direct-provider lease:

```sh
mkdir -p .crabbox/logs
../crabbox/bin/crabbox run \
  --preflight \
  --allow-env OPENAI_API_KEY,OPENAI_BASE_URL \
  --timing-json \
  --capture-stdout .crabbox/logs/live-provider.stdout.log \
  --capture-stderr .crabbox/logs/live-provider.stderr.log \
  --capture-on-fail \
  --shell -- \
  "echo CRABBOX_PHASE:install; pnpm install --frozen-lockfile; echo CRABBOX_PHASE:test; pnpm test:live"
```

Do not pass `--capture-*`, `--download`, `--checksum`, `--force-sync-large`, or
`--sync-only` to delegated providers. Also do not pass `--script*`,
`--fresh-pr`, `--full-resync`, or `--env-helper` there. Crabbox rejects these
because the provider owns sync or command transport. `--keep-on-failure` is OK
for delegated one-shots when you need to inspect a failed lease.

## Efficient Bug E2E Verification

Use the smallest Crabbox lane that proves the reported user path, not just the
touched code. Aim for one after-fix E2E proof before commenting, closing, or
opening a PR for a user-visible bug.

When the user says "test in Crabbox", do not simply copy tests to the remote
box and run them there. Crabbox is for remote real-scenario proof: copy or
install OpenClaw as the user would, run the same setup/update/CLI/Gateway/API
call that failed, and capture behavior from that entrypoint. For regressions or
bug reports, prove the broken state first when feasible, then run the same
scenario after the fix.

Pick the lane by symptom:

- Docker/setup/install bug: build a package tarball and run the matching
  `scripts/e2e/*-docker.sh` or package script. This proves npm packaging,
  install paths, runtime deps, config writes, and container behavior.
- Provider/model/auth bug: prefer true live E2E. Use the configured secret
  workflow, then inject the single needed key into Crabbox if needed. Scrub
  unrelated provider env vars in the child command so interactive defaults do
  not drift to another provider. If only a dummy key is used, label the proof
  narrowly, e.g. "UI/install path only; live provider auth not exercised."
- Channel delivery bug: use the channel Docker/live lane when available; include
  setup, config, gateway start, send/receive or agent-turn proof, and redacted
  logs.
- Gateway/session/tool bug: prefer an end-to-end CLI or Gateway RPC command that
  creates real state and inspects the resulting files/API output.
- Pure parser/config bug: targeted tests may be enough, but still run a
  Crabbox command when OS, package, Docker, secrets, or service lifecycle could
  change behavior.

Efficient flow:

1. Reproduce or prove the pre-fix symptom from the real user-facing entrypoint
   when feasible. If the issue cannot be reproduced, capture the exact command
   and observed behavior instead.
2. Patch locally and run narrow local tests for edit speed.
3. Run one Crabbox E2E command that starts from the user-facing entrypoint:
   package install, Docker setup, onboarding, channel add, gateway start, or
   agent turn as appropriate.
4. Record proof as: Testbox id, command, environment shape, redacted secret
   source, and copied success/failure output.
5. If the issue says "cannot reproduce", ask for the missing config/log fields
   that would distinguish the tested path from the reporter's path.

Keep it efficient:

- Reuse existing E2E scripts and helper assertions before writing ad hoc shell.
- Use `--script <file>` or `--script-stdin` for multi-line E2E commands instead
  of quote-heavy `--shell` strings on direct SSH providers.
- Use `--fresh-pr <pr>` when validating an upstream PR in isolation from the
  local dirty tree. Add `--apply-local-patch` only when testing a local fixup on
  top of that PR.
- Use `--full-resync` before replacing a warmed direct-provider lease when the
  remote workdir or sync fingerprint appears stale.
- Use one-shot Crabbox for a single proof; use a reusable Testbox only when
  several commands must share built images, installed packages, or live state.
- Prefer `OPENCLAW_CURRENT_PACKAGE_TGZ` with Docker/package lanes when testing a
  candidate tarball; prefer the repo's package helper instead of direct source
  execution when the bug might be packaging/install related.
- Keep secrets redacted. It is fine to report key presence, source, and length;
  never print secret values.
- Include `--timing-json` on broad or flaky runs when command duration or sync
  behavior matters.

Before/after PR proof on delegated Testbox:

- For PRs that should prove "broken before, fixed after", compare base and PR
  on the same Testbox when practical. Fetch both refs, create detached temp
  worktrees under `/tmp`, install in each, then run the same harness twice.
- Do not checkout base/PR refs in the synced repo root. Delegated Testbox sync
  may leave the root dirty with local files; `git checkout` can abort or mix
  proof state.
- Temp harness files under `/tmp` do not resolve repo packages by default. Put
  the harness inside the worktree, or in ESM use
  `createRequire(path.join(process.cwd(), "package.json"))` before requiring
  workspace deps such as `@lydell/node-pty`.
- For full-screen TUI/CLI bugs, a PTY harness is stronger than helper-only
  assertions. Use a real PTY, wait for visible lifecycle markers, send input,
  then send control keys and assert process exit/stuck behavior.
- When validating a rebased local branch before push, remember delegated sync
  usually validates synced file content on a detached dirty checkout, not a
  remote commit object. Record the local head SHA, changed files, Testbox id,
  and final success markers; after pushing, ensure the pushed SHA has the same
  file content.
- If GitHub CI is still queued but the exact changed content passed Testbox
  `pnpm check:changed`, `pnpm check:test-types`, and the real E2E proof, it is
  reasonable to merge once required checks allow it. Note any still-running
  unrelated shards in the proof comment instead of waiting forever.

Interactive CLI/onboarding:

- For full-screen or prompt-heavy CLI flows, run the target command inside tmux
  on the Crabbox and drive it with `tmux send-keys`; capture proof with
  `tmux capture-pane`, redacted through `sed`.
- Prefer deterministic arrow navigation over search typing for Clack-style
  searchable selects. Raw `send-keys -l openai` may not trigger filtering in a
  tmux pane; inspect option order locally or on-box and send exact Down/Enter
  sequences.
- Isolate mutable state with `OPENCLAW_STATE_DIR=$(mktemp -d)`. Plugin npm
  installs live under that state dir (`npm/node_modules/...`), not under
  `OPENCLAW_CONFIG_DIR`. Verify downloads by checking the state dir, package
  lock, and installed package metadata.
- To test automatic setup installs against local package artifacts, use
  `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1` plus
  `OPENCLAW_PLUGIN_INSTALL_OVERRIDES='{"plugin-id":"npm-pack:/tmp/plugin.tgz"}'`.
  Pack with `npm pack`, set an isolated `OPENCLAW_STATE_DIR`, and verify the
  package under `npm/node_modules`. Overrides are test-only and must not be
  treated as official/trusted-source installs.
- For OpenAI/Codex onboarding proof, the useful markers are the UI line
  `Installed Codex plugin`, `npm/node_modules/@openclaw/codex`, and the
  package-lock entry showing the bundled `@openai/codex` dependency. A dummy
  OpenAI-shaped key can prove only UI/install behavior; it is not live auth.

## Reuse And Keepalive

For most Crabbox calls, one-shot is enough. Use reuse only when you need
multiple manual commands on the same hydrated box.

The examples below assume the lease came from the still-current resolved
configuration. For a lease created through an explicit provider override, add
`--provider <reported-provider>` to every reuse, inspection, and cleanup command
instead of relying on the id to recover its backend.

If Crabbox returns a reusable id or you intentionally keep a lease:

```sh
../crabbox/bin/crabbox run --id <cbx_id-or-slug> --no-sync --timing-json --shell -- "pnpm test <path>"
```

Stop boxes you created before handoff:

```sh
../crabbox/bin/crabbox stop <id-or-slug>
blacksmith testbox stop --id <tbx_id>
```

## Interactive Desktop And WebVNC

Before using WebVNC, confirm the resolved provider supports both desktop and a
coordinator-backed WebVNC lease, and that broker login is configured. Crabbox
0.39 WebVNC supports coordinator-backed Hetzner, AWS, and Azure desktop leases;
this capability list does not establish a provider preference. If the resolved
provider lacks WebVNC, do not switch providers: use native `crabbox vnc` on the
same provider when it supports that path, or report the capability blocker.

When those preconditions hold, prefer WebVNC for human inspection because the
browser portal can preload the lease VNC password and avoids a native VNC
client's copy/paste/password dance. Use native `crabbox vnc` when the browser
portal is unavailable or broken, or the user explicitly wants a local VNC
client.

Common desktop flow:

```sh
../crabbox/bin/crabbox warmup --desktop --browser --idle-timeout 60m --ttl 240m
../crabbox/bin/crabbox desktop launch --id <cbx_id-or-slug> --browser --url https://example.com --webvnc --open --take-control
```

Useful WebVNC commands:

```sh
../crabbox/bin/crabbox webvnc --id <cbx_id-or-slug> --open --take-control
../crabbox/bin/crabbox webvnc daemon start --id <cbx_id-or-slug> --open --take-control
../crabbox/bin/crabbox webvnc daemon status --id <cbx_id-or-slug>
../crabbox/bin/crabbox webvnc daemon stop --id <cbx_id-or-slug>
../crabbox/bin/crabbox webvnc status --id <cbx_id-or-slug>
../crabbox/bin/crabbox webvnc reset --id <cbx_id-or-slug> --open --take-control
../crabbox/bin/crabbox desktop doctor --id <cbx_id-or-slug>
../crabbox/bin/crabbox desktop click --id <cbx_id-or-slug> --x 640 --y 420
../crabbox/bin/crabbox desktop paste --id <cbx_id-or-slug> --text "user@example.com"
../crabbox/bin/crabbox desktop key --id <cbx_id-or-slug> ctrl+l
../crabbox/bin/crabbox artifacts collect --id <cbx_id-or-slug> --all --output artifacts/<slug>
../crabbox/bin/crabbox artifacts publish --dir artifacts/<slug> --pr <number>
```

`desktop launch --webvnc --open` is usually the nicest one-shot: it starts the
browser/app inside the visible session, bridges the lease into the authenticated
WebVNC portal, and opens the portal. Keep browsers windowed for human QA; use
`--fullscreen` only for capture/video workflows.
For human handoff, include `--take-control` so the opened portal viewer gets
keyboard/mouse control automatically instead of landing as an observer.

Human handoff preflight:

- Do not assume a visible desktop or launched browser means the repo CLI/app is
  installed, built, or on the interactive terminal's `PATH`.
- Before handing WebVNC to a human tester, prove the expected command from the
  same kept lease and from a neutral directory such as `~`.
- If the handoff needs repo-local code, sync/build/link it explicitly on that
  lease. Source-tree CLIs often need build output before a symlink works.
- Prefer a real `command -v <expected-command> && <expected-command> --version`
  check over a repo-root-only `pnpm ...` command.

Generic handoff repair pattern:

```sh
../crabbox/bin/crabbox run --id <cbx_id-or-slug> --full-resync --shell -- \
  "set -euo pipefail
   pnpm install --frozen-lockfile
   pnpm build
   sudo ln -sf \"\$PWD/<cli-entry>\" /usr/local/bin/<expected-command>
   cd ~
   command -v <expected-command>
   <expected-command> --version"
```

## If Crabbox Fails

Keep the fallback narrow. First decide whether the failure is Crabbox itself,
the brokered AWS lease, Blacksmith/Testbox, repo hydration, sync, or the test
command.

Fast checks:

```sh
command -v crabbox
../crabbox/bin/crabbox --version
../crabbox/bin/crabbox run --help | sed -n '1,140p'
../crabbox/bin/crabbox doctor
command -v blacksmith
blacksmith --version
blacksmith testbox list
```

Common Crabbox-only failures:

- Provider missing or old CLI: use `../crabbox/bin/crabbox` from the sibling
  repo, or update/install Crabbox before retrying.
- Local-container hydration rejects a configured Actions `uses` step: stay on
  `provider=local-container`, add `--no-hydrate`, and perform the required
  dependency setup inside the container command. For example:

  ```sh
  ../crabbox/bin/crabbox run --no-hydrate --timing-json --shell -- \
    "corepack enable && pnpm install --frozen-lockfile && <check-command>"
  ```

  This is a hydration transport workaround, not permission to run the broad
  check on the host or silently select a remote provider.
- Bad local config: inspect `.crabbox.yaml`, `crabbox config show`, and
  `crabbox whoami`; preserve the resolved provider unless the user explicitly
  requests another backend.
- Slug/claim confusion: use the raw `cbx_...` / `tbx_...` id, or run one-shot
  without `--id`.
- Sync/timing bug: add `--debug --timing-json`; capture the final JSON and the
  printed Actions URL. Large sync warnings now include top source directories
  by file count and a hint to update `.crabboxignore` / `sync.exclude`; inspect
  those before reaching for `--force-sync-large`. Quiet rsync watchdogs and SSH
  timeouts now print `next_action=` hints; follow them, usually `--full-resync`
  first and a fresh lease second.
- Cleanup uncertainty: run `crabbox list` with the resolved configuration; for
  explicitly selected Blacksmith runs, use `blacksmith testbox list` and stop
  only boxes you created.
- Testbox queued/capacity pressure: do not retry repeatedly or switch providers.
  Report the blocker and preserve the resolved provider.

If the resolved direct provider cannot dispatch, sync, attach, or stop, retry
once with `--debug` and `--timing-json` without changing providers:

```sh
../crabbox/bin/crabbox run --debug --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed
```

Full suite:

```sh
../crabbox/bin/crabbox run --debug --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test
```

Auth fallback, only when `blacksmith` says auth is missing:

```sh
blacksmith auth login --non-interactive --organization openclaw
```

Raw Blacksmith footguns:

- Run from repo root. The CLI syncs the current directory.
- Save the returned `tbx_...` id in the session.
- Reuse that id for focused reruns; stop it before handoff.
- Raw commit SHAs are not reliable `warmup --ref` refs; use a branch or tag.
- Treat `blacksmith testbox list` as cleanup diagnostics, not a shared reusable
  queue.

If the selected Blacksmith backend is down or quota-limited, do not keep probing
it or switch providers. Report the delegated-provider outage.

## Blacksmith Backend Notes

Crabbox Blacksmith backend delegates setup to:

- the organization reported by `crabbox config show`
- a Testbox-capable `blacksmith.workflow` or `actions.workflow` in the target
  repository
- `blacksmith.job` / `blacksmith.ref`, with `actions.job` / `actions.ref`
  fallbacks

The hydration workflow owns checkout, Node/pnpm setup, dependency install,
secrets, ready marker, and keepalive. Crabbox owns dispatch, sync, SSH command
execution, timing, logs/results, and cleanup.

Minimal configured Blacksmith-backed Crabbox run, from repo root. Do not use
this fresh-run form until the effective workflow is present and verified as
Testbox-capable; supply the explicit user-provided workflow above or reuse an
existing Testbox id instead.

```sh
../crabbox/bin/crabbox run --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test:changed
```

Use direct Blacksmith only when Crabbox is the broken layer and you are
isolating a Crabbox bug. Prefer direct `blacksmith testbox list` for cleanup
diagnostics, not as a reusable work queue.

Important Blacksmith footguns:

- Always run from repo root. The CLI syncs the current directory.
- Raw commit SHAs are not reliable `warmup --ref` refs; use a branch or tag.
- If auth is missing and browser auth is acceptable:

```sh
blacksmith auth login --non-interactive --organization openclaw
```

## Brokered AWS

This section applies only after the resolved configuration or an explicit user
request selects AWS. Do not infer AWS from an omitted `--provider`.

Confirm the selection first:

```sh
crabbox config show
crabbox doctor
```

For Linux, the repository configuration supplies the broker URL, developer
image, `eu-west-1` default region, capacity-region candidates, and
spot-to-on-demand capacity policy. Do not repeat those values on every command;
the resolved configuration remains the source of truth. For native Windows,
use the `us-west-2` on-demand command in "macOS And Windows Targets" above. For
brokered macOS, complete the quota/IAM and no-spend Dedicated Host preflight in
that section before allocation. If the user explicitly selects AWS over a
different resolved provider, add `--provider aws` to the AWS commands below.

```sh
../crabbox/bin/crabbox warmup --idle-timeout 90m
../crabbox/bin/crabbox actions hydrate --id <cbx_id-or-slug>
../crabbox/bin/crabbox run --id <cbx_id-or-slug> --timing-json --shell -- "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
../crabbox/bin/crabbox stop <cbx_id-or-slug>
```

Install/auth for owned Crabbox if needed. When configuration already resolves
AWS and only broker auth is missing, omit `--provider` so login writes the token
without changing provider selection:

```sh
brew install openclaw/tap/crabbox
crabbox login --url https://crabbox.openclaw.ai
```

If the user explicitly wants AWS as their persisted user-config default, use
`crabbox login --url https://crabbox.openclaw.ai --provider aws`. The provider
flag writes both broker auth and `provider=aws`; it is a configuration change,
not merely credential scoping. Repository config or `CRABBOX_PROVIDER` may
still take higher precedence, so confirm the effective result with
`crabbox config show` in the target worktree.

New users should self-resolve broker auth before anyone asks for AWS keys:

```sh
crabbox config show
crabbox doctor
crabbox whoami
```

- If broker auth is missing, run `crabbox login --url https://crabbox.openclaw.ai`.
  Add `--provider aws` only when the user also wants to persist AWS as their
  user-config default.
- If the CLI asks for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or AWS
  profile setup during normal OpenClaw validation, assume the agent selected
  the wrong path. Use brokered `crabbox login` or an existing brokered lease
  before asking the user for cloud credentials.
- Ask for AWS keys only for explicit direct-provider/account administration,
  not for normal brokered OpenClaw proof.
- Trusted automation that intentionally persists AWS as its default may use
  `printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url https://crabbox.openclaw.ai --provider aws --token-stdin`.

macOS config lives at:

```text
~/Library/Application Support/crabbox/config.yaml
```

It should include `broker.url` and `broker.token` for AWS lanes. Let the resolved
config select the backend; override it only when the user explicitly requests a
different provider.

### Interactive Desktop / WebVNC

For human desktop demos, prefer `webvnc` over native `vnc` and keep the remote
desktop visible/windowed. Do not fullscreen the remote browser or hide the XFCE
panel/window chrome unless the explicit goal is video/capture output. After
launch, verify a screenshot shows the desktop panel plus browser title bar. If
Chrome is fullscreen, toggle it back with:

```sh
crabbox run --id <lease> --shell -- 'DISPLAY=:99 xdotool search --onlyvisible --class google-chrome windowactivate key F11'
```

## Diagnostics

```sh
crabbox status --id <id-or-slug> --wait
crabbox inspect --id <id-or-slug> --json
crabbox sync-plan
crabbox history --limit 20
crabbox history --lease <id-or-slug>
crabbox attach <run_id>
crabbox events <run_id> --json
crabbox logs <run_id>
crabbox results <run_id>
crabbox cache stats --id <id-or-slug>
crabbox ssh --id <id-or-slug>
blacksmith testbox list
```

Use `--debug` on `run` when measuring sync timing.
Use `--timing-json` on warmup, hydrate, and run when comparing backends.
Use `--market spot|on-demand` only on AWS warmup/one-shot runs.

## Failure Triage

- Crabbox cannot find provider: verify `../crabbox/bin/crabbox --help` lists
  the provider selected by `.crabbox.yaml`; update Crabbox before falling back.
- Hydration stuck or failed: open the printed GitHub Actions run URL and inspect
  the hydration step.
- Sync failed: rerun with `--debug`; check changed-file count and whether the
  checkout is dirty.
- Command failed: rerun only the failing shard/file first. Do not rerun a full
  suite until the focused failure is understood.
- Cleanup uncertain: `crabbox list` with the resolved configuration; for
  explicitly selected Blacksmith runs, use `blacksmith testbox list` and stop
  owned `tbx_...` leases you created.
- Selected provider broken: report the provider-specific blocker; do not switch
  providers unless the user explicitly requests the fallback.

## Boundary

Do not add OpenClaw-specific setup to Crabbox itself. Put repo setup in the
hydration workflow and keep Crabbox generic around lease, sync, command
execution, logs/results, timing, and cleanup.
