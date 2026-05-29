# AGENTS.md — ClawSweeper (valkyriweb fork)

Luke's fork of `openclaw/clawsweeper`. Divergence from upstream is intentional. Telegraph style; min tokens.

## What this is

Automated GitHub issue/PR triage + review/repair via GitHub Actions + Codex. Runs in
`valkyriweb/clawsweeper`; state in `valkyriweb/clawsweeper-state`; targets in
[`config/target-repositories.json`](config/target-repositories.json). Each run mints a
**scoped per-target token** from the `valkyriweb-clawsweeper` GitHub App.

## Read first

| Topic | Doc |
|---|---|
| Deploy, runner fleet, gh/ghx, add runner, pause | [`docs/deployment.md`](docs/deployment.md) |
| Safe restart / ramp ladder / emergency stop | [`docs/safe-ramp-valkyriweb.md`](docs/safe-ramp-valkyriweb.md) |
| Scheduler / crons | [`docs/scheduler.md`](docs/scheduler.md) |
| Token/cost limits | [`docs/limits.md`](docs/limits.md) |
| Dashboard | [`docs/dashboard-deploy-valkyriweb.md`](docs/dashboard-deploy-valkyriweb.md) |

## Check state at runtime (don't trust static lists)

```bash
# activity + worker health across the fleet
~/Projects/agent-scripts/skills/clawsweeper-status/scripts/clawsweeper-status.sh --all-targets
# live runners + selection vars
gh api repos/valkyriweb/clawsweeper/actions/runners --jq '.runners[]|"\(.name)\t\(.status)\tbusy=\(.busy)"'
gh variable list --repo valkyriweb/clawsweeper | grep -E 'RUNNER_LABELS|REVIEW_RUNNER'
gh api repos/valkyriweb/clawsweeper/actions/workflows/sweep.yml/runs --jq '.workflow_runs[:5][]|"\(.conclusion // .status)\t\(.created_at)\t\(.display_title)"'
```

## CLI (built: `pnpm run build:all`; runs `node dist/clawsweeper.js <cmd>`)

`pnpm run plan | review | apply-artifacts | apply-decisions | audit | reconcile | status`
Repair lane: `pnpm run repair:*` (see `package.json`). Package manager: **pnpm**.

## Hard rules

- **clawsweeper MUST use native gh, never ghx.** ghx ignores the scoped `GH_TOKEN` → private targets 404. `sweep.yml` sets `GH_BIN=/usr/local/bin/gh-native`. See deployment.md → "gh vs ghx".
- **Keep heavy load off cluster nodes.** x99 + old-mbp are lue-kube cluster workers; Codex review shards are pinned to mac-mini via `CLAWSWEEPER_REVIEW_RUNNER`. Don't route review to Linux boxes.
- **Cost discipline.** Sweeps are a token sink. Ramp one notch at a time (safe-ramp doc); never enable all repos/mutations at once.
- **Upstream:** `origin` = valkyriweb fork, `upstream` = openclaw. Don't auto-merge upstream; cherry-pick deliberately. Upstream uses native gh (no ghx).

## App credentials

1Password → **Personal** vault → *"GitHub App — valkyriweb-clawsweeper"* (`app_id 3711554`,
client id, private key, install ids). Never commit keys; the workflow reads the
`CLAWSWEEPER_APP_PRIVATE_KEY` Actions secret.
