import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const [output, delay = "0"] = process.argv.slice(2);
if (!output || !/^(0|34)$/.test(delay)) throw new Error("usage: once.mjs OUTPUT [0|34]");
appendFileSync(`${output}.invocations`, "invoked\n");
try {
  mkdirSync(output);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.error("REFUSED_EXISTING_OUTPUT");
  process.exit(17);
}
console.log("PROOF_STARTED");
await setTimeout(Number(delay) * 1000);
const assertions = [
  "PASS exclusive directory",
  "PASS original bytes retained",
  "PASS local fixture",
  "PASS stable assertions",
  "PASS proof complete",
];
writeFileSync(join(output, "result.txt"), `${assertions.join("\n")}\n`, { flag: "wx" });
console.log(assertions.join("\n"));
