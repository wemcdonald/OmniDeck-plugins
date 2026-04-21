// plugins/claude-code/src/focus/proc.ts
// Cross-platform process/cwd discovery helpers. No tmux or iTerm here —
// just: "given a cwd of a running `claude` process, find its PID and the PID
// of its parent shell".

import type { OmniDeck } from "@omnideck/agent-sdk";
import { readlinkSync, readdirSync, readFileSync } from "fs";

interface PidEntry {
  pid: number;
  cwd: string;
}

let claudePidCache: { built: number; entries: PidEntry[] } | null = null;
const CACHE_TTL_MS = 10_000;

/** List every running process with `claude` in argv (platform-specific). */
async function listClaudePids(omnideck: OmniDeck): Promise<number[]> {
  const plat = omnideck.platform;
  if (plat === "linux") {
    // Walk /proc directly.
    const pids: number[] = [];
    let dirs: string[] = [];
    try {
      dirs = readdirSync("/proc");
    } catch {
      return pids;
    }
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmdline = readFileSync(`/proc/${d}/cmdline`, "utf-8");
        if (cmdline.includes("claude")) pids.push(Number(d));
      } catch {
        // process vanished or no permission
      }
    }
    return pids;
  }
  // macOS (and anything else): match processes whose executable name is exactly
  // "claude" — not bootstrap shells, node MCP helpers, or `claude-code` VS Code
  // extensions, all of which appear in `pgrep -f claude`.
  try {
    const { stdout } = await omnideck.exec("pgrep", ["-x", "claude"]);
    return stdout
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** Return the cwd of PID `pid`, or undefined if unknown. */
async function pidCwd(omnideck: OmniDeck, pid: number): Promise<string | undefined> {
  if (omnideck.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  // macOS: lsof is the only reliable way without entitlements.
  try {
    const { stdout } = await omnideck.exec("lsof", [
      "-a",
      "-d",
      "cwd",
      "-p",
      String(pid),
      "-Fn",
    ]);
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Refresh cache if stale. */
async function refreshCache(omnideck: OmniDeck): Promise<void> {
  const now = Date.now();
  if (claudePidCache && now - claudePidCache.built < CACHE_TTL_MS) return;
  const pids = await listClaudePids(omnideck);
  const entries: PidEntry[] = [];
  for (const pid of pids) {
    const cwd = await pidCwd(omnideck, pid);
    if (cwd) entries.push({ pid, cwd });
  }
  claudePidCache = { built: now, entries };
}

/**
 * Find the PID that has `filePath` open. Used to pinpoint the specific claude
 * process for a given session when multiple claudes share a cwd.
 */
export async function findPidByOpenFile(
  omnideck: OmniDeck,
  filePath: string,
): Promise<number | undefined> {
  if (omnideck.platform === "linux") {
    let dirs: string[] = [];
    try {
      dirs = readdirSync("/proc");
    } catch {
      return undefined;
    }
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const fds = readdirSync(`/proc/${d}/fd`);
        for (const fd of fds) {
          try {
            if (readlinkSync(`/proc/${d}/fd/${fd}`) === filePath) {
              return Number(d);
            }
          } catch {
            // fd vanished
          }
        }
      } catch {
        // process vanished or no permission
      }
    }
    return undefined;
  }
  // macOS: lsof -t prints just the pid. `^R` opens for read, `^W` for write —
  // the classifier tails the file for read, so claude is typically the only
  // writer. Use `-a` with `-w` filter disabled; plain lsof on the path lists
  // every opener.
  try {
    const { stdout } = await omnideck.exec("lsof", ["-t", filePath]);
    const pid = Number(stdout.split("\n")[0]?.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function findClaudePidByCwd(
  omnideck: OmniDeck,
  cwd: string,
): Promise<number | undefined> {
  await refreshCache(omnideck);
  const hit = claudePidCache?.entries.find((e) => e.cwd === cwd);
  return hit?.pid;
}

/**
 * Walk up the process tree from `pid` until a shell (zsh/bash/fish) is found.
 * Returns the shell's PID, or undefined if none found within `maxDepth` hops.
 */
export async function findShellAncestor(
  omnideck: OmniDeck,
  pid: number,
  maxDepth = 20,
): Promise<number | undefined> {
  let current = pid;
  for (let depth = 0; depth < maxDepth && current > 1; depth++) {
    const { comm, ppid } = await psFor(omnideck, current);
    if (!ppid) return undefined;
    const bare = (comm || "").replace(/^-/, "").split("/").pop() ?? "";
    if (/^(zsh|bash|fish|sh|dash)$/.test(bare)) return current;
    current = ppid;
  }
  return undefined;
}

async function psFor(
  omnideck: OmniDeck,
  pid: number,
): Promise<{ comm?: string; ppid?: number }> {
  if (omnideck.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // "pid (comm) state ppid ..." — comm can contain spaces, wrapped in ().
      const m = stat.match(/^\d+ \((.*?)\) \S+ (\d+)/);
      if (m) return { comm: m[1], ppid: Number(m[2]) };
    } catch {
      return {};
    }
    return {};
  }
  try {
    const { stdout } = await omnideck.exec("ps", [
      "-o",
      "comm=,ppid=",
      "-p",
      String(pid),
    ]);
    const line = stdout.trim();
    if (!line) return {};
    // Last whitespace-separated token is ppid; everything before is comm.
    const idx = line.lastIndexOf(" ");
    if (idx < 0) return {};
    const comm = line.slice(0, idx).trim();
    const ppid = Number(line.slice(idx + 1).trim());
    return { comm, ppid: Number.isFinite(ppid) ? ppid : undefined };
  } catch {
    return {};
  }
}

/** Get the controlling tty for a PID ("/dev/ttys003") — macOS only reliably. */
export async function ttyFor(omnideck: OmniDeck, pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await omnideck.exec("ps", ["-o", "tty=", "-p", String(pid)]);
    const tty = stdout.trim();
    if (!tty || tty === "?" || tty === "??") return undefined;
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  } catch {
    return undefined;
  }
}

/** Reset the cache (for tests / manual invalidation). */
export function _resetProcCache() {
  claudePidCache = null;
}
