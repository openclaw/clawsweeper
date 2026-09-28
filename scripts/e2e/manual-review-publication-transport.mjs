// Test-only Node/curl transport. It cannot reach production, and does not emulate
// queue transitions, canonical writes, comment receipts, or bundle validation.
import { spawnSync } from "node:child_process";

const base = process.env.MANUAL_PUBLICATION_LOOPBACK;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || "")) throw new Error("loopback fixture required");
const request = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const original = new Request(input, init);
  const url = new URL(original.url);
  if (url.origin !== "https://manual-queue.invalid")
    throw new Error(`proof refused outbound URL: ${url.origin}`);
  return request(new Request(`${base}/queue${url.pathname}${url.search}`, original));
};
if (process.argv[2] === "curl") {
  const args = process.argv.slice(3);
  const url = new URL(args.at(-1));
  if (url.origin !== "https://manual-queue.invalid")
    throw new Error(`proof refused outbound URL: ${url.origin}`);
  args[args.length - 1] = `${base}/queue${url.pathname}${url.search}`;
  // Preserve actual curl body files, headers, write-out and HTTP exit semantics.
  const result = spawnSync("/usr/bin/curl", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
