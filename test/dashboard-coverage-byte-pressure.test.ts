import { runCensusScenario } from "./fixtures/isolated-census.ts";
import test from "node:test";

test(
  "signed near-32MiB finite byte churn reclaims obsolete rows without resetting progress",
  { timeout: 180_000 },
  async (t) => {
    await runCensusScenario(t, "runBytePressureScenario", { fault: true, overcap: true });
  },
);

test(
  "existing-row payload growth credits its old bytes only once during pressure reclamation",
  { timeout: 180_000 },
  async (t) => {
    await runCensusScenario(t, "runBytePressureScenario", {
      fault: false,
      overcap: false,
      growthOnExisting: true,
      tinyPrefix: true,
    });
  },
);
