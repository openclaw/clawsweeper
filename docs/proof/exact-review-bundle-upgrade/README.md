# Reading stored review bundles after a queue upgrade

A deferred publisher must match the report it received to the producer decision stored in the queue. Older writers included `bayJourneyDeliveryId` in the manifest’s decision hash. Some queue versions retained that ID and others discarded it.

The replay runs the bundle writer and publication request builder from the revision immediately before telemetry retirement, the v0.3.5 release and the checkout under test. It sends the request to a historical `ExactReviewQueue` in workerd, stops that runtime, and opens the same SQLite storage with the queue from the current commit. The publisher claims and fetches the publication through the batch endpoints. The rollback case reverses the direction. The checkout under test writes the bundle and queue entry, then main at `3494d3cb` reopens the SQLite store. Each publisher validates the original files against the decision and claim it fetched.

| Stored publication | Expected result after upgrade |
| --- | --- |
| Current writer and queue retained the delivery ID, then publication rolled back to main | The main publisher validates the original bundle. |
| Producer and queue both predate telemetry retirement | The publisher validates the original manifest and report with the delivery ID from the persisted producer decision. |
| v0.3.5 writer received the delivery ID and the pre-retirement queue retained it | The publisher also validates the released writer’s delivery-bearing manifest. |
| The released writer received an ordinary decision without the retired field | The publisher validates the ordinary v0.3.5 bundle. |
| Same v0.3.5 delivery-bearing manifest as in the second case, with a queue that already discarded the ID | Both the v0.3.5 and current readers reject the bundle. Recovery requires a fresh review. |

For every accepted bundle, substituting a different command marker or claim generation must fail validation. The replay compares the manifest and report bytes after each case. It exercises queue persistence and the publisher’s validation step using synthetic review content. GitHub artifact transport, final publication and live service data are outside its scope.

## Run the replay

Use Node 24 or later, Git, tar and the repository’s frozen dependencies. The checkout must contain the commits for the queue before telemetry retirement (`ff4b89dd`), v0.3.5 (`22265ff1`) and the rollback reader (`3494d3cb`). The script reads those commits and `HEAD` directly from Git.

```sh
pnpm install --frozen-lockfile
node docs/proof/exact-review-bundle-upgrade/run.mjs
```

Each result includes the original decision hash, the manifest file’s SHA-256 and the validation outcome. The v0.3.5 retained-ID and discarded-ID cases use the same manifest file. Its SHA-256 matches across those two cases in a run. A new run gets a new manifest creation timestamp. The script removes its SQLite stores, bundles and source snapshots on exit.
