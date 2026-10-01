#!/usr/bin/env node

/**
 * Definition: validate ClawSweeper changelog fragments in `changelog.d/`, or
 * fold them into the `## <version> - Unreleased` section of `CHANGELOG.md` at
 * release time and delete them.
 *
 * Parameters: `--check` validates without writing; `--root <dir>` selects the
 * repository root (default: the current directory).
 *
 * Outputs: a summary on stdout, findings on stderr, and exit code 1 when any
 * fragment is invalid or the stitch cannot be applied. Stitching is
 * deterministic (fragments are ordered by file name) and idempotent: a second
 * run finds no fragments, and a fragment whose bullet already appears in the
 * Unreleased section is deleted without being inserted again.
 *
 * Examples:
 *   node scripts/changelog-stitch.mjs --check
 *   node scripts/changelog-stitch.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./cli-args.mjs";

export const FRAGMENT_DIRECTORY = "changelog.d";
export const CHANGELOG_FILE = "CHANGELOG.md";
const FRAGMENT_README = "README.md";
const FRAGMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.md$/;
const UNRELEASED_HEADING_PATTERN = /^## \S.* - Unreleased$/;

const HELP = `Usage:
  node scripts/changelog-stitch.mjs [--check] [--root <dir>]

Description:
  Validate changelog fragments in ${FRAGMENT_DIRECTORY}/ (one "- " bullet line per
  file). Without --check, insert their bullets at the top of the
  "## <version> - Unreleased" section of ${CHANGELOG_FILE} in file-name order and
  delete the fragments.

Options:
  --check       Validate fragments and the stitch target without writing
  --root <dir>  Repository root (default: current directory)
  -h, --help    Show this help
`;

/** Compare by UTF-16 code units so ordering never depends on the host locale. */
function compareNames(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Read every candidate fragment. Unexpected directory entries are returned as
 * findings so a misnamed or nested file cannot be silently skipped.
 */
export function readChangelogFragments(root) {
  const directory = path.join(root, FRAGMENT_DIRECTORY);
  const fragments = [];
  const findings = [];
  if (!fs.existsSync(directory)) return { fragments, findings };
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === FRAGMENT_README) continue;
    const file = `${FRAGMENT_DIRECTORY}/${entry.name}`;
    if (!entry.isFile()) {
      findings.push({ file, message: "must be a regular file, not a directory or link" });
      continue;
    }
    if (!FRAGMENT_NAME_PATTERN.test(entry.name)) {
      findings.push({
        file,
        message:
          "file name must be lowercase [a-z0-9._-] and end in .md, for example 1719-queue-parking.md",
      });
      continue;
    }
    fragments.push({ file, text: fs.readFileSync(path.join(directory, entry.name), "utf8") });
  }
  return { fragments, findings };
}

/** Return the single bullet line of a fragment, or a finding message. */
export function fragmentBullet(text) {
  if (text.startsWith("﻿")) return { error: "must not start with a byte-order mark" };
  if (text.includes("\r")) return { error: "must use LF line endings" };
  if (!text.endsWith("\n") || text.endsWith("\n\n")) {
    return { error: "must end with exactly one newline" };
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 1) {
    return { error: "must contain exactly one line: one bullet, no wrapping or blank lines" };
  }
  const [line] = lines;
  if (!line.startsWith("- ") || /^-\s*$/.test(line) || /^- \s/.test(line)) {
    return { error: 'must be a single "- " bullet followed by the entry text' };
  }
  if (/\s$/.test(line)) return { error: "must not have trailing whitespace" };
  return { bullet: line };
}

function findUnreleasedHeading(lines) {
  const headings = [];
  for (const [index, line] of lines.entries()) {
    if (UNRELEASED_HEADING_PATTERN.test(line)) headings.push(index);
  }
  if (headings.length === 1) return { index: headings[0] };
  if (headings.length === 0) {
    return {
      missing: true,
      error: `${CHANGELOG_FILE} has no "## <version> - Unreleased" heading; add one before stitching`,
    };
  }
  return {
    error: `${CHANGELOG_FILE} has ${headings.length} "## <version> - Unreleased" headings; keep exactly one`,
  };
}

function sectionEnd(lines, headingIndex) {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) return index;
  }
  return lines.length;
}

/**
 * Plan a stitch without touching the filesystem. `strict` (used by --check)
 * also rejects fragments whose bullet already appears in the Unreleased
 * section; the stitch itself treats those as already folded in. A missing
 * Unreleased heading blocks only the stitch, so contributor checks keep
 * passing between a release commit and the next Unreleased heading.
 */
export function planChangelogStitch({ changelog, fragments, strict = false }) {
  const findings = [];
  const parsed = [];
  for (const fragment of fragments) {
    const result = fragmentBullet(fragment.text);
    if (result.error) findings.push({ file: fragment.file, message: result.error });
    else parsed.push({ file: fragment.file, bullet: result.bullet });
  }

  const lines = changelog.split("\n");
  const heading = findUnreleasedHeading(lines);
  if (heading.error && fragments.length > 0 && !(strict && heading.missing)) {
    findings.push({ file: CHANGELOG_FILE, message: heading.error });
  }
  const start = heading.error ? lines.length : heading.index;
  const end = heading.error ? lines.length : sectionEnd(lines, heading.index);
  const unreleased = new Set(lines.slice(start + 1, end));
  const released = new Set([...lines.slice(0, start), ...lines.slice(end)]);

  const seen = new Map();
  const insert = [];
  const alreadyPresent = [];
  for (const fragment of parsed) {
    const duplicateOf = seen.get(fragment.bullet);
    if (duplicateOf) {
      findings.push({ file: fragment.file, message: `duplicates the entry in ${duplicateOf}` });
      continue;
    }
    seen.set(fragment.bullet, fragment.file);
    if (released.has(fragment.bullet)) {
      findings.push({
        file: fragment.file,
        message: `re-adds an entry that ${CHANGELOG_FILE} already lists outside the Unreleased section`,
      });
    } else if (unreleased.has(fragment.bullet)) {
      if (strict) {
        findings.push({
          file: fragment.file,
          message: `${CHANGELOG_FILE} already lists this entry; delete the fragment or run the stitch to finish folding it in`,
        });
      }
      alreadyPresent.push(fragment);
    } else {
      insert.push(fragment);
    }
  }
  if (heading.error || findings.length > 0 || insert.length === 0) {
    return { findings, insert, alreadyPresent, changelog };
  }

  let at = heading.index + 1;
  const added = [];
  if (lines[at] !== "") added.push("");
  else at += 1;
  added.push(...insert.map((fragment) => fragment.bullet));
  const next = lines[at];
  // Keep a blank line before following prose or headings, and the final newline.
  if (next === undefined || (next !== "" && !next.startsWith("- "))) added.push("");
  const stitched = [...lines.slice(0, at), ...added, ...lines.slice(at)].join("\n");
  return { findings, insert, alreadyPresent, changelog: stitched };
}

/** Validate fragments against the current changelog without writing. */
export function checkChangelogFragments(root) {
  const { fragments, findings } = readChangelogFragments(root);
  const changelog = fs.readFileSync(path.join(root, CHANGELOG_FILE), "utf8");
  const plan = planChangelogStitch({ changelog, fragments, strict: true });
  return { fragments, findings: [...findings, ...plan.findings] };
}

/**
 * Fold fragments into the changelog, then delete them. The changelog is
 * replaced atomically before any fragment is removed, so an interrupted run
 * leaves either the original state or a state the next run finishes.
 */
export function stitchChangelogFragments(root) {
  const { fragments, findings } = readChangelogFragments(root);
  const changelogPath = path.join(root, CHANGELOG_FILE);
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const plan = planChangelogStitch({ changelog, fragments });
  const allFindings = [...findings, ...plan.findings];
  if (allFindings.length > 0) return { findings: allFindings, inserted: [], removed: [] };
  if (plan.changelog !== changelog) {
    const temporary = `${changelogPath}.stitch-${process.pid}`;
    fs.writeFileSync(temporary, plan.changelog);
    fs.renameSync(temporary, changelogPath);
  }
  const removed = [...plan.insert, ...plan.alreadyPresent].map((fragment) => fragment.file);
  for (const file of removed) fs.rmSync(path.join(root, file));
  return {
    findings: [],
    inserted: plan.insert.map((fragment) => fragment.file),
    removed,
  };
}

function reportFindings(heading, findings) {
  console.error(`${heading} (${findings.length}):`);
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.message}`);
  process.exitCode = 1;
}

function runCli(argv) {
  const options = parseCliArgs(argv, {
    check: { type: "boolean" },
    root: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = path.resolve(options.root ?? process.cwd());
  if (options.check) {
    const { fragments, findings } = checkChangelogFragments(root);
    if (findings.length > 0) {
      reportFindings("Changelog fragment checks failed", findings);
      return;
    }
    console.log(`Changelog fragment checks passed (${fragments.length} pending).`);
    return;
  }
  const result = stitchChangelogFragments(root);
  if (result.findings.length > 0) {
    reportFindings("Changelog stitch refused", result.findings);
    return;
  }
  if (result.removed.length === 0) {
    console.log("No changelog fragments to stitch.");
    return;
  }
  console.log(
    `Stitched ${result.inserted.length} fragment(s) into ${CHANGELOG_FILE}; removed ${result.removed.length}.`,
  );
  for (const file of result.removed) console.log(`- ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
