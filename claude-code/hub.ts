// plugins/claude-code/hub.ts
// Hub-side plugin: config schema, actions, state providers, presets, and the
// dynamic Sessions page. Reads session state pushed by the agent and renders
// color-coded buttons.

import { z } from "zod";
import sharp from "sharp";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

// Claude mark (Simple Icons, CC0). Inlined because the plugin bundler does not
// ship the assets/ dir; rasterized once per state color at init.
const CLAUDE_SVG = `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Claude</title><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>`;

async function renderClaudeIcon(fill: string, size: number): Promise<Buffer> {
  const tinted = CLAUDE_SVG.replace("<path ", `<path fill="${fill}" `);
  return sharp(Buffer.from(tinted), { density: 400 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// ── Colors ──────────────────────────────────────────────────────────────────
const ORANGE = "#ff8c00"; // WORKING
const BLUE = "#3b82f6"; // ASKING
const GREEN = "#22c55e"; // DONE (running, waiting at prompt)
const DIM = "#475569"; // STALE (exited or long-idle)
const WHITE = "#ffffff";

// ── Types (mirror of agent.ts; duplicated to avoid cross-file import) ──────
type SessionState = "WORKING" | "ASKING" | "DONE" | "STALE";

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
  stale_timeout_ms: field(z.number().min(60_000).default(86_400_000), {
    label: "Stale timeout (ms)",
    description:
      "Safety net for abruptly-killed sessions. If a session never wrote its exit marker and has had no activity for this long, treat it as STALE. Default 24h.",
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
    // ── Pre-rendered Claude icon, tinted per state color ──────────────────
    // Done at init (async) so state providers can return Buffers synchronously.
    const claudeIcons = new Map<string, Buffer>();
    try {
      for (const color of [ORANGE, BLUE, GREEN, DIM, WHITE]) {
        claudeIcons.set(color, await renderClaudeIcon(color, 144));
      }
    } catch (err) {
      ctx.log.warn({ err: String(err) }, "Failed to pre-render Claude icons; falling back to ms:terminal");
    }
    function claudeIconFor(color: string): Buffer | string {
      return claudeIcons.get(color) ?? "ms:terminal";
    }

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

    function collectAllSessions(target: string | undefined): Session[] {
      if (target) return getSessions(target);
      // No target — aggregate across every agent that has pushed sessions.
      const all: Session[] = [];
      const store = ctx.state.getAll("claude-code");
      for (const [key, value] of store) {
        if (typeof key !== "string" || !key.startsWith("agent:") || !key.endsWith(":sessions")) continue;
        if (Array.isArray(value)) all.push(...(value as Session[]));
      }
      return all;
    }

    function getRecentSession(
      target: string | undefined,
      index: number,
    ): Session | undefined {
      // Deduplicate by project basename — keep the most recent session per project.
      const byProject = new Map<string, Session>();
      for (const s of collectAllSessions(target)) {
        const key = s.cwd.split("/").pop() || s.cwd;
        const existing = byProject.get(key);
        if (!existing || s.lastActivityMs > existing.lastActivityMs) {
          byProject.set(key, s);
        }
      }
      const sessions = Array.from(byProject.values()).sort(
        (a, b) => b.lastActivityMs - a.lastActivityMs,
      );
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
              ({ ASKING: 0, WORKING: 1, DONE: 2, STALE: 3 })[st];
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
            state: { iconColor: DIM, icon: claudeIconFor(DIM), label: "—" },
            variables: { state: "NONE", project: "", cwd: "" },
          };
        }

        // Drop opacity for slot tiles — STALE just means "not currently live",
        // but the user asked for the most-recent projects and wants them readable.
        const { opacity: _opacity, ...visuals } = stateVisuals(session.state);
        const project = session.cwd.split("/").pop() ?? "";
        return {
          state: {
            ...visuals,
            icon: claudeIconFor(visuals.iconColor),
            label: project,
            scrollLabel: true,
          },
          variables: {
            state: session.state,
            project,
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
            ({ ASKING: 0, WORKING: 1, DONE: 2, STALE: 3 })[st];
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
