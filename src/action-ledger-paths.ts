const ACTION_EVENT_PUBLISH_PATH_PATTERN =
  /^ledger\/v1\/(?:events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl|import-bindings\/(?:producer-runs|events|shard-sets|completed-shard-sets)\/[a-f0-9]{64}\.json)$/;

export function isActionEventPublishPath(path: string): boolean {
  return ACTION_EVENT_PUBLISH_PATH_PATTERN.test(path);
}
