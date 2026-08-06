import assert from "node:assert/strict";
import test from "node:test";

import {
  isGithubUrl,
  sanitizeCheckLink,
  sanitizeEvidenceList,
  sanitizeEvidenceText,
  sanitizeResultEvidence,
} from "../../dist/repair/url-safety.js";

test("isGithubUrl accepts only github.com host", () => {
  assert.equal(isGithubUrl("https://github.com/foo/bar"), true);
  assert.equal(isGithubUrl("http://github.com/foo/bar"), true);
  assert.equal(isGithubUrl("https://gist.github.com/x/y"), false);
  assert.equal(isGithubUrl("https://raw.githubusercontent.com/x/y"), false);
  assert.equal(isGithubUrl("https://vercel.com/foo"), false);
  assert.equal(isGithubUrl(""), false);
  assert.equal(isGithubUrl("not a url"), false);
  assert.equal(isGithubUrl(null), false);
});

test("sanitizeCheckLink keeps github.com URLs verbatim", () => {
  assert.equal(
    sanitizeCheckLink("https://github.com/openclaw/openclaw/runs/123"),
    "https://github.com/openclaw/openclaw/runs/123",
  );
});

test("sanitizeCheckLink drops non-github URLs", () => {
  assert.equal(sanitizeCheckLink("https://vercel.com/openclaw/preview/abc"), "");
  assert.equal(sanitizeCheckLink("https://gist.github.com/x/y"), "");
  assert.equal(sanitizeCheckLink("not-a-url"), "");
  assert.equal(sanitizeCheckLink(""), "");
  assert.equal(sanitizeCheckLink(null), "");
});

test("sanitizeEvidenceText replaces non-github URLs with hostname-free placeholder", () => {
  const cleaned = sanitizeEvidenceText(
    "Failing check: vercel:failure (https://vercel.com/openclaw/preview/abc)",
  );
  assert.equal(cleaned, "Failing check: vercel:failure (<external link>)");
  assert.match(cleaned, /<external link>/);
  assert.doesNotMatch(cleaned, /https?:\/\//);
});

test("sanitizeEvidenceText keeps github.com URLs but replaces sibling external URLs", () => {
  const cleaned = sanitizeEvidenceText(
    "PR https://github.com/openclaw/openclaw/pull/2353 references https://vercel.com/openclaw/preview/abc and https://raw.githubusercontent.com/openclaw/openclaw/main/x.md",
  );
  assert.match(cleaned, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/2353/);
  assert.doesNotMatch(cleaned, /vercel\.com/);
  assert.doesNotMatch(cleaned, /raw\.githubusercontent\.com/);
});

test("sanitizeEvidenceText replaces external URLs regardless of scheme case", () => {
  // GitHub autolinks schemes case-insensitively, so an uppercase scheme is still
  // a live external link once the evidence is published.
  for (const scheme of ["HTTPS", "Https", "hTTpS", "HTTP", "Http", "hTtP"]) {
    const cleaned = sanitizeEvidenceText(`deploy preview: ${scheme}://vercel.com/openclaw/abc`);
    assert.equal(cleaned, "deploy preview: <external link>", `scheme ${scheme} was not redacted`);
  }
});

test("sanitizeEvidenceText keeps github.com URLs with an uppercase scheme", () => {
  // The host is what decides; case-insensitive matching must not start dropping
  // legitimate github.com links.
  assert.equal(
    sanitizeEvidenceText("see HTTPS://github.com/openclaw/openclaw/pull/1 for context"),
    "see HTTPS://github.com/openclaw/openclaw/pull/1 for context",
  );
  assert.equal(
    sanitizeEvidenceText("see HTTPS://GitHub.com/openclaw/openclaw/pull/1"),
    "see HTTPS://GitHub.com/openclaw/openclaw/pull/1",
  );
});

test("sanitizeResultEvidence redacts uppercase-scheme URLs on every evidence field", () => {
  const result = {
    actions: [{ evidence: ["proof: HTTPS://attacker.example/exfil?data=secret"] }],
    needs_human: ["HTTP://attacker.example/ping"],
    merge_preflight: [
      {
        security_evidence: ["HtTpS://attacker.example/scan"],
        comments_evidence: ["Https://attacker.example/thread"],
        bot_comments_evidence: ["HTTP://attacker.example/ack"],
        codex_review: { evidence: ["HTTPS://attacker.example/review"] },
      },
    ],
  };
  sanitizeResultEvidence(result);
  assert.doesNotMatch(JSON.stringify(result), /attacker\.example/);
});

test("sanitizeEvidenceText is idempotent", () => {
  const once = sanitizeEvidenceText(
    "see https://github.com/x/y and https://vercel.com/z for details",
  );
  const twice = sanitizeEvidenceText(once);
  assert.equal(once, twice);
});

test("sanitizeEvidenceList stringifies non-string entries safely", () => {
  const out = sanitizeEvidenceList([
    "https://vercel.com/x",
    { url: "https://gist.github.com/x" },
    "https://github.com/o/r/pull/1",
  ]);
  assert.equal(out.length, 3);
  assert.doesNotMatch(out[0]!, /vercel\.com/);
  assert.doesNotMatch(out[1]!, /gist\.github\.com/);
  assert.match(out[2]!, /https:\/\/github\.com\/o\/r\/pull\/1/);
});

test("sanitizeResultEvidence cleans actions[].evidence in place", () => {
  const result = {
    actions: [
      {
        target: "#1",
        evidence: [
          "Source PR: https://github.com/o/r/pull/1",
          "external preview at https://vercel.com/o/r",
        ],
      },
    ],
  };
  sanitizeResultEvidence(result);
  assert.match(result.actions[0]!.evidence[0]!, /https:\/\/github\.com\/o\/r\/pull\/1/);
  assert.equal(result.actions[0]!.evidence[1]!, "external preview at <external link>");
});

test("sanitizeResultEvidence cleans needs_human and merge_preflight evidence", () => {
  const result = {
    needs_human: ["see https://vercel.com/x for the deploy"],
    merge_preflight: [
      {
        target: "#2",
        security_evidence: ["https://github.com/o/r/pull/2", "https://example.com/scan"],
        comments_evidence: ["resolved at https://gist.github.com/x"],
        bot_comments_evidence: ["bot ack at https://app.codecov.io/foo"],
        codex_review: {
          command: "/review",
          status: "passed",
          findings_addressed: true,
          evidence: [
            "/review run https://github.com/o/r/pull/2#issuecomment-1",
            "details https://vercel.com/o/preview",
          ],
        },
      },
    ],
  };
  sanitizeResultEvidence(result);
  assert.doesNotMatch(JSON.stringify(result), /vercel\.com/);
  assert.doesNotMatch(JSON.stringify(result), /gist\.github\.com/);
  assert.doesNotMatch(JSON.stringify(result), /codecov\.io/);
  assert.doesNotMatch(JSON.stringify(result), /example\.com/);
  assert.match(
    result.merge_preflight[0]!.codex_review.evidence[0]!,
    /https:\/\/github\.com\/o\/r\/pull\/2#issuecomment-1/,
  );
});

test("sanitizeResultEvidence handles null/undefined safely", () => {
  assert.equal(sanitizeResultEvidence(null), null);
  assert.equal(sanitizeResultEvidence(undefined), undefined);
});

test("sanitized evidence does not trigger evidenceHasExternalUrl regex", () => {
  // Mirror the regex used in review-results.ts evidenceHasExternalUrl, including
  // its flags. If these drift apart the sanitizer can emit output the validator
  // then rejects (or, as before the `i` flag, both can miss the same URL).
  const URL_PATTERN = /https?:\/\/[^\s)\]"']+/gi;
  const cleaned = sanitizeEvidenceList([
    "Source PR: https://github.com/o/r/pull/2353",
    "Failing check: vercel:failure (https://vercel.com/o/preview/abc)",
    "see https://gist.github.com/foo for snippet",
    "Preview: HTTPS://vercel.com/o/preview/upper",
    "Snippet: HtTpS://gist.github.com/upper",
  ]);
  for (const line of cleaned) {
    const urls = line.match(URL_PATTERN) ?? [];
    for (const url of urls) {
      assert.equal(new URL(url).hostname, "github.com", `unexpected external URL: ${url}`);
    }
  }
});
