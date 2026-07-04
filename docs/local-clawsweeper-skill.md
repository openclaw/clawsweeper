# Local ClawSweeper Skill

The CLI workflow in the README is the source of truth for local ClawSweeper
reviews. The repo-local Codex skill is an optional wrapper that helps run the
same commands, inspect the generated artifact, and avoid accidental GitHub
mutation.

The shipped skill lives at:

```text
.agents/skills/local-clawsweeper-review
```

From a ClawSweeper checkout, ask Codex:

```text
Use $local-clawsweeper-review to run a local ClawSweeper review for PR <number>.
```

For a full proof-aware review before a PR exists, ask it to review the current
clean branch with `--local-range`. That path reviews committed work against a
base ref without reading or writing GitHub; the Codex model call itself still
uses its configured network service.

To make the skill available outside this checkout, copy it into your Codex user
skills directory.

POSIX shell:

```sh
mkdir -p ~/.codex/skills
cp -R .agents/skills/local-clawsweeper-review ~/.codex/skills/
```

PowerShell:

```powershell
$dest = Join-Path $env:USERPROFILE ".codex\skills\local-clawsweeper-review"
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Copy-Item -Recurse -Force .agents\skills\local-clawsweeper-review $dest
```

The skill intentionally stays small and points back to the README workflow
instead of duplicating every setup and command detail.
