#!/usr/bin/env node
import fs from "node:fs";
// Transports the real CLI's gh calls only to the owned loopback stub.
const origin = new URL(process.env.PROOF_GITHUB_ORIGIN);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1")
  throw Error("loopback required");
const args = process.argv.slice(2);
if (args[0] !== "api" || !args[1]?.startsWith("repos/") || args[1].includes(".."))
  throw Error("unsupported proof gh command");
const method = args.indexOf("--method"),
  input = args.indexOf("--input");
const response = await fetch(new URL("/" + args[1], origin), {
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
