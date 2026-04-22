// plugins/zoom/hub.ts

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";
// @ts-expect-error — bundled as text by esbuild (.svg → string)
import logoSvg from "./assets/logo.svg";

interface ZoomState {
  running: boolean;
  inMeeting: boolean;
  muted: boolean | null;
  videoOn: boolean | null;
  sharing: boolean | null;
  recording: boolean | null;
  handRaised: boolean | null;
}

const targetParam = {
  target: field(z.string().optional(), { label: "Target", fieldType: "agent" as const }),
};

const targetOnlySchema = z.object(targetParam);

export const zoomPlugin: OmniDeckPlugin = {
  id: "zoom",
  name: "Zoom",
  version: "1.0.0",
  icon: "plugin:zoom/logo",

  async init(ctx: PluginContext) {
    ctx.registerIcon("logo", logoSvg as string);

    function resolveTarget(params: Record<string, unknown>, actionCtx: { focusedAgent?: string }) {
      return (params.target as string | undefined) ?? actionCtx.focusedAgent;
    }

    function getMeetingState(target: string | undefined): ZoomState | undefined {
      if (!target) return undefined;
      return ctx.state.get("zoom", `agent:${target}:meeting`) as ZoomState | undefined;
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
          ctx.state.set("zoom", `pending:${target}:${id}`, {
            params,
            timestamp: Date.now(),
          });
        },
      });
    }

    registerAgentAction("toggle_mute", "Toggle Mute", "Mute or unmute your microphone", "ms:mic");
    registerAgentAction("toggle_video", "Toggle Video", "Turn your camera on or off", "ms:videocam");
    registerAgentAction("toggle_share", "Share Screen", "Start or stop screen sharing", "ms:screen-share");
    registerAgentAction("leave", "Leave Meeting", "Leave the current meeting", "ms:call-end");
    registerAgentAction("end", "End Meeting", "End the meeting for everyone (host only)", "ms:phone-disabled");
    registerAgentAction("toggle_hand", "Raise Hand", "Raise or lower your virtual hand", "ms:back-hand");
    registerAgentAction("react", "React", "Open the emoji reactions panel", "ms:add-reaction");
    registerAgentAction("toggle_recording", "Record", "Start or stop local recording", "ms:fiber-manual-record");

    // ── State Provider: meeting status ───────────────────────────────────

    ctx.registerStateProvider({
      id: "meeting_status",
      name: "Meeting Status",
      description: "Whether Zoom is running and in a meeting",
      icon: "ms:videocam",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "status", label: "Status", example: "In Meeting" },
        { key: "in_meeting", label: "In Meeting", example: "true" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meeting = getMeetingState(target);

        if (!meeting || !meeting.running) {
          return {
            state: { icon: "ms:videocam-off", label: "Offline", iconColor: "#6b7280" },
            variables: { status: "Offline", in_meeting: "false" },
          };
        }
        if (!meeting.inMeeting) {
          return {
            state: { icon: "ms:videocam", label: "Idle", iconColor: "#9ca3af" },
            variables: { status: "Idle", in_meeting: "false" },
          };
        }
        return {
          state: { icon: "ms:videocam", label: "In Meeting", iconColor: "#22c55e" },
          variables: { status: "In Meeting", in_meeting: "true" },
        };
      },
    });

    // ── State Provider: mute status ──────────────────────────────────────

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
        const meeting = getMeetingState(target);

        if (!meeting?.inMeeting) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#6b7280" },
            variables: { mute_state: "" },
          };
        }
        if (meeting.muted === true) {
          return {
            state: { icon: "ms:mic-off", iconColor: "#ef4444", background: "#451a1a" },
            variables: { mute_state: "Muted" },
          };
        }
        if (meeting.muted === false) {
          return {
            state: { icon: "ms:mic", iconColor: "#22c55e" },
            variables: { mute_state: "Unmuted" },
          };
        }
        // Unknown state — show neutral
        return {
          state: { icon: "ms:mic" },
          variables: { mute_state: "" },
        };
      },
    });

    // ── State Provider: video status ─────────────────────────────────────

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
        const meeting = getMeetingState(target);

        if (!meeting?.inMeeting) {
          return {
            state: { icon: "ms:videocam-off", iconColor: "#6b7280" },
            variables: { video_state: "" },
          };
        }
        if (meeting.videoOn === true) {
          return {
            state: { icon: "ms:videocam", iconColor: "#22c55e" },
            variables: { video_state: "On" },
          };
        }
        if (meeting.videoOn === false) {
          return {
            state: { icon: "ms:videocam-off", iconColor: "#ef4444", background: "#451a1a" },
            variables: { video_state: "Off" },
          };
        }
        return {
          state: { icon: "ms:videocam" },
          variables: { video_state: "" },
        };
      },
    });

    // ── State Provider: share status ─────────────────────────────────────

    ctx.registerStateProvider({
      id: "share_status",
      name: "Share Status",
      description: "Whether you are sharing your screen",
      icon: "ms:screen-share",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "share_state", label: "Share State", example: "Sharing" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meeting = getMeetingState(target);

        if (!meeting?.inMeeting) {
          return {
            state: { icon: "ms:stop-screen-share", iconColor: "#6b7280" },
            variables: { share_state: "" },
          };
        }
        if (meeting.sharing === true) {
          return {
            state: { icon: "ms:screen-share", iconColor: "#3b82f6", background: "#1e293b" },
            variables: { share_state: "Sharing" },
          };
        }
        return {
          state: { icon: "ms:screen-share" },
          variables: { share_state: "" },
        };
      },
    });

    // ── State Provider: hand status ──────────────────────────────────────

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
        const meeting = getMeetingState(target);

        if (!meeting?.inMeeting) {
          return {
            state: { icon: "ms:back-hand", iconColor: "#6b7280" },
            variables: { hand_state: "" },
          };
        }
        if (meeting.handRaised === true) {
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

    // ── State Provider: recording status ─────────────────────────────────

    ctx.registerStateProvider({
      id: "recording_status",
      name: "Recording Status",
      description: "Whether the meeting is being recorded",
      icon: "ms:fiber-manual-record",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "recording_state", label: "Recording State", example: "Recording" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = resolveTarget(p, { focusedAgent: undefined });
        const meeting = getMeetingState(target);

        if (!meeting?.inMeeting) {
          return {
            state: { icon: "ms:fiber-manual-record", iconColor: "#6b7280" },
            variables: { recording_state: "" },
          };
        }
        if (meeting.recording === true) {
          return {
            state: { icon: "ms:fiber-manual-record", iconColor: "#ef4444", background: "#451a1a" },
            variables: { recording_state: "Recording" },
          };
        }
        return {
          state: { icon: "ms:fiber-manual-record" },
          variables: { recording_state: "" },
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
      id: "share_screen",
      name: "Share Screen",
      description: "Start or stop screen sharing",
      category: "Meeting",
      icon: "ms:screen-share",
      action: "toggle_share",
      stateProvider: "share_status",
      defaults: {
        icon: "ms:screen-share",
        label: "{{share_state}}",
      },
    });

    ctx.registerPreset({
      id: "leave",
      name: "Leave",
      description: "Leave the current meeting",
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
      id: "end",
      name: "End Meeting",
      description: "End the meeting for everyone (host only)",
      category: "Meeting",
      icon: "ms:phone-disabled",
      action: "end",
      stateProvider: "meeting_status",
      defaults: {
        icon: "ms:phone-disabled",
        label: "End",
        iconColor: "#ef4444",
        background: "#451a1a",
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
      id: "react",
      name: "React",
      description: "Open the emoji reactions panel",
      category: "Meeting",
      icon: "ms:add-reaction",
      action: "react",
      stateProvider: "meeting_status",
      defaults: {
        icon: "ms:add-reaction",
        label: "React",
      },
    });

    ctx.registerPreset({
      id: "record",
      name: "Record",
      description: "Start or stop local recording",
      category: "Meeting",
      icon: "ms:fiber-manual-record",
      action: "toggle_recording",
      stateProvider: "recording_status",
      defaults: {
        icon: "ms:fiber-manual-record",
        label: "{{recording_state}}",
      },
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
