import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
if (!home) throw new Error("Review network configuration requires an isolated CODEX_HOME.");
const path = join(home, "config.toml");
const existing = readFileSync(path, "utf8");
const profile = readFileSync(new URL("./review-permissions.toml", import.meta.url), "utf8");
// Root settings must precede the existing provider tables. Duplicate permission
// settings fail config parsing rather than silently weakening the profile.
const tables = profile.indexOf("[features]");
writeFileSync(path, `${profile.slice(0, tables)}\n${existing}\n${profile.slice(tables)}`, {
  mode: 0o600,
});
