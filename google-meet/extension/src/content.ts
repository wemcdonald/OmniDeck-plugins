// OmniDeck Google Meet — Chrome Extension Content Script
//
// Injected into meet.google.com/* pages. Controls Meet by clicking DOM elements
// and detects state via MutationObservers. Communicates with the OmniDeck agent
// via a WebSocket connection to localhost.

// ── Configuration ─────────────────────────────────────────────────────────────

const WS_URL = "ws://127.0.0.1:2395";
const RECONNECT_DELAY = 3000;
const CALL_POLL_INTERVAL = 2000;

// ── DOM Selectors ─────────────────────────────────────────────────────────────
// Centralized for easy maintenance when Google updates Meet's UI.
// Multiple selectors per control provide fallbacks across Meet UI versions.

const SELECTORS = {
  // Mic button (uses data-is-muted attribute for state)
  mic: [
    'button[jsname="hw0c9"]',                           // Post-Sep 2024 redesign
    'div[role="button"][jsname="hw0c9"]',                // Join screen variant
    'div[jsname="Dg9Wp"] [jsname="BOHaEe"]',            // Pre-Sep 2024
  ],
  // Camera button (uses data-is-muted attribute for state)
  camera: [
    'button[jsname="psRWwc"]',                           // Post-Sep 2024
    'div[role="button"][jsname="psRWwc"]',               // Join screen
    'div[jsname="R3GXJb"] [jsname="BOHaEe"]',           // Pre-Sep 2024
  ],
  // Hand raise button (uses aria-pressed for state)
  hand: [
    'button[jsname="FpSaz"]',
  ],
  // Captions button (uses icon-based detection for state)
  captions: [
    'button[jsname="RrG0hf"]',
    'button[jsname="r8qRAd"]',                           // Older UI
  ],
  // Leave call button
  leave: [
    '[jsname="CQylAd"]',
  ],
  // Leave confirmation dialog button ("Just leave" for hosts)
  leaveConfirm: [
    '[data-mdc-dialog-action="Pd96ce"]',
  ],
  // Chat side panel toggle
  chatPanel: [
    '[jsname="A5il2e"][data-panel-id="2"]',
  ],
  // Emoji reaction panel opener
  emojiPanelOpener: [
    'button[jsname="G0pghc"]',
  ],
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findElement(selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function emojiButtonSelector(emoji: string): string {
  return `button[jsname="vnVdbf"][data-emoji^="${emoji}"]`;
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  inCall: false,
  muted: null as boolean | null,
  videoOff: null as boolean | null,
  handRaised: null as boolean | null,
  captionsOn: null as boolean | null,
};

function resetCallState() {
  state.muted = null;
  state.videoOff = null;
  state.handRaised = null;
  state.captionsOn = null;
}

// ── WebSocket Client ──────────────────────────────────────────────────────────

let ws: WebSocket | null = null;

function sendStateUpdate() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "state_update", data: { ...state } }));
  }
}

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    setTimeout(connect, RECONNECT_DELAY);
    return;
  }

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: "hello" }));
    // Read current state and push immediately
    readFullState();
    sendStateUpdate();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "command" && msg.command) {
        handleCommand(msg.command, msg.params);
      }
    } catch {
      // Ignore parse errors
    }
  };

  ws.onclose = () => {
    ws = null;
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

// ── Command Handlers ──────────────────────────────────────────────────────────

function handleCommand(command: string, params?: Record<string, unknown>) {
  switch (command) {
    case "toggle_mute":
      findElement(SELECTORS.mic)?.click();
      break;

    case "toggle_video":
      findElement(SELECTORS.camera)?.click();
      break;

    case "toggle_hand":
      findElement(SELECTORS.hand)?.click();
      break;

    case "toggle_captions":
      findElement(SELECTORS.captions)?.click();
      break;

    case "leave": {
      // Check if a confirmation dialog is already open
      const confirm = document.querySelector<HTMLElement>(SELECTORS.leaveConfirm[0]);
      if (confirm) {
        confirm.click();
        break;
      }
      findElement(SELECTORS.leave)?.click();
      // If host, a dialog may appear — click confirm after a short delay
      setTimeout(() => {
        const confirmBtn = document.querySelector<HTMLElement>(SELECTORS.leaveConfirm[0]);
        confirmBtn?.click();
      }, 500);
      break;
    }

    case "toggle_chat":
      document.querySelector<HTMLElement>(SELECTORS.chatPanel[0])?.click();
      break;

    case "emoji_react":
      handleEmojiReact(params);
      break;

    case "get_state":
      readFullState();
      sendStateUpdate();
      break;
  }
}

async function handleEmojiReact(params?: Record<string, unknown>) {
  const emoji = (params?.emoji as string) ?? "\u{1F44D}"; // default: thumbsup

  // Try clicking the emoji directly if the panel is already open
  let emojiBtn = document.querySelector<HTMLElement>(emojiButtonSelector(emoji));
  if (emojiBtn) {
    emojiBtn.click();
    return;
  }

  // Open the emoji panel first
  const opener = document.querySelector<HTMLElement>(SELECTORS.emojiPanelOpener[0]);
  if (!opener) return;
  opener.click();

  // Wait for the panel to open, then find and click the emoji
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    emojiBtn = document.querySelector<HTMLElement>(emojiButtonSelector(emoji));
    if (emojiBtn) {
      emojiBtn.click();
      return;
    }
  }
}

// ── State Detection ───────────────────────────────────────────────────────────

function readFullState() {
  // Read mic state
  const micEl = findElement(SELECTORS.mic);
  if (micEl) {
    state.muted = micEl.getAttribute("data-is-muted") === "true";
  }

  // Read camera state
  const camEl = findElement(SELECTORS.camera);
  if (camEl) {
    state.videoOff = camEl.getAttribute("data-is-muted") === "true";
  }

  // Read hand state
  const handEl = findElement(SELECTORS.hand);
  if (handEl) {
    state.handRaised = handEl.getAttribute("aria-pressed") === "true";
  }

  // Read captions state
  const captionsEl = findElement(SELECTORS.captions);
  if (captionsEl) {
    const icons = captionsEl.querySelectorAll("i");
    let captionsOff = false;
    for (const icon of icons) {
      if (icon.textContent?.includes("closed_caption_off")) {
        captionsOff = true;
        break;
      }
    }
    state.captionsOn = icons.length > 0 ? !captionsOff : null;
  }

  // Check if in a call
  state.inCall = micEl !== null && findElement(SELECTORS.leave) !== null;
}

// ── MutationObserver: data-is-muted (mic and camera) ──────────────────────────

const mutedObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.attributeName !== "data-is-muted") continue;
    const target = mutation.target as HTMLElement;

    const micEl = findElement(SELECTORS.mic);
    if (micEl && (target === micEl || micEl.contains(target) || target.contains(micEl))) {
      state.muted = micEl.getAttribute("data-is-muted") === "true";
      sendStateUpdate();
    }

    const camEl = findElement(SELECTORS.camera);
    if (camEl && (target === camEl || camEl.contains(target) || target.contains(camEl))) {
      state.videoOff = camEl.getAttribute("data-is-muted") === "true";
      sendStateUpdate();
    }
  }
});

mutedObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["data-is-muted"],
  subtree: true,
});

// ── MutationObserver: aria-pressed (hand raise) ───────────────────────────────

const ariaPressedObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.attributeName !== "aria-pressed") continue;
    const target = mutation.target as HTMLElement;
    const jsname = target.getAttribute("jsname");

    if (jsname === "FpSaz") {
      state.handRaised = target.getAttribute("aria-pressed") === "true";
      sendStateUpdate();
    }
  }
});

ariaPressedObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["aria-pressed"],
  subtree: true,
});

// ── MutationObserver: aria-label (captions — icon-based) ──────────────────────

const ariaLabelObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.attributeName !== "aria-label") continue;
    const target = mutation.target as HTMLElement;

    const captionsEl = findElement(SELECTORS.captions);
    if (!captionsEl) continue;
    if (target !== captionsEl && !captionsEl.contains(target) && !target.contains(captionsEl)) continue;

    const icons = captionsEl.querySelectorAll("i");
    let captionsOff = false;
    for (const icon of icons) {
      if (icon.textContent?.includes("closed_caption_off")) {
        captionsOff = true;
        break;
      }
    }
    if (icons.length > 0) {
      state.captionsOn = !captionsOff;
      sendStateUpdate();
    }
  }
});

ariaLabelObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["aria-label"],
  subtree: true,
});

// ── Call presence polling ─────────────────────────────────────────────────────

setInterval(() => {
  const wasInCall = state.inCall;
  const micEl = findElement(SELECTORS.mic);
  const leaveEl = findElement(SELECTORS.leave);
  state.inCall = micEl !== null && leaveEl !== null;

  if (state.inCall !== wasInCall) {
    if (state.inCall) {
      // Just joined a call — read full state
      readFullState();
    } else {
      resetCallState();
    }
    sendStateUpdate();
  }
}, CALL_POLL_INTERVAL);

// ── Initialize ────────────────────────────────────────────────────────────────

connect();
