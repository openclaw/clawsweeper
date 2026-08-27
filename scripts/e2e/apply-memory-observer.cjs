// Observe the built CLI without changing record contents or its memory limit.
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

net.Socket.prototype.connect = () => {
  throw new Error("apply memory proof forbids network access");
};
globalThis.fetch = () => {
  throw new Error("apply memory proof forbids fetch");
};

if (process.argv[1]?.endsWith("/dist/clawsweeper.js")) {
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = childProcess[method];
    childProcess[method] = (command, args, ...rest) => {
      // The ledger uses these local process-identity probes on macOS.
      const ledgerProbe = ["/usr/bin/python3", "/usr/sbin/sysctl", "/bin/ps"].includes(command);
      if (
        !ledgerProbe &&
        (command !== process.execPath || args[0] !== process.env.APPLY_MEMORY_TRANSPORT)
      ) {
        throw new Error(`apply memory proof forbids subprocess: ${command}`);
      }
      return original(command, args, ...rest);
    };
  }
  const originalRead = fs.readFileSync;
  const counts = { items: 0, closed: 0, bytes: 0 };
  const firstStacks = {};
  let peakHeapUsed = 0;
  let peakRss = 0;
  const save = () => {
    const memory = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
    fs.writeFileSync(
      process.env.APPLY_MEMORY_METRICS,
      JSON.stringify({
        counts,
        peakHeapUsed,
        peakRss,
        maxRSSKiB: process.resourceUsage().maxRSS,
        firstStacks,
      }),
    );
  };
  fs.readFileSync = (file, ...args) => {
    const value = originalRead(file, ...args);
    const path = String(file);
    const match = path.startsWith(process.env.APPLY_MEMORY_RECORDS)
      ? path.match(/\/(items|closed)\/\d+\.md$/)
      : null;
    if (match) {
      counts[match[1]] += 1;
      counts.bytes += Buffer.byteLength(value);
      firstStacks[match[1]] ??= new Error(`first ${match[1]} read`).stack;
      if ((counts.items + counts.closed) % 10 === 0) save();
    }
    return value;
  };
  process.on("exit", save);
  save();
}
syncBuiltinESMExports();
