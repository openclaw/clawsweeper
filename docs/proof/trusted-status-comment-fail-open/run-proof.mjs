#!/usr/bin/env node
/**
 * Real-behavior proof for the trusted-status-comment fail-open fix.
 *
 * Three claims:
 *
 *   1. FAILS CLOSED - an unreadable author (null user, empty login, whitespace)
 *                     is not trusted. Adopting a status comment means reading
 *                     durable state from it and editing it in place, so an author
 *                     we cannot read must never satisfy the guard.
 *   2. NO LOSS      - every genuine ClawSweeper / configured-bot login is still
 *                     trusted, in any casing, and untrusted humans stay rejected.
 *   3. DEDUPLICATED - both consumer modules now route through the one shared
 *                     comparator; no private copy of the predicate remains.
 *
 * The pre-fix predicate was module-private, so it cannot be imported. Rather than
 * evaluating extracted source (a code-injection pattern that does not belong in a
 * committed script), the contrast reimplements it explicitly AND asserts that the
 * reimplementation is faithful to the base commit's source text. Supply that
 * source file as argv[2]; without it the contrast reports SKIPPED and the proof
 * FAILS.
 *
 * Usage: node docs/proof/trusted-status-comment-fail-open/run-proof.mjs [preFixSourceFile]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distCore = path.join(repoRoot, "dist", "repair", "comment-router-core.js");

if (!fs.existsSync(distCore)) {
  console.error(`missing build artifact: ${distCore}\nrun: pnpm run build:node (or pnpm run build:repair)`);
  process.exit(2);
}
const { isTrustedStatusCommentAuthor } = await import(`file://${distCore}`);

const TRUSTED = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    if (detail) console.log(`        ${detail}`);
    failures.push(label);
  }
};

/* -- Claim 1: unreadable author fails closed ----------------------------- */

console.log("== Claim 1: an unreadable author is not trusted ==\n");
const UNREADABLE = {
  "user: null": { user: null },
  "no user key": {},
  "user without login": { user: {} },
  "empty login": { user: { login: "" } },
  "whitespace login": { user: { login: "   " } },
  "comment itself null": null,
};
for (const [name, comment] of Object.entries(UNREADABLE)) {
  check(name, isTrustedStatusCommentAuthor(comment, TRUSTED) === false);
}
// A deleted account is reattributed to `ghost` - a real login, rejected on its
// own merits rather than via the absent-author path.
check("deleted account (ghost) rejected", isTrustedStatusCommentAuthor({ user: { login: "ghost" } }, TRUSTED) === false);

/* -- Claim 2: genuine authors still trusted ------------------------------ */

console.log("\n== Claim 2: genuine ClawSweeper and trusted bots still adopt ==\n");
for (const login of [
  "clawsweeper",
  "ClawSweeper",
  "clawsweeper[bot]",
  "ClawSweeper[Bot]",
  "openclaw-clawsweeper[bot]",
]) {
  check(`trusts ${JSON.stringify(login)}`, isTrustedStatusCommentAuthor({ user: { login } }, TRUSTED) === true);
}
for (const login of ["contributor", "other[bot]", "clawsweeper-impostor"]) {
  check(`rejects ${JSON.stringify(login)}`, isTrustedStatusCommentAuthor({ user: { login } }, TRUSTED) === false);
}
// A padded login is malformed data, not a trusted identity. GitHub logins never
// contain whitespace, so trimming would widen the boundary rather than normalize
// it - the guard must not accept these.
for (const login of ["  clawsweeper[bot]  ", " clawsweeper", "clawsweeper ", "\tclawsweeper"]) {
  check(
    `rejects padded ${JSON.stringify(login)}`,
    isTrustedStatusCommentAuthor({ user: { login } }, TRUSTED) === false,
  );
}

/* -- Claim 3: no private copy of the predicate remains ------------------- */

console.log("\n== Claim 3: both consumers route through the shared comparator ==\n");
for (const file of ["comment-router.js", "execute-fix-artifact.js"]) {
  const full = path.join(repoRoot, "dist", "repair", file);
  if (!fs.existsSync(full)) {
    check(`${file} present`, false, "build artifact missing");
    continue;
  }
  const src = fs.readFileSync(full, "utf8");
  check(`${file}: uses the shared comparator`, src.includes("isTrustedStatusCommentAuthor"));
  // The fail-open shape was `return !author || ...`.
  check(`${file}: no local fail-open predicate`, !/return\s*!author\s*\|\|/.test(src));
}

/* -- Before/after against the real pre-fix source ------------------------ */

console.log("\n== Before/after against the pre-fix predicate ==\n");
const preFixSource = process.argv[2];
if (!preFixSource) {
  console.log("  SKIPPED  no pre-fix source supplied (argv[2]); contrast not measured");
  failures.push("before/after not measured");
} else if (!fs.existsSync(preFixSource)) {
  console.log(`  FAIL     pre-fix source not found: ${preFixSource}`);
  failures.push("pre-fix source missing");
} else {
  const text = fs.readFileSync(preFixSource, "utf8");
  const start = text.indexOf("function isTrustedStatusComment(");
  if (start < 0) {
    check("pre-fix predicate located in source", false, "function not found");
  } else {
    const body = text.slice(start, text.indexOf("\n}", start) + 2);
    console.log("  the predicate as it shipped at the base commit:");
    for (const line of body.split("\n")) console.log(`    ${line}`);

    // Reimplementation of the shipped predicate. Not evaluated from source - the
    // assertions below prove it is faithful, which is stronger than eval and does
    // not put a code-injection pattern in a committed script.
    const preFix = (comment) => {
      const author = String(comment?.user?.login ?? "").toLowerCase();
      return !author || author === "clawsweeper" || TRUSTED.has(author);
    };

    // Fidelity: the shipped source must actually contain the fail-open clause and
    // the same author read this reimplementation models.
    const normalized = body.replace(/\s+/g, " ");
    check(
      "shipped predicate contained the fail-open clause",
      /return !author \|\|/.test(normalized),
      normalized,
    );
    check(
      "shipped predicate read the author the same way",
      normalized.includes('String(comment.user?.login ?? "").toLowerCase()'),
      normalized,
    );

    const beforeNull = preFix({ user: null });
    const afterNull = isTrustedStatusCommentAuthor({ user: null }, TRUSTED);
    console.log(`\n    { user: null }  pre-fix: ${beforeNull}   post-fix: ${afterNull}`);
    check("pre-fix trusted an unreadable author", beforeNull === true);
    check("post-fix rejects an unreadable author", afterNull === false);

    // And a genuine author must be unchanged by the fix.
    const genuine = { user: { login: "clawsweeper[bot]" } };
    check(
      "genuine author trusted in both builds",
      preFix(genuine) === true && isTrustedStatusCommentAuthor(genuine, TRUSTED) === true,
    );
  }
}

console.log(`\nRESULT: ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length) console.log(`  failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
