#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: true });

const MARKDOWN_ROOTS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "VISION.md",
  "docs",
  "instructions",
  ".github/pull_request_template.md",
];
const REPOSITORY_PATH_PREFIXES = [
  ".github/",
  "config/",
  "dashboard/",
  "docs/",
  "instructions/",
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
    checkLinks({ root, relativeFile, text, inventory, findings });
    if (!relativeFile.startsWith("docs/proof/")) {
      checkDocumentedCommands({ relativeFile, text, packageScripts, inventory, findings });
    }
  }

  checkConfiguredClaims({ root, inventory, findings });
  return findings.sort(compareFindings);
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
    if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) return;

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
