import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDashboardStrictBaseline,
  DASHBOARD_STRICT_BASELINE_FILES,
} from "../scripts/check-dashboard-strict.mjs";

test("dashboard strict accepts the full baseline", () => {
  assert.doesNotThrow(() => assertDashboardStrictBaseline(DASHBOARD_STRICT_BASELINE_FILES));
});

test("dashboard strict rejects a missing baseline file and names it", () => {
  const missing = "dashboard/github-api.ts";
  const configuredFiles = DASHBOARD_STRICT_BASELINE_FILES.filter((file) => file !== missing);

  assert.throws(() => assertDashboardStrictBaseline(configuredFiles), {
    message: `dashboard strict config is missing baseline files:\n${missing}`,
  });
});

test("dashboard strict accepts the baseline plus a new file", () => {
  const extendedBaseline = [
    ...DASHBOARD_STRICT_BASELINE_FILES,
    "dashboard/future-strict-module.ts",
  ];

  assert.doesNotThrow(() => assertDashboardStrictBaseline(extendedBaseline, extendedBaseline));
});

test("dashboard strict requires new files to extend the baseline", () => {
  const added = "dashboard/future-strict-module.ts";

  assert.throws(() => assertDashboardStrictBaseline([...DASHBOARD_STRICT_BASELINE_FILES, added]), {
    message: `dashboard strict config has files missing from its baseline:\n${added}`,
  });
});
