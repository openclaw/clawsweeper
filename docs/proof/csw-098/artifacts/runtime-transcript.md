# CSW-098 controlled runtime transcript

- Worker endpoint: `GET /api/live-activity-bay` -> HTTP 200; local unauthenticated source returned `unknown` with `activity: null`.
- Built Bay page: rendered four redacted transient signals from controlled current input, then rendered stale input as Unknown.
- Durable Kanban: retained its one completed durable card across both activity cases.
- Browser requests: 14 total, 0 mutating.
