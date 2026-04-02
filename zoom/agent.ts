// plugins/zoom/agent.ts
// Agent-side plugin: detects Zoom meeting state and controls Zoom without
// requiring the Zoom window to be focused.
//
// macOS  — platformRequest("run_applescript") for detection,
//          platformRequest("send_keystroke") for actions (both run in the
//          Tauri host process which has Accessibility permission)
// Windows — PowerShell for detection, SendKeys for actions
// Linux  — pgrep/xdotool for detection and actions
import type { OmniDeck } from "@omnideck/agent-sdk";

interface ZoomState {
  running: boolean;
  inMeeting: boolean;
  muted: boolean | null;
  videoOn: boolean | null;
  sharing: boolean | null;
  recording: boolean | null;
  handRaised: boolean | null;
}

const EMPTY_STATE: ZoomState = {
  running: false,
  inMeeting: false,
  muted: null,
  videoOn: null,
  sharing: null,
  recording: null,
  handRaised: null,
};

export default function init(omnideck: OmniDeck) {
  const pollInterval = parseDuration(
    (omnideck.config.poll_interval as string) ?? "2s",
  );

  // ── State polling ────────────────────────────────────────────────────────

  let state: ZoomState = { ...EMPTY_STATE };

  // Cache the Zoom window ID on Linux so actions can target it directly.
  let linuxWindowId: string | undefined;

  async function poll() {
    try {
      if (omnideck.platform === "darwin") {
        state = await pollDarwin();
      } else if (omnideck.platform === "windows") {
        state = await pollWindows();
      } else if (omnideck.platform === "linux") {
        state = await pollLinux();
      }
    } catch (err) {
      omnideck.log.error("Zoom poll failed", { err: String(err) });
      state = { ...EMPTY_STATE };
    }
    omnideck.setState("meeting", state);
  }

  const handle = omnideck.setInterval(poll, pollInterval);
  poll();

  // ── macOS: AppleScript via platformRequest (runs in Tauri host) ──────────

  async function runAppleScript(script: string): Promise<string> {
    const res = await omnideck.platformRequest("run_applescript", { script }) as
      { result?: string; error?: string };
    if (res.error) throw new Error(res.error);
    return res.result ?? "";
  }

  async function pollDarwin(): Promise<ZoomState> {
    const script = `
      tell application "System Events"
        if not (exists process "zoom.us") then return "not_running"
        tell process "zoom.us"
          set windowNames to name of every window
          if (count of windowNames) = 0 then return "no_meeting"

          set inMeeting to false
          repeat with w in windowNames
            if w contains "Zoom Meeting" or w contains "Zoom Workplace" then
              set inMeeting to true
            end if
          end repeat
          if not inMeeting then return "no_meeting"

          set menuItems to name of every menu item of menu 1 of menu bar item "Meeting" of menu bar 1
          set result to ""
          repeat with mi in menuItems
            set result to result & mi & "|"
          end repeat
          return result
        end tell
      end tell
    `;
    const out = await runAppleScript(script);

    if (out === "not_running") return { ...EMPTY_STATE };
    if (out === "no_meeting") return { ...EMPTY_STATE, running: true };

    const items = out.toLowerCase();
    return {
      running: true,
      inMeeting: true,
      muted: items.includes("unmute") ? true : items.includes("mute") ? false : null,
      videoOn: items.includes("stop video") ? true : items.includes("start video") ? false : null,
      sharing: items.includes("stop share") ? true : items.includes("share screen") ? false : null,
      recording: items.includes("stop recording") ? true : items.includes("record") ? false : null,
      handRaised: items.includes("lower hand") ? true : items.includes("raise hand") ? false : null,
    };
  }

  // ── Windows: PowerShell process + window title detection ─────────────────

  async function pollWindows(): Promise<ZoomState> {
    const script = `
      $zoom = Get-Process -Name "Zoom" -ErrorAction SilentlyContinue
      if (-not $zoom) { Write-Output "not_running"; exit }
      $windows = $zoom | ForEach-Object { $_.MainWindowTitle } | Where-Object { $_ -ne "" }
      $inMeeting = $windows | Where-Object { $_ -match "Zoom Meeting|Zoom Workplace" }
      if (-not $inMeeting) { Write-Output "no_meeting"; exit }
      Write-Output "in_meeting"
    `;
    const r = await omnideck.exec("powershell", ["-Command", script]);
    const out = r.stdout.trim();

    if (out === "not_running") return { ...EMPTY_STATE };
    if (out === "no_meeting") return { ...EMPTY_STATE, running: true };

    return { ...EMPTY_STATE, running: true, inMeeting: true };
  }

  // ── Linux: process + xdotool window detection ───────────────────────────

  async function pollLinux(): Promise<ZoomState> {
    const proc = await omnideck.exec("pgrep", ["-x", "zoom"]);
    if (proc.exitCode !== 0) {
      linuxWindowId = undefined;
      return { ...EMPTY_STATE };
    }

    const win = await omnideck.exec("xdotool", ["search", "--name", "Zoom Meeting"]);
    if (win.exitCode !== 0 || !win.stdout.trim()) {
      const win2 = await omnideck.exec("xdotool", ["search", "--name", "Zoom Workplace"]);
      if (win2.exitCode !== 0 || !win2.stdout.trim()) {
        linuxWindowId = undefined;
        return { ...EMPTY_STATE, running: true };
      }
      linuxWindowId = win2.stdout.trim().split("\n")[0];
    } else {
      linuxWindowId = win.stdout.trim().split("\n")[0];
    }

    return { ...EMPTY_STATE, running: true, inMeeting: true };
  }

  // ── macOS keystroke via platformRequest ──────────────────────────────────
  // Keystrokes are sent via CGEvents in the Tauri host process, which has
  // Accessibility permission. The sidecar doesn't need Accessibility at all.

  const MAC_KEYCODES: Record<string, number> = {
    a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
    b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  };

  const kCGEventFlagMaskShift = 0x20000;
  const kCGEventFlagMaskAlternate = 0x80000;
  const kCGEventFlagMaskCommand = 0x100000;

  function parseShortcutDarwin(shortcut: string): { keyCode: number; flags: number } | null {
    const parts = shortcut.split(",").map((k) => k.trim());
    const key = parts[parts.length - 1].toLowerCase();
    const modifiers = parts.slice(0, -1);

    const keyCode = MAC_KEYCODES[key];
    if (keyCode === undefined) return null;

    let flags = 0;
    for (const mod of modifiers) {
      switch (mod) {
        case "cmd": case "command": flags |= kCGEventFlagMaskCommand; break;
        case "shift": flags |= kCGEventFlagMaskShift; break;
        case "alt": case "option": flags |= kCGEventFlagMaskAlternate; break;
      }
    }
    return { keyCode, flags };
  }

  async function sendKeystrokeDarwin(shortcut: string): Promise<boolean> {
    const parsed = parseShortcutDarwin(shortcut);
    if (!parsed) return false;

    // Single IPC call: activate Zoom, send keystroke, restore previous app.
    // All happens in the Tauri host process to avoid timing issues.
    const res = await omnideck.platformRequest("send_keystroke_to_app", {
      app: "zoom.us",
      keyCode: parsed.keyCode,
      flags: parsed.flags,
    }) as { success?: boolean; error?: string };

    return res.success === true;
  }

  // ── Windows: send keystrokes, saving/restoring foreground window ─────────

  async function sendKeystrokeWindows(shortcut: string): Promise<boolean> {
    const parts = shortcut.split(",").map((k) => k.trim());
    const key = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);
    const modMap: Record<string, string> = { alt: "%", shift: "+", ctrl: "^", control: "^" };
    const sendKey = modifiers.map((m) => modMap[m] ?? "").join("") + key;
    const script = `
      Add-Type -AssemblyName Microsoft.VisualBasic
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinFg {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $prev = [WinFg]::GetForegroundWindow()
      $zoom = Get-Process -Name "Zoom" -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $zoom) { Write-Output "no_zoom"; exit }
      [Microsoft.VisualBasic.Interaction]::AppActivate($zoom.Id)
      Start-Sleep -Milliseconds 100
      [System.Windows.Forms.SendKeys]::SendWait("${sendKey}")
      Start-Sleep -Milliseconds 50
      [void][WinFg]::SetForegroundWindow($prev)
      Write-Output "ok"
    `;
    const r = await omnideck.exec("powershell", ["-Command", script]);
    return r.stdout.trim() === "ok";
  }

  // ── Linux: send keystrokes to the Zoom window without focus ──────────────

  async function sendKeystrokeLinux(shortcut: string): Promise<boolean> {
    if (!linuxWindowId) return false;
    const parts = shortcut.split(",").map((k) => k.trim());
    const key = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);
    const modMap: Record<string, string> = { alt: "alt", shift: "shift", ctrl: "ctrl", control: "ctrl" };
    const xdoKeys = [...modifiers.map((m) => modMap[m] ?? m), key].join("+");
    const r = await omnideck.exec("xdotool", ["key", "--window", linuxWindowId, xdoKeys]);
    return r.exitCode === 0;
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  const DARWIN_SHORTCUTS: Record<string, string> = {
    toggle_mute: "cmd,shift,a",
    toggle_video: "cmd,shift,v",
    toggle_share: "cmd,shift,s",
    toggle_recording: "cmd,shift,r",
    leave: "cmd,w",
    end: "cmd,shift,e",
    toggle_hand: "option,y",
    react: "cmd,shift,e",
  };

  const SHORTCUTS_WINDOWS: Record<string, string> = {
    toggle_mute: "alt,a",
    toggle_video: "alt,v",
    toggle_share: "alt,s",
    leave: "alt,q",
    end: "alt,q",
    toggle_hand: "alt,y",
    toggle_recording: "alt,r",
    react: "alt,shift,y",
  };

  const SHORTCUTS_LINUX: Record<string, string> = { ...SHORTCUTS_WINDOWS };

  // ── Unified action dispatcher ────────────────────────────────────────────

  async function executeAction(actionId: string): Promise<boolean> {
    if (omnideck.platform === "darwin") {
      const shortcut = DARWIN_SHORTCUTS[actionId];
      return shortcut ? sendKeystrokeDarwin(shortcut) : false;
    }

    if (omnideck.platform === "windows") {
      const shortcut = SHORTCUTS_WINDOWS[actionId];
      return shortcut ? sendKeystrokeWindows(shortcut) : false;
    }

    if (omnideck.platform === "linux") {
      const shortcut = SHORTCUTS_LINUX[actionId];
      return shortcut ? sendKeystrokeLinux(shortcut) : false;
    }

    return false;
  }

  // ── Register actions ─────────────────────────────────────────────────────

  const actions = [
    "toggle_mute",
    "toggle_video",
    "toggle_share",
    "leave",
    "end",
    "toggle_hand",
    "react",
    "toggle_recording",
  ] as const;

  for (const actionId of actions) {
    omnideck.onAction(actionId, async () => {
      const ok = await executeAction(actionId);
      if (ok) await poll();
      return { success: ok, error: ok ? undefined : "Zoom not running or action failed" };
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  omnideck.onReloadConfig(() => {
    // Hub reconnected — re-push current state to repopulate empty store
    omnideck.setState("meeting", state);
  });

  omnideck.onDestroy(() => {
    omnideck.clearInterval(handle);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m)$/);
  if (!match) return 2000;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return 2000;
}
