// plugins/spotify/hub.ts
// Hub-side plugin: registers actions, state providers, and presets for
// Spotify playback control. Reads agent state and renders button visuals
// including album art, scrolling text, and status indicators.

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

// ── Spotify brand colors ──────────────────────────────────────────────────
const GREEN = "#1DB954";
const BG = "#191414";
const GRAY = "#6b7280";
const RED = "#ef4444";
const WHITE = "#ffffff";

// ── Config schema ─────────────────────────────────────────────────────────
const configSchema = z.object({
  client_id: field(z.string().default(""), {
    label: "Spotify Client ID",
    description: "Create an app at developer.spotify.com/dashboard and copy the Client ID",
    placeholder: "e.g. a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    secret: true,
  }),
  poll_interval: field(z.number().min(1000).max(30000).default(3000), {
    label: "Poll Interval (ms)",
    description: "How often to check Spotify for updates (lower = more responsive)",
  }),
  volume_step: field(z.number().min(1).max(50).default(10), {
    label: "Volume Step (%)",
    description: "Volume change per button press",
  }),
});

// ── Shared param schemas ──────────────────────────────────────────────────
const targetParam = {
  target: field(z.string().optional(), { label: "Target Agent", fieldType: "agent" as const }),
};
const targetOnlySchema = z.object(targetParam);

// ── Plugin definition ─────────────────────────────────────────────────────
export const spotifyPlugin: OmniDeckPlugin = {
  id: "spotify",
  name: "Spotify",
  version: "1.0.0",
  icon: "ms:music-note",
  configSchema,

  async init(ctx: PluginContext) {
    // ── Helpers ───────────────────────────────────────────────────────────

    function resolveTarget(
      params: Record<string, unknown>,
      actionCtx: { focusedAgent?: string },
    ): string | undefined {
      return (params.target as string | undefined) ?? actionCtx.focusedAgent;
    }

    function getPlayback(params: Record<string, unknown>): Record<string, unknown> | undefined {
      const target =
        (params.target as string | undefined) ??
        (ctx.state.get("spotify", "active_agent") as string | undefined);
      if (!target) return undefined;
      return ctx.state.get("spotify", `agent:${target}:playback`) as
        | Record<string, unknown>
        | undefined;
    }

    function getAlbumArt(params: Record<string, unknown>): Record<string, unknown> | undefined {
      const target =
        (params.target as string | undefined) ??
        (ctx.state.get("spotify", "active_agent") as string | undefined);
      if (!target) return undefined;
      return ctx.state.get("spotify", `agent:${target}:album_art`) as
        | Record<string, unknown>
        | undefined;
    }

    // ── Register actions ──────────────────────────────────────────────────

    function registerAgentAction(
      id: string,
      name: string,
      description: string,
      icon: string,
      extraParams?: Record<string, z.ZodType>,
    ) {
      const schema = extraParams ? z.object({ ...targetParam, ...extraParams }) : targetOnlySchema;
      ctx.registerAction({
        id,
        name,
        description,
        icon,
        paramsSchema: schema,
        async execute(params, actionCtx) {
          const p = params as Record<string, unknown>;
          const target = resolveTarget(p, actionCtx);
          if (target) {
            ctx.state.set("spotify", `pending:${target}:${id}`, {
              params,
              timestamp: Date.now(),
            });
          }
        },
      });
    }

    registerAgentAction("play_pause", "Play/Pause", "Toggle Spotify playback", "ms:play-pause");
    registerAgentAction("next_track", "Next Track", "Skip to next track", "ms:skip-next");
    registerAgentAction("prev_track", "Previous Track", "Skip to previous track", "ms:skip-previous");
    registerAgentAction("shuffle", "Toggle Shuffle", "Toggle shuffle mode on or off", "ms:shuffle");
    registerAgentAction(
      "repeat",
      "Cycle Repeat",
      "Cycle repeat mode: off \u2192 playlist \u2192 track",
      "ms:repeat",
    );
    registerAgentAction("volume_up", "Volume Up", "Increase Spotify volume", "ms:volume-up", {
      step: field(z.number().min(1).max(50).optional(), { label: "Step (%)" }),
    });
    registerAgentAction("volume_down", "Volume Down", "Decrease Spotify volume", "ms:volume-down", {
      step: field(z.number().min(1).max(50).optional(), { label: "Step (%)" }),
    });
    registerAgentAction(
      "connect",
      "Connect to Spotify",
      "Start the Spotify authorization flow",
      "ms:login",
    );
    registerAgentAction(
      "disconnect",
      "Disconnect Spotify",
      "Remove stored Spotify credentials",
      "ms:logout",
    );

    // ── State providers ───────────────────────────────────────────────────

    // Status-based result for non-playing states (reused across providers)
    function statusFallback(playback: Record<string, unknown> | undefined): {
      state: Record<string, unknown>;
      variables: Record<string, string>;
    } | null {
      const emptyVars = { track: "", artist: "", album: "", volume: "" };
      if (!playback || playback.status === "loading") {
        return {
          state: { icon: "ms:play-arrow", iconColor: GRAY, background: BG },
          variables: emptyVars,
        };
      }
      if (playback.status === "needs_auth") {
        return {
          state: { icon: "ms:link", label: "Connect", iconColor: GREEN, background: BG },
          variables: emptyVars,
        };
      }
      if (playback.status === "error") {
        return {
          state: {
            icon: "ms:error",
            label: ((playback.error_message as string) ?? "Error").slice(0, 12),
            iconColor: RED,
            background: BG,
          },
          variables: emptyVars,
        };
      }
      if (playback.status === "idle") {
        // No track has ever played — dim play icon
        return {
          state: { icon: "ms:play-arrow", iconColor: GRAY, background: BG },
          variables: emptyVars,
        };
      }
      return null; // Has playback data (playing or paused)
    }

    // ── Now Playing: album art with progress bar ──────────────────────────

    ctx.registerStateProvider({
      id: "now_playing",
      name: "Now Playing",
      description: "Album art with playback progress bar",
      icon: "ms:album",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "track", label: "Track Name", example: "Bohemian Rhapsody" },
        { key: "artist", label: "Artist", example: "Queen" },
        { key: "album", label: "Album", example: "A Night at the Opera" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const albumArt = getAlbumArt(p);

        // For now_playing, check album art BEFORE falling back to status icons.
        // The album_art state persists in the hub even when Spotify returns 204
        // (idle), so we can keep showing it when paused.
        const isPlaying = playback?.is_playing as boolean ?? false;
        const hasTrack = !!(playback?.track_id);
        const trackName = (playback?.track_name as string) ?? "";
        const artistName = (playback?.artist_name as string) ?? "";
        const albumName = (playback?.album_name as string) ?? "";

        // If we have album art, always show it
        // Note: don't use opacity here — the renderer's opacity overlay
        // has a bug that produces black when compositing over Buffer icons.
        if (albumArt?.data) {
          const duration = (playback?.duration_ms as number) || 1;
          let progress = (playback?.progress_ms as number) || 0;
          if (isPlaying && playback?.updated_at) {
            progress += Date.now() - (playback.updated_at as number);
          }
          return {
            state: {
              background: BG,
              icon: Buffer.from(albumArt.data as string, "base64"),
              iconFullBleed: true,
              progress: Math.min(progress / duration, 1),
            },
            variables: { track: trackName, artist: artistName, album: albumName },
          };
        }

        // No album art — use status-based fallback
        if (!playback || playback.status === "needs_auth") {
          return statusFallback(playback)!;
        }
        if (playback.status === "error") {
          return statusFallback(playback)!;
        }

        // Has track but no art: white play arrow. No track: gray play arrow.
        return {
          state: {
            background: BG,
            icon: "ms:play-arrow",
            iconColor: hasTrack ? WHITE : GRAY,
          },
          variables: { track: trackName, artist: artistName, album: albumName },
        };
      },
    });

    // ── Track Info: scrolling title and artist ─────────────────────────────

    ctx.registerStateProvider({
      id: "track_info",
      name: "Track Info",
      description: "Scrolling track name and artist",
      icon: "ms:lyrics",
      paramsSchema: targetOnlySchema,
      templateVariables: [
        { key: "track", label: "Track Name", example: "Bohemian Rhapsody" },
        { key: "artist", label: "Artist", example: "Queen" },
        { key: "album", label: "Album", example: "A Night at the Opera" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const fb = statusFallback(playback);
        if (fb) return fb;

        const trackName = (playback!.track_name as string) ?? "";
        const artistName = (playback!.artist_name as string) ?? "";

        return {
          state: {
            icon: playback!.is_playing ? "ms:music-note" : "ms:pause",
            iconColor: GREEN,
            label: trackName,
            scrollLabel: true,
            topLabel: artistName,
            scrollTopLabel: true,
            background: BG,
            opacity: playback!.is_playing ? undefined : 0.7,
          },
          variables: {
            track: trackName,
            artist: artistName,
            album: (playback!.album_name as string) ?? "",
          },
        };
      },
    });

    // ── Playback Status: play/pause icon ──────────────────────────────────

    ctx.registerStateProvider({
      id: "playback_status",
      name: "Play/Pause Status",
      description: "Shows play or pause icon based on playback state",
      icon: "ms:play-pause",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const fb = statusFallback(playback);
        if (fb) return fb;

        const isPlaying = playback!.is_playing as boolean;
        return {
          state: {
            icon: isPlaying ? "ms:pause" : "ms:play-arrow",
            iconColor: isPlaying ? GREEN : WHITE,
            label: isPlaying ? "Pause" : "Play",
            background: BG,
          },
          variables: {},
        };
      },
    });

    // ── Shuffle Status ────────────────────────────────────────────────────

    ctx.registerStateProvider({
      id: "shuffle_status",
      name: "Shuffle Status",
      description: "Shows whether shuffle mode is on or off",
      icon: "ms:shuffle",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const fb = statusFallback(playback);
        if (fb) return fb;

        const isOn = playback!.shuffle as boolean;
        return {
          state: {
            icon: "ms:shuffle",
            iconColor: isOn ? GREEN : GRAY,
            label: isOn ? "On" : "Off",
            background: BG,
          },
          variables: {},
        };
      },
    });

    // ── Repeat Status ─────────────────────────────────────────────────────

    ctx.registerStateProvider({
      id: "repeat_status",
      name: "Repeat Status",
      description: "Shows the current repeat mode",
      icon: "ms:repeat",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const fb = statusFallback(playback);
        if (fb) return fb;

        const mode = (playback!.repeat as string) ?? "off";
        const icons: Record<string, string> = {
          off: "ms:repeat",
          context: "ms:repeat",
          track: "ms:repeat-one",
        };
        const colors: Record<string, string> = { off: GRAY, context: GREEN, track: GREEN };
        const labels: Record<string, string> = { off: "Off", context: "All", track: "One" };

        return {
          state: {
            icon: icons[mode] ?? "ms:repeat",
            iconColor: colors[mode] ?? GRAY,
            label: labels[mode] ?? "Off",
            background: BG,
          },
          variables: {},
        };
      },
    });

    // ── Volume Status ─────────────────────────────────────────────────────

    ctx.registerStateProvider({
      id: "volume_status",
      name: "Volume Level",
      description: "Shows the current Spotify volume with a progress bar",
      icon: "ms:volume-up",
      providesIcon: true,
      paramsSchema: targetOnlySchema,
      templateVariables: [{ key: "volume", label: "Volume %", example: "65" }],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const playback = getPlayback(p);
        const fb = statusFallback(playback);
        if (fb) return fb;

        const vol = (playback!.volume as number) ?? 0;
        let icon = "ms:volume-up";
        if (vol === 0) icon = "ms:volume-off";
        else if (vol < 30) icon = "ms:volume-mute";
        else if (vol < 70) icon = "ms:volume-down";

        return {
          state: {
            icon,
            iconColor: GREEN,
            label: `${vol}%`,
            background: BG,
            progress: vol / 100,
          },
          variables: { volume: String(vol) },
        };
      },
    });

    // ── Presets ────────────────────────────────────────────────────────────

    ctx.registerPreset({
      id: "now_playing",
      name: "Now Playing",
      description: "Album art with progress bar — tap to play/pause",
      category: "Spotify",
      icon: "ms:album",
      action: "play_pause",
      stateProvider: "now_playing",
      defaults: { background: BG, scrollLabel: true, scrollTopLabel: true },
    });

    ctx.registerPreset({
      id: "track_info",
      name: "Track Info",
      description: "Scrolling track name and artist — tap to play/pause",
      category: "Spotify",
      icon: "ms:lyrics",
      action: "play_pause",
      stateProvider: "track_info",
      defaults: { icon: "ms:music-note", iconColor: GREEN, background: BG, scrollLabel: true, scrollTopLabel: true },
    });

    ctx.registerPreset({
      id: "play_pause",
      name: "Play / Pause",
      description: "Toggle playback — icon reflects current state",
      category: "Spotify",
      icon: "ms:play-pause",
      action: "play_pause",
      stateProvider: "playback_status",
      defaults: { background: BG },
    });

    ctx.registerPreset({
      id: "next_track",
      name: "Next Track",
      description: "Skip to the next track",
      category: "Spotify",
      icon: "ms:skip-next",
      action: "next_track",
      defaults: { icon: "ms:skip-next", iconColor: WHITE, label: "Next", background: BG },
    });

    ctx.registerPreset({
      id: "prev_track",
      name: "Previous Track",
      description: "Skip to the previous track",
      category: "Spotify",
      icon: "ms:skip-previous",
      action: "prev_track",
      defaults: { icon: "ms:skip-previous", iconColor: WHITE, label: "Previous", background: BG },
    });

    ctx.registerPreset({
      id: "shuffle",
      name: "Shuffle",
      description: "Toggle shuffle — color shows current state",
      category: "Spotify",
      icon: "ms:shuffle",
      action: "shuffle",
      stateProvider: "shuffle_status",
      defaults: { background: BG },
    });

    ctx.registerPreset({
      id: "repeat",
      name: "Repeat",
      description: "Cycle repeat: off \u2192 all \u2192 one",
      category: "Spotify",
      icon: "ms:repeat",
      action: "repeat",
      stateProvider: "repeat_status",
      defaults: { background: BG },
    });

    ctx.registerPreset({
      id: "volume_up",
      name: "Volume Up",
      description: "Increase Spotify volume",
      category: "Spotify",
      icon: "ms:volume-up",
      action: "volume_up",
      defaults: { icon: "ms:volume-up", iconColor: GREEN, label: "Vol +", background: BG },
    });

    ctx.registerPreset({
      id: "volume_down",
      name: "Volume Down",
      description: "Decrease Spotify volume",
      category: "Spotify",
      icon: "ms:volume-down",
      action: "volume_down",
      defaults: { icon: "ms:volume-down", iconColor: GREEN, label: "Vol −", background: BG },
    });

    // ── Health check ──────────────────────────────────────────────────────

    const config = ctx.config as Record<string, unknown>;
    if (!config.client_id) {
      ctx.setHealth({
        status: "misconfigured",
        message: "Spotify Client ID not configured — add it in plugin settings",
      });
    } else {
      ctx.setHealth({ status: "ok" });
    }
  },

  async destroy() {},
};
