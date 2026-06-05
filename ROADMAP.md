# ClawSweeper Roadmap

## Future

### Crabfleet + Crabbox integration

Stand up [Crabfleet](https://github.com/openclaw/crabfleet) (OpenClaw's SSH-first Codex control plane) and Codex crabboxes, then wire them to ClawSweeper.

- **What it is:** Crabfleet is a Cloudflare Worker control plane for creating/attaching/supervising interactive Codex *crabbox* sessions (cards, run attempts, repo-gated task intent, fleet visibility). Crabboxes are the live agent runtimes.
- **Why:** Crabfleet handles spawn-and-supervise; ClawSweeper handles sweep/merge/cleanup. Crabfleet's roadmap lists "Direct merge execution and ClawSweeper handoff" as *not wired yet* — so the two are meant to connect, with Crabfleet handing finished work off to ClawSweeper.
- **Relationship to existing surfaces:**
  - `clawsweeper.myhorizon.co.za` (our `clawsweeper-status` CF Worker, `dashboard/worker.ts`) monitors sweep runs + triage queues and flips runner-lane variables. It is *not* replaced by Crabfleet.
  - Crabfleet is upstream of ClawSweeper in the pipeline (session orchestration), not a swap-in for the runner or the dashboard.
- **Setup notes (when we get to it):**
  - SSH-first onboarding: `ssh link@crabd.sh`, GitHub OAuth, then linked-key auth.
  - Web app: `clawfleet.openclaw.ai/app`; Go CLI also available (`crabfleet new ...`).
  - Like the dashboard, upstream's hosted instance is OpenClaw-owned — expect to deploy our own Worker on a domain we control (mirror the `dashboard-deploy-valkyriweb.md` fork-deploy pattern).
- **Open questions:** how the ClawSweeper handoff contract works once upstream wires it; whether we run our own Crabfleet Worker or use the hosted one; crabbox runtime hosting (lue-kube vs. Cloudflare).
