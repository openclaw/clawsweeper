#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";

const markdown = new MarkdownIt({ html: true });

const MARKDOWN_ROOTS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "VISION.md",
  "docs",
  "instructions",
  "prompts",
  ".agents",
  ".github/pull_request_template.md",
];
const REPOSITORY_PATH_PREFIXES = [
  ".github/",
  "config/",
  "dashboard/",
  "docs/",
  "instructions/",
  "prompts/",
  ".agents/",
  "scripts/",
  "src/",
  "test/",
];
const PNPM_BUILT_INS = new Set([
  "add",
  "approve-builds",
  "audit",
  "bin",
  "cache",
  "cat-file",
  "cat-index",
  "clean",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "find-hash",
  "i",
  "ignored-builds",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ln",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rb",
  "rebuild",
  "remove",
  "rm",
  "root",
  "rt",
  "runtime",
  "self-update",
  "stage",
  "store",
  "unlink",
  "up",
  "update",
  "why",
]);

export function checkDocumentation(root = process.cwd()) {
  const inventory = buildInventory(root);
  const packageJson = readJson(path.join(root, "package.json"));
  const packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const markdownFiles = collectMarkdownFiles(root, inventory);
  const findings = [];

  for (const relativeFile of markdownFiles) {
    const text = fs.readFileSync(path.join(root, relativeFile), "utf8");
    checkMarkdownFences({ relativeFile, text, findings });
    checkLinks({ root, relativeFile, text, inventory, findings });
    if (
      !relativeFile.startsWith("docs/proof/") &&
      relativeFile !== ".agents/skills/crabbox/SKILL.md"
    ) {
      checkDocumentedCommands({ relativeFile, text, packageScripts, inventory, findings });
    }
  }

  checkConfiguredClaims({ root, inventory, findings });
  checkDocumentationSiteManifest({ root, inventory, findings });
  checkOperationalHealthDocumentation({ root, findings });
  checkOperatorDocumentation({ root, inventory, findings });
  return findings.sort(compareFindings);
}

function checkMarkdownFences({ relativeFile, text, findings }) {
  let openFence = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const suffix = match[2];
    if (marker.length !== 3) {
      addFinding(
        findings,
        relativeFile,
        index + 1,
        "markdown-fence",
        "use exactly three backticks or tildes for fenced code blocks",
      );
    }
    if (!openFence) {
      openFence = { marker: marker[0], line: index + 1 };
      continue;
    }
    if (marker[0] === openFence.marker && suffix.trim() === "") {
      openFence = null;
      continue;
    }
    if (suffix.trim() !== "") {
      addFinding(
        findings,
        relativeFile,
        index + 1,
        "markdown-fence",
        `fenced code block starts before the block from line ${openFence.line} closes`,
      );
    }
  }
  if (openFence) {
    addFinding(
      findings,
      relativeFile,
      openFence.line,
      "markdown-fence",
      "fenced code block is not closed",
    );
  }
}

function checkOperatorDocumentation({ root, inventory, findings }) {
  const manifestPath = "config/operator-documentation.json";
  const documentPath = "docs/operator-configuration.md";
  const apiDocumentPath = "docs/public-api.md";
  const manifest = readJson(path.join(root, manifestPath));
  const worker = fs.readFileSync(path.join(root, "dashboard/worker.ts"), "utf8");
  const apiDocument = fs.readFileSync(path.join(root, apiDocumentPath), "utf8");
  const configDocument = fs.readFileSync(path.join(root, documentPath), "utf8");
  const documentedRouteRows = apiDocument
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("|")
        .slice(1, 3)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 2);
  const documentedRouteMethods = new Map(documentedRouteRows);
  for (const route of duplicateKeys(
    documentedRouteRows
      .filter(([route]) => /^`\/api\/[^`]+`$/.test(route))
      .map(([route, method]) => [route.slice(1, -1), method]),
  )) {
    addFinding(
      findings,
      apiDocumentPath,
      1,
      "operator-route",
      `duplicate documented route ${route}`,
    );
  }
  const declaredRouteEntries = (manifest.publicObserverRoutes ?? []).map(
    ({ path: route, method }) => [route, method],
  );
  for (const route of duplicateKeys(declaredRouteEntries))
    addFinding(findings, manifestPath, 1, "operator-route", `duplicate manifest route ${route}`);
  const sourceRoutes = observerRouteMethods(worker);
  const declaredRoutes = new Map(declaredRouteEntries);
  for (const route of sourceRoutes.keys()) {
    if (!declaredRoutes.has(route))
      addFinding(findings, manifestPath, 1, "operator-route", `missing public route ${route}`);
  }
  for (const documentedRoute of documentedRouteMethods.keys()) {
    if (!/^`\/api\/[^`]+`$/.test(documentedRoute)) continue;
    const route = documentedRoute.slice(1, -1);
    if (!declaredRoutes.has(route))
      addFinding(findings, apiDocumentPath, 1, "operator-route", `stale documented route ${route}`);
  }
  for (const [route, method] of declaredRoutes) {
    const sourceMethod = sourceRoutes.get(route);
    if (!sourceMethod)
      addFinding(findings, manifestPath, 1, "operator-route", `stale public route ${route}`);
    if (sourceMethod && method !== sourceMethod)
      addFinding(
        findings,
        manifestPath,
        1,
        "operator-route",
        `method drift for ${route}: expected ${sourceMethod}, found ${method}`,
      );
    if (documentedRouteMethods.get(`\`${route}\``) !== `\`${method}\``)
      addFinding(findings, apiDocumentPath, 1, "operator-route", `missing route ${route}`);
  }

  const wrangler = fs.readFileSync(path.join(root, "dashboard/wrangler.toml"), "utf8");
  const workflowSources = [...inventory.exact]
    .filter((file) => file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file))
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const workflowSecrets = workflowSecretNames(workflowSources);
  for (const name of manifest.auditedDashboardVariables ?? []) {
    if (!new RegExp(`^${name}\\s*=`, "m").test(wrangler))
      addFinding(findings, manifestPath, 1, "operator-config", `stale dashboard variable ${name}`);
    if (!configDocument.includes(`\`${name}\``))
      addFinding(
        findings,
        documentPath,
        1,
        "operator-config",
        `missing dashboard variable ${name}`,
      );
  }
  for (const name of manifest.auditedWorkflowSecrets ?? []) {
    if (!workflowSecrets.has(name))
      addFinding(findings, manifestPath, 1, "operator-config", `stale workflow secret ${name}`);
    if (!configDocument.includes(`\`${name}\``))
      addFinding(findings, documentPath, 1, "operator-config", `missing workflow secret ${name}`);
  }
}

function workflowSecretNames(sources) {
  const names = new Set();
  for (const source of sources) visit(parseYaml(source));
  return names;

  function visit(value) {
    if (typeof value === "string") {
      for (const expression of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        for (const match of expression[1].matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g))
          names.add(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry);
    }
  }
}

function duplicateKeys(entries) {
  const seen = new Set();
  const duplicates = new Set();
  for (const [key] of entries) {
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return duplicates;
}

function observerRouteMethods(source) {
  const routes = new Map();
  for (const condition of executableIfConditions(source)) {
    for (const alternative of booleanAlternatives(condition)) {
      const guardedMethods = stringEqualities(alternative, "request", "method");
      for (const route of stringEqualities(alternative, "url", "pathname")) {
        if (!route.startsWith("/api/") || route === "/api/events") continue;
        const methods = routes.get(route) ?? new Set();
        if (guardedMethods.length === 0) methods.add("ANY");
        else for (const method of guardedMethods) methods.add(method);
        routes.set(route, methods);
      }
    }
  }
  return new Map(
    [...routes].map(([route, methods]) => [
      route,
      methods.has("ANY") ? "ANY" : [...methods].sort().join(", "),
    ]),
  );
}

function booleanAlternatives(source) {
  const expression = stripWrappingParentheses(source.trim());
  const disjunction = splitTopLevelLogical(expression, "||");
  if (disjunction.length > 1) return disjunction.flatMap(booleanAlternatives);
  const conjunction = splitTopLevelLogical(expression, "&&");
  if (conjunction.length === 1) return [expression];
  let alternatives = [""];
  for (const part of conjunction) {
    alternatives = alternatives.flatMap((prefix) =>
      booleanAlternatives(part).map((alternative) =>
        prefix ? `${prefix} && ${alternative}` : alternative,
      ),
    );
  }
  return alternatives;
}

function stripWrappingParentheses(source) {
  let expression = source;
  while (expression.startsWith("(") && matchingParenthesis(expression, 0) === expression.length - 1)
    expression = expression.slice(1, -1).trim();
  return expression;
}

function splitTopLevelLogical(source, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") depth -= 1;
    else if (depth === 0 && source.startsWith(operator, index)) {
      parts.push(source.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function executableIfConditions(source) {
  const branches = [];
  for (let index = 0; index < source.length; index += 1) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (
      !source.startsWith("if", index) ||
      isIdentifierCharacter(source[index - 1]) ||
      isIdentifierCharacter(source[index + 2])
    ) {
      continue;
    }
    let open = index + 2;
    while (/\s/.test(source[open] ?? "")) open += 1;
    if (source[open] !== "(") continue;
    const conditionEnd = matchingParenthesis(source, open);
    if (conditionEnd < 0) continue;
    let bodyOpen = conditionEnd + 1;
    while (bodyOpen < source.length) {
      if (/\s/.test(source[bodyOpen])) {
        bodyOpen += 1;
        continue;
      }
      const afterTrivia = skipNonCode(source, bodyOpen);
      if (afterTrivia !== bodyOpen && source[bodyOpen] === "/") {
        bodyOpen = afterTrivia;
        continue;
      }
      break;
    }
    branches.push({
      start: index,
      condition: source.slice(open + 1, conditionEnd),
      bodyOpen: source[bodyOpen] === "{" ? bodyOpen : -1,
      bodyEnd: source[bodyOpen] === "{" ? matchingBrace(source, bodyOpen) : -1,
    });
    index = conditionEnd;
  }
  return branches.map((branch) => {
    const enclosing = branches
      .filter(
        (candidate) =>
          candidate !== branch &&
          candidate.bodyOpen >= 0 &&
          candidate.bodyOpen < branch.start &&
          branch.start < candidate.bodyEnd,
      )
      .sort((left, right) => left.start - right.start)
      .map((candidate) => candidate.condition);
    return [...enclosing, branch.condition].map((condition) => `(${condition})`).join(" && ");
  });
}

function matchingParenthesis(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function matchingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function skipNonCode(source, index) {
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === "`") {
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\\") cursor += 1;
      else if (source[cursor] === quote) return cursor + 1;
    }
    return source.length;
  }
  if (source[index] === "/" && source[index + 1] === "/") {
    const end = source.indexOf("\n", index + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source[index] === "/" && source[index + 1] === "*") {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  return index;
}

function isIdentifierCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function stringEqualities(condition, objectName, propertyName) {
  const tokens = conditionTokens(condition);
  const values = [];
  const propertyAt = (index) =>
    tokens[index]?.type === "identifier" &&
    tokens[index].value === objectName &&
    tokens[index + 1]?.value === "." &&
    tokens[index + 2]?.type === "identifier" &&
    tokens[index + 2].value === propertyName;
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      propertyAt(index) &&
      tokens[index + 3]?.value === "===" &&
      tokens[index + 4]?.type === "string"
    )
      values.push(tokens[index + 4].value);
    if (
      tokens[index]?.type === "string" &&
      tokens[index + 1]?.value === "===" &&
      propertyAt(index + 2)
    )
      values.push(tokens[index].value);
  }
  return values;
}

function conditionTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/.test(character)) continue;
    if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipNonCode(source, index) - 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      let value = "";
      let interpolated = false;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\" && index + 1 < source.length) value += source[++index];
        else if (character === "`" && source[index] === "$" && source[index + 1] === "{") {
          interpolated = true;
        } else if (source[index] === character) break;
        else value += source[index];
      }
      if (!interpolated) tokens.push({ type: "string", value });
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier });
      index += identifier.length - 1;
      continue;
    }
    if (source.startsWith("===", index)) {
      tokens.push({ type: "punctuation", value: "===" });
      index += 2;
    } else if (character === ".") {
      tokens.push({ type: "punctuation", value: "." });
    }
  }
  return tokens;
}

function checkDocumentationSiteManifest({ root, inventory, findings }) {
  const manifestPath = "config/documentation-site.json";
  const manifest = readJson(path.join(root, manifestPath));
  const canonical = new Set();
  for (const section of manifest.sections ?? []) {
    for (const page of section.pages ?? []) {
      if (canonical.has(page)) {
        addFinding(
          findings,
          manifestPath,
          1,
          "docs-lifecycle",
          `duplicates canonical page ${page}`,
        );
      }
      canonical.add(page);
      if (!inventory.exact.has(`docs/${page}`)) {
        addFinding(
          findings,
          manifestPath,
          1,
          "docs-lifecycle",
          `references missing page docs/${page}`,
        );
      }
    }
  }

  const docsPages = [...inventory.exact]
    .filter((file) => file.startsWith("docs/") && file.endsWith(".md"))
    .map((file) => file.slice("docs/".length));
  for (const page of docsPages) {
    const matches = (manifest.noncanonical ?? []).filter(
      (entry) => entry.path === page || (entry.prefix && page.startsWith(entry.prefix)),
    );
    const classifications = Number(canonical.has(page)) + matches.length;
    if (classifications !== 1) {
      addFinding(
        findings,
        manifestPath,
        1,
        "docs-lifecycle",
        `${page} has ${classifications === 0 ? "no" : "multiple"} lifecycle classifications`,
      );
    }
  }
}

function checkOperationalHealthDocumentation({ root, findings }) {
  const sourcePath = "dashboard/operational-health.ts";
  const documentPath = "docs/live-dashboard.md";
  const source = fs.readFileSync(path.join(root, sourcePath), "utf8");
  const document = normalizeWhitespace(fs.readFileSync(path.join(root, documentPath), "utf8"));
  const minutes = (name) => {
    const expression = source.match(new RegExp(`export const ${name} = ([0-9 *]+);`))?.[1];
    if (!expression) return null;
    return (
      expression
        .split("*")
        .map(Number)
        .reduce((total, value) => total * value, 1) / 60_000
    );
  };
  const documentedFields = [
    "zombie_queued_runs",
    "oldest_zombie_queued_minutes",
    "wedged_rerun_runs",
    "oldest_wedged_rerun_minutes",
    "approval_gated_runs",
    "oldest_approval_gated_minutes",
  ];
  const operationalHealthType = source.match(
    /export type OperationalHealth = \{([\s\S]*?)\n\};/,
  )?.[1];
  for (const field of documentedFields) {
    if (
      !operationalHealthType ||
      !new RegExp(`^\\s*${field}\\s*:`, "m").test(operationalHealthType)
    ) {
      addFinding(
        findings,
        sourcePath,
        1,
        "operational-health-source",
        `documented field is missing from OperationalHealth: ${field}`,
      );
    }
  }
  const expected = [
    `queued runs from ${minutes("OPERATIONAL_QUEUE_DEGRADED_MS")} through ${minutes("OPERATIONAL_QUEUE_ZOMBIE_MS")} minutes old degrade operational health`,
    `queued runs older than ${minutes("OPERATIONAL_QUEUE_ZOMBIE_MS")} minutes are reported separately as zombies`,
    `pre-queue pending reruns older than ${minutes("OPERATIONAL_WEDGED_RERUN_MS")} minutes are reported separately as wedged`,
    `in-progress runs become stalled after ${minutes("OPERATIONAL_RUNNING_STALLED_MS")} minutes`,
    ...documentedFields,
  ];
  for (const claim of expected) {
    if (!document.includes(claim)) {
      addFinding(
        findings,
        documentPath,
        1,
        "operational-health-claim",
        `missing source-derived claim: ${claim}`,
      );
    }
  }
}

function buildInventory(root) {
  const exact = new Set();
  const lower = new Map();

  try {
    const tracked = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const relative of tracked.split("\0").filter(Boolean)) {
      if (!fs.existsSync(path.join(root, relative))) continue;
      addInventoryEntry(relative.replace(/\\/g, "/"));
    }
    return { exact, lower };
  } catch {
    // Standalone fixture directories are intentionally supported by tests.
  }

  function visit(absolute, relative = "") {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      addInventoryEntry(childRelative);
      if (entry.isDirectory()) visit(path.join(absolute, entry.name), childRelative);
    }
  }

  visit(root);
  return { exact, lower };

  function addInventoryEntry(relative) {
    let entry = relative;
    while (entry) {
      exact.add(entry);
      const folded = entry.toLowerCase();
      if (!lower.has(folded)) lower.set(folded, entry);
      entry = path.posix.dirname(entry);
      if (entry === ".") break;
    }
  }
}

function collectMarkdownFiles(root, inventory) {
  return [...inventory.exact]
    .filter(
      (entry) =>
        entry.endsWith(".md") &&
        MARKDOWN_ROOTS.some(
          (markdownRoot) => entry === markdownRoot || entry.startsWith(`${markdownRoot}/`),
        ) &&
        fs.statSync(path.join(root, entry)).isFile(),
    )
    .sort();
}

function checkLinks({ root, relativeFile, text, inventory, findings }) {
  const environment = {};
  const tokens = markdown.parse(text, environment);
  const renderedTargets = new Set();
  for (const token of tokens) {
    if (token.type !== "inline") continue;
    let line = (token.map?.[0] ?? 0) + 1;
    for (const child of token.children ?? []) {
      if (child.type === "softbreak" || child.type === "hardbreak") {
        line += 1;
        continue;
      }
      const attribute = child.type === "image" ? "src" : child.type === "link_open" ? "href" : null;
      if (!attribute) continue;
      const target = child.attrGet(attribute);
      if (!target) continue;
      renderedTargets.add(target);
      checkLinkTarget(target, line);
    }
  }
  const referenceLines = referenceDefinitionLines(text);
  for (const [label, reference] of Object.entries(environment.references ?? {})) {
    if (!renderedTargets.has(reference.href)) {
      checkLinkTarget(reference.href, referenceLines.get(label) ?? 1);
    }
  }

  function checkLinkTarget(rawTarget, line) {
    let target = rawTarget.trim().replace(/\\([()\\ ])/g, "$1");
    if (target.startsWith("<") && target.includes(">"))
      target = target.slice(1, target.indexOf(">"));
    else target = target.split(/\s+["']/)[0];
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return;

    const [rawPath, rawAnchor] = target.split("#", 2);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath.split("?", 1)[0]);
    } catch {
      addFinding(findings, relativeFile, line, "link", `malformed percent-encoding: ${target}`);
      return;
    }
    const resolved = decodedPath
      ? decodedPath.startsWith("/")
        ? normalizeRelative(decodedPath.slice(1))
        : normalizeRelative(path.posix.join(path.posix.dirname(relativeFile), decodedPath))
      : relativeFile;

    if (!inventory.exact.has(resolved)) {
      const actual = inventory.lower.get(resolved.toLowerCase());
      addFinding(
        findings,
        relativeFile,
        line,
        "link",
        actual
          ? `target case does not match repository entry: ${resolved} (actual: ${actual})`
          : `target does not exist: ${resolved}`,
      );
      return;
    }

    const anchorDocument = resolved.endsWith(".md")
      ? resolved
      : inventory.exact.has(`${resolved}/README.md`)
        ? `${resolved}/README.md`
        : null;
    if (rawAnchor && anchorDocument) {
      const targetText = fs.readFileSync(path.join(root, anchorDocument), "utf8");
      const anchors = markdownAnchors(targetText);
      let anchor;
      try {
        anchor = decodeURIComponent(rawAnchor);
      } catch {
        addFinding(
          findings,
          relativeFile,
          line,
          "anchor",
          `malformed percent-encoding: #${rawAnchor}`,
        );
        return;
      }
      if (!anchors.has(anchor)) {
        addFinding(
          findings,
          relativeFile,
          line,
          "anchor",
          `#${rawAnchor} does not exist in ${anchorDocument}`,
        );
      }
    }
  }
}

function referenceDefinitionLines(text) {
  const lines = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const definition = line.match(/^\s{0,3}\[([^\]]+)\]:/);
    if (!definition) continue;
    lines.set(markdown.utils.normalizeReference(definition[1]), index + 1);
  }
  return lines;
}

function markdownAnchors(text) {
  const anchors = new Set();
  const occurrences = new Map();
  const tokens = markdown.parse(text, {});
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "inline" && tokens[index - 1]?.type === "heading_open") {
      const base = githubSlug(inlineText(token));
      const count = occurrences.get(base) ?? 0;
      occurrences.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    const htmlTokens = [token, ...(token.children ?? [])].filter((item) =>
      ["html_block", "html_inline"].includes(item.type),
    );
    for (const htmlToken of htmlTokens) {
      for (const match of htmlToken.content.matchAll(
        /<a\s+(?:[^>]*\s)?(?:id|name)=["']([^"']+)["']/gi,
      )) {
        anchors.add(match[1]);
      }
    }
  }
  return anchors;
}

function inlineText(token) {
  return (token.children ?? [])
    .map((child) => {
      if (child.type === "text" || child.type === "code_inline" || child.type === "image") {
        return child.content;
      }
      if (child.type === "softbreak" || child.type === "hardbreak") return " ";
      return "";
    })
    .join("");
}

function githubSlug(value) {
  return value
    .replace(/[`*~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function checkDocumentedCommands({ relativeFile, text, packageScripts, inventory, findings }) {
  const codeText = markdownCodeOnly(text);
  const pnpmPattern = /\bpnpm\b(?!@)([^\r\n;|&~]*)/g;
  for (const match of codeText.matchAll(pnpmPattern)) {
    const script = documentedPnpmScript(match[1]);
    if (!script) continue;
    if (
      PNPM_BUILT_INS.has(script) ||
      packageScripts.has(script) ||
      (script === "start" && inventory.exact.has("server.js"))
    ) {
      continue;
    }
    addFinding(
      findings,
      relativeFile,
      lineNumber(codeText, match.index),
      "pnpm-script",
      `package.json has no script named ${script}`,
    );
  }

  const workflowPattern = /\bgh\s+workflow\s+(?:run|view)\s+(["']?)([^\s"']+\.ya?ml)\1/g;
  for (const match of codeText.matchAll(workflowPattern)) {
    const workflow = `.github/workflows/${path.posix.basename(match[2])}`;
    checkInventoryReference({
      relativeFile,
      text: codeText,
      index: match.index,
      value: workflow,
      inventory,
      findings,
      kind: "workflow",
    });
  }

  const codePattern = /`([^`\r\n]+)`/g;
  for (const match of text.matchAll(codePattern)) {
    const value = match[1].replace(/\\/g, "/").replace(/[),.;:]$/, "");
    if (!REPOSITORY_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))) continue;
    if (/[*{}<>]|\.\.\//.test(value) || value.includes(" ")) continue;
    const reference = normalizeRelative(value.split(/[?#]/, 1)[0]);
    if (!path.posix.extname(reference) && !inventory.exact.has(reference)) continue;
    checkInventoryReference({
      relativeFile,
      text,
      index: match.index,
      value: reference,
      inventory,
      findings,
      kind: "path",
    });
  }
}

function documentedPnpmScript(commandTail) {
  const tokens = commandTail
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"),.;:]$/g, ""))
    .filter(Boolean);
  const scopedOptions = new Set(["--dir", "--filter", "-C", "-F"]);
  const valuedOptions = new Set([...scopedOptions, "--config", "--reporter"]);

  function consumeOptions() {
    while (tokens[0]?.startsWith("-")) {
      const option = tokens.shift();
      const optionName = option.split("=", 1)[0];
      if (scopedOptions.has(optionName)) return false;
      if (valuedOptions.has(optionName) && !option.includes("=")) tokens.shift();
    }
    return true;
  }

  if (!consumeOptions()) return null;
  if (tokens[0] === "run") tokens.shift();
  if (!consumeOptions()) return null;
  const command = tokens[0]?.replace(/[.,;:]$/, "") ?? null;
  if (command === "t" || command === "it" || command === "install-test") return "test";
  return command;
}

function checkInventoryReference({ relativeFile, text, index, value, inventory, findings, kind }) {
  if (inventory.exact.has(value)) return;
  const actual = inventory.lower.get(value.toLowerCase());
  addFinding(
    findings,
    relativeFile,
    lineNumber(text, index),
    kind,
    actual
      ? `reference case does not match repository entry: ${value} (actual: ${actual})`
      : `repository entry does not exist: ${value}`,
  );
}

function checkConfiguredClaims({ root, inventory, findings }) {
  const manifestPath = "config/documentation-sync.json";
  if (!inventory.exact.has(manifestPath)) return;
  const manifest = readJson(path.join(root, manifestPath));
  for (const source of manifest.sources ?? []) {
    if (!inventory.exact.has(source.path)) {
      addFinding(
        findings,
        manifestPath,
        1,
        "config-claim",
        `source does not exist: ${source.path}`,
      );
      continue;
    }
    const values = sourceValues(path.join(root, source.path));
    for (const [key, expected] of Object.entries(source.expect ?? {})) {
      if (values.get(key) === String(expected)) continue;
      addFinding(
        findings,
        manifestPath,
        1,
        "config-claim",
        `${source.path} ${key} is ${values.get(key) ?? "undefined"}; expected ${expected}`,
      );
    }
    for (const claim of source.claims ?? []) {
      if (!inventory.exact.has(claim.document)) {
        addFinding(
          findings,
          manifestPath,
          1,
          "config-claim",
          `document does not exist: ${claim.document}`,
        );
        continue;
      }
      const missing = [];
      const expected = claim.text.replace(/{{([^}]+)}}/g, (_match, key) => {
        if (values.has(key)) return values.get(key);
        missing.push(key);
        return `{{${key}}}`;
      });
      if (missing.length > 0) {
        addFinding(
          findings,
          manifestPath,
          1,
          "config-claim",
          `${source.path} does not define ${missing.join(", ")}`,
        );
        continue;
      }
      const documentText = fs.readFileSync(path.join(root, claim.document), "utf8");
      if (!normalizeWhitespace(documentText).includes(normalizeWhitespace(expected))) {
        addFinding(
          findings,
          claim.document,
          1,
          "config-claim",
          `does not match ${source.path}: ${expected}`,
        );
      }
    }
  }
}

function parseTomlStrings(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function sourceValues(file) {
  if (file.endsWith(".json")) {
    const values = new Map();
    flattenJson(readJson(file), "", values);
    return values;
  }
  return parseTomlStrings(fs.readFileSync(file, "utf8"));
}

function flattenJson(value, prefix, values) {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenJson(child, prefix ? `${prefix}.${key}` : key, values);
    }
    return;
  }
  values.set(prefix, String(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeRelative(value) {
  return value.replace(/^\.\//, "").replace(/\/$/, "");
}

function markdownCodeOnly(text) {
  const output = text.split(/\r?\n/).map(() => "");
  for (const token of markdown.parse(text, {})) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      const start = token.map[0] + (token.type === "fence" ? 1 : 0);
      for (const [offset, content] of token.content.split(/\r?\n/).entries()) {
        if (content && start + offset < output.length) output[start + offset] += content;
      }
      continue;
    }
    if (token.type !== "inline") continue;
    let line = token.map?.[0] ?? 0;
    for (const child of token.children ?? []) {
      if (child.type === "softbreak" || child.type === "hardbreak") {
        line += 1;
        continue;
      }
      if (child.type === "code_inline") output[line] += `; ${child.content}`;
    }
  }
  return output.join("\n");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function addFinding(findings, file, line, kind, message) {
  findings.push({ file, line, kind, message });
}

function compareFindings(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.message.localeCompare(right.message)
  );
}

function runCli() {
  const findings = checkDocumentation();
  if (findings.length === 0) {
    console.log("Documentation checks passed.");
    return;
  }
  console.error(`Documentation checks failed (${findings.length}):`);
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} [${finding.kind}] ${finding.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runCli();
