import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The owning runner removes this home together with its per-invocation temp root. */
export function isolatedReviewerHome(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const config = join(home, ".config");
  const cache = join(home, ".cache");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    ...(process.platform === "win32"
      ? { USERPROFILE: home, APPDATA: config, LOCALAPPDATA: cache }
      : {}),
  };
}
