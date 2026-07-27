import assert from "node:assert/strict";
import test from "node:test";

import { rankGitcrawlCluster } from "../../dist/repair/gitcrawl-cluster-ranking.js";

const asOf = new Date("2026-07-26T00:00:00Z");
const member = (overrides = {}) => ({
  number: 1,
  kind: "issue",
  state: "open",
  title: "Telegram upload crashes when media path contains spaces",
  body: "Reproduction consistently throws an error.",
  labels_json: '["bug"]',
  updated_at: "2026-07-24T00:00:00Z",
  ...overrides,
});

test("ranking favors recent narrow coherent bug clusters with a landable PR", () => {
  const ranking = rankGitcrawlCluster(
    [
      member(),
      member({ number: 2, title: "Telegram media upload fails for paths with spaces" }),
      member({
        number: 3,
        kind: "pull_request",
        title: "Fix Telegram media upload paths containing spaces",
      }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, true);
  assert(ranking.score > 70);
  assert.match(ranking.signals.join("\n"), /open implementation PR/);
});

test("ranking rejects closed, stale, broad, security, feature, and decision clusters", () => {
  const fixtures = [
    [member(), member({ number: 2, state: "closed" }), member({ number: 3, state: "closed" })],
    [
      member({ updated_at: "2026-01-01T00:00:00Z" }),
      member({ number: 2, updated_at: "2026-01-02T00:00:00Z" }),
    ],
    Array.from({ length: 9 }, (_, index) => member({ number: index + 1 })),
    [
      member({ title: "Mattermost token forgeable via hardcoded HMAC" }),
      member({ number: 2, title: "Fix forgeable Mattermost interaction token" }),
    ],
    [
      member({ title: "Callback URLs expose reusable command tokens" }),
      member({ number: 2, title: "Harden callback auth" }),
    ],
    [
      member({ title: "Feature request: add Telegram themes" }),
      member({ number: 2, title: "Feature: Telegram custom themes" }),
    ],
    [
      member({ title: "Telegram transport needs a product decision" }),
      member({ number: 2, labels_json: '["needs-maintainer-input"]' }),
    ],
  ];
  for (const members of fixtures)
    assert.equal(rankGitcrawlCluster(members, { asOf }).eligible, false);
});

test("ranking rejects unrelated clusters even when every member says bug", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({ title: "Telegram upload crash" }),
      member({ number: 2, title: "Windows installer error" }),
      member({ number: 3, title: "Cron scheduler fails" }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(ranking.reasons.join("\n"), /low title cohesion/);
});

test("ranking rejects generic fix verbs without broken-behavior evidence", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({
        title: "Fix README typo in installation guide",
        body: "Documentation cleanup.",
        labels_json: "[]",
      }),
      member({
        number: 2,
        title: "Fix README spelling typo in installation guide",
        body: "Documentation cleanup.",
        labels_json: "[]",
      }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(ranking.reasons.join("\n"), /no high-confidence bug signal/);
});

test("ranking requires bug evidence from every open issue candidate", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({ title: "Telegram upload crashes in topic threads" }),
      member({
        number: 2,
        title: "Telegram upload documentation for topic threads is unclear",
        body: "The guide could explain this behavior more clearly.",
        labels_json: "[]",
      }),
      member({
        number: 3,
        kind: "pull_request",
        title: "Fix Telegram upload crash in topic threads",
      }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(
    ranking.reasons.join("\n"),
    /open issue candidates lack high-confidence bug evidence \(1\/2\)/,
  );
});

test("ranking rejects bridge clusters without pairwise root-cause overlap", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({ title: "Telegram upload crashes on media paths" }),
      member({ number: 2, title: "Telegram upload and cron scheduler fail" }),
      member({ number: 3, title: "Cron scheduler hangs on missed runs" }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(ranking.reasons.join("\n"), /low title cohesion/);
});

test("ranking rejects an unrelated two-item bug cluster", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({ title: "Telegram upload crash" }),
      member({ number: 2, title: "Windows installer error" }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(ranking.reasons.join("\n"), /low title cohesion/);
});

test("ranking reads object-shaped bug and maintainer-decision labels", () => {
  const eligible = rankGitcrawlCluster(
    [
      member({ labels_json: '[{"name":"bug"}]', title: "Telegram media behavior" }),
      member({
        number: 2,
        labels_json: '[{"name":"bug"}]',
        title: "Telegram media behavior regression",
      }),
    ],
    { asOf },
  );
  assert.equal(eligible.eligible, true);

  const blocked = rankGitcrawlCluster(
    [
      member({ labels_json: '[{"name":"bug"}]', title: "Telegram media behavior" }),
      member({
        number: 2,
        labels_json: '[{"name":"needs-maintainer-input"}]',
        title: "Telegram media behavior regression",
      }),
    ],
    { asOf },
  );
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join("\n"), /maintainer or product decision/);
});

test("ranking rejects a single feature member and common vulnerability disclosures", () => {
  const mixedProduct = rankGitcrawlCluster(
    [
      member({ title: "Telegram upload crashes" }),
      member({ number: 2, title: "Feature request: support Telegram upload themes" }),
    ],
    { asOf },
  );
  assert.equal(mixedProduct.eligible, false);
  assert.match(mixedProduct.reasons.join("\n"), /feature\/proposal/);

  for (const disclosure of [
    "Fix SQL injection in webhook filter",
    "Prevent command injection in hook runner",
    "Block SSRF in URL fetcher",
    "Fix sandbox escape allowing arbitrary code execution",
  ]) {
    const ranking = rankGitcrawlCluster(
      [member({ title: disclosure }), member({ number: 2, title: `${disclosure} regression` })],
      { asOf },
    );
    assert.equal(ranking.eligible, false, disclosure);
    assert.match(ranking.reasons.join("\n"), /security-sensitive/);
  }
});

test("ranking rejects vulnerability evidence from a closed cluster member", () => {
  const ranking = rankGitcrawlCluster(
    [
      member({ title: "Webhook filter crashes on malformed predicates" }),
      member({ number: 2, title: "Webhook filter fails on malformed predicates" }),
      member({
        number: 3,
        state: "closed",
        title: "Webhook filter permits SQL injection",
        body: "Security report for the same filter path.",
      }),
    ],
    { asOf },
  );
  assert.equal(ranking.eligible, false);
  assert.match(ranking.reasons.join("\n"), /security-sensitive cluster member/);
});

test("ranking rejects label-only security ownership", () => {
  for (const label of ["impact:security", "clawsweeper:needs-security-review", "vulnerability"]) {
    const ranking = rankGitcrawlCluster(
      [
        member({
          title: "Webhook filter crashes on malformed predicates",
          labels_json: `["${label}"]`,
        }),
        member({ number: 2, title: "Webhook filter fails on malformed predicates" }),
      ],
      { asOf },
    );
    assert.equal(ranking.eligible, false, label);
    assert.match(ranking.reasons.join("\n"), /security-sensitive cluster member/);
  }
});
