// plugins/claude-code/src/focus/tmux.ts
// Focus a tmux pane by matching its pane_pid against the shell ancestor of the
// `claude` process running in `cwd`. Falls back to matching pane_current_path.

import { existsSync } from "fs";
import type { OmniDeck } from "@omnideck/agent-sdk";
import type { FocusStrategy } from "./index";
import { findClaudePidByCwd, findShellAncestor } from "./proc";

// The macOS agent runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// which excludes Homebrew and MacPorts. Probe the common install locations so
// tmux works without requiring the user to fix the agent env.
const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/opt/local/bin/tmux",
  "/usr/bin/tmux",
];
let tmuxPathCache: string | undefined | null = undefined; // undefined=unresolved, null=not found
function resolveTmux(): string | undefined {
  if (tmuxPathCache !== undefined) return tmuxPathCache ?? undefined;
  for (const p of TMUX_CANDIDATES) {
    if (existsSync(p)) {
      tmuxPathCache = p;
      return p;
    }
  }
  tmuxPathCache = null;
  return undefined;
}

async function tmuxAvailable(omnideck: OmniDeck): Promise<boolean> {
  const tmuxBin = resolveTmux() ?? "tmux";
  try {
    const { exitCode } = await omnideck.exec(tmuxBin, ["list-sessions"]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function findPaneByShellPid(
  omnideck: OmniDeck,
  shellPid: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await omnideck.exec(resolveTmux() ?? "tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id} #{pane_pid}",
    ]);
    for (const line of stdout.split("\n")) {
      const [paneId, pid] = line.trim().split(/\s+/);
      if (Number(pid) === shellPid) return paneId;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function findPaneByCwd(
  omnideck: OmniDeck,
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await omnideck.exec(resolveTmux() ?? "tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id} #{pane_current_path}",
    ]);
    for (const line of stdout.split("\n")) {
      const idx = line.indexOf(" ");
      if (idx < 0) continue;
      const paneId = line.slice(0, idx);
      const paneCwd = line.slice(idx + 1);
      if (paneCwd === cwd) return paneId;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function raiseITermForTmuxSession(
  omnideck: OmniDeck,
  sessionName: string,
): Promise<void> {
  if (omnideck.platform !== "darwin") return;
  let clientTty: string | undefined;
  try {
    const { stdout } = await omnideck.exec(resolveTmux() ?? "tmux", [
      "list-clients",
      "-t",
      sessionName,
      "-F",
      "#{client_tty}",
    ]);
    clientTty = stdout.split("\n")[0]?.trim();
  } catch {
    return;
  }
  if (!clientTty) return;

  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (tty of s) is "${clientTty}" then
            tell w to select
            tell t to select
            select s
            activate
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`.trim();

  try {
    await omnideck.platformRequest("run_applescript", { script });
  } catch (err) {
    omnideck.log.debug("iTerm raise failed", { err: String(err) });
  }
}

export const tmuxStrategy: FocusStrategy = {
  id: "tmux",

  async isAvailable(omnideck) {
    return tmuxAvailable(omnideck);
  },

  async focus(omnideck, cwd) {
    // Strategy 1: cwd → claude PID → shell PID → pane_pid
    let pane: string | undefined;
    const claudePid = await findClaudePidByCwd(omnideck, cwd);
    if (claudePid) {
      const shellPid = await findShellAncestor(omnideck, claudePid);
      if (shellPid) pane = await findPaneByShellPid(omnideck, shellPid);
    }

    // Strategy 2: pane_current_path match (approximate)
    if (!pane) pane = await findPaneByCwd(omnideck, cwd);

    if (!pane) return false;

    // Resolve the tmux session name for this pane so we can raise iTerm.
    let sessionName: string | undefined;
    try {
      const { stdout } = await omnideck.exec(resolveTmux() ?? "tmux", [
        "display-message",
        "-p",
        "-t",
        pane,
        "#{session_name}",
      ]);
      sessionName = stdout.trim();
    } catch {
      // ignore
    }

    // Position the pane/window server-side.
    await omnideck.exec(resolveTmux() ?? "tmux", ["select-pane", "-t", pane]).catch(() => {});
    await omnideck.exec(resolveTmux() ?? "tmux", ["select-window", "-t", pane]).catch(() => {});

    // Switch any attached client. Best-effort — if no client is attached, fine.
    if (sessionName) {
      await omnideck
        .exec(resolveTmux() ?? "tmux", ["switch-client", "-t", sessionName])
        .catch(() => {});
      await raiseITermForTmuxSession(omnideck, sessionName);
    }

    return true;
  },
};
