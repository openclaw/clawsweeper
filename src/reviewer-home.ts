import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The owning runner removes this home together with its per-invocation temp root. */
export function isolatedReviewerHome(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const config = join(home, ".config");
  const cache = join(home, ".cache");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const gitConfig = join(config, "gitconfig");
  const gitSystemConfig = join(config, "gitconfig-system");
  const ghConfig = join(config, "gh");
  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  writeFileSync(gitConfig, "", { mode: 0o600 });
  writeFileSync(gitSystemConfig, "", { mode: 0o600 });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: gitSystemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: ghConfig,
    ...(process.platform === "win32"
      ? { USERPROFILE: home, APPDATA: config, LOCALAPPDATA: cache }
      : {}),
  };
}
