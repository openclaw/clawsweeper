import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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

test("hosted admission heredocs execute as ESM without network access", () => {
  const admission = readFileSync(".github/workflows/hosted-target-admission.yml", "utf8");
  const scripts = [
    ...admission.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/g),
  ].map((match) => match[1] ?? "");
  assert.equal(scripts.length, 2);
  assert.equal(
    scripts.every((script) => /import fs from "node:fs";/.test(script)),
    true,
  );

  const root = mkdtempSync(join(tmpdir(), "clawsweeper-hosted-admission-"));
  try {
    for (const [index, script] of scripts.entries()) {
      const output = join(root, `output-${index}`);
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          TARGET_REPO: "invalid",
          TARGET_ELIGIBILITY: "terminal",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), "outcome=terminal\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled, manual, target-sweep, and comment workflows admit targets before privileged jobs", () => {
  const admission = readFileSync(".github/workflows/hosted-target-admission.yml", "utf8");
  assert.match(admission, /workflow_call:/);
  assert.match(admission, /permissions: \{\}/);
  assert.match(admission, /runs-on: ubuntu-latest\s+timeout-minutes: 2/);
  assert.match(admission, /outputs:\s+outcome:/);
  assert.match(admission, /value: \$\{\{ jobs\.admit\.outputs\.outcome \}\}/);
  assert.match(admission, /outcome: \$\{\{ steps\.probe\.outputs\.outcome \}\}/);
  assert.match(admission, /registry_ref:\s+required: false\s+type: string\s+default: main/);
  assert.match(
    admission,
    /https:\/\/raw\.githubusercontent\.com\/openclaw\/clawsweeper\/\$\{registryRef\}\/config\/target-repositories\.json/,
  );
  assert.match(admission, /entry\.deny_repositories/);
  assert.match(admission, /fallback\.denyRepositories\.includes\(target\)/);
  assert.match(admission, /\/\^\(openclaw\|steipete\)\$\/\.test\(owner\)/);
  assert.match(admission, /entry\.target_repo\.trim\(\)\.toLowerCase\(\) === target/);
  assert.match(admission, /if: \$\{\{ steps\.eligibility\.outputs\.outcome == 'eligible' \}\}/);
  assert.ok(
    admission.indexOf("Check hosted target eligibility") <
      admission.indexOf("Create central metadata token"),
  );
  assert.doesNotMatch(admission, /\.hosted != false/);
  assert.match(admission, /create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(admission, /continue-on-error: true/);
  assert.match(
    admission,
    /owner: openclaw\s+repositories: clawsweeper\s+permission-metadata: read/,
  );
  assert.doesNotMatch(admission, /permission-(?:contents|issues|pull-requests|actions):/);
  assert.match(admission, /Authorization: `Bearer \$\{token\}`/);
  assert.match(admission, /"Cache-Control": "no-store"/);
  assert.match(admission, /cache: "no-store"/);
  assert.match(admission, /redirect: "manual"/);
  assert.match(admission, /signal: AbortSignal\.timeout\(20_000\)/);
  assert.match(admission, /outcome = "terminal"/);
  assert.match(admission, /outcome = "retryable"/);
  assert.match(admission, /outcome =\s+fullName === target[\s\S]*\? "public"\s+:\s+"terminal"/);
  assert.match(
    admission,
    /fs\.appendFileSync\(process\.env\.GITHUB_OUTPUT, `outcome=\$\{outcome\}\\n`\)/,
  );
  assert.doesNotMatch(admission, /console\.(?:log|error)|echo .*METADATA_TOKEN/);
  assert.doesNotMatch(admission, /checkout/);

  const sweep = readFileSync(".github/workflows/sweep.yml", "utf8");
  const jobBlock = (job: string) => {
    const start = sweep.indexOf(`\n  ${job}:`);
    assert.notEqual(start, -1, `missing workflow job ${job}`);
    const remaining = sweep.slice(start + 1);
    const next = remaining.search(/\n  [A-Za-z0-9_-]+:\n/);
    return sweep.slice(start, next === -1 ? undefined : start + 1 + next);
  };
  const admissionJob = jobBlock("hosted-target-admission");
  assert.match(admissionJob, /github\.event_name == 'schedule'/);
  assert.match(admissionJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(admissionJob, /github\.event\.action == 'clawsweeper_target_sweep'/);
  assert.match(admissionJob, /github\.event\.inputs\.target_repo/);
  assert.match(admissionJob, /github\.event\.client_payload\.target_repo/);
  assert.match(admissionJob, /'openclaw\/clawsweeper'/);
  assert.match(admissionJob, /'openclaw\/clawhub'/);
  assert.match(admissionJob, /'openclaw\/openclaw'/);
  for (const job of [
    "plan",
    "target-fanout",
    "retry-failed-reviews",
    "audit-dashboard",
    "apply-proof",
  ]) {
    const block = jobBlock(job);
    assert.match(block.slice(0, 500), /needs: hosted-target-admission/);
    assert.match(
      block.slice(0, 800),
      /needs\.hosted-target-admission\.outputs\.outcome == 'public'/,
    );
    assert.doesNotMatch(block.slice(0, 800), /hosted-target-admission\.result == 'skipped'/);
  }
  assert.match(
    sweep,
    /apply_after_review_min_age_minutes:\s+description: "Minute-level item age floor for immediate post-review apply"\s+required: false\s+default: "0"/,
  );
  assert.match(
    sweep,
    /min_age_minutes="\$\{\{ github\.event\.inputs\.apply_after_review_min_age_minutes \|\| '0' \}\}"/,
  );
  assert.match(
    sweep,
    /apply_min_age_minutes:\s+description: "Optional minute-level minimum item age before apply-existing can close it"\s+required: false\s+default: ""/,
  );
  const router = readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  assert.match(router, /route-comments:\s+needs: hosted-target-admission/);
  assert.match(
    router,
    /CLAWSWEEPER_APP_PRIVATE_KEY: \$\{\{ secrets\.CLAWSWEEPER_APP_PRIVATE_KEY \}\}/,
  );

  const dispatcher = readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8");
  assert.match(
    dispatcher,
    /hosted-target-admission:[\s\S]*?uses: openclaw\/clawsweeper\/\.github\/workflows\/hosted-target-admission\.yml@main[\s\S]*?target_repo: \$\{\{ github\.repository \}\}/,
  );
  assert.match(dispatcher, /dispatch:\s+needs: hosted-target-admission/);
  assert.match(dispatcher, /reject-hosted-target:\s+needs: hosted-target-admission/);
  assert.match(dispatcher, /needs\.hosted-target-admission\.outputs\.outcome == 'public'/);
  const rejectionJob = dispatcher.slice(
    dispatcher.indexOf("\n  reject-hosted-target:"),
    dispatcher.indexOf("\n  dispatch:"),
  );
  assert.match(rejectionJob, /permissions: \{\}/);
  assert.doesNotMatch(
    rejectionJob,
    /permissions: \{ issues: write \}|gh api|github\.token|GH_TOKEN/,
  );
  assert.match(
    dispatcher,
    /hosted-target-admission:[\s\S]*?secrets:\s+CLAWSWEEPER_APP_PRIVATE_KEY: \$\{\{ secrets\.CLAWSWEEPER_APP_PRIVATE_KEY \}\}/,
  );
});
