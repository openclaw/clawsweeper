import assert from "node:assert/strict";
import test from "node:test";

import { buildRepoCatalog, inferTargetRepo, ownerRepoFromUrls } from "../dist/linear/repo-infer.js";
import type { RepoCatalog, RepoInferenceItem } from "../dist/linear/repo-infer.js";
// Barrel wiring check.
import { inferTargetRepo as inferFromIndex } from "../dist/linear/index.js";

// The static REPOSITORY_PROFILES include openclaw/openclaw, openclaw/clawhub,
// openclaw/clawsweeper, openclaw/fs-safe. Fallback owners: openclaw, steipete.
const FALLBACKS = [
  { owner: "openclaw", allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/, denyRepositories: [] },
  { owner: "steipete", allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/, denyRepositories: [] },
];
const CATALOG: RepoCatalog = buildRepoCatalog(FALLBACKS);

function item(overrides: Partial<RepoInferenceItem> = {}): RepoInferenceItem {
  return { labels: [], title: "", urls: [], ...overrides };
}

// ---------------------------------------------------------------------------
// ownerRepoFromUrls
// ---------------------------------------------------------------------------

test("ownerRepoFromUrls extracts distinct normalized owner/repo from issue/pull urls", () => {
  const repos = ownerRepoFromUrls([
    "https://github.com/openclaw/clawhub/issues/12",
    "https://github.com/OpenClaw/ClawHub/pull/7",
    "https://github.com/steipete/foo",
    "not a url",
  ]);
  assert.deepEqual(repos, ["openclaw/clawhub", "steipete/foo"]);
});

test("ownerRepoFromUrls ignores GitHub routes that are not repositories", () => {
  assert.deepEqual(
    ownerRepoFromUrls([
      "https://github.com/orgs/openclaw/projects/12",
      "https://github.com/sponsors/openclaw",
      "https://github.com/apps/example-app",
      "https://github.com/login/device",
      "https://github.com/pricing/calculator",
      "https://github.com/openclaw/clawhub/issues/12",
    ]),
    ["openclaw/clawhub"],
  );
});

test("reserved GitHub routes do not veto a configured repository label", () => {
  const r = inferTargetRepo(
    item({ labels: ["clawhub"], urls: ["https://github.com/login/device"] }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "label");
});

// Everything after owner/repo is ignored, NOT matched against a list of known sub-routes. An
// allow-list would fail open: an unlisted-but-valid route drops the URL as evidence, which
// removes it from the URL/label agreement check.
test("ownerRepoFromUrls keeps repository evidence for any sub-route", () => {
  assert.deepEqual(
    ownerRepoFromUrls([
      "https://github.com/openclaw/clawhub/forks",
      "https://github.com/openclaw/clawhub/stargazers",
      "https://github.com/openclaw/clawhub/network/members",
      "https://github.com/openclaw/clawhub/graphs/contributors",
      "https://github.com/openclaw/clawhub/blob/main/src/index.ts",
      "https://github.com/openclaw/clawhub/pull/7",
    ]),
    ["openclaw/clawhub"],
  );
});

// Regression: dropping a valid URL for an unrecognized sub-route let a conflicting label pick
// the wrong checkout. A repository URL must always remain conflict evidence.
test("an uncommon repository sub-route still conflicts with a different configured label", () => {
  const r = inferTargetRepo(
    item({
      labels: ["clawhub"],
      urls: ["https://github.com/openclaw/openclaw/forks"],
    }),
    CATALOG,
  );
  assert.equal(r.repo, null);
  assert.equal(r.ambiguous, true);
});

// Two-segment marketing routes have no third segment, so the sub-route guard cannot help and
// the reserved-first-segment list is the only discriminator. Pin the ones that shipped.
test("ownerRepoFromUrls ignores two-segment GitHub marketing routes", () => {
  assert.deepEqual(
    ownerRepoFromUrls([
      "https://github.com/solutions/industry",
      "https://github.com/resources/articles",
      "https://github.com/enterprise/contact",
      "https://github.com/openclaw/clawhub",
    ]),
    ["openclaw/clawhub"],
  );
});

test("GitHub legal and policy routes do not veto a configured repository label", () => {
  for (const url of [
    "https://github.com/customer-terms/general-terms",
    "https://github.com/site-policy/github-terms",
    "https://github.com/community/community",
  ]) {
    const r = inferTargetRepo(item({ labels: ["clawhub"], urls: [url] }), CATALOG);
    assert.equal(r.repo, "openclaw/clawhub", `expected ${url} to be a non-signal`);
  }
});

test("a two-segment marketing route does not veto a configured repository label", () => {
  const r = inferTargetRepo(
    item({ labels: ["clawhub"], urls: ["https://github.com/solutions/industry"] }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "label");
});

test("a reserved deep GitHub route does not veto a configured repository label", () => {
  const r = inferTargetRepo(
    item({
      labels: ["clawhub"],
      urls: ["https://github.com/solutions/industry/healthcare"],
    }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "label");
});

// Deny lists filter only the generic-fallback path; an explicitly configured target still
// resolves. This pins the precedence isSupportedRepo shares with repositoryProfileFor.
test("deny_repositories does not override an explicitly configured target", () => {
  const catalog = buildRepoCatalog([
    {
      owner: "openclaw",
      allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/,
      denyRepositories: ["openclaw/clawhub", "openclaw/clawsweeper-state"],
    },
  ]);
  const configured = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawhub/issues/12"] }),
    catalog,
  );
  assert.equal(configured.repo, "openclaw/clawhub");

  const denied = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawsweeper-state/issues/5"] }),
    catalog,
  );
  assert.equal(denied.repo, null);
});

// ---------------------------------------------------------------------------
// Precedence (1): a single unique GitHub URL wins outright
// ---------------------------------------------------------------------------

test("infer step1: unique GitHub URL wins outright", () => {
  const r = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawhub/issues/3"], labels: ["bug"] }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "url");
});

test("infer fails closed when a GitHub URL conflicts with a known repository label", () => {
  const r = inferTargetRepo(
    item({
      title: "fix the ClawHub widget",
      labels: ["OpenClaw FaceTime"],
      urls: ["https://github.com/openclaw/clawhub/issues/1"],
    }),
    CATALOG,
  );
  assert.equal(r.repo, null);
  assert.match(r.reasons.join("; "), /conflicting repository signals/);
});

test("infer ignores fallback-owner guesses when a supported GitHub URL is present", () => {
  const r = inferTargetRepo(
    item({
      title: "OpenClaw worker regression",
      labels: ["bug"],
      urls: ["https://github.com/openclaw/clawhub/issues/1"],
    }),
    CATALOG,
  );
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "url");
});

test("infer step1: >=2 distinct GitHub URLs is ambiguous -> skip", () => {
  const r = inferTargetRepo(
    item({
      urls: [
        "https://github.com/openclaw/clawhub/issues/3",
        "https://github.com/openclaw/fs-safe/pull/9",
      ],
    }),
    CATALOG,
  );
  assert.equal(r.repo, null);
});

test("infer step1: an unsupported GitHub URL is skipped rather than treated as a repo", () => {
  const r = inferTargetRepo(
    item({ urls: ["https://github.com/unconfigured-owner/private-repo/issues/3"] }),
    CATALOG,
  );
  assert.equal(r.repo, null);
  assert.match(r.reasons.join("\n"), /unsupported GitHub URL repository/);
});

test("infer treats a fallback-owner deny-listed repository as unsupported", () => {
  const rules = [
    {
      owner: "openclaw",
      allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/,
      denyRepositories: ["openclaw/clawsweeper-state"],
    },
  ];
  const r = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawsweeper-state"] }),
    buildRepoCatalog(rules),
  );
  assert.equal(r.repo, null);
  assert.match(r.reasons.join("\n"), /unsupported GitHub URL repository/);
});

test("deny lists cannot be bypassed by a second fallback rule for the same owner", () => {
  const r = inferTargetRepo(
    item({ urls: ["https://github.com/openclaw/clawsweeper-state"] }),
    buildRepoCatalog([
      {
        owner: "openclaw",
        allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/,
        denyRepositories: ["openclaw/clawsweeper-state"],
      },
      {
        owner: "openclaw",
        allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/,
        denyRepositories: [],
      },
    ]),
  );
  assert.equal(r.repo, null);
  assert.match(r.reasons.join("\n"), /unsupported GitHub URL repository/);
});

// ---------------------------------------------------------------------------
// Precedence (2): label naming a known target_repo / checkout_dir / display_name
// ---------------------------------------------------------------------------

test("infer step2: a known checkout_dir label resolves the repo", () => {
  const r = inferTargetRepo(item({ labels: ["clawhub"] }), CATALOG);
  assert.equal(r.repo, "openclaw/clawhub");
  if (r.repo !== null) assert.equal(r.via, "label");
});

test("infer step2: a full owner/repo label resolves the repo", () => {
  const r = inferTargetRepo(item({ labels: ["openclaw/fs-safe"] }), CATALOG);
  assert.equal(r.repo, "openclaw/fs-safe");
});

test("infer step2: two distinct known-repo labels is ambiguous -> skip", () => {
  const r = inferTargetRepo(item({ labels: ["clawhub", "fs-safe"] }), CATALOG);
  assert.equal(r.repo, null);
});

// ---------------------------------------------------------------------------
// Precedence (3): fallback-owner token + allowed repo name
// ---------------------------------------------------------------------------

test("infer step3: owner token in title + a plain repo-name label", () => {
  const r = inferTargetRepo(
    item({ title: "steipete: fix the widget", labels: ["mywidget"] }),
    CATALOG,
  );
  assert.equal(r.repo, "steipete/mywidget");
  if (r.repo !== null) assert.equal(r.via, "fallback-owner");
});

// ---------------------------------------------------------------------------
// Ambiguous: no candidates -> skip; never defaults
// ---------------------------------------------------------------------------

test("infer: no URL, no known label, no owner token -> ambiguous (never default)", () => {
  const r = inferTargetRepo(item({ labels: ["bug", "needs-triage"], title: "something" }), CATALOG);
  assert.equal(r.repo, null);
});

test("inferTargetRepo is exported from the barrel", () => {
  assert.equal(typeof inferFromIndex, "function");
});
