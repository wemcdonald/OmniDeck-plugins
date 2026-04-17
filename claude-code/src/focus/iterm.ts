// plugins/claude-code/src/focus/iterm.ts
// macOS iTerm2 focus via AppleScript. Matches sessions by tty — which we
// resolve from cwd → claude PID → shell PID → tty.

import { existsSync } from "fs";
import type { OmniDeck } from "@omnideck/agent-sdk";
import type { FocusStrategy } from "./index";
import { findClaudePidByCwd, findShellAncestor, ttyFor } from "./proc";

async function itermRunning(omnideck: OmniDeck): Promise<boolean> {
  try {
    const { stdout } = await omnideck.exec("pgrep", ["-x", "iTerm2"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export const itermStrategy: FocusStrategy = {
  id: "iterm",

  async isAvailable(omnideck) {
    if (omnideck.platform !== "darwin") return false;
    if (!existsSync("/Applications/iTerm.app")) return false;
    return itermRunning(omnideck);
  },

  async focus(omnideck, cwd) {
    const claudePid = await findClaudePidByCwd(omnideck, cwd);
    if (!claudePid) return false;
    const shellPid = await findShellAncestor(omnideck, claudePid);
    if (!shellPid) return false;
    const tty = await ttyFor(omnideck, shellPid);
    if (!tty) return false;

    const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (tty of s) is "${tty}" then
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
      const result = (await omnideck.platformRequest("run_applescript", {
        script,
      })) as unknown;
      const ok = typeof result === "string" && result.includes("ok");
      return ok;
    } catch (err) {
      omnideck.log.debug("iTerm AppleScript failed", { err: String(err) });
      return false;
    }
  },
};
