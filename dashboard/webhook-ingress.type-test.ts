import type { GithubWebhookClassifier } from "./worker.ts";

declare const classifyGithubWebhook: GithubWebhookClassifier;

classifyGithubWebhook({ event: "issue_comment", payload: {} });
classifyGithubWebhook({ event: "issues", payload: {} });
classifyGithubWebhook({ event: "pull_request", payload: {} });
classifyGithubWebhook({ event: "future_event", payload: {} });

// @ts-expect-error GitHub event names are strings.
classifyGithubWebhook({ event: 7, payload: {} });

// @ts-expect-error The classifier requires the correctly spelled payload property.
classifyGithubWebhook({ event: "issues", paylod: {} });

// @ts-expect-error Pull request fields do not belong to an issues delivery.
classifyGithubWebhook({ event: "issues", payload: { pull_request: {} } });
