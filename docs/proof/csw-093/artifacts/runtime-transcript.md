# CSW-093 controlled runtime proof

- Source: `f05643e215b8026276b3b1b05483437055132d5b`
- Pure initialization-safe read: local Wrangler Worker `GET /api/durable-lifecycle-bay` called the uninitialized local DO `GET /lifecycle-bay`; it returned fail-closed Unknown with null counts and cards.
- Ordinary queue request after the pure read: local Wrangler Worker `GET /api/recent-durable-publication-events?window=24h` called the same local DO and returned a complete aggregate response. This demonstrates the pure read did not prevent normal local queue initialization.
- Reducer route: the focused Worker-to-DO fixture test proves the populated, 512+1-bounded read uses one SELECT and performs no initialization, write, alarm, queue reclaim, or GitHub request.
- Browser: the real local Wrangler-built `/bay-demo` rendered a 25-record synthetic projection as the fixed 24-card sample, then a mixed snapshot as Unknown with no partial cards or counts.
- Network: 13 browser requests, 0 external requests, 0 mutation requests.

This is controlled synthetic evidence only. The ordinary request initializes only the disposable local proof DO. It makes no production, external, queue, lifecycle, GitHub, R2, deployment, gate, or merge mutation. Fixture data is synthetic and redacted; no operational identifiers are printed.
