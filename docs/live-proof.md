# Live proof

- Status: active
- Owner: ClawSweeper review and publication maintainers
- Source of truth: `src/live-proof/`, `.github/workflows/sweep.yml`,
  `.github/workflows/exact-review-batch-publish.yml`, and repository `live_test`
  profiles
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: the plan schema, security boundary, execution gates, media
  limits, storage path, or comment rendering changes

Live proof turns a review-time `liveProofPlan` into deterministic browser or
terminal execution, with an optional recording when the behavior is worth
watching. Classification and execution now happen in the same review job. The
review first writes its decision artifact, then immediately executes the typed
plan against the exact `pull_head_sha` recorded in that artifact. There is no
separate dispatch, public PR-head lookup, second hydration, or live-head check.

The planner gates execution in order: the repository must opt in with
`live_test.enabled`, the item must be a pull request, and the plan must be
`recommended` with a runnable browser or terminal surface.
`declined_suspicious` is a strict no-execution result. A `static_text` payoff
still runs and publishes verification, but it bypasses recording, transcoding,
and poster generation.

Only after those gates pass does the verification child resolve the target
repository profile's `package_manager`. If the configured Bun, pnpm, or npm
executable is missing, the child runs that package manager's official installer
inside the same sanitized scratch profile and verifies that the executable is
available before target setup. Installer failures become a failed
`live-verification.json` result and are published through the normal artifact
path; they do not fail the review itself. Reviews that do not verify never probe
or install a target package manager.

## Review-job execution

After the review command returns, the job inspects the produced reports before
installing tools. tmux is installed only when a terminal candidate exists. The
recording toolchain (`ffmpeg`, Xvfb, xterm, and related X11 tools) is installed
only when at least one recommended plan has a non-`static_text` payoff. Review
jobs use each candidate's exact reviewed-head root `go.mod` as the setup gate,
then use a root `go.work` instead when present and provision the highest
candidate baseline. A directive-less root workspace requires Go 1.18. Nested Go
configuration and mixed shards with rootless candidates enable
`GOTOOLCHAIN=auto` after setup so each proof can select a newer toolchain without
letting nested fixtures choose the shared baseline. Automatic fallback baselines
are floored at Go 1.21, the first release with toolchain switching. Root-only
candidates retain the setup action's `GOTOOLCHAIN=local`; the sanitized child
keeps the selected setting while using its private writable module cache. Review
job timeouts include the target installation and deterministic drive. Review
jobs default to `ubuntu-latest`; `CLAWSWEEPER_REVIEW_RUNNER` remains an optional
runner override.

For every candidate, trusted ClawSweeper code materializes the report's exact
head SHA into a scratch worktree, then invokes the existing `live-proof`
planner/driver/verifier as a normal child process. The security posture has
three controls:

- The review reads the entire diff before deciding whether the plan is safe.
  `liveProofPlan.status: declined_suspicious` is the execution gate. The prompt
  requires that result whenever the diff or its dependencies could plausibly
  exfiltrate, including new or bumped dependencies the reviewer cannot inspect.
- The child receives a newly constructed environment. An explicit denylist
  removes `OPENAI_API_KEY`, `CLAWSWEEPER_OPENCLAW_OPENAI_KEY`, `GH_TOKEN`,
  `GITHUB_TOKEN`, and `CLAWSWEEPER_WEBHOOK_SECRET`; provider rules remove every
  `AWS_*` and R2 variable; and a heuristic removes every name ending in
  `*_TOKEN`, `*_KEY`, `*_SECRET`, or `*_PASSWORD`. The child asserts and reports
  that zero matching names remain before it reads the plan, and every target
  setup/build/run command receives the sanitized environment again.
- Direct pnpm, npm, and Bun install commands in `live_test.setup` gain
  `--ignore-scripts` by default. This matters because a lockfile-only dependency
  bump can execute a dependency postinstall that never appears in the reviewed
  diff. A repository may opt in only with the explicit
  `live_test.allow_install_scripts: true` flag. No current repository opts in.

Untrusted target code therefore runs unsandboxed in a credentialed review job.
Environment sanitization reduces what the direct child inherits, but it is not
a kernel security boundary and does not make a suspicious plan safe. Linux
user/mount/PID/network containment remains a future hardening step; it is not a
runner requirement today. The repair lane's separate containment remains in use
and is unaffected by this live-proof policy.

HOME, package-manager caches, and temporary files point into the scratch profile.

Plans must use assertions the demonstration can satisfy. Browser interactions
should derive search or filter values from content the page already renders,
and terminal plans should assert stable output such as a header, flag, or error
string rather than counts, timings, or run-dependent numbers. When no exact
value is certain, the planner must choose a more stable assertion instead of
inventing one.

Browser plans are serialized as JSON data into a generated plain
`playwright-core` script; plan values are never inserted as source code.
Recorded browser runs use installed Chrome with a 1280x800 video context and
fall back to Playwright Chromium only when Chrome cannot launch. Browser output
is step telemetry only: ClawSweeper never serializes document text. Recorded
terminal plans use tmux, Xvfb with its TCP listener disabled, fullscreen xterm,
and ffmpeg `x11grab`; unrecorded terminal plans use tmux directly.

Browser startup writes the configured start command's output to `server.log`
and records its process in `server.pid`. Readiness polling stops early when that
process exits; both an early exit and a readiness timeout publish a one-line
startup reason plus the sanitized, capped tail of the last 40 log lines. This
usually exposes a failed build or code-generation command that ran before the
dev server could bind its port without publishing an unbounded target log.

Every drive writes `live-verification.json` with the exact reviewed head, entry,
typed steps and outcomes, bounded terminal output, and overall pass/fail result.
A setup or drive failure still publishes verification and no media. Media is
eligible only when an expectation was absent initially and satisfied after the
plan acted, and the recording passes the three-second floor. Eligible recordings
are capped at 90 seconds and 50 MB, transcoded to H.264 MP4, probed, and paired
with `poster.jpg` plus a metadata-only manifest.

## Existing artifact and publication path

The review artifact contains its report plus `live-proof/<item>/` with the
verification result and, when eligible, the manifest, MP4, and poster. The exact
review bundle binds those files into its existing hashed inventory. No second
live-proof artifact is uploaded.

The existing publication jobs download and validate the review artifact. Before
their normal record mutation, they fold each verification result into the review
report. If media exists, publication re-probes it and uploads it with its own R2
credentials to:

```text
live-proof/<repo-slug>/<item>/<head-sha>/live-proof.mp4
live-proof/<repo-slug>/<item>/<head-sha>/live-proof.jpg
```

Public URLs are constructed only from trusted publication configuration; bundle
data cannot supply a host. Publication validates the result against the report's
repository, item, type, and `pull_head_sha`, but it does not query GitHub for a
new head. The normal record publisher then writes the canonical record and the
existing comment-sync path upserts the marker-backed review comment.

Browser comments contain sanitized per-step outcomes and a one-line failing-step
reason, never page text. Terminal comments retain capped output and list
assertions only when present. A terminal command with a confirmed successful exit
still passes when its expected marker is absent from the captured pane; the
assertion remains a completed, non-gating schema-v1 step, is explicitly labeled
`NOT OBSERVED`, and cannot qualify a recording. Private command files and runner
paths never enter published terminal output. Each entry or `run` action executes
as a separately supervised Bash process in the same checkout, so plans should
share state through files or one command rather than shell-local mutations.
The terminal `entry` executes automatically before typed steps and must not be
repeated as the first `run`; exact leading duplicates are normalized away before
execution.
Nonzero exits, signals, command timeouts, and missing markers for still-running
commands remain failures.
All untrusted fields are bounded and neutralized against Markdown fences, HTML,
and ClawSweeper marker spoofing. OpenClaw Bay is unaffected because schema v1
and the existing lifecycle and publication contracts do not change.

## Local simulation

The low-level driver can still run against an existing checkout:

```bash
CLAWSWEEPER_LIVE_PROOF_ENABLED=1 node dist/clawsweeper.js live-proof \
  --repo owner/name \
  --item 123 \
  --plan ./fixtures/browser-live-proof-plan.json \
  --checkout /absolute/path/to/checkout \
  --output ./artifacts/live-proof
```

This developer command does not add sandboxing by itself. The production review
path is `live-proof-review`, which owns exact-head materialization, environment
sanitization, and the unsandboxed child invocation.

## Retracting a published recording

Retraction remains a trusted maintenance action. Run the manual **Maintain live
proof** workflow with the target repository and pull-request number. It removes
only the recording block while retaining the plan and verification result, then
publishes the canonical record and refreshes the review comment.

The maintenance workflow is `workflow_dispatch`-only. It never downloads a
review artifact, executes target code, reads a media manifest, or compares a
head SHA.
