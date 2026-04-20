// plugins/claude-code/src/focus/app.ts
// Fallback: open the cwd in the host's default terminal. Best-effort, no
// attempt to locate the exact running session.

import { existsSync } from "fs";
import type { OmniDeck } from "@omnideck/agent-sdk";
import type { FocusStrategy } from "./index";

export const appStrategy: FocusStrategy = {
  id: "app",

  async isAvailable(omnideck) {
    return omnideck.platform === "darwin" || omnideck.platform === "linux";
  },

  async focus(omnideck, cwd) {
    if (omnideck.platform === "darwin") {
      const appName = existsSync("/Applications/iTerm.app") ? "iTerm" : "Terminal";
      try {
        const { exitCode } = await omnideck.exec("open", ["-a", appName, cwd]);
        return exitCode === 0;
      } catch {
        return false;
      }
    }

    if (omnideck.platform === "linux") {
      const term = process.env.TERMINAL || process.env.TERM_PROGRAM || "x-terminal-emulator";
      try {
        const { exitCode } = await omnideck.exec(term, ["--working-directory", cwd]);
        return exitCode === 0;
      } catch {
        return false;
      }
    }

    return false;
  },
};
