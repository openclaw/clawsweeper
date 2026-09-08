import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const endpoint = new URL(process.env.PROOF_ENDPOINT);
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== endpoint.origin) throw new Error("Proof refused non-loopback fetch");
  return fetchLocal(input, init);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options =
    typeof normalized[0] === "object"
      ? normalized[0]
      : { port: normalized[0], host: normalized[1] };
  if (
    options.path ||
    Number(options.port) !== Number(endpoint.port) ||
    !["127.0.0.1", "localhost", "::1"].includes(options.host)
  ) {
    throw new Error("Proof refused non-loopback socket");
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const input = args.indexOf("--input");
  const payload = input >= 0 ? JSON.parse(readFileSync(args[input + 1], "utf8")) : undefined;
  const response = await fetch(`${endpoint.origin}/gh`, {
    method: "POST",
    body: JSON.stringify({ args, payload }),
  });
  const value = await response.json();
  if (!response.ok) {
    console.error(value.error);
    process.exitCode = 1;
  } else {
    process.stdout.write(value.stdout);
  }
}
