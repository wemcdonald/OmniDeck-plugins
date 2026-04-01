// plugins/google-meet/hub.ts

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

interface GoogleMeetState {
  extensionConnected: boolean;
  inCall: boolean;
  muted: boolean | null;
  videoOff: boolean | null;
  handRaised: boolean | null;
  captionsOn: boolean | null;
}

const targetParam = {
  target: field(z.string().optional(), { label: "Target", fieldType: "agent" as const }),
};

const targetOnlySchema = z.object(targetParam);

export const googleMeetPlugin: OmniDeckPlugin = {
  id: "google-meet",
  name: "Google Meet",
  version: "1.0.0",
  icon: "ms:videocam",

  async init(ctx: PluginContext) {
    function resolveTarget(params: Record<string, unknown>, actionCtx: { focusedAgent?: string }) {
      return (params.target as string | undefined)
        ?? actionCtx.focusedAgent
        ?? (ctx.state.get("google-meet", "active_agent") as string | undefined);
    }

    function getMeetState(target: string | undefined): GoogleMeetState | undefined {
      if (!target) return undefined;
      return ctx.state.get("google-meet", `agent:${target}:meeting`) as GoogleMeetState | undefined;
    }

    // ── Actions ──────────────────────────────────────────────────────────

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
          ctx.state.set("google-meet", `pending:${target}:${id}`, {
            params,
            timestamp: Date.now(),
          });
        },
      });
    }

    registerAgentAction("toggle_mute", "Toggle Mute", "Mute or unmute your microphone", "ms:mic");
    registerAgentAction("toggle_video", "Toggle Video", "Turn your camera on or off", "ms:videocam");
    registerAgentAction("toggle_hand", "Raise Hand", "Raise or lower your virtual hand", "ms:back-hand");
    registerAgentAction("toggle_captions", "Toggle Captions", "Turn captions on or off", "ms:closed-caption");
    registerAgentAction("leave", "Leave Call", "Leave the current call", "ms:call-end");
    registerAgentAction("toggle_chat", "Toggle Chat", "Open or close the chat panel", "ms:chat");
    registerAgentAction("emoji_react", "Emoji React", "Send an emoji reaction", "ms:add-reaction", {
      emoji: field(z.string().optional(), { label: "Emoji", placeholder: "thumbsup" }),
    });

    // ── State Provider: connection status ────────────────────────────────

    ctx.registerStateProvider({
      id: "connection_status",
      name: "Connection Status",
      description: "Whether the Chrome extension is connected and in a call",
      icon: "ms:videocam",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "status", label: "Status", example: "In Call" },
        { key: "in_call", label: "In Call", example: "true" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet || !meet.extensionConnected) {
          return {
            state: { icon: "ms:videocam-off", label: "Disconnected", iconColor: "#6b7280" },
            variables: { status: "Disconnected", in_call: "false" },
          };
        }
        if (!meet.inCall) {
          return {
            state: { icon: "ms:videocam", label: "Connected", iconColor: "#9ca3af" },
            variables: { status: "Connected", in_call: "false" },
          };
        }
        return {
          state: { icon: "ms:videocam", label: "In Call", iconColor: "#22c55e" },
          variables: { status: "In Call", in_call: "true" },
        };
      },
    });

    // ── State Provider: mute status ─────────────────────────────────────

    ctx.registerStateProvider({
      id: "mute_status",
      name: "Mute Status",
      description: "Whether your microphone is muted",
      icon: "ms:mic",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "mute_state", label: "Mute State", example: "Muted" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet?.inCall) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#6b7280" },
            variables: { mute_state: "" },
          };
        }
        if (meet.muted === true) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#ef4444", background: "#451a1a" },
            variables: { mute_state: "Muted" },
          };
        }
        if (meet.muted === false) {
          return {
            state: { icon: "ms:mic", iconColor: "#22c55e" },
            variables: { mute_state: "Unmuted" },
          };
        }
        return {
          state: { icon: "ms:mic" },
          variables: { mute_state: "" },
        };
      },
    });

    // ── State Provider: video status ────────────────────────────────────

    ctx.registerStateProvider({
      id: "video_status",
      name: "Video Status",
      description: "Whether your camera is on",
      icon: "ms:videocam",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "video_state", label: "Video State", example: "On" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet?.inCall) {
          return {
            state: { icon: "ms:videocam-off", iconColor: "#6b7280" },
            variables: { video_state: "" },
          };
        }
        if (meet.videoOff === true) {
          return {
            state: { icon: "ms:videocam-off", iconColor: "#ef4444", background: "#451a1a" },
            variables: { video_state: "Off" },
          };
        }
        if (meet.videoOff === false) {
          return {
            state: { icon: "ms:videocam", iconColor: "#22c55e" },
            variables: { video_state: "On" },
          };
        }
        return {
          state: { icon: "ms:videocam" },
          variables: { video_state: "" },
        };
      },
    });

    // ── State Provider: hand status ─────────────────────────────────────

    ctx.registerStateProvider({
      id: "hand_status",
      name: "Hand Status",
      description: "Whether your hand is raised",
      icon: "ms:back-hand",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "hand_state", label: "Hand State", example: "Raised" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet?.inCall) {
          return {
            state: { icon: "ms:back-hand", iconColor: "#6b7280" },
            variables: { hand_state: "" },
          };
        }
        if (meet.handRaised === true) {
          return {
            state: { icon: "ms:back-hand", iconColor: "#f59e0b", background: "#451a1a" },
            variables: { hand_state: "Raised" },
          };
        }
        return {
          state: { icon: "ms:back-hand" },
          variables: { hand_state: "" },
        };
      },
    });

    // ── State Provider: captions status ─────────────────────────────────

    ctx.registerStateProvider({
      id: "captions_status",
      name: "Captions Status",
      description: "Whether captions are on",
      icon: "ms:closed-caption",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "captions_state", label: "Captions State", example: "On" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet?.inCall) {
          return {
            state: { icon: "ms:closed-caption-disabled", iconColor: "#6b7280" },
            variables: { captions_state: "" },
          };
        }
        if (meet.captionsOn === true) {
          return {
            state: { icon: "ms:closed-caption", iconColor: "#3b82f6", background: "#1e293b" },
            variables: { captions_state: "On" },
          };
        }
        return {
          state: { icon: "ms:closed-caption" },
          variables: { captions_state: "" },
        };
      },
    });

    // ── State Provider: meeting status (for action-only presets) ─────────

    ctx.registerStateProvider({
      id: "meeting_status",
      name: "Meeting Status",
      description: "Simple meeting status for action-only buttons",
      icon: "ms:videocam",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "status", label: "Status", example: "In Call" },
        { key: "in_call", label: "In Call", example: "true" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meet = getMeetState(target);

        if (!meet?.extensionConnected) {
          return {
            state: { iconColor: "#6b7280" },
            variables: { status: "Disconnected", in_call: "false" },
          };
        }
        if (!meet.inCall) {
          return {
            state: { opacity: 0.6 },
            variables: { status: "Connected", in_call: "false" },
          };
        }
        return {
          state: {},
          variables: { status: "In Call", in_call: "true" },
        };
      },
    });

    // ── Presets ───────────────────────────────────────────────────────────

    ctx.registerPreset({
      id: "mute",
      name: "Mute",
      description: "Toggle microphone mute/unmute",
      category: "Meeting",
      icon: "ms:mic",
      action: "toggle_mute",
      stateProvider: "mute_status",
      defaults: {
        icon: "ms:mic",
        label: "{{mute_state}}",
      },
    });

    ctx.registerPreset({
      id: "video",
      name: "Video",
      description: "Toggle camera on/off",
      category: "Meeting",
      icon: "ms:videocam",
      action: "toggle_video",
      stateProvider: "video_status",
      defaults: {
        icon: "ms:videocam",
        label: "{{video_state}}",
      },
    });

    ctx.registerPreset({
      id: "raise_hand",
      name: "Raise Hand",
      description: "Raise or lower your virtual hand",
      category: "Meeting",
      icon: "ms:back-hand",
      action: "toggle_hand",
      stateProvider: "hand_status",
      defaults: {
        icon: "ms:back-hand",
        label: "{{hand_state}}",
      },
    });

    ctx.registerPreset({
      id: "captions",
      name: "Captions",
      description: "Turn captions on or off",
      category: "Meeting",
      icon: "ms:closed-caption",
      action: "toggle_captions",
      stateProvider: "captions_status",
      defaults: {
        icon: "ms:closed-caption",
        label: "{{captions_state}}",
      },
    });

    ctx.registerPreset({
      id: "leave",
      name: "Leave",
      description: "Leave the current call",
      category: "Meeting",
      icon: "ms:call-end",
      action: "leave",
      stateProvider: "meeting_status",
      defaults: {
        icon: "ms:call-end",
        label: "Leave",
        iconColor: "#ef4444",
      },
    });

    ctx.registerPreset({
      id: "chat",
      name: "Chat",
      description: "Toggle the chat panel",
      category: "Meeting",
      icon: "ms:chat",
      action: "toggle_chat",
      stateProvider: "meeting_status",
      defaults: {
        icon: "ms:chat",
        label: "Chat",
      },
    });

    ctx.registerPreset({
      id: "react",
      name: "React",
      description: "Send an emoji reaction",
      category: "Meeting",
      icon: "ms:add-reaction",
      action: "emoji_react",
      stateProvider: "meeting_status",
      defaults: {
        icon: "ms:add-reaction",
        label: "React",
      },
    });

    // ── Scaffold emoji page ──────────────────────────────────────────────

    const EMOJIS = [
      { emoji: "\u{1F496}", label: "Heart" },
      { emoji: "\u{1F44D}", label: "Thumbs Up" },
      { emoji: "\u{1F389}", label: "Party" },
      { emoji: "\u{1F44F}", label: "Clap" },
      { emoji: "\u{1F602}", label: "Haha" },
      { emoji: "\u{1F62E}", label: "Wow" },
      { emoji: "\u{1F622}", label: "Sad" },
      { emoji: "\u{1F914}", label: "Thinking" },
      { emoji: "\u{1F44E}", label: "Thumbs Down" },
    ];

    const emojiButtons = EMOJIS.map((e, i) => ({
      pos: [i % 5, Math.floor(i / 5)],
      action: "omnideck-core.multi_action",
      params: {
        mode: "sequential",
        actions: [
          { action: "google-meet.emoji_react", params: { emoji: e.emoji } },
          { action: "omnideck-core.go_back" },
        ],
      },
      icon: e.emoji,
    }));

    ctx.scaffoldPage("meet-emoji", {
      page: "meet-emoji",
      name: "Meet Emoji",
      buttons: emojiButtons,
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
