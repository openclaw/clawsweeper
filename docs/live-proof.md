# Live proof

- Status: active
- Owner: ClawSweeper review and publication maintainers
- Source of truth: `src/live-proof/`, `.github/workflows/live-proof.yml`, and
  repository `live_test` profiles
- Update when: the plan schema, execution gates, media limits, storage path, or
  comment rendering changes

Live proof turns a review-time `liveProofPlan` into a short deterministic
recording of user-visible browser or terminal behavior. Classification remains
part of the existing read-only review. It records only a typed plan in the
durable report; it never executes pull request code and never publishes a URL.

After the report is published, both scheduled publication and exact-event
direct delivery in `sweep.yml` dispatch `live-proof.yml` only when the plan
status is `recommended` and the target's repository profile has
`live_test.enabled: true`. The command then applies ordered gates for
`CLAWSWEEPER_LIVE_PROOF_ENABLED=1`, repository opt-in, a recommended plan, a
runnable configured surface, and a still-open pull request. Every failed gate
is a logged successful skip, including a browser recommendation for a
terminal-only repository that has no configured server or URL.

## Execute and attach

The workflow has two jobs with different trust. `execute` has
`permissions: {}`, receives no secret environment values, checks out the public
PR head, and runs setup/start commands from the trusted repository profile. It
contains no model call. Browser plans are serialized as JSON data into a
generated plain `playwright-core` script; plan values are never inserted as
source code. The script uses installed Chrome, a 1280x800 recorded context, and
falls back to Playwright Chromium only when Chrome cannot launch. Terminal
plans use tmux, `xvfb-run`, a fullscreen xterm, and ffmpeg `x11grab`; typed
`run`, `wait`, and `expect_output` steps are replayed through the tmux pane.

Both drivers finalize the recording after a mid-plan failure and record the
result as `drive_status`. The command transcodes to H.264 MP4, probes it with
ffprobe, creates `poster.jpg`, enforces the repository's recording limit and a
50 MB MP4 cap, and writes `steps-log.json` plus a metadata-only
`live-proof-manifest.json`. The manifest contains no media URL. The bundle is
retained as a GitHub Actions artifact for seven days.

The trusted `attach` job checks out only ClawSweeper `main`; it never checks out
or executes target PR code. It treats the downloaded bundle as untrusted,
strictly validates the manifest, rejects extra URL fields, probes the MP4 and
poster again, rechecks size/duration/dimensions, and refuses a stale PR head.
Only then does it upload `live-proof.mp4` and `poster.jpg` with `aws s3 cp` to:

```text
live-proof/<repo-slug>/<item>/<head-sha>/live-proof.mp4
live-proof/<repo-slug>/<item>/<head-sha>/live-proof.jpg
```

The attach job constructs both public URLs from its trusted
`CLAWSWEEPER_LIVE_PROOF_BASE_URL`; bundle data cannot supply a host or URL. It
updates the durable report's `Live Proof` section, re-renders the existing
review presentation, upserts the marker-backed comment with a target-scoped
write token, updates the comment-sync front matter, and publishes the changed
canonical record. OpenClaw Bay is unaffected: this lane changes a durable
report and its existing GitHub comment, not Bay's observer-only data contract
or controls.

## ClawSweeper Bay demo

The `openclaw/clawsweeper` repository profile enables browser live proof against
the local OpenClaw Bay at `http://127.0.0.1:8787`. Its maintained launcher and
data seeder live in `scripts/live-proof/bay-demo/`: `start.sh` creates a
throwaway `.dev.vars` and Wrangler state directory outside the checkout, starts
the dashboard Worker in the foreground, and runs `seed.mjs` after the health
endpoint becomes ready. The dependency-free Node seeder fills the local Worker
with representative ClawSweeper lifecycle and workflow records so recordings
show real Bay cards and stage content instead of an empty dashboard.

The profile installs the PR head with `pnpm install --frozen-lockfile`, allows
240 seconds for the Worker and seed data to become ready, and retains the
lane-wide 90-second recording limit. The temporary signing value is generated
for each launcher process; the demo neither requires production credentials nor
writes a `.dev.vars` or Wrangler state into the tracked tree.

## Local simulation

The execution lane can run without GitHub or an API key against an existing
checkout. The target repository must still have an enabled `live_test` profile.
Pass a JSON fixture containing either the `liveProofPlan` object itself or an
object with a `liveProofPlan` property:

```bash
CLAWSWEEPER_LIVE_PROOF_ENABLED=1 node dist/clawsweeper.js live-proof \
  --repo owner/name \
  --item 123 \
  --plan ./fixtures/browser-live-proof-plan.json \
  --checkout /absolute/path/to/checkout \
  --output ./artifacts/live-proof
```

`--plan` bypasses report-artifact lookup. `--checkout` uses that checkout's
current Git HEAD and logs that the live PR kind/open lookup is skipped. The
environment, profile, and plan-status gates still run in their normal order.

To validate an attachment without GitHub, R2, or credentials, point the attach
command at a local media bundle and report and supply non-secret example
origins. Dry-run mode performs strict manifest/media/report validation, uses
the report head for the simulated freshness check, and prints the exact two
`aws s3 cp` commands, replacement report section, and marker-backed comment
body without making a mutation:

```bash
CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT=https://example.r2.cloudflarestorage.com \
CLAWSWEEPER_LIVE_PROOF_BUCKET=example-live-proof \
CLAWSWEEPER_LIVE_PROOF_BASE_URL=https://media.example.test \
node dist/clawsweeper.js live-proof-attach \
  --bundle ./artifacts/live-proof \
  --record ./fixtures/report.md \
  --dry-run
```

## Security invariants

- Classification is read-only and executes no target code.
- Execute has no GitHub permissions, secrets, credentials, or inference; the
  disposable GitHub-hosted VM is the isolation boundary.
- Drivers replay only schema-validated typed steps, with at most ten actions
  and a recording cap of 90 seconds.
- The artifact manifest is metadata-only. Unknown keys, including any injected
  URL field, are rejected by attach.
- R2 credentials, the public base URL, the canonical-record credential, and
  the target write token exist only in attach.
- Attach validates media and current PR head before upload, constructs URLs
  from trusted configuration, and never runs code from the target checkout.
