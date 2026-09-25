import { spawnSync } from "node:child_process";

export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals | 0,
  deadlineAt?: number,
): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM") {
      // Darwin can reject a group containing only unreaped zombies. Preserve
      // POSIX success for that verified state, never for a live permission denial.
      if (sameUserZombieGroup(pid, deadlineAt)) return true;
      try {
        process.kill(-pid, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return false;
      }
    }
    throw error;
  }
}

function sameUserZombieGroup(pid: number, deadlineAt?: number): boolean {
  const timeout = Math.min(1_000, deadlineAt === undefined ? 1_000 : deadlineAt - Date.now());
  if (timeout <= 0 || typeof process.geteuid !== "function") return false;
  try {
    const result = spawnSync("/bin/ps", ["-o", "pgid=,uid=,stat=", "-g", String(pid)], {
      encoding: "utf8",
      env: { COMMAND_MODE: "unix2003", LC_ALL: "C" },
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || result.stderr.trim() || !result.stdout.trim()) {
      return false;
    }
    const owner = process.geteuid();
    return result.stdout
      .trim()
      .split("\n")
      .every((line) => {
        const [group, user, state, ...extra] = line.trim().split(/\s+/);
        return (
          extra.length === 0 &&
          group === String(pid) &&
          user === String(owner) &&
          state?.startsWith("Z") === true
        );
      });
  } catch {
    return false;
  }
}
