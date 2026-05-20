# Deploying the ClawSweeper dashboard for valkyriweb

Fork-specific runbook for getting `dashboard/worker.ts` live on Luke's Cloudflare account. Read once, then rerun in ~10 minutes.

Upstream's `dashboard.openclaw.ai` deployment belongs to OpenClaw and we can't push to it. We deploy our own worker at `clawsweeper.myhorizon.co.za` (or any subdomain you control) on Luke's Cloudflare account `f6a544e0beaf9e2de3f959d1e5a11611`.

## Prerequisites

- `pnpm` install completed at the repo root (`pnpm install`)
- `valkyriweb-clawsweeper` GitHub App's private key (PEM) — likely in 1Password
- The App must have **Variables: Read and write** repository permission so the runner-lane buttons work. Check at `gh api /apps/valkyriweb-clawsweeper --jq '.permissions.actions_variables'` — must say `"write"`. If not, add it at <https://github.com/settings/apps/valkyriweb-clawsweeper/permissions> and accept the new permission on the installation.
- The current App installation ID for `valkyriweb` is `132284017`.

## Step 1 — strip the openclaw.ai custom domain

`dashboard/wrangler.toml` ships with an OpenClaw-owned custom domain. Replace the `[[routes]]` block. Two options:

**Option A — workers.dev only (fastest, ugly URL).** Delete the `[[routes]]` block entirely. The worker becomes accessible at `https://clawsweeper-status.<your-subdomain>.workers.dev` (subdomain is the one Cloudflare assigned your account; visible via `pnpm dlx wrangler@4.90.0 whoami`).

**Option B — your own custom domain.** Pick a hostname on a zone you own (`clawsweeper.myhorizon.co.za`, `claws.bermont.digital`, whatever). Update the pattern:

```toml
[[routes]]
pattern = "clawsweeper.myhorizon.co.za"
custom_domain = true
```

Custom domains require the zone to already exist in Cloudflare DNS — they don't need a pre-existing DNS record (`custom_domain = true` will create one).

## Step 2 — Cloudflare auth

```bash
pnpm dlx wrangler@4.90.0 login
# Browser opens, click "Allow"
pnpm dlx wrangler@4.90.0 whoami
# Should show account id f6a544e0beaf9e2de3f959d1e5a11611 and workers.dev subdomain luke-f6a
```

## Step 3 — KV namespace for STATUS_STORE (recommended)

The worker degrades to `caches.default` if no KV is bound, which means snapshots vanish on worker restart. For a real dashboard you want a KV namespace:

```bash
# Create the KV namespace
pnpm dlx wrangler@4.90.0 kv namespace create STATUS_STORE \
  --config dashboard/wrangler.toml
# Output gives you an `id = "..."` line — copy it
```

Append to `dashboard/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATUS_STORE"
id = "PASTE_THE_ID_HERE"
```

Commit this — KV namespace IDs are not secrets.

## Step 4 — set secrets

Three secrets, all via `wrangler secret put` (never commit these). Each command prompts for the value; paste and hit enter.

```bash
# GitHub App private key. Paste the full PEM block including BEGIN/END lines.
# Literal \n sequences are normalized to newlines by the worker if needed.
pnpm dlx wrangler@4.90.0 secret put CLAWSWEEPER_APP_PRIVATE_KEY \
  --config dashboard/wrangler.toml

# Installation ID for the App on valkyriweb/clawsweeper.
# Current valkyriweb installation ID: 132284017
pnpm dlx wrangler@4.90.0 secret put CLAWSWEEPER_APP_INSTALLATION_ID \
  --config dashboard/wrangler.toml

# Auth token for the /api/events ingest endpoint AND /api/runner-mode.
# Generate one: openssl rand -hex 32
pnpm dlx wrangler@4.90.0 secret put INGEST_TOKEN \
  --config dashboard/wrangler.toml
```

`CLAWSWEEPER_APP_ID` (`3711554`) and `CLAWSWEEPER_APP_CLIENT_ID` (`Iv23lirdjmVqYd1gwY26`) are already in `[vars]` of `wrangler.toml`; the numeric App ID is preferred as the GitHub JWT issuer.

**Optional fourth secret** — separate the dashboard admin from the ingest token. If you want a distinct token for the runner-lane buttons:

```bash
pnpm dlx wrangler@4.90.0 secret put DASHBOARD_ADMIN_TOKEN \
  --config dashboard/wrangler.toml
```

If unset, `setRunnerMode` falls back to `INGEST_TOKEN`.

## Step 5 — build and deploy

```bash
pnpm run build:dashboard
pnpm run dashboard:deploy
# tail of output shows the live URL
```

If you went with workers.dev only, the URL is `https://clawsweeper-status.<subdomain>.workers.dev`. If custom domain, the pattern from step 1.

## Step 6 — verify

```bash
# Public health check — should return JSON with fleet/pipeline data
curl -s https://YOUR_URL/api/status | jq '.fleet'

# Runner config in the snapshot
curl -s https://YOUR_URL/api/status | jq '.fleet.runner_config, .fleet.runners'

# Browser: open YOUR_URL — should see ClawSweeper Live page with Runner Lane card
```

First load may take 5–10s while it warms the GitHub API cache. Subsequent loads are <1s (cached via `CACHE_TTL_SECONDS = "20"`).

## Step 7 — wire the runner-lane buttons (smoke test)

On the live page, the Runner Lane card shows three buttons (`mac-mini`, `macbook`, `both`). Click `both`. Browser prompts for admin token — paste the `INGEST_TOKEN` (or `DASHBOARD_ADMIN_TOKEN` if you set step-4-optional). On success:

```bash
# Confirm the variable flipped
gh variable list --repo valkyriweb/clawsweeper | grep CLAWSWEEPER_RUNNER_LABELS
```

Should now read `["self-hosted","macOS","ARM64"]`. If you get a 403, the App is missing `Variables: write` — see prereqs.

## Step 8 (optional) — feed live event data

The dashboard derives most of its display from the GitHub API directly, so it works out of the box. To get the "Recent Activity" feed populated with actual sweeper progress, the repair workers need to `POST /api/events` with `Authorization: Bearer ${INGEST_TOKEN}`.

That's a separate plumbing change in the sweep workflow / repair scripts — not required for the dashboard to function. Park it until you actually want the event stream.

## Reference

- Env vars the worker reads: `CACHE_TTL_SECONDS`, `STALE_CACHE_TTL_SECONDS`, `CLAWSWEEPER_REPO`, `TARGET_REPOS`, `WORKER_BUDGET`, `INCLUDE_CI_STATUS`, `TRIAGE_TARGET_REPOS`, `PR_PROOF_TARGET_REPOS`, `TRIAGE_ITEMS_PER_VIEW`, `PR_PROOF_ITEMS_PER_VIEW`, `CLAWSWEEPER_BOT_LOGINS`, `STORE_CACHE_TTL_SECONDS`, `CI_STATUS_TTL_SECONDS`
- Secrets: `CLAWSWEEPER_APP_PRIVATE_KEY`, `CLAWSWEEPER_APP_INSTALLATION_ID`, `INGEST_TOKEN`, optionally `DASHBOARD_ADMIN_TOKEN`, or fallback `GITHUB_TOKEN` (PAT instead of App auth)
- Bindings: `STATUS_STORE` (KV namespace)
- Deploy commands: `pnpm run dashboard:deploy`, `pnpm run dashboard:dev` (local), `pnpm run dashboard:smoke`
