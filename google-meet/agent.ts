// plugins/google-meet/agent.ts
// Agent-side plugin: runs a local WebSocket server that bridges between the
// OmniDeck hub and the companion Chrome extension running in Google Meet tabs.
//
// No platform-specific code — all Meet control happens via the Chrome extension.

import type { OmniDeck } from "@omnideck/agent-sdk";

interface GoogleMeetState {
  extensionConnected: boolean;
  inCall: boolean;
  muted: boolean | null;
  videoOff: boolean | null;
  handRaised: boolean | null;
  captionsOn: boolean | null;
}

interface ExtensionMessage {
  type: "state_update" | "hello";
  data?: {
    inCall?: boolean;
    muted?: boolean;
    videoOff?: boolean;
    handRaised?: boolean;
    captionsOn?: boolean;
  };
}

interface AgentCommand {
  type: "command";
  command: string;
  params?: Record<string, unknown>;
}

const EMPTY_STATE: GoogleMeetState = {
  extensionConnected: false,
  inCall: false,
  muted: null,
  videoOff: null,
  handRaised: null,
  captionsOn: null,
};

export default function init(omnideck: OmniDeck) {
  const port = (omnideck.config.ws_port as number) ?? 2395;

  let state: GoogleMeetState = { ...EMPTY_STATE };
  const clients = new Set<unknown>();
  // Track which client is in an active call (prefer this one for commands)
  let activeClient: unknown = null;

  function pushState() {
    omnideck.setState("meeting", state);
  }

  // ── WebSocket server via Bun.serve() ────────────────────────────────────

  const server = Bun.serve({
    port,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("OmniDeck Google Meet Agent", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        state.extensionConnected = true;
        omnideck.log.info("Chrome extension connected", { clients: clients.size });
        pushState();
      },

      message(ws, message) {
        try {
          const msg: ExtensionMessage = JSON.parse(String(message));

          if (msg.type === "hello") {
            // Extension just connected or tab navigated — request full state
            (ws as { send(data: string): void }).send(JSON.stringify({ type: "command", command: "get_state" }));
            return;
          }

          if (msg.type === "state_update" && msg.data) {
            const d = msg.data;

            // Track which client is in a call
            if (d.inCall) {
              activeClient = ws;
            } else if (activeClient === ws) {
              activeClient = null;
            }

            // Merge state
            if (d.inCall !== undefined) state.inCall = d.inCall;
            if (d.muted !== undefined) state.muted = d.muted;
            if (d.videoOff !== undefined) state.videoOff = d.videoOff;
            if (d.handRaised !== undefined) state.handRaised = d.handRaised;
            if (d.captionsOn !== undefined) state.captionsOn = d.captionsOn;

            // Reset detailed state when not in a call
            if (!state.inCall) {
              state.muted = null;
              state.videoOff = null;
              state.handRaised = null;
              state.captionsOn = null;
            }

            pushState();
          }
        } catch {
          // Ignore malformed messages
        }
      },

      close(ws) {
        clients.delete(ws);
        if (activeClient === ws) activeClient = null;

        if (clients.size === 0) {
          state = { ...EMPTY_STATE };
        } else {
          state.extensionConnected = true;
        }

        omnideck.log.info("Chrome extension disconnected", { clients: clients.size });
        pushState();
      },
    },
  });

  omnideck.log.info(`WebSocket server listening on ws://127.0.0.1:${port}`);
  pushState();

  // ── Heartbeat: verify connection health ─────────────────────────────────

  omnideck.setInterval(() => {
    const wasConnected = state.extensionConnected;
    state.extensionConnected = clients.size > 0;
    if (wasConnected !== state.extensionConnected) {
      if (!state.extensionConnected) state = { ...EMPTY_STATE };
      pushState();
    }
  }, 5000);

  // ── Action handlers ─────────────────────────────────────────────────────

  function sendCommand(command: string, params?: Record<string, unknown>) {
    const msg = JSON.stringify({ type: "command", command, params } as AgentCommand);
    // Send to the active client (in a call), or first available
    const target = activeClient ?? clients.values().next().value;
    if (target) {
      (target as { send(data: string): void }).send(msg);
    }
  }

  const actions = [
    "toggle_mute",
    "toggle_video",
    "toggle_hand",
    "toggle_captions",
    "leave",
    "toggle_chat",
    "emoji_react",
  ] as const;

  for (const actionId of actions) {
    omnideck.onAction(actionId, async (params) => {
      if (clients.size === 0) {
        return { success: false, error: "Chrome extension not connected" };
      }
      sendCommand(actionId, params);
      return { success: true };
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  omnideck.onReloadConfig(() => {
    omnideck.log.warn("google-meet config changed — restart agent to apply");
  });

  omnideck.onDestroy(() => {
    server.stop();
    omnideck.log.info("WebSocket server stopped");
  });
}
