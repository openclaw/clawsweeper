import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GitHubRequestError } from "../dashboard/github-api.ts";
import { observeReviewAuthority } from "../scripts/review-authority-observer.mjs";

const subject = { repository: "example/project", actor: "reviewer", maxAgeMs: 10_000 };
const repository = {
  permission: "write",
  role_name: "maintain",
  user: { id: 7, login: "reviewer" },
  private: "not-evidence",
};
const membership = {
  state: "active",
  role: "member",
  user: { login: "reviewer", email: "omit@example.test" },
  organization: { login: "example" },
  private: "not-evidence",
};
const refuseFetch = `globalThis.fetch=()=>{throw new Error('sensitive-provider-canary');};`;
const operatorArguments = [
  "--repo",
  subject.repository,
  "--actor",
  subject.actor,
  "--max-age-ms",
  "10000",
];

test("outside mode selects one exact identity from a complete 100-entry page", async () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, login: `other-${index}`, email: "private-canary" }));
  page[99] = { id: 100, login: "ReViEwEr", email: "private-canary" };
  const calls: unknown[] = [];
  const actual = await observeReviewAuthority({ ...subject, outsideCollaboratorId: 100 }, "fixture-token", async (path, options) => {
    calls.push([path, options]);
    return path.startsWith("repos/") ? { ...repository, role_name: "write", user: { id: 100, login: "reviewer" } } : page;
  });
  assert.deepEqual(calls, [
    ["repos/example/project/collaborators/reviewer/permission", {}],
    ["orgs/example/outside_collaborators?filter=all&per_page=100", { maxResponseBytes: 262_144 }],
  ]);
  assert.equal(actual.authority.role, "ordinary");
  assert.equal(actual.authority.organizationMembershipObservedAt, null);
  assert(!Object.hasOwn(actual, "organizationMembership"));
  assert.deepEqual(actual.organizationOutsideCollaborator.value, { id: 100, login: "ReViEwEr" });
  assert.equal(actual.organizationOutsideCollaborator.repository, subject.repository);
  assert(Number.isFinite(Date.parse(actual.organizationOutsideCollaborator.observedAt)));
  assert.doesNotMatch(JSON.stringify(actual), /private-canary|email|other-/);
});

test("outside missing, malformed, conflicting and duplicate pages never expose a partial grant", async () => {
  const selected = { id: 7, login: "reviewer" };
  for (const page of [[], [{ id: 8, login: "elsewhere" }],
    Array.from({ length: 100 }, (_, index) => ({ id: index + 100, login: `other-${index}` })),
    null, {}, [selected, null], [selected, { id: 8, login: " padded " }],
    [selected, selected], [{ id: 8, login: "reviewer" }], [{ id: 7, login: "elsewhere" }],
    Array.from({ length: 101 }, (_, index) => ({ id: index + 1, login: `user-${index}` }))]) {
    const actual = await observeReviewAuthority({ ...subject, outsideCollaboratorId: 7 }, "fixture-token", async (path) =>
      path.startsWith("repos/") ? { ...repository, user: { id: 7, login: "reviewer" } } : page);
    assert.equal(actual.authority.role, "unknown");
    assert.equal(actual.organizationOutsideCollaborator.value, null);
  }
  for (const user of [{ id: 8, login: "reviewer" }, { id: 7, login: "other" }, { id: 7, login: " reviewer " }]) {
    const actual = await observeReviewAuthority({ ...subject, outsideCollaboratorId: 7 }, "fixture-token", async (path) =>
      path.startsWith("repos/") ? { ...repository, user } : [selected]);
    assert.equal(actual.authority.role, "unknown");
  }
});

test("selected outside errors retain their status and never try membership", async () => {
  const calls: string[] = [];
  await assert.rejects(observeReviewAuthority({ ...subject, outsideCollaboratorId: 7 }, "fixture-token", async (path) => {
    calls.push(path);
    if (path.startsWith("repos/")) return repository;
    throw new GitHubRequestError("private-canary", 404);
  }), (error: { phase: string; httpStatus: number; message: string }) => {
    assert.equal(error.phase, "organization_outside_collaborator");
    assert.equal(error.httpStatus, 404);
    assert.doesNotMatch(error.message, /private-canary/);
    return true;
  });
  assert.equal(calls.length, 2);
  assert(!calls.some((path) => path.includes("/memberships/")));
});

test("observer retains canonical subject/timestamps and only classifier-relevant fields", async () => {
  const calls: string[] = [];
  const actual = await observeReviewAuthority(subject, "fixture-token", async (path: string) => {
    calls.push(path);
    return calls.length === 1 ? repository : membership;
  });
  assert.deepEqual(calls, [
    "repos/example/project/collaborators/reviewer/permission",
    "orgs/example/memberships/reviewer",
  ]);
  assert.equal(actual.authority.role, "maintainer");
  assert.deepEqual(Object.keys(actual), ["authority", "repositoryPermission", "organizationMembership"]);
  assert.equal(
    actual.repositoryPermission.observedAt,
    actual.authority.repositoryPermissionObservedAt,
  );
  assert.equal(
    actual.organizationMembership.observedAt,
    actual.authority.organizationMembershipObservedAt,
  );
  assert.deepEqual(actual.repositoryPermission.value, {
    permission: "write",
    role_name: "maintain",
    user: { login: "reviewer" },
  });
  assert.deepEqual(actual.organizationMembership.value, {
    state: "active",
    role: "member",
    user: { login: "reviewer" },
    organization: { login: "example" },
  });
  assert.doesNotMatch(JSON.stringify(actual), /not-evidence|email|fixture-token/);
});

for (const status of [403, 404])
  test(`selected membership ${status} yields no partial authority or raw diagnostic`, async () => {
    await assert.rejects(
      observeReviewAuthority(subject, "fixture-token", async (path: string) => {
        if (path.startsWith("repos/")) return repository;
        throw new GitHubRequestError("sensitive-provider-body", status);
      }),
      (error: { phase: string; httpStatus: number; message: string }) => {
        assert.equal(error.phase, "organization_membership");
        assert.equal(error.httpStatus, status);
        assert.doesNotMatch(error.message, /sensitive/);
        return true;
      },
    );
  });

test("a later observation does fresh reads and sees loss of maintain access", async () => {
  let role = "maintain",
    calls = 0;
  const read = async (path: string) => {
    calls++;
    return path.startsWith("repos/") ? { ...repository, role_name: role } : membership;
  };
  assert.equal(
    (await observeReviewAuthority(subject, "fixture-token", read)).authority.role,
    "maintainer",
  );
  role = "write";
  assert.equal(
    (await observeReviewAuthority(subject, "fixture-token", read)).authority.role,
    "ordinary",
  );
  assert.equal(calls, 4);
});

test("the actual Node operator refuses piped output before any GET", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(refuseFetch)}`,
      "scripts/review-authority-observer.mjs",
      ...operatorArguments,
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: { GITHUB_TOKEN: "fixture-token" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.phase, "configuration");
  assert.equal(diagnostic.reason, "private_output");
  assert.match(diagnostic.hint, /Redirect stdout.*empty.*0600.*one link/);
  assert.ok(Buffer.byteLength(result.stderr) < 256);
  assert.doesNotMatch(result.stderr, /fixture-token|sensitive-provider-canary/);
});

for (const scenario of [
  { name: "missing token", args: operatorArguments, token: "", reason: "credentials" },
  { name: "missing arguments", args: [], token: "sensitive-token-canary", reason: "arguments" },
  {
    name: "unknown argument",
    args: ["--sensitive-argument-canary"],
    token: "sensitive-token-canary",
    reason: "arguments",
  },
  {
    name: "invalid outside identity",
    args: [...operatorArguments, "--outside-collaborator-id", "9007199254740992"],
    token: "sensitive-token-canary",
    reason: "arguments",
  },
  {
    name: "invalid age",
    args: [...operatorArguments.slice(0, -1), "sensitive-argument-canary"],
    token: "sensitive-token-canary",
    reason: "arguments",
  },
  {
    name: "invalid subject",
    args: ["--repo", "sensitive-subject-canary", ...operatorArguments.slice(2)],
    token: "sensitive-token-canary",
    reason: "arguments",
  },
])
  test(
    `the actual Node operator explains ${scenario.name} without a GET or sensitive values`,
    { skip: typeof process.getuid !== "function" },
    (t) => {
      const directory = mkdtempSync(join(tmpdir(), "review-authority-observer-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const output = join(directory, "private.json"),
        fd = openSync(output, "wx", 0o600);
      let result;
      try {
        result = spawnSync(
          process.execPath,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(refuseFetch)}`,
            "scripts/review-authority-observer.mjs",
            ...scenario.args,
          ],
          {
            cwd: resolve(import.meta.dirname, ".."),
            env: { GITHUB_TOKEN: scenario.token },
            stdio: ["ignore", fd, "pipe"],
          },
        );
      } finally {
        closeSync(fd);
      }
      assert.equal(result.status, 1);
      assert.equal(readFileSync(output, "utf8"), "");
      const diagnostic = JSON.parse(result.stderr.toString());
      assert.deepEqual(Object.keys(diagnostic).sort(), ["hint", "phase", "reason"]);
      assert.equal(diagnostic.phase, "configuration");
      assert.equal(diagnostic.reason, scenario.reason);
      assert.match(
        diagnostic.hint,
        scenario.reason === "credentials"
          ? /installation token as GITHUB_TOKEN/
          : /--repo.*--actor.*--max-age-ms/,
      );
      assert.ok(result.stderr.length < 256);
      assert.doesNotMatch(result.stderr.toString(), /sensitive-.*-canary/);
    },
  );

test(
  "the actual Node operator keeps selected HTTP failures redacted without configuration hints",
  { skip: typeof process.getuid !== "function" },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-authority-observer-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, "private.json"),
      fd = openSync(output, "wx", 0o600);
    const preload =
      "globalThis.fetch=async()=>new Response('sensitive-provider-canary',{status:403});";
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
          "scripts/review-authority-observer.mjs",
          ...operatorArguments,
        ],
        {
          cwd: resolve(import.meta.dirname, ".."),
          env: { GITHUB_TOKEN: "sensitive-token-canary" },
          stdio: ["ignore", fd, "pipe"],
        },
      );
    } finally {
      closeSync(fd);
    }
    assert.equal(result.status, 1);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.deepEqual(JSON.parse(result.stderr.toString()), {
      phase: "repository_permission",
      httpStatus: 403,
    });
    assert.doesNotMatch(result.stderr.toString(), /sensitive-.*-canary/);
  },
);

test(
  "the actual Node operator uses the canonical fixed-origin fresh GET owner",
  { skip: typeof process.getuid !== "function" },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "review-authority-observer-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, "private.json"),
      fd = openSync(output, "wx", 0o600);
    const preload = `globalThis.fetch=async(url,options)=>{if(!url.startsWith('https://api.github.com/')||options.method!=='GET'||options.cache!=='no-store'||options.redirect!=='manual'||options.headers.Authorization!=='Bearer fixture-token')throw new Error('unexpected transport');return Response.json(url.includes('/collaborators/')?${JSON.stringify(repository)}:${JSON.stringify(membership)});};`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "scripts/review-authority-observer.mjs",
        "--repo",
        subject.repository,
        "--actor",
        subject.actor,
        "--max-age-ms",
        "10000",
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { GITHUB_TOKEN: "fixture-token", GITHUB_API_URL: "https://untrusted.example" },
        stdio: ["ignore", fd, "pipe"],
      },
    );
    closeSync(fd);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).authority.role, "maintainer");
    assert.doesNotMatch(readFileSync(output, "utf8"), /fixture-token|not-evidence|email/);
  },
);

test("actual outside CLI keeps exact selection private and rejects truncated or oversized transport", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "outside-observer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const variant of ["match", "absent", "truncated", "oversized"]) {
    const output = join(directory, `${variant}.json`), fd = openSync(output, "wx", 0o600);
    const response = variant === "truncated" ? "new Response('[{')" : variant === "oversized"
      ? "new Response('x'.repeat(262145))" : `Response.json(${variant === "match" ? '[{id:7,login:"REVIEWER",email:"private-canary"}]' : '[]'})`;
    const preload = `let count=0;globalThis.fetch=async(url,options)=>{count++;if(count>2||options.method!=='GET'||url.includes('/memberships/'))throw new Error('unexpected call');return url.includes('/collaborators/')?Response.json({permission:'write',role_name:'write',user:{id:7,login:'reviewer'}}):${response};};`;
    let result;
    try {
      result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
        "scripts/review-authority-observer.mjs", ...operatorArguments, "--outside-collaborator-id", "7"],
        { cwd: resolve(import.meta.dirname, ".."), env: { GITHUB_TOKEN: "fixture-token" }, stdio: ["ignore", fd, "pipe"] });
    } finally { closeSync(fd); }
    const bytes = readFileSync(output, "utf8");
    if (["match", "absent"].includes(variant)) {
      assert.equal(result.status, 0, result.stderr.toString());
      const value = JSON.parse(bytes);
      assert.equal(value.authority.role, variant === "match" ? "ordinary" : "unknown");
      assert(!Object.hasOwn(value, "organizationMembership"));
      assert.doesNotMatch(bytes, /private-canary|email|fixture-token/);
    } else {
      assert.equal(result.status, 1);
      assert.equal(bytes, "");
      assert.deepEqual(JSON.parse(result.stderr.toString()), { phase: "organization_outside_collaborator", ...(variant === "oversized" ? { httpStatus: 200 } : {}) });
    }
  }
});
