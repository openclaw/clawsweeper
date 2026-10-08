import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIGURE_REVIEW_NETWORK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github/actions/setup-codex/configure-review-network.mjs",
);

/**
 * Local reviews run in the same isolated Codex home as hosted reviews: the checked-in review
 * network profile and nothing from the operator's own Codex home except its login. Personal
 * instructions, providers, and sandbox defaults would make a local review differ from hosted.
 */
export function prepareLocalReviewCodexHome(workspaceDir: string): string {
  const home = join(workspaceDir, "codex-home");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "config.toml"), "", { mode: 0o600 });
  const operatorAuth = join(
    process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    "auth.json",
  );
  const auth = join(home, "auth.json");
  if (existsSync(operatorAuth)) {
    // A link keeps token refreshes in the operator's login. Windows refuses file links
    // without Developer Mode, so a private copy in the run's scratch serves there.
    try {
      symlinkSync(operatorAuth, auth);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      copyFileSync(operatorAuth, auth);
      chmodSync(auth, 0o600);
    }
  }
  execFileSync(process.execPath, [CONFIGURE_REVIEW_NETWORK], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: "ignore",
  });
  return home;
}
