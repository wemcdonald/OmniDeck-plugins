// plugins/discord/hub.ts
// State providers, actions, presets, and dynamic pages for Discord integration.

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

interface DiscordState {
  connected: boolean;
  authenticated: boolean;
  muted: boolean;
  deafened: boolean;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
  guildId: string | null;
  voiceMode: string;
  voiceUsers: Array<{ id: string; username: string; volume: number; mute: boolean }>;
  username: string;
  pttActive: boolean;
}

const targetParam = {
  target: field(z.string().optional(), { label: "Target", fieldType: "agent" as const }),
};

const targetOnlySchema = z.object(targetParam);

const voiceChannelParams = z.object({
  ...targetParam,
  channel_id: field(z.string(), { label: "Channel ID", placeholder: "Discord voice channel snowflake ID" }),
});

const textChannelParams = z.object({
  ...targetParam,
  guild_id: field(z.string(), { label: "Server ID", placeholder: "Discord server snowflake ID" }),
  channel_id: field(z.string(), { label: "Channel ID", placeholder: "Discord text channel snowflake ID" }),
});

const dndDurationParams = z.object({
  ...targetParam,
  duration: field(z.number().default(60), { label: "Snooze Duration (minutes)" }),
});

const discordConfigSchema = z.object({
  client_id: field(z.string().min(1), { label: "Client ID" }),
  client_secret: field(z.string().min(1), { label: "Client Secret", secret: true }),
});

export const discordPlugin: OmniDeckPlugin = {
  id: "discord",
  name: "Discord",
  version: "1.0.0",
  icon: "ms:headset-mic",
  configSchema: discordConfigSchema,

  async init(ctx: PluginContext) {
    // ── Required-config guard ──────────────────────────────────────────────
    const cfgResult = discordConfigSchema.safeParse(ctx.config ?? {});
    if (!cfgResult.success) {
      ctx.setHealth({
        status: "misconfigured",
        message: "client_id and client_secret are required. Configure them in the plugin settings.",
      });
      return;
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    function resolveTarget(params: Record<string, unknown>, actionCtx: { focusedAgent?: string }) {
      // Prefer explicit target > focused agent > last active agent from state store
      return (params.target as string | undefined)
        ?? actionCtx.focusedAgent
        ?? (ctx.state.get("discord", "active_agent") as string | undefined);
    }

    function getState(target: string | undefined): DiscordState | undefined {
      if (!target) return undefined;
      return ctx.state.get("discord", `agent:${target}:discord`) as DiscordState | undefined;
    }

    function registerAgentAction(
      id: string,
      name: string,
      description: string,
      icon: string,
      extraParams?: Record<string, z.ZodType>,
    ) {
      const schema = extraParams
        ? z.object({ ...targetParam, ...extraParams })
        : targetOnlySchema;

      ctx.registerAction({
        id,
        name,
        description,
        icon,
        paramsSchema: schema,
        async execute(params, actionCtx) {
          const p = params as Record<string, unknown>;
          const target = resolveTarget(p, actionCtx);
          ctx.state.set("discord", `pending:${target}:${id}`, {
            params,
            timestamp: Date.now(),
          });
        },
      });
    }

    // ── Actions ────────────────────────────────────────────────────────────

    registerAgentAction("toggle_mute", "Toggle Mute", "Mute or unmute your microphone", "ms:mic");
    registerAgentAction("toggle_deafen", "Toggle Deafen", "Toggle deafen on or off", "ms:hearing");
    registerAgentAction("toggle_video", "Toggle Video", "Turn camera on or off", "ms:videocam");
    registerAgentAction("toggle_stream", "Toggle Stream", "Start or stop screenshare", "ms:screen-share");
    registerAgentAction("toggle_ptt_mode", "Toggle PTT Mode", "Switch between Voice Activity and Push to Talk", "ms:keyboard-voice");
    registerAgentAction("leave_voice", "Leave Voice", "Leave the current voice channel", "ms:call-end");
    registerAgentAction("ptt_start", "PTT Start", "Unmute microphone (hold-to-talk press)", "ms:mic");
    registerAgentAction("ptt_stop", "PTT Stop", "Mute microphone (hold-to-talk release)", "ms:mic-off");

    ctx.registerAction({
      id: "join_voice",
      name: "Join Voice",
      description: "Join a specific voice channel",
      icon: "ms:spatial-audio",
      paramsSchema: voiceChannelParams,
      async execute(params, actionCtx) {
        const p = voiceChannelParams.parse(params);
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("discord", `pending:${target}:join_voice`, {
          params: { channel_id: p.channel_id },
          timestamp: Date.now(),
        });
      },
    });

    ctx.registerAction({
      id: "open_text",
      name: "Open Text Channel",
      description: "Open a text channel in Discord",
      icon: "ms:chat",
      paramsSchema: textChannelParams,
      async execute(params, actionCtx) {
        const p = textChannelParams.parse(params);
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("discord", `pending:${target}:open_text`, {
          params: { guild_id: p.guild_id, channel_id: p.channel_id },
          timestamp: Date.now(),
        });
      },
    });

    ctx.registerAction({
      id: "open_user_mixer",
      name: "User Mixer",
      description: "Open per-user volume control page",
      icon: "ms:tune",
      paramsSchema: targetOnlySchema,
      async execute() {
        ctx.state.set("omnideck-core", "current_page", "discord.voice_users");
      },
    });

    ctx.registerAction({
      id: "select_user_volume",
      name: "Select User Volume",
      description: "Open volume control for a specific user",
      icon: "ms:person",
      paramsSchema: z.object({ user_id: z.string() }),
      async execute(params) {
        const p = params as { user_id: string };
        ctx.state.set("discord", "selected_user", p.user_id);
        ctx.state.set("omnideck-core", "current_page", "discord.user_volume");
      },
    });

    ctx.registerAction({
      id: "adjust_user",
      name: "Adjust User Volume",
      description: "Adjust a user's volume by a delta",
      icon: "ms:tune",
      paramsSchema: z.object({
        ...targetParam,
        user_id: z.string(),
        delta: z.number(),
      }),
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("discord", `pending:${target}:adjust_user`, {
          params: { user_id: p.user_id, delta: p.delta },
          timestamp: Date.now(),
        });
      },
    });

    ctx.registerAction({
      id: "mute_user",
      name: "Mute User",
      description: "Toggle local mute for a specific user",
      icon: "ms:person",
      paramsSchema: z.object({
        ...targetParam,
        user_id: z.string(),
        mute: z.boolean(),
      }),
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("discord", `pending:${target}:mute_user`, {
          params: { user_id: p.user_id, mute: p.mute },
          timestamp: Date.now(),
        });
      },
    });

    // ── State Providers ────────────────────────────────────────────────────

    ctx.registerStateProvider({
      id: "voice_status",
      name: "Voice Status",
      description: "Current voice channel connection",
      icon: "ms:headset-mic",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "channel", label: "Channel", example: "General" },
        { key: "guild", label: "Server", example: "My Server" },
        { key: "status", label: "Status", example: "In Voice" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected) {
          return {
            state: { icon: "ms:headset-off", iconColor: "#4b5563" },
            variables: { channel: "", guild: "", status: "Disconnected" },
          };
        }
        if (!s.voiceChannelId) {
          return {
            state: { icon: "ms:headset-mic", iconColor: "#9ca3af" },
            variables: { channel: "", guild: "", status: "Not in voice" },
          };
        }
        return {
          state: { icon: "ms:headset-mic", iconColor: "#22c55e" },
          variables: {
            channel: s.voiceChannelName ?? "",
            guild: "",
            status: s.voiceChannelName ?? "In Voice",
          },
        };
      },
    });

    // voice_connection — like voice_status but does NOT override the button icon.
    // Used for buttons that have their own fixed icon (PTT, Leave, Mixer, Text).
    ctx.registerStateProvider({
      id: "voice_connection",
      name: "Voice Connection",
      description: "Dims button when not connected; provides channel name. Does not override icon.",
      icon: "ms:spatial-audio",
      providesIcon: false,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "channel", label: "Channel", example: "General" },
        { key: "status", label: "Status", example: "In Voice" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected) {
          return {
            state: { iconColor: "#4b5563" },
            variables: { channel: "", status: "Disconnected" },
          };
        }
        if (!s.voiceChannelId) {
          return {
            state: { iconColor: "#9ca3af" },
            variables: { channel: "", status: "Not in voice" },
          };
        }
        return {
          state: { iconColor: "#ffffff" },
          variables: { channel: s.voiceChannelName ?? "", status: s.voiceChannelName ?? "In Voice" },
        };
      },
    });

    ctx.registerStateProvider({
      id: "mute_status",
      name: "Mute Status",
      description: "Microphone mute state",
      icon: "ms:mic",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "mute_state", label: "Mute State", example: "Muted" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#4b5563" },
            variables: { mute_state: "" },
          };
        }
        if (s.muted) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#ef4444", background: "#451a1a" },
            variables: { mute_state: "Muted" },
          };
        }
        return {
          state: { icon: "ms:mic", iconColor: "#22c55e" },
          variables: { mute_state: "Unmuted" },
        };
      },
    });

    ctx.registerStateProvider({
      id: "deafen_status",
      name: "Deafen Status",
      description: "Audio output deafen state",
      icon: "ms:headphones",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "deafen_state", label: "Deafen State", example: "Deafened" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected) {
          return {
            state: { icon: "ms:hearing", iconColor: "#4b5563" },
            variables: { deafen_state: "Undeafened" },
          };
        }
        if (s.deafened) {
          return {
            state: { icon: "ms:hearing-disabled", iconColor: "#ef4444", background: "#451a1a" },
            variables: { deafen_state: "Deafened" },
          };
        }
        return {
          state: { icon: "ms:hearing", iconColor: "#22c55e" },
          variables: { deafen_state: "Undeafened" },
        };
      },
    });

    ctx.registerStateProvider({
      id: "video_status",
      name: "Video Status",
      description: "Camera on/off state",
      icon: "ms:videocam",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "video_state", label: "Video State", example: "On" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected || !s.voiceChannelId) {
          return {
            state: { icon: "ms:videocam-off", iconColor: "#4b5563" },
            variables: { video_state: "" },
          };
        }
        return {
          state: { icon: "ms:videocam", iconColor: "#9ca3af" },
          variables: { video_state: "" },
        };
      },
    });

    ctx.registerStateProvider({
      id: "stream_status",
      name: "Stream Status",
      description: "Screenshare on/off state",
      icon: "ms:screen-share",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "stream_state", label: "Stream State", example: "Streaming" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected || !s.voiceChannelId) {
          return {
            state: { icon: "ms:stop-screen-share", iconColor: "#4b5563" },
            variables: { stream_state: "" },
          };
        }
        return {
          state: { icon: "ms:screen-share", iconColor: "#9ca3af" },
          variables: { stream_state: "" },
        };
      },
    });

    ctx.registerStateProvider({
      id: "ptt_status",
      name: "PTT Status",
      description: "Push-to-talk active/muted state — green when live, red when muted",
      icon: "ms:mic",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "ptt_state", label: "PTT State", example: "Live" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const s = getState(target);

        if (!s?.connected || !s.voiceChannelId) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#4b5563" },
            variables: { ptt_state: "" },
          };
        }
        if (!s.muted) {
          return {
            state: { icon: "ms:mic", iconColor: "#22c55e", background: "#052e16" },
            variables: { ptt_state: "Live" },
          };
        }
        return {
          state: { icon: "ms:mic-off", iconColor: "#ef4444", background: "#451a1a" },
          variables: { ptt_state: "Muted" },
        };
      },
    });

    // State provider for user volume level (used by dynamic volume page)
    ctx.registerStateProvider({
      id: "user_volume",
      name: "User Volume",
      icon: "ms:volume-up",
      providesIcon: true,
      paramsSchema: z.object({ user_id: z.string().optional() }),
      templateVariables: [
        { key: "level", label: "Volume", example: "100%" },
        { key: "username", label: "Username", example: "User" },
      ],
      resolve(params) {
        const p = params as { user_id?: string };
        const userId = p.user_id ?? (ctx.state.get("discord", "selected_user") as string);
        const target = ctx.state.get("discord", "active_agent") as string | undefined;
        const s = target ? getState(target) : undefined;
        const user = s?.voiceUsers.find((u) => u.id === userId);

        if (!user) {
          return {
            state: { icon: "ms:volume-up", iconColor: "#6b7280" },
            variables: { level: "?", username: "?" },
          };
        }

        return {
          state: { icon: "ms:volume-up", iconColor: "#ffffff" },
          variables: {
            level: `${Math.round(user.volume)}%`,
            username: user.username,
          },
        };
      },
    });

    // ── Dynamic Pages ──────────────────────────────────────────────────────

    // Voice Users page — lists all users in current voice channel
    ctx.registerPageProvider("voice_users", () => {
      const target = ctx.state.get("discord", "active_agent") as string | undefined;
      const s = target ? getState(target) : undefined;
      const users = s?.voiceUsers ?? [];

      const buttons: Array<Record<string, unknown>> = users.slice(0, 14).map((user, i) => ({
        pos: [i % 5, Math.floor(i / 5)],
        action: "discord.select_user_volume",
        params: { user_id: user.id },
        long_press_action: "discord.mute_user",
        long_press_params: { user_id: user.id, mute: !user.mute },
        icon: "ms:person",
        icon_color: user.mute ? "#ef4444" : "#22c55e",
        label: user.username.length > 10 ? user.username.slice(0, 9) + "…" : user.username,
      }));

      buttons.push({
        pos: [4, 2],
        action: "omnideck-core.go_back",
        icon: "ms:arrow-back",
        label: "Back",
      });

      return { page: "discord.voice_users", name: "Voice Users", buttons };
    });

    // User Volume page — mic/vol controls for selected user
    ctx.registerPageProvider("user_volume", () => {
      const userId = ctx.state.get("discord", "selected_user") as string;
      const target = ctx.state.get("discord", "active_agent") as string | undefined;
      const s = target ? getState(target) : undefined;
      const user = s?.voiceUsers.find((u) => u.id === userId);
      const username = user?.username ?? "User";
      const vol = user?.volume ?? 100;
      const isMuted = user?.mute ?? false;

      const buttons: Array<Record<string, unknown>> = [
        // Volume % above user name
        { pos: [2, 0], icon: "ms:volume-up", label: `${Math.round(vol)}%` },

        // User name / mute toggle — red if muted, green if unmuted
        {
          pos: [2, 1],
          action: "discord.mute_user",
          params: { user_id: userId, mute: !isMuted },
          icon: "ms:person",
          icon_color: isMuted ? "#ef4444" : "#22c55e",
          label: username,
        },

        // Fine controls (col 1)
        { pos: [1, 0], action: "discord.adjust_user", params: { user_id: userId, delta: 5 }, icon: "ms:add", label: "" },
        { pos: [1, 1], icon: "ms:tune", label: "Fine" },
        { pos: [1, 2], action: "discord.adjust_user", params: { user_id: userId, delta: -5 }, icon: "ms:remove", label: "" },

        // Coarse controls (col 3)
        { pos: [3, 0], action: "discord.adjust_user", params: { user_id: userId, delta: 20 }, icon: "ms:add", label: "" },
        { pos: [3, 1], icon: "ms:tune", label: "Coarse" },
        { pos: [3, 2], action: "discord.adjust_user", params: { user_id: userId, delta: -20 }, icon: "ms:remove", label: "" },

        // Back
        { pos: [4, 2], action: "omnideck-core.go_back", icon: "ms:arrow-back", label: "Back" },
      ];

      return { page: "discord.user_volume", name: `${username} Volume`, buttons };
    });

    // ── Presets ─────────────────────────────────────────────────────────────

    ctx.registerPreset({
      id: "mute",
      name: "Mute",
      description: "Toggle microphone mute",
      category: "Voice",
      icon: "ms:mic",
      action: "toggle_mute",
      stateProvider: "mute_status",
      defaults: { icon: "ms:mic", label: "{{mute_state}}" },
    });

    ctx.registerPreset({
      id: "deafen",
      name: "Deafen",
      description: "Toggle audio deafen",
      category: "Voice",
      icon: "ms:hearing",
      action: "toggle_deafen",
      stateProvider: "deafen_status",
      defaults: { icon: "ms:hearing", label: "{{deafen_state}}" },
    });

    ctx.registerPreset({
      id: "voice_channel",
      name: "Voice Channel",
      description: "Join a voice channel",
      category: "Voice",
      icon: "ms:spatial-audio",
      action: "join_voice",
      stateProvider: "voice_connection",
      defaults: { icon: "ms:spatial-audio", label: "{{status}}" },
    });

    ctx.registerPreset({
      id: "leave_voice",
      name: "Leave Voice",
      description: "Leave the current voice channel",
      category: "Voice",
      icon: "ms:call-end",
      action: "leave_voice",
      stateProvider: "voice_connection",
      defaults: { icon: "ms:call-end", label: "Leave", iconColor: "#ef4444" },
    });

    ctx.registerPreset({
      id: "text_channel",
      name: "Text Channel",
      description: "Open a text channel in Discord",
      category: "Channels",
      icon: "ms:chat",
      action: "open_text",
      defaults: { icon: "ms:chat", label: "Text" },
    });

    ctx.registerPreset({
      id: "video",
      name: "Video",
      description: "Toggle camera",
      category: "Voice",
      icon: "ms:videocam",
      action: "toggle_video",
      stateProvider: "video_status",
      defaults: { icon: "ms:videocam", label: "{{video_state}}" },
    });

    ctx.registerPreset({
      id: "stream",
      name: "Stream",
      description: "Toggle screenshare",
      category: "Voice",
      icon: "ms:screen-share",
      action: "toggle_stream",
      stateProvider: "stream_status",
      defaults: { icon: "ms:screen-share", label: "{{stream_state}}" },
    });

    ctx.registerPreset({
      id: "ptt_mode",
      name: "PTT Mode",
      description: "Toggle Push to Talk mode",
      category: "Voice",
      icon: "ms:keyboard-voice",
      action: "toggle_ptt_mode",
      stateProvider: "voice_connection",
      defaults: { icon: "ms:keyboard-voice", label: "PTT" },
    });

    ctx.registerPreset({
      id: "ptt",
      name: "Push to Talk",
      description: "Hold to unmute, release to mute. Works with or without PTT mode enabled.",
      category: "Voice",
      icon: "ms:mic",
      pressAction: "ptt_start",
      releaseAction: "ptt_stop",
      stateProvider: "ptt_status",
      defaults: { icon: "ms:mic", label: "PTT" },
    });

    ctx.registerPreset({
      id: "user_mixer",
      name: "User Mixer",
      description: "Open per-user volume controls for the current voice channel",
      category: "Voice",
      icon: "ms:equalizer",
      action: "open_user_mixer",
      stateProvider: "voice_connection",
      defaults: { icon: "ms:equalizer", label: "Mixer" },
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
