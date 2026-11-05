import test from "node:test";
import { runBytePressureScenario } from "./fixtures/review-coverage-byte-pressure.ts";

test(
  "signed near-32MiB finite byte churn reclaims obsolete rows without resetting progress",
  { timeout: 180_000 },
  async () => {
    await runBytePressureScenario({ fault: true, overcap: true });
  },
);

test(
  "existing-row payload growth credits its old bytes only once during pressure reclamation",
  { timeout: 180_000 },
  async () => {
    await runBytePressureScenario({
      fault: false,
      overcap: false,
      growthOnExisting: true,
      tinyPrefix: true,
    });
  },
);
