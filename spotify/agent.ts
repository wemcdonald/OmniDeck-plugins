// plugins/spotify/agent.ts  (v2 — with 204 track preservation)
// Agent-side plugin: authenticates with Spotify via PKCE, polls playback
// state, downloads album art, and handles playback control actions.
//
// All Spotify API calls happen here. The hub receives state updates and
// renders button visuals.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomBytes, createHash } from "crypto";
import type { OmniDeck } from "@omnideck/agent-sdk";

interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface PlaybackState {
  status: "playing" | "paused" | "idle" | "needs_auth" | "error" | "no_device" | "loading";
  is_playing: boolean;
  track_id: string | null;
  track_name: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  progress_ms: number;
  shuffle: boolean;
  repeat: "off" | "context" | "track";
  volume: number;
  device_name: string;
  updated_at: number;
  error_message?: string;
}

const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
const SPOTIFY_API = "https://api.spotify.com/v1";
const SCOPES = "user-modify-playback-state user-read-playback-state user-read-currently-playing";
const CALLBACK_PORT = 28120;
const AGENT_CODE_VERSION = 2; // bump to verify agent re-downloads on SHA change

const EMPTY_PLAYBACK: PlaybackState = {
  status: "idle",
  is_playing: false,
  track_id: null,
  track_name: "",
  artist_name: "",
  album_name: "",
  duration_ms: 0,
  progress_ms: 0,
  shuffle: false,
  repeat: "off",
  volume: 0,
  device_name: "",
  updated_at: 0,
};

export default function init(omnideck: OmniDeck) {
  let clientId = (omnideck.config as Record<string, unknown>).client_id as string;
  const pollInterval = ((omnideck.config as Record<string, unknown>).poll_interval as number) ?? 3000;
  const volumeStep = ((omnideck.config as Record<string, unknown>).volume_step as number) ?? 10;

  const tokenPath = `${omnideck.dataDir}/spotify-tokens.json`;
  let tokens: SpotifyTokens | null = null;
  let lastState: PlaybackState = { ...EMPTY_PLAYBACK, status: "loading" };
  let lastTrackId: string | null = null;
  let lastAlbumArtData: { track_id: string; data: string } | null = null;
  let authServer: { stop(): void } | null = null;
  let pollHandle: ReturnType<typeof omnideck.setInterval> | null = null;

  function pushState() {
    omnideck.setState("playback", lastState);
  }

  // ── Token persistence ───────────────────────────────────────────────────

  function loadTokens(): SpotifyTokens | null {
    try {
      if (existsSync(tokenPath)) {
        return JSON.parse(readFileSync(tokenPath, "utf-8"));
      }
    } catch (e) {
      omnideck.log.warn("Failed to load Spotify tokens", { err: String(e) });
    }
    return null;
  }

  function saveTokens(t: SpotifyTokens) {
    try {
      if (!existsSync(omnideck.dataDir)) mkdirSync(omnideck.dataDir, { recursive: true });
      writeFileSync(tokenPath, JSON.stringify(t));
    } catch (e) {
      omnideck.log.error("Failed to save Spotify tokens", { err: String(e) });
    }
  }

  // ── PKCE helpers ────────────────────────────────────────────────────────

  function generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  function generateCodeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
  }

  // ── Token refresh ───────────────────────────────────────────────────────

  async function refreshAccessToken(): Promise<boolean> {
    if (!tokens?.refresh_token) return false;
    try {
      const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          omnideck.log.warn("Spotify refresh token invalid, need re-auth");
          tokens = null;
          return false;
        }
        throw new Error(`Refresh failed: ${res.status}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      tokens = {
        access_token: data.access_token as string,
        refresh_token: (data.refresh_token as string) ?? tokens.refresh_token,
        expires_at: Date.now() + (data.expires_in as number) * 1000,
      };
      saveTokens(tokens);
      return true;
    } catch (e) {
      omnideck.log.error("Spotify token refresh failed", { err: String(e) });
      return false;
    }
  }

  async function ensureToken(): Promise<string | null> {
    if (!tokens) return null;
    if (Date.now() > tokens.expires_at - 300_000) {
      omnideck.log.info("Spotify: token expired, refreshing...");
      if (!(await refreshAccessToken())) {
        lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
        pushState();
        return null;
      }
    }
    return tokens.access_token;
  }

  // ── Spotify API helper ──────────────────────────────────────────────────

  async function spotifyFetch(path: string, options?: RequestInit): Promise<Response | null> {
    let accessToken = await ensureToken();
    if (!accessToken) return null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      let res = await fetch(`${SPOTIFY_API}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${accessToken}`, ...options?.headers },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 401) {
        if (!(await refreshAccessToken())) {
          lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
          pushState();
          return null;
        }
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 4000);
        res = await fetch(`${SPOTIFY_API}${path}`, {
          ...options,
          headers: { Authorization: `Bearer ${tokens!.access_token}`, ...options?.headers },
          signal: controller2.signal,
        });
        clearTimeout(timeout2);
      }

      return res;
    } catch (e) {
      omnideck.log.warn("Spotify API request failed", { path, err: String(e) });
      return null;
    }
  }

  // ── OAuth PKCE flow ─────────────────────────────────────────────────────

  function html(title: string, message: string): string {
    return `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#191414;color:white}div{text-align:center}h1{color:#1DB954}p{color:#b3b3b3}</style></head><body><div><h1>${title}</h1><p>${message}</p></div></body></html>`;
  }

  async function startAuth() {
    if (!clientId) {
      lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "No Client ID" };
      pushState();
      return;
    }

    if (authServer) return; // Already in progress

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");
    const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

    try {
      authServer = Bun.serve({
        port: CALLBACK_PORT,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== "/callback") {
            return new Response("Not found", { status: 404 });
          }

          const error = url.searchParams.get("error");
          if (error) {
            omnideck.log.error("Spotify auth denied", { error });
            lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: `Auth denied: ${error}` };
            pushState();
            setTimeout(() => { authServer?.stop(); authServer = null; }, 500);
            return new Response(html("Authorization Denied", "You can close this tab."), {
              headers: { "Content-Type": "text/html" },
            });
          }

          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");
          if (!code || returnedState !== state) {
            return new Response(html("Error", "Invalid callback parameters."), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          try {
            const tokenRes = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: codeVerifier,
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (!tokenRes.ok) {
              const errText = await tokenRes.text();
              throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
            }

            const data = (await tokenRes.json()) as Record<string, unknown>;
            tokens = {
              access_token: data.access_token as string,
              refresh_token: data.refresh_token as string,
              expires_at: Date.now() + (data.expires_in as number) * 1000,
            };
            saveTokens(tokens);
            omnideck.log.info("Spotify authenticated successfully");
            startPolling();

            setTimeout(() => { authServer?.stop(); authServer = null; }, 500);
            return new Response(
              html("Connected!", "Spotify is now connected to OmniDeck. You can close this tab."),
              { headers: { "Content-Type": "text/html" } },
            );
          } catch (e) {
            omnideck.log.error("Spotify token exchange failed", { err: String(e) });
            lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "Token exchange failed" };
            pushState();
            setTimeout(() => { authServer?.stop(); authServer = null; }, 500);
            return new Response(html("Error", "Token exchange failed. Check the logs."), {
              status: 500,
              headers: { "Content-Type": "text/html" },
            });
          }
        },
      });
    } catch (e) {
      omnideck.log.error("Failed to start auth server", { err: String(e) });
      lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "Auth server failed" };
      pushState();
      return;
    }

    const authUrl =
      `${SPOTIFY_ACCOUNTS}/authorize?` +
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        code_challenge_method: "S256",
        code_challenge: codeChallenge,
        scope: SCOPES,
        state,
      }).toString();

    // Open browser
    const openCmd =
      omnideck.platform === "darwin" ? "open" : omnideck.platform === "windows" ? "cmd" : "xdg-open";
    const openArgs = omnideck.platform === "windows" ? ["/c", "start", "", authUrl] : [authUrl];
    try {
      await omnideck.exec(openCmd, openArgs);
    } catch {
      omnideck.log.warn("Could not open browser — visit the auth URL manually");
    }

    lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
    pushState();
    omnideck.log.info("Spotify auth started — waiting for callback", { authUrl });
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  async function pollPlayback() {
    try {
      await doPoll();
    } catch (e) {
      omnideck.log.error("Spotify poll error", { err: String(e) });
      if (lastState.status === "loading") {
        lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "Poll failed" };
      }
      pushState();
    }
  }

  async function doPoll() {
    const res = await spotifyFetch("/me/player");
    if (!res) {
      // spotifyFetch returns null when auth fails — push current state so buttons aren't blank
      if (lastState.status === "loading") {
        lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
      }
      pushState();
      return;
    }

    // 204 = no recent activity. Keep previous track data if we have it —
    // Spotify returns 204 even when a song is paused for a while.
    if (res.status === 204) {
      if (lastState.track_id) {
        omnideck.log.info("Spotify 204: keeping paused track", { track: lastState.track_name });
        lastState = { ...lastState, status: "paused", is_playing: false, updated_at: Date.now() };
      } else {
        omnideck.log.info("Spotify 204: no track, idle");
        lastState = { ...EMPTY_PLAYBACK, updated_at: Date.now() };
      }
      pushState();
      omnideck.setActive(false);
      return;
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") || "5";
      omnideck.log.warn("Spotify rate limited", { retryAfter });
      return;
    }

    if (!res.ok) {
      omnideck.log.warn("Spotify API error", { status: res.status });
      if (res.status === 403) {
        lastState = {
          ...EMPTY_PLAYBACK,
          status: "error",
          error_message: "Premium required",
          updated_at: Date.now(),
        };
      } else {
        lastState = {
          ...EMPTY_PLAYBACK,
          status: "error",
          error_message: `API ${res.status}`,
          updated_at: Date.now(),
        };
      }
      pushState();
      return;
    }

    const data = (await res.json()) as Record<string, unknown>;
    const item = data.item as Record<string, unknown> | null;
    const device = data.device as Record<string, unknown> | null;
    const artists = (item?.artists as Array<{ name: string }>) ?? [];

    lastState = {
      status: data.is_playing ? "playing" : "paused",
      is_playing: data.is_playing as boolean,
      track_id: (item?.id as string) ?? null,
      track_name: (item?.name as string) ?? "",
      artist_name: artists.map((a) => a.name).join(", "),
      album_name: ((item?.album as Record<string, unknown>)?.name as string) ?? "",
      duration_ms: (item?.duration_ms as number) ?? 0,
      progress_ms: (data.progress_ms as number) ?? 0,
      shuffle: (data.shuffle_state as boolean) ?? false,
      repeat: (data.repeat_state as PlaybackState["repeat"]) ?? "off",
      volume: (device?.volume_percent as number) ?? 0,
      device_name: (device?.name as string) ?? "",
      updated_at: Date.now(),
    };
    pushState();
    omnideck.setActive(lastState.is_playing);

    // Download album art only when track changes
    const trackId = item?.id as string | undefined;
    if (trackId && trackId !== lastTrackId) {
      lastTrackId = trackId;
      const album = item?.album as Record<string, unknown> | undefined;
      const images = album?.images as Array<{ url: string; height: number }> | undefined;
      if (images?.length) {
        // Prefer 300x300 for good quality when scaled to 72x72
        const imageUrl = images.find((i) => i.height === 300)?.url ?? images[0].url;
        try {
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            lastAlbumArtData = {
              track_id: trackId,
              data: Buffer.from(buf).toString("base64"),
            };
            omnideck.setState("album_art", lastAlbumArtData);
          }
        } catch (e) {
          omnideck.log.warn("Failed to download album art", { err: String(e) });
        }
      }
    }
  }

  function startPolling() {
    if (pollHandle) return;
    omnideck.log.info("Spotify: polling started", { pollInterval });
    pollPlayback();
    pollHandle = omnideck.setInterval(pollPlayback, pollInterval);
  }

  function stopPolling() {
    if (pollHandle) {
      omnideck.clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  // ── Action helpers ──────────────────────────────────────────────────────

  async function ensureAuthForAction(): Promise<boolean> {
    if (tokens) return true;
    await startAuth();
    return false;
  }

  async function controlAction(
    endpoint: string,
    method: string = "PUT",
  ): Promise<{ success: boolean; error?: string }> {
    if (!(await ensureAuthForAction())) return { success: true }; // Auth started
    try {
      const res = await spotifyFetch(endpoint, { method });
      if (!res) return { success: false, error: "Not authenticated" };
      if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
        const body = await res.text().catch(() => "");
        return { success: false, error: `Spotify ${res.status}: ${body.slice(0, 100)}` };
      }
      // Poll after a short delay to let Spotify update
      setTimeout(() => pollPlayback(), 250);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── Action handlers ─────────────────────────────────────────────────────

  omnideck.onAction("play_pause", async () => {
    if (!(await ensureAuthForAction())) return { success: true };
    const endpoint = lastState.is_playing ? "/me/player/pause" : "/me/player/play";
    return controlAction(endpoint);
  });

  omnideck.onAction("next_track", () => controlAction("/me/player/next", "POST"));
  omnideck.onAction("prev_track", () => controlAction("/me/player/previous", "POST"));

  omnideck.onAction("shuffle", async () => {
    if (!(await ensureAuthForAction())) return { success: true };
    return controlAction(`/me/player/shuffle?state=${!lastState.shuffle}`);
  });

  omnideck.onAction("repeat", async () => {
    if (!(await ensureAuthForAction())) return { success: true };
    const nextMode =
      lastState.repeat === "off" ? "context" : lastState.repeat === "context" ? "track" : "off";
    return controlAction(`/me/player/repeat?state=${nextMode}`);
  });

  omnideck.onAction("volume_up", async (params) => {
    if (!(await ensureAuthForAction())) return { success: true };
    const step = (params.step as number) ?? volumeStep;
    const newVol = Math.min(100, lastState.volume + step);
    return controlAction(`/me/player/volume?volume_percent=${newVol}`);
  });

  omnideck.onAction("volume_down", async (params) => {
    if (!(await ensureAuthForAction())) return { success: true };
    const step = (params.step as number) ?? volumeStep;
    const newVol = Math.max(0, lastState.volume - step);
    return controlAction(`/me/player/volume?volume_percent=${newVol}`);
  });

  omnideck.onAction("connect", async () => {
    await startAuth();
    return { success: true };
  });

  omnideck.onAction("disconnect", async () => {
    tokens = null;
    lastTrackId = null;
    lastAlbumArtData = null;
    stopPolling();
    try {
      if (existsSync(tokenPath)) writeFileSync(tokenPath, "");
    } catch {}
    lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
    pushState();
    omnideck.setState("album_art", null);
    return { success: true };
  });

  // ── Startup ─────────────────────────────────────────────────────────────

  function startup() {
    if (!clientId) {
      lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "No Client ID" };
      pushState();
      return;
    }

    tokens = loadTokens();
    if (tokens) {
      omnideck.log.info("Spotify: loaded cached tokens", {
        expiresIn: Math.round((tokens.expires_at - Date.now()) / 1000),
      });
      startPolling();
    } else {
      lastState = { ...EMPTY_PLAYBACK, status: "needs_auth" };
      pushState();
    }
  }

  omnideck.log.info(`Spotify agent init (code v${AGENT_CODE_VERSION})`);

  if (clientId) {
    startup();
  } else {
    omnideck.log.info("Spotify plugin: waiting for config with client_id");
    lastState = { ...EMPTY_PLAYBACK, status: "error", error_message: "No Client ID" };
    pushState();
  }

  // ── Config reload / Hub reconnect ───────────────────────────────────────

  omnideck.onReloadConfig((newConfig) => {
    const newClientId = (newConfig as Record<string, unknown>).client_id as string;
    if (newClientId && newClientId !== clientId) {
      clientId = newClientId;
      tokens = null;
      stopPolling();
      startup();
    } else {
      // Hub reconnected — re-push current state
      pushState();
      if (lastAlbumArtData) {
        omnideck.setState("album_art", lastAlbumArtData);
      }
    }
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────

  omnideck.onDestroy(() => {
    stopPolling();
    if (authServer) {
      authServer.stop();
      authServer = null;
    }
  });
}
