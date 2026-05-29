# Deployment & runner fleet

How Luke's ClawSweeper fork is deployed and how to operate the self-hosted runner
fleet. Prefer the **runtime checks** in each section over memorising host facts —
the cluster changes and static lists go stale. Host/IP details live in
`~/Projects/agent-scripts/devices.md`, not here.

## What runs where

- **Code + Actions:** `valkyriweb/clawsweeper` (this repo) runs the sweep/review/repair workflows.
- **State:** `valkyriweb/clawsweeper-state` (published review state, dashboards).
- **Targets:** the fleet in [`config/target-repositories.json`](../config/target-repositories.json).
- **GitHub App:** `valkyriweb-clawsweeper` mints a **scoped per-target token** per run
  (least privilege). App credentials in 1Password → **Personal** vault, item
  *"GitHub App — valkyriweb-clawsweeper"* (`app_id 3711554`, client id, private key,
  install ids). The `bermont-clawsweeper` app (Bermont Digital vault) is the separate
  bermont-digital install.

Check live app installs:

```bash
# needs the app JWT; key is in 1Password (op item get / op read)
gh api repos/valkyriweb/clawsweeper/actions/secrets --jq '.secrets[].name'  # confirms APP_PRIVATE_KEY secret is set
```

## gh vs ghx — clawsweeper MUST use native gh

Luke's self-hosted runners shim `gh` → **ghx** (a gh cache proxy) for openclaw.
**ghx is incompatible with clawsweeper** and must be bypassed:

> ghx serves cached GETs through one persistent per-user daemon that adopts a single
> identity at spawn and **ignores the per-call `GH_TOKEN`**. clawsweeper passes a
> *scoped per-target* token, so via ghx a CI user with no stored gh auth hits GitHub
> **unauthenticated** → public targets 200, **private targets 404** (the
> `valkyriweb/lue-kube` "Not Found" failures, 2026-05-29).

Fix: `sweep.yml` sets `GH_BIN` to a real gh (upstream-supported override — see
`src/command.ts`, `src/clawsweeper.ts`). Each runner host has a stable
`/usr/local/bin/gh-native` symlink → real gh:

```bash
# verify the bypass on a host (must print a gh version, not the ghx shim)
ssh <host> '/usr/local/bin/gh-native --version; readlink /usr/local/bin/gh-native'
# create it if missing (target = the host's real gh: apt /usr/bin/gh, or ghx's ~/.ghx/bin/gh)
ssh <host> 'sudo ln -sf /usr/bin/gh /usr/local/bin/gh-native'   # Linux w/ apt gh
```

`GH_BIN` defaults to `/usr/local/bin/gh-native`; override per-repo with the
`CLAWSWEEPER_GH_BIN` variable if a host needs a different path. ghx stays untouched
for openclaw.

## Runner fleet & job distribution

Runners are selected by `runs-on`, driven by repo variables:

| Variable | Controls | Current value |
|---|---|---|
| `CLAWSWEEPER_RUNNER_LABELS` | general pool (plan/apply/audit) | `["self-hosted","lue-clawsweeper"]` |
| `CLAWSWEEPER_REVIEW_RUNNER` | heavy Codex **review shards** only | `["self-hosted","macOS","ARM64","mac-mini"]` |

The shared label **`lue-clawsweeper`** spans the mac-mini pool **and** the Linux
boxes (old-mbp, x99). Review shards are pinned to the mac-mini so the **lue-kube
cluster nodes (x99, old-mbp) only take light jobs** — they are production cluster
workers, keep heavy Codex/token load off them.

Check the live fleet (don't trust a static list):

```bash
gh api repos/valkyriweb/clawsweeper/actions/runners \
  --jq '.runners[]|"\(.name)\t\(.status)\tbusy=\(.busy)\t"+([.labels[].name]|join(","))'
gh variable list --repo valkyriweb/clawsweeper | grep -E 'RUNNER_LABELS|REVIEW_RUNNER'
```

Activity & worker health: use the `clawsweeper-status` skill —
`~/Projects/agent-scripts/skills/clawsweeper-status/scripts/clawsweeper-status.sh --all-targets`.

## Add a self-hosted runner

On a host that already runs an openclaw runner (clone its binaries, configure fresh):

```bash
REG=$(gh api -X POST repos/valkyriweb/clawsweeper/actions/runners/registration-token --jq .token)
ssh <host> "
  cd ~ && cp -a actions-runner-openclaw actions-runner-clawsweeper
  cd actions-runner-clawsweeper
  rm -rf _work _diag _update .runner .credentials .credentials_rsaparams .service .runner_migrated
  ./config.sh --url https://github.com/valkyriweb/clawsweeper --token $REG \
    --name <host>-clawsweeper --labels lue-clawsweeper --unattended --replace
  sudo ./svc.sh install \$(whoami) && sudo ./svc.sh start
"
# then ensure /usr/local/bin/gh-native exists (see gh vs ghx section)
```

One runner instance per host = one concurrent job (deliberate, for resource caution).
To add an existing mac-mini runner to the shared pool without reconfiguring:

```bash
id=$(gh api repos/valkyriweb/clawsweeper/actions/runners --jq '.runners[]|select(.name=="<name>")|.id')
gh api -X POST repos/valkyriweb/clawsweeper/actions/runners/$id/labels -f 'labels[]=lue-clawsweeper'
```

Runner service control on a host:

```bash
ssh <host> 'sudo systemctl status actions.runner.valkyriweb-clawsweeper.<name>.service'
```

## Pause / resume / emergency stop

Pausing points `runs-on` at a label no runner has, so jobs queue instead of running.
Full ladder and safe target order: [`safe-ramp-valkyriweb.md`](safe-ramp-valkyriweb.md).

```bash
# pause (queue everything)
gh variable set CLAWSWEEPER_RUNNER_LABELS --repo valkyriweb/clawsweeper --body '["self-hosted","clawsweeper-paused"]'
# resume to the shared pool
gh variable set CLAWSWEEPER_RUNNER_LABELS --repo valkyriweb/clawsweeper --body '["self-hosted","lue-clawsweeper"]'
```

## Verify a target after a change

```bash
gh workflow run sweep.yml --repo valkyriweb/clawsweeper -f target_repo=valkyriweb/lue-kube
RID=$(gh run list --repo valkyriweb/clawsweeper --workflow sweep.yml -L1 --json databaseId -q '.[].databaseId')
gh api repos/valkyriweb/clawsweeper/actions/runs/$RID/jobs \
  --jq '.jobs[]|select(.name|test("Plan"))|"\(.status)/\(.conclusion)\trunner=\(.runner_name)"'
```

A green **Plan review candidates** step confirms the scoped token + gh-native path
(it is the step that 404s when ghx is in the way).
