import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySpamCommentActivity,
  runSpamCommentIntake,
} from "../../dist/repair/spam-comment-intake.js";

function spamActivity() {
  return {
    action: "github_activity",
    client_payload: {
      event_name: "issue_comment",
      activity: {
        type: "issue_comment",
        action: "created",
        repo: "openclaw/openclaw",
        actor: "IgorGanapolsky",
        subject: {
          kind: "issue",
          number: 81908,
          title: "Telegram hangs",
          url: "https://github.com/openclaw/openclaw/issues/81908",
          state: "open",
        },
        comment: {
          id: 4454649536,
          html_url: "https://github.com/openclaw/openclaw/issues/81908#issuecomment-4454649536",
          body: "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
          user: { login: "IgorGanapolsky" },
          author_association: "NONE",
          created_at: "2026-05-14T20:54:28Z",
          updated_at: "2026-05-14T20:54:28Z",
        },
      },
    },
  };
}

test("spam comment intake dispatches exact scans for deterministic candidates", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: spamActivity(),
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.comment_id, "4454649536");
  assert.equal(decision.dispatch_payload.client_payload.max_comments, "1");
  assert.match(decision.reason, /outside_author_with_external_link/);
  assert.match(decision.reason, /priced_service_pitch/);
});

test("spam comment intake accepts compact repository dispatch activity payloads", () => {
  const payload = spamActivity();
  delete payload.client_payload.activity.type;

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
});

test("spam comment intake honors target repo on compact dispatch payloads", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: {
      action: "github_activity",
      repository: { full_name: "openclaw/clawsweeper" },
      client_payload: {
        event_name: "issue_comment",
        action: "created",
        target_repo: "openclaw/openclaw",
        comment_id: 4454649536,
        body: "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
        actor: "IgorGanapolsky",
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.target_repo, "openclaw/openclaw");
});

test("spam comment intake honors top-level target repo on nested dispatch payloads", () => {
  const payload = spamActivity();
  payload.repository = { full_name: "openclaw/clawsweeper" };
  payload.client_payload.target_repo = "openclaw/openclaw";
  delete payload.client_payload.activity.repo;

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.target_repo, "openclaw/openclaw");
  assert.equal(decision.dispatch_payload.client_payload.target_repo, "openclaw/openclaw");
});

test("spam comment intake dispatches exact scans for pull request review comments", () => {
  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload: {
      action: "github_activity",
      client_payload: {
        event_name: "pull_request_review_comment",
        activity: {
          type: "pull_request_review_comment",
          action: "created",
          repo: "openclaw/openclaw",
          actor: "IgorGanapolsky",
          subject: {
            kind: "pull_request",
            number: 81908,
            url: "https://github.com/openclaw/openclaw/pull/81908",
          },
          comment: {
            id: 4454649536,
            url: "https://github.com/openclaw/openclaw/pull/81908#discussion_r4454649536",
            body_excerpt:
              "We build Managed Revenue Engines for $1,500. Demo: https://igorganapolsky.github.io/openclaw-mac-ai-workstation-setup/agent-app-catalog.html",
          },
        },
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.comment.kind, "pull_request_review_comment");
  assert.equal(decision.dispatch_payload.client_payload.review_comment_id, "4454649536");
  assert.equal(decision.dispatch_payload.client_payload.comment_id, undefined);
});

test("spam comment intake skips protected authors before dispatch", () => {
  const payload = spamActivity();
  payload.client_payload.activity.comment.author_association = "CONTRIBUTOR";

  const decision = classifySpamCommentActivity({
    eventName: "repository_dispatch",
    payload,
  });

  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /protected/);
});

test("runSpamCommentIntake posts repository dispatch for accepted comments", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-spam-intake-")));
  const outputRoot = path.join(root, "action-ledger-output");
  fs.mkdirSync(outputRoot);
  const eventPath = path.join(root, "event.json");
  fs.writeFileSync(eventPath, `${JSON.stringify(spamActivity())}\n`);
  const requests: { url: string; body: Record<string, unknown> }[] = [];

  const summary = await runSpamCommentIntake(["--write-report"], {
    root,
    log: () => undefined,
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GH_TOKEN: "credential-value",
      GITHUB_ACTIONS: "true",
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "spam-intake-test",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "spam comment intake",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/spam-comment-intake.yml@refs/heads/main",
      GITHUB_JOB: "intake",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTION: "dispatch-exact-spam-scan",
      GITHUB_RUN_STARTED_AT: "2026-07-14T12:00:00Z",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
      CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.dispatched, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.github.com/repos/openclaw/clawsweeper/dispatches");
  assert.deepEqual(requests[0]?.body, {
    event_type: "clawsweeper_spam_comment",
    client_payload: {
      target_repo: "openclaw/openclaw",
      comment_id: "4454649536",
      max_comments: "1",
    },
  });
  assert.ok(fs.existsSync(path.join(root, "notifications/spam-comment-intake-report.json")));
  const events = readActionEvents(outputRoot);
  assert.deepEqual(
    events.map((event) => event.attributes.completion_reason),
    ["dispatch_attempted", "dispatch_accepted"],
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /Managed Revenue Engines/);
  assert.doesNotMatch(serialized, /credential-value/);
});

test("spam intake workflows publish authoritative dispatch receipts", () => {
  const workflows = [
    [".github/workflows/github-activity.yml", "github-activity-dispatch"],
    [".github/workflows/spam-comment-intake.yml", "spam-intake-dispatch"],
  ] as const;
  for (const [workflowPath, lane] of workflows) {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, new RegExp(`--lane ${lane}`));
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /repair:publish-main/);
  }
});

function readActionEvents(root: string): Array<Record<string, any>> {
  return fs
    .readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"))
    .flatMap((entry) => fs.readFileSync(path.join(root, entry), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
