import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveCommand, runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "./command.js";
import { ROOT } from "./clawsweeper-repository-paths.js";
import {
  recordGitHubHttpRead,
  recordUnobservedGitHubInvocation,
} from "./github-egress-observer.js";
import { ghRetryKind } from "./github-retry.js";
import { asRecord } from "./value-coerce.js";

function normalizedAuthHost(host: string): string {
  if (host.endsWith(".github.com")) return "github.com";
  if (host.endsWith(".github.localhost")) return "github.localhost";
  return host.endsWith(".ghe.com") ? host.split(".").slice(-3).join(".") : host;
}

function receiptTarget(env: NodeJS.ProcessEnv): {
  base: URL;
  socket: string;
  authHost: string;
  fallbackHost?: string;
} {
  // Match go-gh DefaultHost: one configured host wins even with GH_TOKEN set.
  // Reading config keys avoids an auth-status probe and extra GitHub requests.
  const directory =
    env.GH_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "gh")
      : process.platform === "win32" && (env.AppData || env.APPDATA)
        ? join((env.AppData || env.APPDATA)!, "GitHub CLI")
        : join(
            (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir(),
            ".config",
            "gh",
          ));
  const readConfig = (name: string): Record<string, unknown> => {
    try {
      return asRecord(parse(readFileSync(join(directory, name), "utf8"), { logLevel: "error" }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return {};
      // YAML diagnostics can contain credential lines. Never expose config text.
      // oxlint-disable-next-line preserve-caught-error -- A cause can retain credential lines.
      throw new Error("could not read GitHub receipt host configuration");
    }
  };
  const general = readConfig("config.yml");
  const configured = readConfig("hosts.yml");
  const hosts = Object.keys(configured).length ? configured : asRecord(general.hosts);
  const names = Object.keys(hosts);
  const selected = env.GH_HOST || (names.length === 1 ? names[0]! : "github.com");
  const host = selected.trim().toLowerCase();
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error("invalid GitHub API hostname");
  const normalized = normalizedAuthHost(host);
  const cloud =
    normalized === "github.com" ||
    normalized === "github.localhost" ||
    normalized.endsWith(".ghe.com");
  const base = new URL(
    host === "github.localhost"
      ? `http://api.${host}/`
      : cloud && host !== "garage.github.com"
        ? `https://api.${host}/`
        : `https://${host}/api/v3/`,
  );
  const apiHost = asRecord(hosts[selected]).api_host;
  if (typeof apiHost === "string" && apiHost) {
    const override = new URL(`https://${apiHost}`);
    if (
      apiHost.trim() !== apiHost ||
      apiHost.includes(":") ||
      override.host !== apiHost.toLowerCase() ||
      override.username ||
      override.password ||
      override.pathname !== "/" ||
      override.search ||
      override.hash
    )
      throw new Error("invalid configured GitHub API hostname");
    base.host = override.host;
  }
  const authHost = normalizedAuthHost(base.hostname);
  // Match gh's request-host token lookup before its lexical api_host reverse map.
  const fallbackHost = names.sort().find((name) => {
    const target = asRecord(hosts[name]).api_host;
    return typeof target === "string" && target.toLowerCase() === authHost;
  });
  return {
    base,
    authHost,
    ...(fallbackHost ? { fallbackHost } : {}),
    socket: typeof general.http_unix_socket === "string" ? general.http_unix_socket : "",
  };
}

/** Machine receipts cannot use gh's terminal-oriented JSON sanitizer. */
export function rawGitHubJsonRead(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
): string {
  const endpoint = args[1] ?? "";
  if (
    args.length !== 2 ||
    args[0] !== "api" ||
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(?:comments\/[1-9]\d*|[1-9]\d*\/comments)(?:\?per_page=100&page=[1-9]\d*)?$/.test(
      endpoint,
    )
  ) {
    throw new Error("lossless GitHub reads require a relative review comment GET route");
  }
  const startedAt = Date.now();
  const remaining = () => {
    const ms = (timeoutMs ?? 60_000) - (Date.now() - startedAt);
    if (ms <= 0) throw new Error("GitHub lossless read timed out before dispatch");
    return ms;
  };
  const { base, socket, authHost, fallbackHost } = receiptTarget(env);
  const tokenForHost = (host: string): string => {
    const normalized = normalizedAuthHost(host.toLowerCase());
    const cloud =
      normalized === "github.com" ||
      normalized === "github.localhost" ||
      normalized.endsWith(".ghe.com");
    const envToken = cloud
      ? env.GH_TOKEN || env.GITHUB_TOKEN
      : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
    if (envToken) return envToken;
    try {
      return runText("gh", ["auth", "token", "--hostname", host], {
        cwd: ROOT,
        env,
        timeoutMs: remaining(),
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 1 &&
        "stderr" in error &&
        String(error.stderr).trim() === `no oauth token found for ${host}`
      )
        return "";
      throw error;
    }
  };
  const token = tokenForHost(authHost) || (fallbackHost ? tokenForHost(fallbackHost) : "");
  if (!token || /[\r\n]/.test(token)) throw new Error("GitHub authentication required");
  let url = new URL(endpoint, base);
  for (let redirects = 0; ; redirects += 1) {
    const curlArgs = [
      "--disable",
      // gh's socket transport is plaintext even for a canonical HTTPS URL.
      ...(socket ? ["--unix-socket", socket] : []),
      "--silent",
      "--show-error",
      "--include",
      "--request",
      "GET",
      "--connect-timeout",
      "10",
      "--max-time",
      String(remaining() / 1000),
      // Authentication goes through stdin, never argv or an error's command text.
      "--header",
      "@-",
      "--url",
      socket ? url.toString().replace(/^https:/, "http:") : url.toString(),
    ];
    const command = resolveCommand("curl", curlArgs, env);
    const dispatchedAt = Date.now();
    const result = spawnSync(command.command, command.args, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: remaining(),
      maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
      input: `Authorization: Bearer ${token}\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: ClawSweeper\n`,
    });
    if (result.error || result.status !== 0) {
      recordUnobservedGitHubInvocation(args, env);
      if (result.error) throw result.error;
      // curl errors may contain transport diagnostics; never surface response text.
      const reason =
        result.status === 28
          ? "timed out"
          : [5, 6].includes(result.status ?? -1)
            ? "could not resolve host"
            : result.status === 7
              ? "connection refused"
              : [16, 18, 35, 52, 55, 56].includes(result.status ?? -1)
                ? "connection reset"
                : "request failed";
      throw new Error(
        `GitHub lossless read transport failure (curl exit ${result.status}); ${reason}`,
      );
    }
    let output = result.stdout;
    let header = "";
    while (output.startsWith("HTTP/")) {
      const separator = /\r?\n\r?\n/.exec(output);
      if (!separator || separator.index === undefined)
        throw new Error("invalid GitHub response headers");
      header = output.slice(0, separator.index);
      output = output.slice(separator.index + separator[0].length);
    }
    const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(header)?.[1]);
    if (!status) throw new Error("missing GitHub response status");
    const headers = new Map(
      header
        .split(/\r?\n/)
        .slice(1)
        .map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }),
    );
    recordGitHubHttpRead(args, status, headers, Date.now() - dispatchedAt, env);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = headers.get("location");
      if (!location || redirects >= 10)
        throw new Error("GitHub receipt redirect limit or missing location");
      const next = new URL(location, url);
      // Repository moves stay within the selected API origin. Never forward a
      // receipt credential to another origin or a URL containing credentials.
      if (next.origin !== base.origin || next.username || next.password) {
        throw new Error("GitHub receipt redirect left the selected API origin");
      }
      url = next;
      continue;
    }
    if (status !== 200) {
      let bodyLimited = false;
      try {
        const value: unknown = JSON.parse(output);
        if (
          value &&
          typeof value === "object" &&
          "message" in value &&
          typeof value.message === "string"
        ) {
          bodyLimited = ghRetryKind(new Error(value.message)) === "throttle";
        }
      } catch {
        // Error bodies are not required to be JSON and must never reach logs.
      }
      const limited =
        status === 429 ||
        (status === 403 &&
          (bodyLimited ||
            headers.has("retry-after") ||
            headers.get("x-ratelimit-remaining") === "0"));
      const hints = ["retry-after", "x-ratelimit-reset"].flatMap((name) => {
        const value = headers.get(name);
        return value && /^\d+$/.test(value) ? [`${name}: ${value}`] : [];
      });
      throw new Error(
        `GitHub API HTTP ${status}${limited ? "; rate limit exceeded" : ""}; ${hints.join("; ")}`,
      );
    }
    return output;
  }
}
