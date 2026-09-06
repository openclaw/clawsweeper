import assert from "node:assert/strict";
import test from "node:test";
import { repositoryManagedPullRequestCloseReason } from "../dist/repository-profiles.js";

const item = {
  repo: "openclaw/openclaw",
  kind: "pull_request" as const,
  author: "openclaw-mantis[bot]",
};
const pull = {
  user: { login: item.author },
  head: { ref: "automation/native-app-locale-refresh", repo: { full_name: item.repo } },
  base: { ref: "main", repo: { full_name: item.repo } },
};

test("managed locale policy recognizes both GitHub author representations", () => {
  for (const author of [item.author, "app/openclaw-mantis"]) {
    assert.match(
      repositoryManagedPullRequestCloseReason({ ...item, author }, () => pull) ?? "",
      /repository-managed locale/,
    );
  }
});

test("unrelated authors, repositories and issues do not need a pull read", () => {
  for (const candidate of [
    { ...item, author: "contributor" },
    { ...item, repo: "example/repo" },
    { ...item, kind: "issue" as const },
  ]) {
    assert.equal(
      repositoryManagedPullRequestCloseReason(candidate, () => {
        throw new Error("Unexpected pull read");
      }),
      null,
    );
  }
});

test("matching titles cannot protect foreign forks, other branches or author mismatches", () => {
  for (const candidate of [
    { ...pull, head: { ...pull.head, repo: { full_name: "example/openclaw" } } },
    { ...pull, head: { ...pull.head, ref: "contributor/locales" } },
    { ...pull, base: { ...pull.base, ref: "release/2026.9.2" } },
    { ...pull, user: { login: "other-bot[bot]" } },
  ]) {
    assert.equal(
      repositoryManagedPullRequestCloseReason(item, () => ({
        ...candidate,
        title: "chore(i18n): refresh native locales",
      })),
      null,
    );
  }
});
