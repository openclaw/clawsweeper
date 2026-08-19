# PR 1089 real-boundary runtime transcript

- Source commit: `3e44d2cf1bfdb9f38805f8056bfc90903032d55b`
- Source-tree SHA-256: `61b283324bc7b30b74294a311d2cfc63aa41f15f165ae9d9b30bc6b39ca3dcfe`
- CLI transport: built `exact-review-batch-cli` over a self-signed TLS listener bound only to `127.0.0.1:8899`.
- CLI observations: reset, HTTP 429, and HTTP 503 each produced `retryable_failure` / `state_contention` after 3 actual publication requests per scenario.
- Worker/DO: pinned Wrangler Worker on `http://127.0.0.1:8799`, disposable local persistence, signed enqueue/claim/complete requests, and public status reads.
- Secrets: one disposable local proof secret; request traces retain only `signature_valid`, never a signature or secret value.

## State contention after one real completion

```json
{
  "ok": true,
  "target_repo": "openclaw/openclaw",
  "item_number": 108901,
  "items": [
    {
      "lane": "publication",
      "state": "pending",
      "parked_reason": null,
      "parked_recovery_attempts": 0,
      "backoff_reason": "publication_retry",
      "revision": 1,
      "attempts": 1,
      "dispatch_failure_status": null,
      "dispatch_failure_class": null,
      "dispatch_failure_at": null,
      "dispatch_failure_fingerprint": null,
      "dispatch_failure_detail": null,
      "created_at": "2026-08-10T01:26:04.347Z",
      "next_attempt_at": "2026-08-10T01:27:09.176Z",
      "older_ready_count": 0
    }
  ],
  "dead_letters": [],
  "position_is_approximate": true
}
```

## Unknown failure after one real completion

```json
{
  "ok": true,
  "target_repo": "openclaw/openclaw",
  "item_number": 108904,
  "items": [
    {
      "lane": "publication",
      "state": "pending",
      "parked_reason": null,
      "parked_recovery_attempts": 0,
      "backoff_reason": "publication_retry",
      "revision": 1,
      "attempts": 1,
      "dispatch_failure_status": null,
      "dispatch_failure_class": null,
      "dispatch_failure_at": null,
      "dispatch_failure_fingerprint": null,
      "dispatch_failure_detail": null,
      "created_at": "2026-08-10T01:26:04.386Z",
      "next_attempt_at": "2026-08-10T01:27:15.800Z",
      "older_ready_count": 0
    }
  ],
  "dead_letters": [],
  "position_is_approximate": true
}
```

## Limit

The real unknown-failure item is pending after attempt 1, as expected. Reaching attempt 14 requires roughly 51 minutes of authentic backoff. This run did not fake time, edit Durable Object state, or change retry constants, so it does not claim the final `retry_exhausted` dead letter or the same-attempt terminal contrast.
