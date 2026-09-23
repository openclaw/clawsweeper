#!/usr/bin/env node
import assert from "node:assert/strict";
import { runCopyProof } from "./exact-review-selected-tuple-copy.mjs";
const serial = runCopyProof({ concurrency: 1 });
const parallel = runCopyProof({ concurrency: 2 });
assert.deepEqual(parallel.plans, serial.plans);
assert.deepEqual(parallel.outcomes, serial.outcomes);
assert.deepEqual(parallel.actions, serial.actions);
assert.equal(parallel.telemetry.observedPeakWorkers, 2);
const circuit = runCopyProof({ concurrency: 2, mode: "circuit" });
const heartbeat = runCopyProof({ concurrency: 2, mode: "heartbeat" });
console.log(JSON.stringify({ serial, parallel, circuit, heartbeat }, null, 2));
