// plugins/claude-code/src/focus/tmux.ts
// Focus a tmux pane by matching its pane_pid against the shell ancestor of the
// `claude` process running in `cwd`. Falls back to matching pane_current_path.

import { existsSync } from "fs";
import type { OmniDeck } from "@omnideck/agent-sdk";
import type { FocusStrategy } from "./index";
import { findClaudePidByCwd, findPidByOpenFile, findShellAncestor } from "./proc";

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

/** Unwrap the AppleScript response shape: { result: "<stdout>" } or raw string. */
function unwrapApplescriptResult(r: unknown): string {
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && "result" in r) {
    const inner = (r as { result: unknown }).result;
    return typeof inner === "string" ? inner : "";
  }
  return "";
}

/**
 * Run AppleScript directly via osascript rather than platformRequest.
 * platformRequest has a hardcoded 10s timeout in the agent SDK; on a busy
 * iTerm, enumerating sessions can take longer than that. Going via exec
 * removes the cap — we still need Accessibility permissions, which the agent
 * already inherits when run from agent-app.
 */
async function runApplescript(
  omnideck: OmniDeck,
  script: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await omnideck.exec("/usr/bin/osascript", ["-e", script]);
  if (exitCode !== 0) {
    omnideck.log.debug("osascript nonzero exit", { exitCode, stderr: stderr.trim() });
    return "";
  }
  return stdout.trim();
}

async function listClientTtys(
  omnideck: OmniDeck,
  sessionName: string,
): Promise<string[]> {
  try {
    const { stdout } = await omnideck.exec(resolveTmux() ?? "tmux", [
      "list-clients",
      "-t",
      sessionName,
      "-F",
      "#{client_tty}",
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Raise the iTerm tab whose session's tty matches any of `clientTtys`. */
async function raiseITermTabByTty(
  omnideck: OmniDeck,
  clientTtys: string[],
): Promise<boolean> {
  if (omnideck.platform !== "darwin" || clientTtys.length === 0) return false;

  const ttyList = clientTtys
    .map((t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(", ");

  // Batched enumeration: one Apple Event per tab returns all session ttys at
  // once, which is much faster than one round trip per session on a busy
  // iTerm. Avoids hitting the 10s platformRequest cap on heavy setups.
  // `repeat with wt in list` binds wt as a reference — string comparison
  // against it silently returns false. Use `contains` to compare by value.
  // On match: activate iTerm, raise the window, switch to the tab, make the
  // session current. All three explicit steps are needed; `select s` alone
  // leaves the wrong window on top.
  const script = `
set wantedTtys to {${ttyList}}
tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      try
        set ttyList to (tty of every session of t)
        repeat with i from 1 to count of ttyList
          set sTty to item i of ttyList
          if wantedTtys contains sTty then
            set targetSession to item i of (every session of t)
            tell w to select
            tell t to select
            select targetSession
            return "ok:" & sTty
          end if
        end repeat
      end try
    end repeat
  end repeat
  return "not_found"
end tell`.trim();

  const startedAt = Date.now();
  try {
    const stdout = await runApplescript(omnideck, script);
    omnideck.log.info(
      `raiseITermTabByTty result: ${stdout || "<empty>"} (${Date.now() - startedAt}ms)`,
    );
    if (stdout.startsWith("ok")) return true;

    // Miss — log every iTerm session tty so we can see the format mismatch.
    const dumpScript = `
tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      try
        set ttyList to (tty of every session of t)
        repeat with sTty in ttyList
          set out to out & sTty & linefeed
        end repeat
      end try
    end repeat
  end repeat
  return out
end tell`.trim();
    const allTtys = await runApplescript(omnideck, dumpScript);
    omnideck.log.info(
      `iTerm session ttys seen: ${allTtys.split("\n").filter(Boolean).join(" | ")}`,
    );
    omnideck.log.info(`tmux client ttys wanted: ${clientTtys.join(" | ")}`);
    return false;
  } catch (err) {
    omnideck.log.warn("iTerm raise threw", { err: String(err) });
    return false;
  }
}

/** Open a new iTerm tab (or window if none exists) and attach to `sessionName`. */
async function openITermTabAttached(
  omnideck: OmniDeck,
  sessionName: string,
): Promise<boolean> {
  if (omnideck.platform !== "darwin") return false;

  const tmuxBin = resolveTmux() ?? "tmux";
  // Build the shell command with a single-quoted session name (safe except for
  // literal apostrophes in the name; escape those via the '\'' shell idiom).
  const shQuotedSession = `'${sessionName.replace(/'/g, `'\\''`)}'`;
  const cmd = `${tmuxBin} attach -t ${shQuotedSession}`;
  // Then escape for AppleScript string literal: \ and " → \\ and \"
  const asCmd = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const script = `
tell application "iTerm2"
  activate
  if (count of windows) = 0 then
    create window with default profile
  else
    tell current window to create tab with default profile
  end if
  tell current session of current tab of current window to write text "${asCmd}"
  return "ok"
end tell`.trim();

  try {
    const stdout = await runApplescript(omnideck, script);
    return stdout.includes("ok");
  } catch (err) {
    omnideck.log.warn("iTerm new-tab attach failed", { err: String(err) });
    return false;
  }
}

export const tmuxStrategy: FocusStrategy = {
  id: "tmux",

  async isAvailable(omnideck) {
    return tmuxAvailable(omnideck);
  },

  async focus(omnideck, cwd, hints) {
    // Strategy 1a: transcript → specific claude PID → shell PID → pane_pid.
    // This is the precise path: the claude process for THIS session has the
    // transcript file open, which disambiguates when multiple claudes share
    // the same cwd (e.g., several tmux windows rooted at the same repo).
    let pane: string | undefined;
    if (hints.transcriptPath) {
      const claudePid = await findPidByOpenFile(omnideck, hints.transcriptPath);
      if (claudePid) {
        const shellPid = await findShellAncestor(omnideck, claudePid);
        if (shellPid) pane = await findPaneByShellPid(omnideck, shellPid);
      }
    }

    // Strategy 1b: cwd → first-matching claude PID → shell PID → pane_pid
    if (!pane) {
      const claudePid = await findClaudePidByCwd(omnideck, cwd);
      if (claudePid) {
        const shellPid = await findShellAncestor(omnideck, claudePid);
        if (shellPid) pane = await findPaneByShellPid(omnideck, shellPid);
      }
    }

    // Strategy 2: pane_current_path match (approximate)
    if (!pane) pane = await findPaneByCwd(omnideck, cwd);

    if (!pane) return false;

    // Resolve the tmux session name for this pane.
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

    // Position the pane/window server-side. If a client is attached to this
    // session, select-window will move its active window — which is what we
    // want. We do NOT call `switch-client` (no -c) because that hijacks the
    // most-recently-active client, replacing whatever it was showing.
    await omnideck.exec(resolveTmux() ?? "tmux", ["select-pane", "-t", pane]).catch(() => {});
    await omnideck.exec(resolveTmux() ?? "tmux", ["select-window", "-t", pane]).catch(() => {});

    if (!sessionName) return true;

    // If the session is already attached somewhere, foreground that app/tab.
    // Otherwise, open a new iTerm tab and attach.
    const clientTtys = await listClientTtys(omnideck, sessionName);
    omnideck.log.info(
      `tmux session=${sessionName} attached_clients=${clientTtys.length > 0 ? clientTtys.join(",") : "none"}`,
    );

    if (clientTtys.length > 0) {
      const raised = await raiseITermTabByTty(omnideck, clientTtys);
      if (raised) {
        omnideck.log.info(`iTerm tab raised for session ${sessionName}`);
        return true;
      }
      // Attached but we couldn't find the iTerm tab (tty mismatch, AppleScript
      // hiccup, or the client is in a non-iTerm terminal). Open a fresh iTerm
      // tab attached to the same session so the button still gets the user
      // somewhere useful. Multiple tmux clients can share one session.
      omnideck.log.warn(
        `iTerm tab not found for client ttys [${clientTtys.join(",")}] on session ${sessionName} — falling back to new tab attach`,
      );
      const opened = await openITermTabAttached(omnideck, sessionName);
      if (opened) {
        omnideck.log.info(`opened new iTerm tab attached to ${sessionName}`);
        return true;
      }
      omnideck.log.warn(`new-tab attach also failed for ${sessionName}`);
      return false;
    }

    const opened = await openITermTabAttached(omnideck, sessionName);
    if (opened) {
      omnideck.log.info(`opened new iTerm tab attached to ${sessionName} (no prior clients)`);
      return true;
    }
    omnideck.log.warn(`no clients attached to ${sessionName} and new-tab attach failed`);
    return false;
  },
};
