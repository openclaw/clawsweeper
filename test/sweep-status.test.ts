import assert from "node:assert/strict";
import test from "node:test";

import { sweepStatusApplyHealthForTest } from "../dist/clawsweeper.js";
import { readText } from "./helpers.ts";

test("sweep status preserves a retained apply-health run URL", () => {
  const retained = {
    mode: "close",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/29091427650",
  };
  assert.deepEqual(
    sweepStatusApplyHealthForTest({
      previousApplyHealth: retained,
      runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/29091585991",
    }),
    retained,
  );
  assert.deepEqual(
    sweepStatusApplyHealthForTest({
      requestedApplyHealth: { mode: "close" },
      runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/29091427650",
    }),
    retained,
  );
});

test("sweep status writer preserves non-apply health and clears stale apply updates", () => {
  const source = readText("src/clawsweeper.ts");

  assert.match(
    source,
    /applyHealthArg === undefined && state\.startsWith\("Apply "\) \? null : applyHealthArg/,
  );
  assert.match(source, /requestedApplyHealth: options\.applyHealth/);
  assert.match(source, /apply_health: applyHealth \?\? null/);
  assert.match(source, /last_close_apply_health: lastCloseApplyHealth \?\? null/);
  assert.match(source, /previousStatus\?\.lastCloseApplyHealth/);
  assert.match(source, /previousStatus\?\.applyHealth\?\.mode === "close"/);
});
