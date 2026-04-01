// plugins/discord/agent.ts
// Connects to Discord's local RPC WebSocket API to control voice, video, and streaming.

import type { OmniDeck } from "@omnideck/agent-sdk";

interface DiscordState {
  connected: boolean;
  authenticated: boolean;
  muted: boolean;
  deafened: boolean;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
  guildId: string | null;
  voiceMode: string; // "VOICE_ACTIVITY" | "PUSH_TO_TALK"
  voiceUsers: Array<{ id: string; username: string; volume: number; mute: boolean }>;
  username: string;
}

const EMPTY_STATE: DiscordState = {
  connected: false,
  authenticated: false,
  muted: false,
  deafened: false,
  voiceChannelId: null,
  voiceChannelName: null,
  guildId: null,
  voiceMode: "VOICE_ACTIVITY",
  voiceUsers: [],
  username: "",
};

export default function init(omnideck: OmniDeck) {
  const clientId = omnideck.config.client_id as string;
  const clientSecret = omnideck.config.client_secret as string;

  if (!clientId || !clientSecret) {
    omnideck.log.warn("Discord plugin: client_id and client_secret are required");
    omnideck.setState("discord", { ...EMPTY_STATE });
    return;
  }

  let state: DiscordState = { ...EMPTY_STATE };
  let ws: WebSocket | null = null;
  let nonceCounter = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribedChannelId: string | null = null;

  // Pending command callbacks
  const pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

  function pushState() {
    omnideck.setState("discord", state);
  }

  function nextNonce(): string {
    return String(++nonceCounter);
  }

  // ── Token persistence ───────────────────────────────────────────────────

  const tokenPath = `${omnideck.dataDir}/discord-token.json`;

  async function loadToken(): Promise<{ access_token: string; refresh_token: string } | null> {
    try {
      const r = await omnideck.exec("cat", [tokenPath]);
      if (r.exitCode !== 0) return null;
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }

  async function saveToken(access_token: string, refresh_token: string) {
    const data = JSON.stringify({ access_token, refresh_token });
    await omnideck.exec("sh", ["-c", `mkdir -p "${omnideck.dataDir}" && cat > "${tokenPath}" << 'TOKENEOF'\n${data}\nTOKENEOF`]);
  }

  // ── RPC command helper ──────────────────────────────────────────────────

  function send(cmd: string, args: Record<string, unknown> = {}, evt?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const nonce = nextNonce();
      const msg: Record<string, unknown> = { cmd, nonce, args };
      if (evt) msg.evt = evt;
      pending.set(nonce, { resolve, reject });
      ws.send(JSON.stringify(msg));
      // Timeout
      setTimeout(() => {
        if (pending.has(nonce)) {
          pending.delete(nonce);
          reject(new Error(`RPC timeout: ${cmd}`));
        }
      }, 10000);
    });
  }

  function subscribe(evt: string, args: Record<string, unknown> = {}) {
    const nonce = nextNonce();
    ws?.send(JSON.stringify({ cmd: "SUBSCRIBE", nonce, evt, args }));
  }

  // ── OAuth2 token exchange ───────────────────────────────────────────────

  async function exchangeCode(code: string): Promise<{ access_token: string; refresh_token: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "http://localhost",
    });
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
    return res.json() as Promise<{ access_token: string; refresh_token: string }>;
  }

  async function refreshToken(refresh: string): Promise<{ access_token: string; refresh_token: string }> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
    return res.json() as Promise<{ access_token: string; refresh_token: string }>;
  }

  // ── Auth flow ───────────────────────────────────────────────────────────

  async function authenticate() {
    // Try cached token first
    const cached = await loadToken();
    if (cached) {
      try {
        await send("AUTHENTICATE", { access_token: cached.access_token });
        state.authenticated = true;
        omnideck.log.info("Authenticated with cached token");
        return;
      } catch {
        // Token expired, try refresh
        try {
          const refreshed = await refreshToken(cached.refresh_token);
          await saveToken(refreshed.access_token, refreshed.refresh_token);
          await send("AUTHENTICATE", { access_token: refreshed.access_token });
          state.authenticated = true;
          omnideck.log.info("Authenticated with refreshed token");
          return;
        } catch {
          omnideck.log.warn("Token refresh failed, starting fresh auth");
        }
      }
    }

    // Fresh authorization flow
    const scopes = ["rpc", "rpc.voice.read", "rpc.voice.write", "rpc.video.write", "rpc.screenshare.write", "identify"];
    const authResult = await send("AUTHORIZE", { client_id: clientId, scopes });
    const code = authResult.code as string;

    const tokens = await exchangeCode(code);
    await saveToken(tokens.access_token, tokens.refresh_token);
    await send("AUTHENTICATE", { access_token: tokens.access_token });
    state.authenticated = true;
    omnideck.log.info("Authenticated with fresh token");
  }

  // ── State sync ──────────────────────────────────────────────────────────

  async function syncVoiceSettings() {
    try {
      const data = await send("GET_VOICE_SETTINGS");
      state.muted = data.mute ?? false;
      state.deafened = data.deaf ?? false;
      state.voiceMode = data.mode?.type ?? "VOICE_ACTIVITY";
    } catch {
      // Ignore
    }
  }

  async function syncVoiceChannel() {
    try {
      const data = await send("GET_SELECTED_VOICE_CHANNEL");
      if (data) {
        state.voiceChannelId = data.id;
        state.voiceChannelName = data.name;
        state.guildId = data.guild_id;
        // Extract voice users
        const voiceStates = data.voice_states as Array<{ user: { id: string; username: string }; voice_state: { mute: boolean }; volume: number }> | undefined;
        if (voiceStates) {
          state.voiceUsers = voiceStates.map((vs) => ({
            id: vs.user.id,
            username: vs.user.username,
            volume: vs.volume ?? 100,
            mute: vs.voice_state?.mute ?? false,
          }));
        }
        // Subscribe to voice state events for this channel
        if (subscribedChannelId !== data.id) {
          if (subscribedChannelId) {
            // Unsubscribe from old channel
            try { send("UNSUBSCRIBE", { channel_id: subscribedChannelId }, "VOICE_STATE_CREATE"); } catch {}
            try { send("UNSUBSCRIBE", { channel_id: subscribedChannelId }, "VOICE_STATE_UPDATE"); } catch {}
            try { send("UNSUBSCRIBE", { channel_id: subscribedChannelId }, "VOICE_STATE_DELETE"); } catch {}
          }
          subscribe("VOICE_STATE_CREATE", { channel_id: data.id });
          subscribe("VOICE_STATE_UPDATE", { channel_id: data.id });
          subscribe("VOICE_STATE_DELETE", { channel_id: data.id });
          subscribedChannelId = data.id;
        }
      } else {
        state.voiceChannelId = null;
        state.voiceChannelName = null;
        state.guildId = null;
        state.voiceUsers = [];
        subscribedChannelId = null;
      }
    } catch {
      // Ignore
    }
  }

  // ── Event handler ───────────────────────────────────────────────────────

  function handleEvent(evt: string, data: any) {
    switch (evt) {
      case "VOICE_SETTINGS_UPDATE":
        state.muted = data.mute ?? state.muted;
        state.deafened = data.deaf ?? state.deafened;
        state.voiceMode = data.mode?.type ?? state.voiceMode;
        pushState();
        break;

      case "VOICE_CHANNEL_SELECT":
        state.voiceChannelId = data.channel_id;
        state.guildId = data.guild_id;
        // Resync to get channel name and users
        syncVoiceChannel().then(pushState);
        break;

      case "VOICE_STATE_CREATE":
      case "VOICE_STATE_UPDATE":
      case "VOICE_STATE_DELETE":
        // Resync voice users
        syncVoiceChannel().then(pushState);
        break;
    }
  }

  // ── WebSocket connection ────────────────────────────────────────────────

  async function connect() {
    for (let port = 6463; port <= 6472; port++) {
      try {
        await tryConnect(port);
        return;
      } catch {
        continue;
      }
    }
    omnideck.log.warn("Could not connect to Discord RPC on any port");
    state = { ...EMPTY_STATE };
    pushState();
    scheduleReconnect();
  }

  function tryConnect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}/?v=1&client_id=${clientId}&encoding=json`;
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("timeout"));
      }, 3000);

      socket.onopen = () => {
        // Wait for READY event
      };

      socket.onmessage = async (event) => {
        try {
          const msg = JSON.parse(String(event.data));

          // Handle READY event (first message after connect)
          if (msg.evt === "READY" && msg.cmd === "DISPATCH") {
            clearTimeout(timeout);
            ws = socket;
            state.connected = true;
            state.username = msg.data?.user?.username ?? "";
            omnideck.log.info(`Discord RPC connected on port ${port}`, { user: state.username });

            try {
              await authenticate();
              subscribe("VOICE_SETTINGS_UPDATE");
              subscribe("VOICE_CHANNEL_SELECT");
              subscribe("VOICE_CONNECTION_STATUS");
              await syncVoiceSettings();
              await syncVoiceChannel();
              pushState();
            } catch (err) {
              omnideck.log.error("Auth failed", { err: String(err) });
              state.authenticated = false;
              pushState();
            }
            resolve();
            return;
          }

          // Handle event dispatches
          if (msg.cmd === "DISPATCH" && msg.evt) {
            handleEvent(msg.evt, msg.data);
            return;
          }

          // Handle command responses
          if (msg.nonce && pending.has(msg.nonce)) {
            const p = pending.get(msg.nonce)!;
            pending.delete(msg.nonce);
            if (msg.evt === "ERROR") {
              p.reject(new Error(msg.data?.message ?? "RPC error"));
            } else {
              p.resolve(msg.data);
            }
          }
        } catch (err) {
          omnideck.log.error("RPC message parse error", { err: String(err) });
        }
      };

      socket.onclose = () => {
        clearTimeout(timeout);
        if (ws === socket) {
          ws = null;
          state.connected = false;
          state.authenticated = false;
          omnideck.log.info("Discord RPC disconnected");
          pushState();
          scheduleReconnect();
        } else {
          reject(new Error("closed"));
        }
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("error"));
      };
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  }

  // ── Action handlers ─────────────────────────────────────────────────────

  omnideck.onAction("toggle_mute", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected to Discord" };
    try {
      await send("SET_VOICE_SETTINGS", { mute: !state.muted });
      state.muted = !state.muted;
      pushState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("toggle_deafen", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected to Discord" };
    try {
      await send("SET_VOICE_SETTINGS", { deaf: !state.deafened });
      state.deafened = !state.deafened;
      pushState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("join_voice", async (params) => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    const channelId = params.channel_id as string;
    if (!channelId) return { success: false, error: "No channel_id" };
    try {
      await send("SELECT_VOICE_CHANNEL", { channel_id: channelId });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("leave_voice", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    try {
      await send("SELECT_VOICE_CHANNEL", { channel_id: null });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("toggle_video", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    try {
      await send("TOGGLE_VIDEO");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("toggle_stream", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    try {
      await send("TOGGLE_SCREENSHARE");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("toggle_ptt_mode", async () => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    const newMode = state.voiceMode === "PUSH_TO_TALK" ? "VOICE_ACTIVITY" : "PUSH_TO_TALK";
    try {
      await send("SET_VOICE_SETTINGS", { mode: { type: newMode } });
      state.voiceMode = newMode;
      pushState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("open_text", async (params) => {
    const guildId = params.guild_id as string;
    const channelId = params.channel_id as string;
    if (!guildId || !channelId) return { success: false, error: "Missing guild_id or channel_id" };

    const url = `discord://-/channels/${guildId}/${channelId}`;
    if (omnideck.platform === "darwin") {
      await omnideck.exec("open", [url]);
    } else if (omnideck.platform === "windows") {
      await omnideck.exec("cmd", ["/c", "start", "", url]);
    } else {
      await omnideck.exec("xdg-open", [url]);
    }
    return { success: true };
  });

  omnideck.onAction("adjust_user", async (params) => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    const userId = params.user_id as string;
    const delta = (params.delta as number) ?? 0;
    if (!userId) return { success: false, error: "No user_id" };

    // Find current volume
    const user = state.voiceUsers.find((u) => u.id === userId);
    const currentVol = user?.volume ?? 100;
    const newVol = Math.max(0, Math.min(200, currentVol + delta));

    try {
      await send("SET_USER_VOICE_SETTINGS", { user_id: userId, volume: newVol });
      // Update local state
      if (user) user.volume = newVol;
      pushState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  omnideck.onAction("mute_user", async (params) => {
    if (!state.authenticated) return { success: false, error: "Not connected" };
    const userId = params.user_id as string;
    const mute = params.mute as boolean;
    if (!userId) return { success: false, error: "No user_id" };

    try {
      await send("SET_USER_VOICE_SETTINGS", { user_id: userId, mute });
      const user = state.voiceUsers.find((u) => u.id === userId);
      if (user) user.mute = mute;
      pushState();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Start ───────────────────────────────────────────────────────────────

  connect();
  pushState();

  omnideck.onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
  });
}
