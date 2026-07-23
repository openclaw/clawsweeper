import assert from "node:assert/strict";

export function repairCommentRouterGroup({ repository, eventName, itemNumbers = "" }) {
  assert.match(repository, /^[^/]+\/[^/]+$/, "repository must use owner/name form");
  if (eventName === "workflow_dispatch" && itemNumbers !== "") {
    return `repair-comment-router-${repository}-items-${itemNumbers}`;
  }
  return `repair-comment-router-${repository}`;
}

export class WorkflowScheduler {
  #groups = new Map();
  #runs = new Map();

  dispatch(run) {
    assert.equal(typeof run?.id, "string", "workflow run id is required");
    assert.equal(typeof run?.group, "string", "workflow concurrency group is required");
    assert.ok(run.id.length > 0, "workflow run id must not be empty");
    assert.ok(run.group.length > 0, "workflow concurrency group must not be empty");
    assert.equal(this.#runs.has(run.id), false, `duplicate workflow run id: ${run.id}`);

    const group = this.#groups.get(run.group) ?? { running: null, pending: null };
    const record = { ...run, status: group.running ? "pending" : "running" };
    this.#runs.set(run.id, record);

    if (!group.running) {
      group.running = run.id;
    } else {
      if (group.pending) {
        const replaced = this.#runs.get(group.pending);
        assert.ok(replaced);
        replaced.status = "replaced";
        replaced.replacedBy = run.id;
      }
      group.pending = run.id;
    }
    this.#groups.set(run.group, group);
    return structuredClone(record);
  }

  complete(runId) {
    const record = this.#requiredRun(runId);
    const group = this.#groups.get(record.group);
    assert.equal(group?.running, runId, `workflow run is not running: ${runId}`);
    record.status = "executed";
    group.running = group.pending;
    group.pending = null;
    if (group.running) this.#requiredRun(group.running).status = "running";
    return structuredClone(record);
  }

  cancel(runId, reason = "cancelled") {
    const record = this.#requiredRun(runId);
    assert.ok(["running", "pending"].includes(record.status), `workflow run is terminal: ${runId}`);
    const group = this.#groups.get(record.group);
    assert.ok(group);
    if (group.running === runId) {
      group.running = group.pending;
      group.pending = null;
      if (group.running) this.#requiredRun(group.running).status = "running";
    } else {
      assert.equal(group.pending, runId, `workflow run is not active: ${runId}`);
      group.pending = null;
    }
    record.status = "cancelled";
    record.reason = reason;
    return structuredClone(record);
  }

  active() {
    return [...this.#groups.entries()].map(([group, state]) => ({ group, ...state }));
  }

  records() {
    return [...this.#runs.values()].map((run) => structuredClone(run));
  }

  #requiredRun(runId) {
    const record = this.#runs.get(runId);
    assert.ok(record, `unknown workflow run id: ${runId}`);
    return record;
  }
}

export function replayWorkflowTrace(trace, groupFor, { completeRemaining = false } = {}) {
  const scheduler = new WorkflowScheduler();
  for (const event of trace.events) {
    if (event.action === "dispatch") {
      scheduler.dispatch({ ...event.run, group: groupFor(event.run) });
    } else if (event.action === "complete") {
      scheduler.complete(event.runId);
    } else if (event.action === "cancel") {
      scheduler.cancel(event.runId, event.reason);
    } else {
      assert.fail(`unsupported workflow trace action: ${event.action}`);
    }
  }
  if (completeRemaining) {
    while (true) {
      const running = scheduler.active().flatMap((group) => (group.running ? [group.running] : []));
      if (running.length === 0) break;
      for (const runId of running) scheduler.complete(runId);
    }
  }
  return scheduler.records();
}
