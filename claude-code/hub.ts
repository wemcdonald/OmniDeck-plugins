// plugins/claude-code/hub.ts
// Hub-side plugin: config schema, actions, state providers, presets, and the
// dynamic Sessions page. Reads session state pushed by the agent and renders
// color-coded buttons.

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

// ── Colors ──────────────────────────────────────────────────────────────────
const ORANGE = "#ff8c00"; // WORKING
const BLUE = "#3b82f6"; // ASKING
const GRAY = "#94a3b8"; // IDLE
const GREEN = "#22c55e"; // DONE (briefly)
const DIM = "#475569"; // STALE
const WHITE = "#ffffff";

// ── Types (mirror of agent.ts; duplicated to avoid cross-file import) ──────
type SessionState = "WORKING" | "ASKING" | "IDLE" | "DONE" | "STALE";

interface Session {
  sessionId: string;
  projectPath: string;
  cwd: string;
  state: SessionState;
  lastActivityMs: number;
  lastAssistantText?: string;
  classifierSource?: "heuristic" | "llm" | "fallback";
}

// ── Config schema ───────────────────────────────────────────────────────────
const configSchema = z.object({
  // Timing
  poll_interval_ms: field(z.number().min(1000).max(30000).default(5000), {
    label: "Poll interval (ms)",
    description: "How often to scan ~/.claude/projects for updated sessions.",
    group: "Timing",
  }),
  done_linger_ms: field(z.number().min(0).max(600_000).default(30_000), {
    label: "DONE linger (ms)",
    description:
      "How long a cleanly-exited session stays on the page (green) before dropping off.",
    group: "Timing",
  }),
  stale_timeout_ms: field(z.number().min(60_000).default(3_600_000), {
    label: "Stale timeout (ms)",
    description:
      "Sessions with no updates and no last-prompt marker are hidden after this.",
    group: "Timing",
  }),

  // Status analysis
  status_analysis: field(
    z.enum(["none", "anthropic", "openai"]).default("none"),
    {
      label: "Status analysis",
      description:
        "When Claude finishes a reply, use an LLM to decide whether it's asking you a question (blue '?') or just idle (gray). Heuristics run first for free; the LLM is only consulted when ambiguous. Only the last assistant message is sent — typically ~200 tokens in, 1 token out. Cost: < $0.0001 per ambiguous reply. 'None' = heuristics only.",
      group: "Status analysis",
    },
  ),
  anthropic_api_key: field(z.string().default(""), {
    label: "Anthropic API key",
    description:
      "Required when Status analysis = Claude. Stored encrypted. Used only for classification calls.",
    placeholder: "sk-ant-...",
    secret: true,
    group: "Status analysis",
  }),
  anthropic_model: field(
    z
      .enum([
        "claude-haiku-4-5-20251001",
        "claude-haiku-3-5-latest",
        "claude-sonnet-4-6",
      ])
      .default("claude-haiku-4-5-20251001"),
    {
      label: "Claude model",
      description:
        "Claude Haiku 4.5 is cheapest and fastest — recommended. Sonnet is overkill for a 1-token classification.",
      group: "Status analysis",
    },
  ),
  openai_api_key: field(z.string().default(""), {
    label: "OpenAI API key",
    description:
      "Required when Status analysis = ChatGPT. Stored encrypted. Used only for classification calls.",
    placeholder: "sk-...",
    secret: true,
    group: "Status analysis",
  }),
  openai_model: field(
    z.enum(["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"]).default("gpt-4o-mini"),
    {
      label: "OpenAI model",
      description:
        "GPT-4o-mini recommended — cheap, fast, and plenty accurate for a 1-token classification.",
      group: "Status analysis",
    },
  ),

  // Focus
  focus_strategies: field(
    z.array(z.enum(["tmux", "iterm", "app"])).default(["tmux", "iterm", "app"]),
    {
      label: "Focus strategies",
      description:
        "Order to try when focusing a session. Unavailable strategies (e.g. iTerm on Linux) are skipped automatically.",
      group: "Focus",
    },
  ),
});

// ── Param schemas ───────────────────────────────────────────────────────────
const targetParam = {
  target: field(z.string().optional(), {
    label: "Target agent",
    fieldType: "agent" as const,
    description: "Which machine is running Claude Code.",
  }),
};

const focusSchema = z.object({
  ...targetParam,
  session_id: field(z.string(), {
    label: "Session ID",
    description: "Claude Code session UUID (usually set automatically by the Sessions page).",
  }),
  cwd: field(z.string().optional(), {
    label: "Working directory",
    description: "Optional override — focus a terminal in this directory even if session_id can't resolve one.",
  }),
});

const sessionStateSchema = z.object({
  ...targetParam,
  session_id: field(z.string().optional(), {
    label: "Session ID",
    description: "Pin to a specific session. Leave blank to bind to a slot via the Sessions page.",
  }),
  project_basename: field(z.string().optional(), {
    label: "Match by project basename",
    description:
      "Alternative to session_id: pin to any session running in a project whose directory basename matches this (e.g. 'OmniDeck'). Survives session restarts.",
  }),
});

const recentSessionSchema = z.object({
  ...targetParam,
  index: field(z.number().int().min(0).max(14), {
    label: "Slot index",
    description:
      "Which recent session to show (0 = most recent). Non-STALE sessions only.",
  }),
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function shortLabel(cwd: string, maxLen = 8): string {
  const parts = cwd.split("/");
  const base = parts[parts.length - 1] || cwd;
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen - 1) + "…";
}

function stateVisuals(state: SessionState): {
  iconColor: string;
  badge?: string;
  badgeColor?: string;
  opacity?: number;
} {
  switch (state) {
    case "WORKING":
      return { iconColor: ORANGE };
    case "ASKING":
      return { iconColor: BLUE, badge: "?", badgeColor: WHITE };
    case "IDLE":
      return { iconColor: GRAY };
    case "DONE":
      return { iconColor: GREEN };
    case "STALE":
      return { iconColor: DIM, opacity: 0.4 };
  }
}

// ── Plugin definition ───────────────────────────────────────────────────────
export const claudeCodePlugin: OmniDeckPlugin = {
  id: "claude-code",
  name: "Claude Code",
  version: "0.1.0",
  icon: "ms:terminal",
  configSchema,

  async init(ctx: PluginContext) {
    // ── Helpers to read agent state ───────────────────────────────────────

    function resolveTarget(
      params: Record<string, unknown>,
      actionCtx: { focusedAgent?: string },
    ): string | undefined {
      return (
        (params.target as string | undefined) ??
        actionCtx.focusedAgent ??
        (ctx.state.get("claude-code", "active_agent") as string | undefined)
      );
    }

    function getSessions(target: string | undefined): Session[] {
      if (!target) {
        // Union across every agent we have state for. Rare (multi-agent decks).
        const all: Session[] = [];
        // We don't have an enumerate API, but we can try a few well-known ones
        // via focusedAgent path; for now, just bail.
        return all;
      }
      const s = ctx.state.get("claude-code", `agent:${target}:sessions`);
      return Array.isArray(s) ? (s as Session[]) : [];
    }

    function getRecentSession(
      target: string | undefined,
      index: number,
    ): Session | undefined {
      const sessions = getSessions(target)
        .filter((s) => s.state !== "STALE")
        .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      return sessions[index];
    }

    function findSession(
      target: string | undefined,
      params: {
        session_id?: string;
        project_basename?: string;
      },
    ): Session | undefined {
      const sessions = getSessions(target);
      if (params.session_id) {
        return sessions.find((s) => s.sessionId === params.session_id);
      }
      if (params.project_basename) {
        const base = params.project_basename.toLowerCase();
        const match = sessions
          .filter((s) => s.cwd.toLowerCase().split("/").pop() === base)
          .sort((a, b) => {
            // Prefer active states, then recency.
            const prio = (st: SessionState) =>
              ({ ASKING: 0, WORKING: 1, IDLE: 2, DONE: 3, STALE: 4 })[st];
            const p = prio(a.state) - prio(b.state);
            return p !== 0 ? p : b.lastActivityMs - a.lastActivityMs;
          });
        return match[0];
      }
      return undefined;
    }

    // ── Action: focus ─────────────────────────────────────────────────────
    ctx.registerAction({
      id: "focus",
      name: "Focus session",
      description: "Switch to the terminal tab running the given Claude Code session.",
      icon: "ms:terminal",
      paramsSchema: focusSchema,
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, actionCtx);
        if (!target) {
          ctx.log.warn("claude-code.focus: no target agent");
          return;
        }
        ctx.state.set("claude-code", `pending:${target}:focus`, {
          params: {
            session_id: p.session_id,
            cwd: p.cwd,
          },
          timestamp: Date.now(),
        });
      },
    });

    // ── Action: focus_recent ──────────────────────────────────────────────
    ctx.registerAction({
      id: "focus_recent",
      name: "Focus recent session",
      description: "Focus the Nth most recently active Claude Code session.",
      icon: "ms:terminal",
      paramsSchema: recentSessionSchema,
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, actionCtx);
        if (!target) {
          ctx.log.warn("claude-code.focus_recent: no target agent");
          return;
        }
        const session = getRecentSession(target, p.index as number);
        if (!session) {
          ctx.log.debug({ index: p.index }, "focus_recent: no session in slot");
          return;
        }
        ctx.state.set("claude-code", `pending:${target}:focus`, {
          params: { session_id: session.sessionId, cwd: session.cwd },
          timestamp: Date.now(),
        });
      },
    });

    // ── State provider: recent session by index ───────────────────────────
    ctx.registerStateProvider({
      id: "recent_session",
      name: "Claude Code recent session",
      description:
        "Nth most recently active Claude Code session (0 = most recent).",
      icon: "ms:terminal",
      paramsSchema: recentSessionSchema,
      providesIcon: true,
      templateVariables: [
        { key: "state", label: "Session state", example: "WORKING" },
        { key: "project", label: "Project basename", example: "OmniDeck" },
        { key: "cwd", label: "Working directory", example: "/Users/you/code/OmniDeck" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target =
          (p.target as string | undefined) ??
          (ctx.state.get("claude-code", "active_agent") as string | undefined);
        const session = getRecentSession(target, p.index as number);

        if (!session) {
          return {
            state: { iconColor: DIM, label: "—", opacity: 0.4 },
            variables: { state: "NONE", project: "", cwd: "" },
          };
        }

        const visuals = stateVisuals(session.state);
        return {
          state: { ...visuals, label: shortLabel(session.cwd) },
          variables: {
            state: session.state,
            project: session.cwd.split("/").pop() ?? "",
            cwd: session.cwd,
          },
        };
      },
    });

    // ── State provider: per-session button visuals ────────────────────────
    ctx.registerStateProvider({
      id: "session",
      name: "Claude Code session",
      description: "Color-coded state for a specific Claude Code session.",
      icon: "ms:terminal",
      paramsSchema: sessionStateSchema,
      providesIcon: true,
      templateVariables: [
        { key: "state", label: "Session state", example: "WORKING" },
        { key: "project", label: "Project basename", example: "OmniDeck" },
        { key: "cwd", label: "Working directory", example: "/Users/you/code/OmniDeck" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        // PluginContext.state doesn't give us focused agent from inside resolve,
        // so we fall back to `active_agent` state key or explicit `target`.
        const target =
          (p.target as string | undefined) ??
          (ctx.state.get("claude-code", "active_agent") as string | undefined);
        const session = findSession(target, {
          session_id: p.session_id as string | undefined,
          project_basename: p.project_basename as string | undefined,
        });

        if (!session) {
          return {
            state: {
              iconColor: DIM,
              label: (p.project_basename as string | undefined) ?? "—",
              opacity: 0.4,
            },
            variables: {
              state: "NONE",
              project: (p.project_basename as string | undefined) ?? "",
              cwd: "",
            },
          };
        }

        const visuals = stateVisuals(session.state);
        return {
          state: {
            ...visuals,
            label: shortLabel(session.cwd),
          },
          variables: {
            state: session.state,
            project: session.cwd.split("/").pop() ?? "",
            cwd: session.cwd,
          },
        };
      },
    });

    // ── Preset: manual pin ────────────────────────────────────────────────
    ctx.registerPreset({
      id: "session_button",
      name: "Claude Code Session",
      description: "Pin a button to a specific Claude Code session or project.",
      category: "Developer",
      icon: "ms:terminal",
      action: "focus",
      stateProvider: "session",
      defaults: {
        icon: "ms:terminal",
        label: "{{project}}",
        background: "#0f172a",
      },
    });

    // ── Preset: recent-session slot ───────────────────────────────────────
    ctx.registerPreset({
      id: "recent_session_button",
      name: "Claude Code Recent Session",
      description:
        "Auto-populated slot showing the Nth most recently active session (0 = most recent).",
      category: "Developer",
      icon: "ms:terminal",
      action: "focus_recent",
      stateProvider: "recent_session",
      defaults: {
        icon: "ms:terminal",
        label: "{{project}}",
        background: "#0f172a",
      },
    });

    // ── Page provider: auto-populated Sessions page ──────────────────────
    ctx.registerPageProvider("sessions", () => {
      const target =
        (ctx.state.get("claude-code", "active_agent") as string | undefined) ??
        undefined;

      // Gather sessions from the focused / active agent.
      let sessions: Session[] = [];
      if (target) {
        sessions = getSessions(target);
      } else {
        // No known target — attempt to aggregate across any agents that have
        // pushed state. We approximate by scanning a handful of known keys.
        // Since there's no enumerate API, this is a no-op when we don't know
        // the target. The focused-agent case covers the common setup.
      }

      // Hide STALE on the auto-page (kept visible only for manual pins).
      const visible = sessions
        .filter((s) => s.state !== "STALE")
        .sort((a, b) => {
          const prio = (st: SessionState) =>
            ({ ASKING: 0, WORKING: 1, IDLE: 2, DONE: 3, STALE: 4 })[st];
          const p = prio(a.state) - prio(b.state);
          return p !== 0 ? p : b.lastActivityMs - a.lastActivityMs;
        })
        .slice(0, 14); // leave room for a Back button on a 3x5 deck

      const buttons: Array<Record<string, unknown>> = visible.map((s, i) => {
        const v = stateVisuals(s.state);
        return {
          pos: [i % 5, Math.floor(i / 5)],
          action: "focus",
          params: { session_id: s.sessionId, target },
          icon: "ms:terminal",
          icon_color: v.iconColor,
          label: shortLabel(s.cwd),
          ...(v.badge ? { badge: v.badge, badge_color: v.badgeColor } : {}),
          ...(v.opacity ? { opacity: v.opacity } : {}),
        };
      });

      buttons.push({
        pos: [4, 2],
        action: "omnideck-core.go_back",
        icon: "ms:arrow-back",
        label: "Back",
      });

      return {
        page: "claude-code.sessions",
        name: "Claude Code Sessions",
        buttons,
      };
    });

    // Note: `active_agent` is maintained automatically by the hub via the
    // agent's `omnideck.setActive(true)` calls. No extra wiring needed.

    ctx.log.info("claude-code plugin loaded");
  },

  async destroy() {
    // Nothing to clean up — all state is held by the hub store and will be
    // discarded on unload. Intervals registered via ctx.setInterval are
    // cleared by the host.
  },
};

export default claudeCodePlugin;
