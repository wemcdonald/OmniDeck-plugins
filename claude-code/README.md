# Claude Code

OmniDeck plugin that surfaces live Claude Code CLI sessions as deck buttons.

## What it does

- Polls `~/.claude/projects/*/*/*.jsonl` to discover active sessions.
- Classifies each session by reading the tail of its transcript:

  | State | Color | Meaning |
  |---|---|---|
  | **WORKING** | orange | Claude is running a tool, or user just sent input |
  | **ASKING** | blue + `?` badge | Claude's reply is a question or request for input |
  | **IDLE** | gray | Claude replied and is sitting at the prompt |
  | **DONE** | green (briefly) | CLI has cleanly exited (`/exit`, Ctrl-D) |
  | **STALE** | hidden | No activity for a while, likely crashed |

- Pressing a button focuses the corresponding terminal:
  1. Tries `tmux switch-client` to the pane matching the session's cwd
  2. Falls back to iTerm2 via AppleScript (matches by tty)
  3. Falls back to `open -a Terminal <cwd>` (macOS) / `$TERMINAL --working-directory <cwd>` (Linux)

## Placement

- **Auto-populated page** — drop the "Claude Code Sessions" page provider onto a
  button; it fills itself with one tile per live session, sorted by state
  priority (ASKING > WORKING > IDLE > DONE).
- **Manual pin** — add the "Claude Code Session" preset and pick a specific
  session or project basename to pin. Useful for pinning a favorite long-running
  repo: matches by `project_basename` so the pin survives across session restarts.

## Status analysis (ASKING vs IDLE)

Claude Code's JSONL transcript tells us when a reply is in progress (`tool_use`)
vs finished (`end_turn`), but it doesn't distinguish "finished with a question
for the user" from "finished, just idle." This plugin uses:

1. **Heuristics** (always on, free, local) — detect trailing `?`, numbered
   option lists, trigger phrases like *"would you like"*, *"should I"*, etc.
2. **Optional LLM classifier** for ambiguous cases. Choose provider via the
   **Status analysis** dropdown in settings:
   - **None** (default)
   - **ChatGPT** — OpenAI, `gpt-4o-mini` recommended
   - **Claude** — Anthropic, `claude-haiku-4-5-20251001` recommended

   Only the last assistant message is sent (~200 tokens in, 1 token out).
   Typical cost: **< $0.0001 per ambiguous reply**. Verdicts are cached per
   message hash so repeat polls don't re-bill. The classifier is **only called
   when heuristics are ambiguous** (no `?`, no trigger phrases).

API keys live in plugin settings, encrypted at rest.

## Focus strategies

Order is configurable. Each strategy self-reports availability and is skipped
if unavailable:

- **tmux** — requires `tmux` on PATH with a running server
- **iterm** — macOS + iTerm.app installed + running
- **app** — `open -a Terminal` (macOS) or `$TERMINAL --working-directory` (Linux)

## Settings groups

- **Timing** — poll interval, DONE linger duration, stale timeout
- **Status analysis** — provider selector + per-provider API key and model
- **Focus** — strategy order

## Not yet implemented / known limitations

- Windows focus support (plugin runs on Windows but `focus` will be a no-op).
- Long-press actions (kill session, copy path, send canned prompt).
- Per-session custom labels / icons.
- Cross-agent Sessions page when multiple machines run Claude Code (the page
  resolves one agent via `active_agent`; other agents still work via manual
  pins with an explicit `target` param).
