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
export function registerPublicationCapability(
  value: string | undefined,
  knownCredential = false,
): void {
  if (knownCredential ? knownCredentialValue(value) : credentialLike(value))
    explicitCapabilities.add(value!);
}

// A value already identified as a credential (token, apiKey, auth header, referenced secret)
// registers even when all-lowercase; only trivially short or path/number values are skipped.
function knownCredentialValue(value: string | undefined): boolean {
  return Boolean(
    value &&
    value.length >= 16 &&
    !/^[\d. +-]+$/.test(value) &&
    !/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(value),
  );
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
          registerPublicationCapability(child, true);
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
    const registerAuthorization = (credential: string) => {
      registerPublicationCapability(credential, true);
      registerPublicationCapability(credential.replace(/^[A-Za-z][A-Za-z0-9+.-]*\s+/, ""), true);
    };
    registerAuthorization(value);
    const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name: string) => {
      registerPublicationCapability(env[name], true);
      return env[name] ?? reference;
    });
    registerAuthorization(resolved);
  };
  // The OpenClaw lane forwards every `${ENV}` reference in a provider block (e.g. a signed
  // baseUrl), so register each resolved value; plain literals such as URLs or model ids
  // are not capabilities and would otherwise invalidate reviews that merely mention them.
  const registerReferences = (value: unknown): void => {
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        const registerComponent = (component: string, known = false) => {
          registerPublicationCapability(component, known);
          try {
            registerPublicationCapability(decodeURIComponent(component), known);
          } catch {
            // Preserve the literal even if a URL component has malformed escapes.
          }
        };
        // Userinfo is explicit authentication; query values stay heuristic.
        registerComponent(url.username, true);
        registerComponent(url.password, true);
        for (const parameter of url.search.slice(1).split("&")) {
          const [key, credential] = new URLSearchParams(parameter).entries().next().value ?? [];
          // Credential-named parameters are identified; unknown names stay heuristic.
          const known = /token|secret|password|passwd|key|sig|auth|credential|code/i.test(
            key ?? "",
          );
          if (
            credential &&
            (known ? knownCredentialValue(credential) : credentialLike(credential))
          ) {
            registerComponent(credential, known);
            registerPublicationCapability(encodeURIComponent(credential), known);
            registerPublicationCapability(parameter.slice(parameter.indexOf("=") + 1), known);
          }
        }
      } catch {
        // Only URL leaves can embed URL authentication.
      }
      for (const [, name] of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        registerPublicationCapability(env[name!], true);
      }
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) registerReferences(nested);
    }
  };
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    registerReferences(provider);
    register(provider.apiKey);
    if (provider.headers && typeof provider.headers === "object") {
      for (const value of Object.values(provider.headers)) register(value);
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
            if (knownCredentialValue(component)) values.add(component);
            try {
              const decoded = decodeURIComponent(component);
              if (knownCredentialValue(decoded)) values.add(decoded);
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
      // Credential-named variables are identified; other CODEX_* names stay heuristic.
      const identified = /TOKEN|SECRET|PASSWORD|PASSWD|(?:^|_)KEY(?:_|$)/i.test(name);
      if (identified ? knownCredentialValue(value) : credentialLike(value)) values.add(value);
    }
  }
  const exact = [...values]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    [
      "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----",
      "\\b(?:gh[sopur]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{36,})",
      "\\bsk-[A-Za-z0-9_-]{16,}",
      "\\b(?:AKIA|ASIA)[A-Z0-9]{16}",
      ...exact,
    ].join("|"),
    "g",
  );
}

/** The publication boundary: scan strings before JSON/Markdown escaping hides exact values. */
export function redactPublication<T>(value: T): { value: T; redactions: number } {
  const pattern = credentialPattern();
  let redactions = 0;
  const replace = (text: string): string =>
    text.replace(pattern, () => {
      redactions += 1;
      return REDACTED;
    });
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      // Parse JSON/JSONL so keys and values are scanned without corrupting syntax.
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
      const entries = Object.entries(entry).map(([key, child]) => ({
        key,
        child,
        matched: replace(key) !== key,
      }));
      const used = new Set(entries.filter((entry) => !entry.matched).map((entry) => entry.key));
      return Object.fromEntries(
        entries.map(({ key, child, matched }) => {
          if (matched) {
            key = REDACTED;
            let suffix = 2;
            while (used.has(key)) key = `${REDACTED}-${suffix++}`;
            used.add(key);
          }
          return [key, visit(child)];
        }),
      );
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
