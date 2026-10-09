import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

import { probeHostedPublicTarget } from "../dashboard/exact-review-queue.ts";
import {
  isHostedTargetEligible,
  resolveHostedTargetEligibility,
} from "../src/hosted-target-admission.ts";

test("hosted target eligibility is configured profiles plus owner fallbacks", () => {
  const policy = {
    configuredRepositories: ["partner/configured-repo"],
    genericFallbacks: [
      {
        owner: "openclaw",
        denyRepositories: ["openclaw/clawsweeper-state"],
        allowRepoNamePattern: /^[a-z0-9_.-]+$/,
      },
      {
        owner: "steipete",
        denyRepositories: [],
        allowRepoNamePattern: /^[a-z0-9_.-]+$/,
      },
    ],
  };
  assert.equal(isHostedTargetEligible("partner/configured-repo", policy), true);
  assert.equal(isHostedTargetEligible("OpenClaw/new-repo", policy), true);
  assert.equal(isHostedTargetEligible("Steipete/new-repo", policy), true);
  assert.equal(isHostedTargetEligible("openclaw/clawsweeper-state", policy), false);
  assert.equal(isHostedTargetEligible("partner/other-repo", policy), false);
  assert.equal(isHostedTargetEligible("outside/repo", policy), false);
  assert.equal(isHostedTargetEligible("outside", policy), false);
});

test("hosted target eligibility reads configured profiles and fallback deny policy together", async () => {
  let registryReads = 0;
  const reader: typeof fetch = async () => {
    registryReads += 1;
    return Response.json({
      schema_version: 2,
      repositories: [{ target_repo: "partner/configured-repo" }],
      generic_fallbacks: [
        {
          owner: "openclaw",
          deny_repositories: ["openclaw/clawsweeper-state", "openclaw/.github"],
          allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$",
        },
        {
          owner: "steipete",
          deny_repositories: [],
          allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$",
        },
      ],
    });
  };

  assert.deepEqual(await resolveHostedTargetEligibility("openclaw/new-repo", reader), {
    outcome: "eligible",
  });
  assert.deepEqual(await resolveHostedTargetEligibility("openclaw/clawsweeper-state", reader), {
    outcome: "terminal",
  });
  assert.deepEqual(await resolveHostedTargetEligibility("openclaw/.github", reader), {
    outcome: "terminal",
  });
  assert.deepEqual(await resolveHostedTargetEligibility("partner/configured-repo", reader), {
    outcome: "eligible",
  });
  assert.deepEqual(await resolveHostedTargetEligibility("partner/other-repo", reader), {
    outcome: "terminal",
  });
  assert.equal(registryReads, 5);
  assert.deepEqual(
    await resolveHostedTargetEligibility("partner/configured-repo", async () =>
      Response.json({}, { status: 503 }),
    ),
    { outcome: "retryable" },
  );
});

test("hosted target registry lookup stays inside queue caller deadlines", async () => {
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs = 0;
  try {
    AbortSignal.timeout = ((milliseconds: number) => {
      timeoutMs = milliseconds;
      return originalTimeout(milliseconds);
    }) as typeof AbortSignal.timeout;
    assert.deepEqual(
      await resolveHostedTargetEligibility("outside/repo", async () =>
        Response.json({
          schema_version: 2,
          repositories: [],
          generic_fallbacks: [],
        }),
      ),
      { outcome: "terminal" },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.equal(timeoutMs, 5_000);
});

test("hosted target metadata classification is authenticated, fresh, and fail-closed", async () => {
  const cases: Array<[string, Response | Error, string]> = [
    [
      "public",
      Response.json({ full_name: "openclaw/openclaw", private: false, visibility: "public" }),
      "public",
    ],
    [
      "private",
      Response.json({ full_name: "openclaw/openclaw", private: true, visibility: "private" }),
      "terminal",
    ],
    [
      "internal",
      Response.json({ full_name: "openclaw/openclaw", private: false, visibility: "internal" }),
      "terminal",
    ],
    [
      "wrong name",
      Response.json({ full_name: "openclaw/other", private: false, visibility: "public" }),
      "terminal",
    ],
    ["missing", Response.json({}, { status: 404 }), "terminal"],
    ["forbidden", Response.json({}, { status: 403 }), "retryable"],
    ["redirect", new Response(null, { status: 302 }), "retryable"],
    ["malformed", new Response("{", { status: 200 }), "retryable"],
    ["network", new Error("offline"), "retryable"],
  ];

  for (const [name, result, expected] of cases) {
    let observedInit: RequestInit | undefined;
    const observed = await probeHostedPublicTarget(
      "openclaw/openclaw",
      "central-metadata-token",
      async (_input, init) => {
        observedInit = init;
        if (result instanceof Error) throw result;
        return result;
      },
    );
    assert.equal(observed.outcome, expected, name);
    assert.equal(observedInit?.redirect, "manual", name);
    assert.equal(observedInit?.cache, "no-store", name);
    assert.equal(new Headers(observedInit?.headers).get("cache-control"), "no-store", name);
    assert.equal(
      new Headers(observedInit?.headers).get("authorization"),
      "Bearer central-metadata-token",
      name,
    );
  }
});

test("hosted target metadata retry hints honor bounded GitHub quota headers", async () => {
  const now = Date.now();
  const resetAt = now + 90_000;
  const reset = await probeHostedPublicTarget(
    "openclaw/openclaw",
    "central-metadata-token",
    async () =>
      Response.json(
        {},
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.ceil(resetAt / 1_000)),
          },
        },
      ),
  );
  assert.equal(reset.outcome, "retryable");
  assert.ok((reset.retryAt ?? 0) >= resetAt - 1_000);
  assert.ok((reset.retryAt ?? 0) <= resetAt + 1_000);

  const retryAfter = await probeHostedPublicTarget(
    "openclaw/openclaw",
    "central-metadata-token",
    async () => Response.json({}, { status: 429, headers: { "retry-after": "999999" } }),
  );
  assert.equal(retryAfter.outcome, "retryable");
  assert.ok((retryAfter.retryAt ?? 0) <= Date.now() + 2 * 60 * 60 * 1_000);
});

test("hosted admission steps classify registry and visibility replies", () => {
  const admit = parse(readFileSync(".github/workflows/hosted-target-admission.yml", "utf8")).jobs
    .admit.steps as Array<{ id?: string; run?: string }>;
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-hosted-admission-"));
  const preload = join(root, "fetch.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs";
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(process.env.FETCH_LOG, JSON.stringify({ url: String(url), ...init, signal: init.signal instanceof AbortSignal }) + "\\n");
  const reply = JSON.parse(process.env.FETCH_REPLY);
  if (reply.status === 0) throw new Error("network down");
  return new Response(JSON.stringify(reply.body), { status: reply.status });
};
`,
  );
  const run = (id: string, env: Record<string, string>, reply = { status: 0, body: {} }) => {
    const output = join(root, "output");
    const log = join(root, "fetch.log");
    writeFileSync(output, "");
    writeFileSync(log, "");
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module"], {
      input: /<<'NODE'\n([\s\S]*?)\nNODE/.exec(
        admit.find((step) => step.id === id)?.run ?? "",
      )?.[1],
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        FETCH_LOG: log,
        FETCH_REPLY: JSON.stringify(reply),
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const requests = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { outcome: readFileSync(output, "utf8"), requests };
  };
  const registry = {
    status: 200,
    body: {
      schema_version: 2,
      repositories: [{ target_repo: "Partner/Configured" }],
      generic_fallbacks: [
        {
          owner: "openclaw",
          deny_repositories: ["openclaw/clawsweeper-state"],
          allow_repo_name_pattern: "^[a-z0-9-]+$",
        },
      ],
    },
  };
  try {
    for (const [target, reply, outcome] of [
      ["partner/configured", registry, "eligible"],
      ["openclaw/new-plugin", registry, "eligible"],
      ["openclaw/clawsweeper-state", registry, "terminal"],
      ["partner/unlisted", registry, "terminal"],
      ["partner/configured", { status: 500, body: {} }, "retryable"],
      ["partner/configured", { status: 0, body: {} }, "retryable"],
    ] as const) {
      const result = run("eligibility", { TARGET_REPO: target, REGISTRY_REF: "main" }, reply);
      assert.equal(result.outcome, `outcome=${outcome}\n`, `${target} ${reply.status}`);
      assert.equal(result.requests.length, 1);
      assert.equal(
        result.requests[0].url,
        "https://raw.githubusercontent.com/openclaw/clawsweeper/main/config/target-repositories.json",
      );
      assert.equal(result.requests[0].cache, "no-store");
      assert.equal(result.requests[0].redirect, "manual");
      assert.equal(result.requests[0].signal, true);
    }
    for (const env of [
      { TARGET_REPO: "invalid", REGISTRY_REF: "main" },
      { TARGET_REPO: "partner/configured", REGISTRY_REF: "feature-branch" },
    ]) {
      const result = run("eligibility", env, registry);
      assert.equal(result.requests.length, 0);
      assert.equal(
        result.outcome,
        `outcome=${env.TARGET_REPO === "invalid" ? "terminal" : "retryable"}\n`,
      );
    }

    const repository = (visibility: string, overrides = {}) => ({
      status: 200,
      body: {
        full_name: "Partner/Configured",
        private: visibility !== "public",
        visibility,
        ...overrides,
      },
    });
    for (const [reply, outcome] of [
      [repository("public"), "public"],
      [repository("private"), "terminal"],
      [repository("public", { private: true }), "terminal"],
      [repository("public", { full_name: "partner/renamed" }), "terminal"],
      [{ status: 404, body: {} }, "terminal"],
      [{ status: 500, body: {} }, "retryable"],
    ] as const) {
      const env = {
        TARGET_REPO: "partner/configured",
        TARGET_ELIGIBILITY: "eligible",
        METADATA_TOKEN: "metadata-token",
      };
      const result = run("probe", env, reply);
      assert.equal(result.outcome, `outcome=${outcome}\n`, `${reply.status}`);
      assert.equal(result.requests[0].url, "https://api.github.com/repos/partner/configured");
      assert.equal(result.requests[0].headers.Authorization, "Bearer metadata-token");
      assert.equal(result.requests[0].redirect, "manual");
    }
    for (const [eligibility, token, outcome] of [
      ["terminal", "metadata-token", "terminal"],
      ["eligible", "", "retryable"],
    ]) {
      const env = {
        TARGET_REPO: "partner/configured",
        TARGET_ELIGIBILITY: eligibility!,
        METADATA_TOKEN: token!,
      };
      const result = run("probe", env, repository("public"));
      assert.equal(result.requests.length, 0);
      assert.equal(result.outcome, `outcome=${outcome}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type GuardJob = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: Array<{ id?: string; uses?: string; if?: string; with?: Record<string, string> }>;
};

function guardJobs(name: string): Record<string, GuardJob> {
  return parse(readFileSync(`.github/workflows/${name}`, "utf8")).jobs as Record<string, GuardJob>;
}

// Admission decides visibility before any other job can mint a credential.
test("hosted admission has no permissions and mints only a metadata-read token after eligibility", () => {
  const document = parse(readFileSync(".github/workflows/hosted-target-admission.yml", "utf8")) as {
    permissions: Record<string, string>;
  };
  assert.deepEqual(document.permissions, {});
  const admit = guardJobs("hosted-target-admission.yml").admit?.steps ?? [];
  assert.equal(
    admit.some((step) => step.uses?.startsWith("actions/checkout")),
    false,
  );
  const eligibility = admit.findIndex((step) => step.id === "eligibility");
  const token = admit.findIndex((step) => step.id === "metadata_token");
  assert.ok(eligibility >= 0 && eligibility < token);
  assert.equal(admit[token]?.if, "${{ steps.eligibility.outputs.outcome == 'eligible' }}");
  assert.deepEqual(
    Object.entries(admit[token]?.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-metadata", "read"]],
  );
  assert.equal(admit[token]?.with?.repositories, "clawsweeper");
});

// Privileged jobs run only after admission reports a public target.
test("privileged sweep and router jobs need a public hosted admission", () => {
  for (const [file, names] of [
    [
      "sweep.yml",
      ["plan", "target-fanout", "retry-failed-reviews", "audit-dashboard", "apply-proof"],
    ],
    ["repair-comment-router.yml", ["route-comments"]],
  ] as const) {
    const jobs = guardJobs(file);
    for (const name of names) {
      assert.equal(jobs[name]?.needs, "hosted-target-admission", `${file}:${name}`);
      assert.match(
        jobs[name]?.if ?? "",
        /needs\.hosted-target-admission\.outputs\.outcome == 'public'/,
        `${file}:${name}`,
      );
      assert.doesNotMatch(jobs[name]?.if ?? "", /hosted-target-admission\.result == 'skipped'/);
    }
  }
  assert.deepEqual(guardJobs("repair-comment-router.yml")["hosted-target-admission"]?.secrets, {
    CLAWSWEEPER_APP_PRIVATE_KEY: "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
  });
});
