import assert from "node:assert/strict";
import test from "node:test";
import { enrollEndorPullRequests } from "../../dist/repair/endor-automerge-intake.js";

const repo = "openclaw/openclaw";
const author = { login: "endor-labs-pro[bot]", id: 179191674, type: "Bot" };
const pull = {
  number: 42,
  user: author,
  state: "open",
  draft: false,
  locked: false,
  labels: [],
  base: { ref: "main", repo: { full_name: repo } },
  head: {
    ref: "endorlabs-e071/npm_and_yarn/dot-/fast-xml-parser-5.3.5",
    repo: { full_name: repo },
  },
};

function fixture(
  options: {
    candidate?: unknown;
    pull?: unknown;
    events?: unknown[][];
    repository?: Record<string, unknown>;
  } = {},
) {
  const writes: string[][] = [];
  const current = structuredClone(options.pull ?? pull);
  const events = options.events ?? [[]];
  const github: NonNullable<Parameters<typeof enrollEndorPullRequests>[0]["github"]> = (args) => {
    const endpoint = args[1];
    if (args.includes("POST")) {
      writes.push(args);
      events.push([{ event: "labeled", label: { name: "clawsweeper:automerge" } }]);
      return [{ name: "clawsweeper:automerge" }];
    }
    if (endpoint === `repos/${repo}`) {
      return {
        full_name: repo,
        private: false,
        archived: false,
        disabled: false,
        has_issues: true,
        default_branch: "main",
        ...options.repository,
      };
    }
    if (endpoint?.includes("?creator="))
      return [
        [
          options.candidate ?? {
            ...pull,
            pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/42" },
          },
        ],
      ];
    if (endpoint === `repos/${repo}/issues/42/events?per_page=100`) return events;
    if (endpoint === `repos/${repo}/pulls/42`) return current;
    throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
  };
  return { github, writes, events };
}

test("enrols an Endor Pro PR using only the existing automerge label", () => {
  const { github, writes } = fixture();
  assert.deepEqual(enrollEndorPullRequests({ repo, execute: true, github }), [
    { number: 42, status: "enrolled" },
  ]);
  assert.deepEqual(writes, [
    [
      "api",
      `repos/${repo}/issues/42/labels`,
      "--method",
      "POST",
      "-f",
      "labels[]=clawsweeper:automerge",
    ],
  ]);
});

test("preview is read-only and reports the intended enrolment", () => {
  const { github, writes } = fixture();
  assert.deepEqual(enrollEndorPullRequests({ repo, github }), [{ number: 42, status: "planned" }]);
  assert.deepEqual(writes, []);
});

test("repeated runs and manual removal do not re-enrol a previously handled PR", () => {
  const { github, writes, events } = fixture();
  enrollEndorPullRequests({ repo, execute: true, github });
  events.push([{ event: "unlabeled", label: { name: "clawsweeper:automerge" } }]);
  // The live PR has no mode label, but GitHub retains the label events.
  assert.deepEqual(enrollEndorPullRequests({ repo, execute: true, github }), [
    { number: 42, status: "skipped" },
  ]);
  assert.equal(writes.length, 1);
});

for (const [name, patch] of Object.entries({
  "human impersonating Endor in the title": { user: { ...author, id: 42, type: "User" } },
  "different bot with the Endor display name": { user: { ...author, id: 42 } },
  "closed after discovery": { state: "closed" },
  "converted to draft": { draft: true },
  "locked PR": { locked: true },
  "fork branch": { head: { ...pull.head, repo: { full_name: "outside/openclaw" } } },
  "non-default base branch": { base: { ...pull.base, ref: "release" } },
  "different base repository": { base: { ...pull.base, repo: { full_name: "openclaw/other" } } },
})) {
  test(`does not enrol ${name}`, () => {
    const { github, writes } = fixture({ pull: { ...pull, ...patch } });
    assert.deepEqual(enrollEndorPullRequests({ repo, execute: true, github }), [
      { number: 42, status: "skipped" },
    ]);
    assert.deepEqual(writes, []);
  });
}

for (const name of [
  "clawsweeper:autofix",
  "clawsweeper:human-review",
  "clawsweeper:manual-only",
  "clawsweeper:merge-ready",
  "clawsweeper:needs-security-review",
  "security",
]) {
  test(`respects current and historical ${name}`, () => {
    for (const options of [
      { pull: { ...pull, labels: [{ name }] } },
      { events: [[], [{ event: "unlabeled", label: { name } }]] },
    ]) {
      const { github, writes } = fixture(options);
      assert.deepEqual(enrollEndorPullRequests({ repo, execute: true, github }), [
        { number: 42, status: "skipped" },
      ]);
      assert.deepEqual(writes, []);
    }
  });
}

test("does not trust discovery alone or treat ordinary issues as PRs", () => {
  for (const candidate of [pull, { ...pull, user: { ...author, id: 42 }, pull_request: {} }]) {
    const { github, writes } = fixture({ candidate });
    assert.deepEqual(enrollEndorPullRequests({ repo, execute: true, github }), []);
    assert.deepEqual(writes, []);
  }
});

test("rejects out-of-scope repositories before any GitHub calls", () => {
  assert.throws(
    () =>
      enrollEndorPullRequests({
        repo: "openclaw/endor-clawsweeper-e2e",
        execute: true,
        github: () => assert.fail("must not contact GitHub"),
      }),
    /restricted/,
  );
});

test("fails closed for inaccessible history and invalid GitHub payloads", () => {
  for (const badResponse of [null, {}, [null], [[{ event: "unlabeled" }]]]) {
    const { github, writes } = fixture();
    assert.throws(() =>
      enrollEndorPullRequests({
        repo,
        execute: true,
        github: (args) => (args[1]?.includes("/events?") ? badResponse : github(args)),
      }),
    );
    assert.deepEqual(writes, []);
  }
  const { github, writes } = fixture();
  assert.throws(
    () =>
      enrollEndorPullRequests({
        repo,
        execute: true,
        github: (args) => {
          if (args[1]?.includes("/events?")) throw new Error("GitHub 403");
          return github(args);
        },
      }),
    /GitHub 403/,
  );
  assert.deepEqual(writes, []);
});

test("refuses repositories that no longer meet the public hosted contract", () => {
  for (const repository of [
    { private: true },
    { archived: true },
    { has_issues: false },
    { disabled: true },
  ]) {
    const { github, writes } = fixture({ repository });
    assert.throws(
      () => enrollEndorPullRequests({ repo, execute: true, github }),
      /active public repository/,
    );
    assert.deepEqual(writes, []);
  }
});
