import http from "node:http";
import { channel } from "node:diagnostics_channel";
import { setImmediate } from "node:timers/promises";

const peers = new Map();
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = Reflect.apply(createServer, this, args);
  server.on("connection", (socket) => {
    const key = socket.remotePort + ":" + socket.localPort;
    peers.set(key, socket);
    socket.once("close", () => peers.delete(key));
  });
  return server;
};

// Close an idle peer after the client selects its pooled socket, before the
// client can observe closure. This makes the keep-alive retirement race repeatable.
const used = new WeakSet();
channel("undici:client:sendHeaders").subscribe(({ socket }) => {
  const peer = peers.get(socket.localPort + ":" + socket.remotePort);
  if (!peer) return;
  if (used.has(socket)) peer.resetAndDestroy();
  used.add(socket);
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  await setImmediate();
  return originalFetch(input, init);
};
