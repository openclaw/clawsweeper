import {
  importActionEventShards,
  workflowActionProducer,
  type ActionEventShardImportResult,
} from "../action-ledger-runtime.js";

export function importWorkflowActionEvents(options: {
  sourceRoot: string;
  stateRoot: string;
  expectedProducerJob: string;
  dependencies?: {
    importActionEventShards?: typeof importActionEventShards;
    workflowActionProducer?: typeof workflowActionProducer;
  };
}): ActionEventShardImportResult {
  if (!options.expectedProducerJob) {
    throw new Error("--expected-producer-job is required");
  }
  const producer = (options.dependencies?.workflowActionProducer ?? workflowActionProducer)(
    "action_event_publisher",
  );
  return (options.dependencies?.importActionEventShards ?? importActionEventShards)(
    options.sourceRoot,
    options.stateRoot,
    {
      expectedProducer: {
        repository: producer.repository,
        sha: producer.sha,
        workflow: producer.workflow,
        job: options.expectedProducerJob,
        runId: producer.runId,
        runAttempt: producer.runAttempt,
      },
    },
  );
}
