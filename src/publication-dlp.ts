import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Decision } from "./clawsweeper-types.js";

const REDACTED = "[redacted credential]";
// These Codex launcher settings carry no authentication authority. Matching
// "codex" or "1" would falsely compromise ordinary local review output.
const CODEX_NON_CAPABILITIES = new Set([
  "CODEX_BIN",
  "CODEX_BIN_ARGS",
  "CODEX_HOME",
  "CODEX_CI",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_SANDBOX",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS",
  "CODEX_VERSION",
]);
const explicitCapabilities = new Set<string>();

/** Remember credentials passed as arguments rather than inherited from the publisher. */
export function registerPublicationCapability(value: string | undefined): void {
  if (credentialLike(value)) explicitCapabilities.add(value!);
}

function credentialLike(value: string | undefined): boolean {
  return Boolean(
    value &&
    value.length >= 20 &&
    !/^[a-z]+$/.test(value) &&
    !/^[\d. +-]+$/.test(value) &&
    !/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(value),
  );
}

/** Snapshot file-backed auth before temporary Codex homes are removed. */
export function registerCodexAuthCapabilities(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const auth: unknown = JSON.parse(
      readFileSync(
        join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "auth.json"),
        "utf8",
      ),
    );
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (/token|key|secret|password/i.test(key) && typeof child === "string")
          registerPublicationCapability(child);
        else visit(child);
      }
    };
    visit(auth);
  } catch {
    // Missing or invalid file auth is handled by Codex; never log auth material.
  }
}

/** Inline provider keys become agent-visible config files in the OpenClaw lane. */
export function registerOpenclawProviderCapabilities(
  providersJson: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!providersJson) return;
  let providers: unknown;
  try {
    providers = JSON.parse(providersJson);
  } catch {
    // OpenClaw's config builder rejects malformed provider JSON before launch.
    return;
  }
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  registerPublicationCapability(providersJson);
  const register = (value: unknown) => {
    if (typeof value !== "string") return;
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    registerPublicationCapability(reference ? env[reference[1]!] : value);
  };
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    register(provider.apiKey);
    if (provider.headers && typeof provider.headers === "object") {
      for (const [name, value] of Object.entries(provider.headers)) {
        if (/authorization|api.?key|token|secret|password|cookie/i.test(name)) register(value);
      }
    }
  }
}

function credentialPattern(): RegExp {
  registerOpenclawProviderCapabilities(process.env.CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON);
  registerCodexAuthCapabilities();
  const values = new Set(explicitCapabilities);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /^(?:https?|all)_proxy$/i.test(name)) {
      try {
        const proxy = new URL(value);
        if (proxy.username || proxy.password) {
          if (credentialLike(value)) values.add(value);
          for (const component of [proxy.username, proxy.password]) {
            if (!component) continue;
            if (credentialLike(component)) values.add(component);
            try {
              const decoded = decodeURIComponent(component);
              if (credentialLike(decoded)) values.add(decoded);
            } catch {
              // Malformed escapes still have their literal value protected.
            }
          }
        }
      } catch {
        // Invalid proxy URLs cannot supply parsed authentication components.
      }
    }
    if (
      value &&
      !CODEX_NON_CAPABILITIES.has(name) &&
      /TOKEN|SECRET|PASSWORD|PASSWD|(?:^|_)KEY(?:_|$)|^CODEX_/i.test(name)
    ) {
      if (credentialLike(value)) values.add(value);
    }
  }
  const exact = [...values]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    [
      "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----",
      "(?:gh[sopur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)",
      "sk-[A-Za-z0-9_-]{16,}",
      "(?:AKIA|ASIA)[A-Z0-9]{16}",
      ...exact,
    ].join("|"),
    "g",
  );
}

/** The publication boundary: scan strings before JSON/Markdown escaping hides exact values. */
export function redactPublication<T>(value: T): { value: T; redactions: number } {
  const pattern = credentialPattern();
  let redactions = 0;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      // Process serialized objects as values, including JSONL and report records.
      // Never run credential substitution over object keys or JSON punctuation.
      const structured = (text: string): string | undefined => {
        if (!/^\s*["[{]/.test(text)) return undefined;
        try {
          const before = redactions;
          const safe = visit(JSON.parse(text));
          return before === redactions
            ? text
            : JSON.stringify(safe) + text.slice(text.trimEnd().length);
        } catch {
          return undefined;
        }
      };
      const parsed = structured(entry);
      if (parsed !== undefined) return parsed;
      const replace = (text: string) => {
        return text.replace(pattern, () => {
          redactions += 1;
          return REDACTED;
        });
      };
      let pending = "";
      let output = "";
      for (const line of entry.split(/(?<=\n)/)) {
        const prefix = line.match(/^[A-Za-z_][A-Za-z0-9_]*:\s+/)?.[0] ?? "";
        const json = structured(prefix ? line.slice(prefix.length) : line);
        if (json === undefined) {
          pending += line;
          continue;
        }
        output += replace(pending) + prefix + json;
        pending = "";
      }
      return output + replace(pending);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    }
    return entry;
  };
  const result = visit(value) as T;
  if (redactions) {
    console.error(JSON.stringify({ event: "publication_credential_redaction", redactions }));
  }
  return { value: result, redactions };
}

const CREDENTIAL_PUBLICATION_FAILURE =
  "Codex review failed: credential output was redacted; a fresh review is required.";

export function credentialPublicationBlocked(decision: Pick<Decision, "summary">): boolean {
  return decision.summary.startsWith(CREDENTIAL_PUBLICATION_FAILURE);
}

export function blockCredentialPublication(decision: Decision, redactions: number): Decision {
  if (
    !redactions &&
    !credentialPublicationBlocked(decision) &&
    !JSON.stringify(decision).includes(REDACTED)
  )
    return decision;
  return {
    ...decision,
    decision: "keep_open",
    closeReason: "none",
    confidence: "low",
    localCheckoutAccess: "unverified",
    summary: credentialPublicationBlocked(decision)
      ? decision.summary
      : `${CREDENTIAL_PUBLICATION_FAILURE}\n\n${decision.summary}`,
  };
}

export function publicationDecision(decision: Decision): Decision {
  const safe = redactPublication(decision);
  return blockCredentialPublication(safe.value, safe.redactions);
}
