// Public-safe controlled canonical front matter for the real corpus/site proof.
// No claim refers to a real GitHub item. Visibility is an explicit fixture input.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeAssessmentScenario(root: string, now: number, extraOpen = 0) {
  const repos = ["fixture/assessments", "fixture/other-repo", "fixture/private-records"];
  const visibility = Object.fromEntries(
    repos.map((repo) => [
      repo,
      {
        public: repo !== "fixture/private-records",
        checkedAt: new Date(now).toISOString(),
      },
    ]),
  );
  const put = (
    repo: string,
    number: number,
    attrs: Record<string, unknown> = {},
    archived = false,
  ) => {
    const directory = join(root, repo.replace("/", "-"), archived ? "closed" : "items");
    mkdirSync(directory, { recursive: true });
    const record: Record<string, unknown> = {
      repository: repo,
      number,
      type: "pull_request",
      title: JSON.stringify("Fixture: recorded assessment " + number),
      state_at_review: "open",
      reviewed_at: "2026-10-30T20:00:00Z",
      review_status: "complete",
      review_terminal_failure: "false",
      pull_head_sha: "a".repeat(40),
      item_snapshot_hash: "b".repeat(64),
      item_source_revision: "c".repeat(64),
      review_record: JSON.stringify({
        version: 1,
        decision: {
          decision: "keep_open",
          triagePriority: number === 2 ? "P0" : "P2",
          securityReview: { status: "needs_attention" },
          maintainerDecision: { required: true, kind: "security_boundary" },
        },
      }),
      ...attrs,
    };
    writeFileSync(
      join(directory, number + ".md"),
      [
        "---",
        ...Object.entries(record)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => key + ": " + value),
        "---",
        "BODY_SENTINEL_NOT_PUBLIC",
        "",
      ].join("\n"),
    );
  };
  put(repos[0]!, 1);
  put(repos[0]!, 2, {
    title: JSON.stringify("Fixture: old unresolved security concern"),
    reviewed_at: "2026-01-01T00:00:00Z",
  });
  put(
    repos[0]!,
    3,
    { title: JSON.stringify("Fixture: archived concern, not verified resolved") },
    true,
  );
  put(repos[0]!, 4, { current_pull_head_sha: "d".repeat(40), action_taken: "skipped_stale_head" });
  put(repos[0]!, 5, {
    state_at_review: undefined,
    review_status: undefined,
    reviewed_at: undefined,
    pull_head_sha: "unknown",
    item_snapshot_hash: "unknown",
    item_source_revision: "unknown",
  });
  put(repos[0]!, 6, {
    current_state: "open",
    reconciled_at: "2026-10-30T21:00:00Z",
    review_status: "stale_reopened",
  });
  put(repos[0]!, 7, { current_state: "closed", reconciled_at: "2026-10-30T21:00:00Z" });
  put(repos[0]!, 8, {
    review_record: JSON.stringify({
      version: 1,
      decision: {
        decision: "keep_open",
        securityReview: { status: "cleared" },
        maintainerDecision: { required: false },
      },
    }),
  });
  for (let index = 0; index < extraOpen; index++) put(repos[0]!, index + 100);
  put(repos[1]!, 1);
  put(repos[2]!, 1, {
    title: JSON.stringify("PRIVATE_TITLE_SENTINEL"),
    author: "PRIVATE_AUTHOR_SENTINEL",
  });
  return { visibility, expected: { open: 3 + extraOpen, changed: 2, unknown: 1, historical: 2 } };
}
