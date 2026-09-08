#!/usr/bin/env node
// Proof-only GitHub CLI boundary: transports requests to the loopback fixture.
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "api") throw new Error("unsupported proof command");
const method = args.indexOf("--method"),
  input = args.indexOf("--input");
const response = await fetch("http://127.0.0.1:8897/" + args[1], {
  method: method < 0 ? "GET" : args[method + 1],
  headers: { "content-type": "application/json" },
  body: input < 0 ? undefined : fs.readFileSync(args[input + 1], "utf8"),
  signal: AbortSignal.timeout(15000),
});
const value = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(value));
  process.exit(1);
}
console.log(JSON.stringify(args.includes("--slurp") ? [value] : value));
