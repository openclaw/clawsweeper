import { runTrustedGitAcquisitionWorker } from "./repair/contained-command-worker.js";

try {
  await runTrustedGitAcquisitionWorker();
} catch {
  process.stderr.write("Git acquisition supervisor could not verify completion");
  process.exitCode = 1;
}
