import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { windowsSystemExecutable } from "../command.js";

type ProcessRow = {
  parentPid: number;
  pid: number;
};

export class ProcessTreeTracker {
  readonly #rootPid: number;
  readonly #trackedPids = new Set<number>();
  #failure: Error | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(rootPid: number) {
    this.#rootPid = rootPid;
    this.#trackedPids.add(rootPid);
  }

  start() {
    const rows = processRows();
    if (!rows.some((row) => row.pid === this.#rootPid)) {
      throw new Error("could not establish validation process containment before command exit");
    }
    this.#capture(rows);
    this.#timer = setInterval(
      () => {
        try {
          this.#capture(processRows());
        } catch (error) {
          this.#failure = error as Error;
        }
      },
      process.platform === "win32" ? 50 : 10,
    );
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#failure) throw this.#failure;
    const rows = processRows();
    this.#capture(rows);
    const livePids = new Set(rows.map((row) => row.pid));
    return [...this.#trackedPids].filter((pid) => pid !== this.#rootPid && livePids.has(pid));
  }

  trackedPids() {
    return [...this.#trackedPids];
  }

  #capture(rows: readonly ProcessRow[]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (
          row.pid === process.pid ||
          this.#trackedPids.has(row.pid) ||
          !this.#trackedPids.has(row.parentPid)
        ) {
          continue;
        }
        this.#trackedPids.add(row.pid);
        changed = true;
      }
    }
  }
}

export function parseProcessRows(output: string): ProcessRow[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([pidText, parentPidText]) => ({
      pid: Number.parseInt(pidText ?? "", 10),
      parentPid: Number.parseInt(parentPidText ?? "", 10),
    }))
    .filter(
      (row) =>
        Number.isInteger(row.pid) &&
        row.pid > 0 &&
        Number.isInteger(row.parentPid) &&
        row.parentPid >= 0,
    );
}

function processRows() {
  if (process.platform === "linux") return linuxProcessRows();
  const result =
    process.platform === "win32"
      ? spawnSync(
          windowsSystemExecutable("powershell.exe", process.env),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { encoding: "utf8", windowsHide: true },
        )
      : spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
          encoding: "utf8",
          windowsHide: true,
        });
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not inspect validation process tree: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return parseProcessRows(String(result.stdout ?? ""));
}

function linuxProcessRows() {
  const rows: ProcessRow[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch (error) {
    throw new Error(`could not inspect validation process tree: ${(error as Error).message}`);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const pid = Number.parseInt(entry, 10);
      const parentPid = Number.parseInt(fields[1] ?? "", 10);
      if (Number.isInteger(parentPid) && parentPid >= 0) rows.push({ pid, parentPid });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return rows;
}
