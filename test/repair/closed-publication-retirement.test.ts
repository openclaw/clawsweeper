import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { sha256 } from "../../dist/content-hash.js";
import {
  applyClosedPublicationRetirement,
  prepareClosedPublicationRetirement,
  readRetirementManifest,
  retirementPlanSummary,
} from "../../dist/repair/closed-publication-retirement.js";

type Member = {
  name: string;
  body: Buffer;
  method?: number;
  flags?: number;
  mode?: number;
  declaredBytes?: number;
};

function zip(members: Member[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const method = member.method ?? 8;
    const data = method === 8 ? deflateRawSync(member.body) : member.body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(member.body), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(member.declaredBytes ?? member.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    local.copy(entry, 6, 4, 26);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((member.mode ?? 0o100644) * 0x10000) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function fixture() {
  const sourceSha = "a".repeat(40);
  const targetKey = "openclaw/openclaw#770700";
  const publicationKey = `${targetKey}@publish:8001:1`;
  const report = Buffer.from("synthetic review");
  const manifest = {
    schema_version: 1,
    created_at: "2026-08-18T12:00:00Z",
    workflow: {
      repository: "openclaw/clawsweeper",
      source_sha: sourceSha,
      run_id: "8001",
      run_attempt: 1,
      producer_job: "event-review-apply",
    },
    queue: { item_key: targetKey, protocol_version: 2, lease_revision: 7, claim_generation: 1 },
    target: {
      repo: "openclaw/openclaw",
      branch: "main",
      item_number: 770700,
      item_kind: "pull_request",
    },
    review: {
      decision_sha256: "b".repeat(64),
      live_proceeded: true,
      live_terminal_noop: false,
      live_terminal_missing: false,
      live_guarded_open: false,
      artifact_present: true,
    },
    files: [{ path: "review/770700.md", bytes: report.length, sha256: sha256(report) }],
  };
  const members = [
    { name: "manifest.json", body: Buffer.from(JSON.stringify(manifest)) },
    { name: "review/770700.md", body: report },
  ];
  const archive = zip(members);
  const artifact = {
    id: 9001,
    name: "exact-review-8001-1",
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${sha256(archive)}`,
    workflow_run: { id: 8001, repository_id: 42, head_sha: sourceSha },
  };
  const run = {
    id: 8001,
    run_attempt: 1,
    path: ".github/workflows/sweep.yml",
    head_sha: sourceSha,
    repository: { id: 42, full_name: "openclaw/clawsweeper" },
    conclusion: "failure",
  };
  const target = {
    number: 770700,
    base: { repo: { private: false, full_name: "openclaw/openclaw" } },
    state: "closed",
    merged: true,
    node_id: "private-node-sentinel",
    merged_at: "2026-08-18T14:00:00Z",
    merge_commit_sha: "c".repeat(40),
    updated_at: "2026-08-18T14:00:00Z",
  };
  const input = {
    producerRunId: 8001,
    artifactId: 9001,
    publicationKeySha256: sha256(publicationKey),
    queueRevision: 8,
    workflowSha: "d".repeat(40),
  };
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.notEqual(options?.method, "POST");
    if (String(url).endsWith("/artifacts/9001/zip")) {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer token-sentinel");
      return new Response(null, {
        status: 302,
        headers: { location: "https://blob.example.test/private-signed-url-sentinel" },
      });
    }
    if (String(url) === "https://blob.example.test/private-signed-url-sentinel") {
      assert.equal(new Headers(options?.headers).get("authorization"), null);
      return new Response(archive);
    }
    if (String(url).endsWith("/artifacts/9001")) return Response.json(artifact);
    if (String(url).endsWith("/attempts/1")) return Response.json(run);
    if (String(url).endsWith("/pulls/770700")) {
      assert.equal(new Headers(options?.headers).get("authorization"), null);
      return Response.json(target);
    }
    throw new Error("unexpected fixture request");
  };
  return {
    input,
    artifact,
    run,
    target,
    manifest,
    members,
    archive,
    calls,
    request,
    publicationKey,
  };
}

test("retirement preview binds exact artifact, attempt, historical source and immutable merge identity", async () => {
  const f = fixture();
  const plan = await prepareClosedPublicationRetirement(f.input, "token-sentinel", f.request);
  assert.equal(plan.sourceRevision, 7);
  assert.equal(plan.queueRevision, 8);
  assert.equal(plan.claimGeneration, 1);
  assert.equal(plan.publicationKey, f.publicationKey);
  assert.equal(plan.producerSourceSha, f.run.head_sha);
  assert.equal(f.calls.length, 5);
  const summary = retirementPlanSummary(plan);
  assert.doesNotMatch(JSON.stringify(summary), /private-|token-sentinel|770700|8001|9001/);
  f.target.updated_at = "2026-09-07T00:00:00Z";
  assert.deepEqual(
    retirementPlanSummary(
      await prepareClosedPublicationRetirement(f.input, "token-sentinel", f.request),
    ),
    summary,
  );
});

test("retirement makes one fixed post-effect only after reviewed-plan validation", async () => {
  const f = fixture();
  const plan = await prepareClosedPublicationRetirement(f.input, "token-sentinel", f.request);
  let constructed = 0;
  const posts: unknown[] = [];
  const create = () => {
    constructed += 1;
    return {
      postEffect: async (route: string, bytes: string) => {
        assert.equal(route, "terminal-disposition");
        posts.push(JSON.parse(bytes));
        return {
          ok: true,
          lifecycle_state: "target_closed",
          acknowledgement_state: "pending",
          private: "private-response-sentinel",
        };
      },
    };
  };
  await assert.rejects(applyClosedPublicationRetirement(plan, "", f.input.workflowSha, create));
  await assert.rejects(
    applyClosedPublicationRetirement(plan, "0".repeat(64), f.input.workflowSha, create),
  );
  await assert.rejects(
    applyClosedPublicationRetirement(
      plan,
      retirementPlanSummary(plan).planSha256,
      "e".repeat(40),
      create,
    ),
  );
  assert.equal(constructed, 0);
  const result = await applyClosedPublicationRetirement(
    plan,
    retirementPlanSummary(plan).planSha256,
    f.input.workflowSha,
    create,
  );
  assert.equal(constructed, 1);
  assert.deepEqual(posts, [
    {
      canonical_target_key: "openclaw/openclaw#770700",
      fence_key: f.publicationKey,
      revision: 8,
      kind: "target_closed",
      operation_id: `operator-retire-target_closed:${f.input.publicationKeySha256}:8`,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-|770700|8001|9001/);
});

test("malformed lifecycle response enums fail after exactly one attempt", async () => {
  const f = fixture();
  const plan = await prepareClosedPublicationRetirement(f.input, "token-sentinel", f.request);
  for (const response of [
    { ok: true, lifecycle_state: ["target_closed"], acknowledgement_state: "pending" },
    { ok: true, lifecycle_state: "target_closed", acknowledgement_state: ["pending"] },
    { ok: true, lifecycle_state: "private-response-sentinel", acknowledgement_state: "pending" },
  ]) {
    let attempts = 0;
    await assert.rejects(
      applyClosedPublicationRetirement(
        plan,
        retirementPlanSummary(plan).planSha256,
        f.input.workflowSha,
        () => ({
          postEffect: async () => {
            attempts += 1;
            return response;
          },
        }),
      ),
    );
    assert.equal(attempts, 1);
  }
});

test("all independent provenance and public merged-target preflight failures stop before signing", async (t) => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.artifact.id = 9002;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.expired = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.digest = "";
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.digest = `sha256:${"0".repeat(64)}`;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.size_in_bytes = 100_000_000;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.workflow_run.id = 8002;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.name = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.run_attempt = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.path = ".github/workflows/other.yml";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.repository.full_name = "other/repo";
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.head_sha = "e".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.publicationKeySha256 = "0".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.merged = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.state = "open";
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.base.repo.private = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.target.base.repo.full_name = "other/repo";
    },
  ];
  for (const [index, mutate] of mutations.entries())
    await t.test(String(index), async () => {
      const f = fixture();
      mutate(f);
      await assert.rejects(
        prepareClosedPublicationRetirement(f.input, "token-sentinel", f.request),
      );
      assert.ok(f.calls.every(({ options }) => options?.method !== "POST"));
    });
});

test("bounded manifest-only parser rejects unsafe and malformed archives", async (t) => {
  const f = fixture();
  const cases: Member[][] = [
    [...f.members, f.members[0]!],
    [...f.members, { name: "../outside", body: Buffer.from("x") }],
    [...f.members, { name: "bad\\path", body: Buffer.from("x") }],
    [...f.members, { name: "link", body: Buffer.from("x"), mode: 0o120777 }],
    [{ ...f.members[0]!, flags: 1 }, f.members[1]!],
    [{ ...f.members[0]!, method: 12 }, f.members[1]!],
    [{ ...f.members[0]!, declaredBytes: 3 * 1024 * 1024 }, f.members[1]!],
    [{ ...f.members[0]!, declaredBytes: 1 }, f.members[1]!],
    [{ ...f.members[0]!, body: Buffer.from('{"private":"sentinel"}') }, f.members[1]!],
    [f.members[1]!],
  ];
  for (const [index, members] of cases.entries())
    await t.test(String(index), async () => {
      const archive = zip(members);
      await assert.rejects(readRetirementManifest(archive, sha256(archive)));
    });
  const truncated = f.archive.subarray(0, f.archive.length - 10);
  await assert.rejects(readRetirementManifest(truncated, sha256(truncated)));
  assert.deepEqual(await readRetirementManifest(f.archive, sha256(f.archive)), f.manifest);
});

test("unsigned archive download refuses insecure or looping redirects", async () => {
  for (const location of [
    "http://blob.example.test/private",
    "https://fixture-user:***@blob.example.test/",
  ]) {
    const f = fixture();
    let rejectedDestinationRequests = 0;
    await assert.rejects(
      prepareClosedPublicationRetirement(f.input, "token-sentinel", async (url, options) => {
        if (String(url) === location) rejectedDestinationRequests += 1;
        return String(url).endsWith("/zip")
          ? new Response(null, { status: 302, headers: { location } })
          : f.request(url, options);
      }),
      { message: "invalid closed publication retirement evidence" },
    );
    assert.equal(rejectedDestinationRequests, 0);
  }
  const f = fixture();
  let requests = 0;
  await assert.rejects(
    prepareClosedPublicationRetirement(f.input, "token-sentinel", async (url, options) => {
      if (
        String(url) ===
          "https://api.github.com/repos/openclaw/clawsweeper/actions/artifacts/9001/zip" ||
        String(url) === "https://blob.example.test/loop"
      ) {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://blob.example.test/loop" },
        });
      }
      return f.request(url, options);
    }),
  );
  assert.equal(requests, 4);
});
