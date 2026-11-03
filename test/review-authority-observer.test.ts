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
  user: { login: "reviewer" },
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
