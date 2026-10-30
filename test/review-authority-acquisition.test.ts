import assert from "node:assert/strict";
import test from "node:test";
import { acquireReviewAuthority } from "../dist/review-authority-acquisition.js";
import { resolveReviewAuthority } from "../dist/review-authority.js";
import { ghJson } from "../dist/clawsweeper-github-execution.js";
import { GitHubRateLimitError } from "../dist/github-retry.js";
import { githubTest, installGhFixture } from "./github-runtime-fixture.ts";

const subject = { repository: "example/project", actor: "reviewer" };
const epoch = Date.parse("2026-10-29T01:00:00Z");
const clock = { now: () => epoch, maxAgeMs: 60_000 };
function permission(role = "maintain", actor = subject.actor) {
  return {
    permission: role === "maintain" ? "write" : role === "triage" ? "read" : role,
    role_name: role,
    user: { login: actor },
  };
}
function membership(role = "admin", state = "active") {
  return { role, state, user: { login: subject.actor }, organization: { login: "example" } };
}
function acquire(value: unknown, member?: unknown) {
  return acquireReviewAuthority({
    ...subject,
    ...clock,
    readRepositoryPermission: () => value,
    ...(member !== undefined ? { readOrganizationMembership: () => member } : {}),
  });
}

test("complete acquired role payloads agree with the canonical classifier", async () => {
  const roles = ["admin", "maintain", "write", "triage", "read", "none"];
  for (const role of roles) {
    const value = permission(role);
    const actual = await acquire(value);
    assert.deepEqual(
      actual,
      resolveReviewAuthority({
        ...subject,
        now: epoch,
        maxAgeMs: clock.maxAgeMs,
        repositoryPermission: { ...subject, value, observedAt: new Date(epoch).toISOString() },
      }),
    );
    assert.equal(actual.role, ["admin", "maintain"].includes(role) ? "maintainer" : "ordinary");
  }
  // GitHub's legacy write value alone cannot distinguish maintain from write.
  assert.equal(
    (await acquire({ permission: "write", user: { login: subject.actor } })).role,
    "unknown",
  );
});

test("custom role names retain complete effective flags and contradictory payloads", async () => {
  const flags = { admin: false, maintain: true, push: true, triage: true, pull: true };
  const custom = {
    ...permission(),
    role_name: "custom-reviewer",
    user: { login: subject.actor, permissions: flags },
  };
  assert.equal((await acquire(custom)).role, "maintainer");
  assert.equal(
    (
      await acquire({
        ...custom,
        user: { ...custom.user, permissions: { ...flags, maintain: false } },
      })
    ).role,
    "ordinary",
  );
  assert.equal(
    (await acquire({ ...custom, user: { ...custom.user, permissions: { maintain: true } } })).role,
    "unknown",
  );
  assert.equal((await acquire({ ...custom, permission: "read" })).reason, "contradictory_evidence");
});

test("selected active org ownership is checked without trusting membership labels", async () => {
  assert.equal((await acquire(permission("admin"), membership())).reason, "organization_owner");
  for (const member of [membership("member"), membership("admin", "pending")]) {
    assert.equal((await acquire(permission("read"), member)).role, "ordinary");
  }
  assert.equal((await acquire(permission("write"), membership())).reason, "contradictory_evidence");
  assert.equal(
    (await acquire(permission("admin"), { ...membership(), organization: { login: "elsewhere" } }))
      .reason,
    "subject_mismatch",
  );
  assert.equal(
    (await acquire(permission("maintain"), membership("billing_manager"))).reason,
    "invalid_evidence",
  );
});

test("fork and upstream observations are acquired under their actual target independently", async () => {
  const paths: string[] = [];
  const read = (path: string) => {
    paths.push(path);
    return permission(path.startsWith("repos/upstream/") ? "admin" : "read");
  };
  const upstream = await acquireReviewAuthority({
    ...subject,
    ...clock,
    repository: "upstream/project",
    readRepositoryPermission: read,
  });
  const fork = await acquireReviewAuthority({
    ...subject,
    ...clock,
    repository: "fork-owner/project",
    readRepositoryPermission: read,
  });
  assert.equal(upstream.role, "maintainer");
  assert.equal(fork.role, "ordinary");
  assert.equal(fork.repository, "fork-owner/project");
  assert.deepEqual(paths, [
    "repos/upstream/project/collaborators/reviewer/permission",
    "repos/fork-owner/project/collaborators/reviewer/permission",
  ]);
});

test("opaque identities are encoded into fixed subject routes and optional org reads stay absent", async () => {
  const paths: string[] = [];
  const actor = "Review_User[bot]";
  const result = await acquireReviewAuthority({
    repository: "Example_Org/Project",
    actor,
    ...clock,
    readRepositoryPermission: (path) => {
      paths.push(path);
      return permission("maintain", actor);
    },
  });
  assert.equal(result.role, "maintainer");
  assert.deepEqual(paths, [
    "repos/example_org/project/collaborators/review_user%5Bbot%5D/permission",
  ]);
  assert.equal(result.organizationMembershipObservedAt, null);
});

test("invalid input cannot issue a request or silently drop repository path segments", async () => {
  for (const overrides of [
    { repository: "example/project/other" },
    { repository: " example/project" },
    { actor: " reviewer" },
    { actor: "" },
    { actor: "x".repeat(257) },
    { maxAgeMs: -1 },
    { now: () => Number.NaN },
  ]) {
    const result = await acquireReviewAuthority({
      ...subject,
      ...clock,
      ...overrides,
      readRepositoryPermission: () => {
        assert.fail("invalid subject must not reach transport");
      },
    });
    assert.equal(result.role, "unknown");
    assert.equal(result.reason, "invalid_evidence");
  }
});

test("fresh observation stamps follow each async completion, then final classification", async () => {
  let now = epoch;
  const paths: string[] = [];
  const result = await acquireReviewAuthority({
    ...subject,
    maxAgeMs: 3_000,
    now: () => now,
    readRepositoryPermission: async (path) => {
      paths.push(path);
      await Promise.resolve();
      now += 1_000;
      return permission("admin");
    },
    readOrganizationMembership: async (path) => {
      paths.push(path);
      await Promise.resolve();
      now += 2_000;
      return membership();
    },
  });
  assert.equal(result.role, "maintainer");
  assert.deepEqual(paths, [
    "repos/example/project/collaborators/reviewer/permission",
    "orgs/example/memberships/reviewer",
  ]);
  assert.equal(result.repositoryPermissionObservedAt, new Date(epoch + 1_000).toISOString());
  assert.equal(result.organizationMembershipObservedAt, new Date(epoch + 3_000).toISOString());
});

test("later reads and final-clock drift cannot refresh earlier permission evidence", async () => {
  for (const stamps of [
    [epoch, epoch, epoch + 61_000, epoch + 61_000],
    [epoch, epoch, epoch, epoch + 61_000],
    [epoch, epoch, epoch, epoch - 1],
  ]) {
    const times = [...stamps];
    const result = await acquireReviewAuthority({
      ...subject,
      maxAgeMs: 60_000,
      now: () => times.shift()!,
      readRepositoryPermission: () => permission("admin"),
      readOrganizationMembership: () => membership(),
    });
    assert.equal(result.role, "unknown");
    assert.equal(result.reason, "stale_evidence");
    assert.equal(times.length, 0);
  }
});

test("malformed selected responses and response actors never disappear as absent evidence", async () => {
  for (const value of [null, undefined, [], {}, permission("admin", "other")]) {
    assert.equal((await acquire(value)).role, "unknown");
  }
  for (const value of [null, undefined]) {
    const result = await acquireReviewAuthority({
      ...subject,
      ...clock,
      readRepositoryPermission: () => permission("admin"),
      readOrganizationMembership: () => value,
    });
    assert.equal(result.role, "unknown");
    assert.equal(result.organizationMembershipObservedAt, new Date(epoch).toISOString());
  }
});

test("every selected transport error preserves identity and prevents a partial authority result", async () => {
  const errors = [
    new Error("HTTP 401 Requires authentication"),
    new Error("HTTP 403 Forbidden"),
    new Error("HTTP 404 Not Found"),
    new SyntaxError("Unexpected end of JSON input"),
    new GitHubRateLimitError(new Error("HTTP 429 rate limit"), epoch),
    Object.assign(new Error("budget exhausted"), { name: "GitHubRuntimeBudgetError" }),
    Object.assign(new Error("deadline exceeded"), { name: "GitHubOperationDeadlineError" }),
  ];
  for (const error of errors) {
    let memberReads = 0;
    await assert.rejects(
      acquireReviewAuthority({
        ...subject,
        ...clock,
        readRepositoryPermission: () => {
          throw error;
        },
        readOrganizationMembership: () => {
          memberReads++;
          return membership();
        },
      }),
      (actual) => actual === error,
    );
    assert.equal(memberReads, 0);
    await assert.rejects(
      acquireReviewAuthority({
        ...subject,
        ...clock,
        readRepositoryPermission: () => permission("admin"),
        readOrganizationMembership: async () => {
          throw error;
        },
      }),
      (actual) => actual === error,
    );
  }
});

test("repeated acquisition observes revocation and keeps author separate from requester", async () => {
  let reads = 0;
  const options = {
    ...subject,
    ...clock,
    readRepositoryPermission: () => permission(reads++ === 0 ? "maintain" : "write"),
  };
  assert.equal((await acquireReviewAuthority(options)).role, "maintainer");
  assert.equal((await acquireReviewAuthority(options)).role, "ordinary");
  assert.equal(reads, 2);
  const author = await acquire(permission("read"));
  const requester = await acquireReviewAuthority({
    ...subject,
    actor: "requester",
    ...clock,
    readRepositoryPermission: () => permission("admin", "requester"),
  });
  assert.equal(author.actor, "reviewer");
  assert.equal(author.role, "ordinary");
  assert.equal(requester.actor, "requester");
  assert.equal(requester.role, "maintainer");
});

githubTest(
  "existing native GET owner carries complete role data without response-cache reuse",
  async (t) => {
    const fixture = installGhFixture(
      t,
      `
if (args[0] !== "api") process.exit(2);
if (args[1] === "repos/example/project/collaborators/reviewer/permission") {
  state.permissionReads = (state.permissionReads || 0) + 1;
  console.log(JSON.stringify({permission:"write",role_name:state.permissionReads === 1 ? "maintain" : "write",user:{login:"reviewer"}}));
} else if (args[1] === "orgs/example/memberships/reviewer") {
  console.log(JSON.stringify({state:"active",role:"member",user:{login:"reviewer"},organization:{login:"example"}}));
} else process.exit(2);
`,
    );
    const get = (path: string) => ghJson(["api", path]);
    const options = {
      ...subject,
      ...clock,
      readRepositoryPermission: get,
      readOrganizationMembership: get,
    };
    assert.equal((await acquireReviewAuthority(options)).role, "maintainer");
    assert.equal((await acquireReviewAuthority(options)).role, "ordinary");
    assert.deepEqual(
      fixture.requests().map(({ args }) => args),
      [
        ["api", "repos/example/project/collaborators/reviewer/permission"],
        ["api", "orgs/example/memberships/reviewer"],
        ["api", "repos/example/project/collaborators/reviewer/permission"],
        ["api", "orgs/example/memberships/reviewer"],
      ],
    );
  },
);
