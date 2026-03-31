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

/**
 * Click a Meet button by asking the service worker to execute in the main world.
 * Content script events have isTrusted=false in the isolated world and Meet's
 * jsaction framework ignores them. We ask the service worker to use
 * chrome.scripting.executeScript with world:"MAIN" to click the element.
 */
function simulateClick(el: HTMLElement) {
  // Build a unique selector for the element
  const jsname = el.getAttribute("jsname");
  const tag = el.tagName.toLowerCase();
  let selector: string;
  if (jsname) {
    selector = `${tag}[jsname="${jsname}"]`;
  } else {
    const dataAction = el.getAttribute("data-mdc-dialog-action");
    selector = dataAction ? `[data-mdc-dialog-action="${dataAction}"]` : "";
  }
  if (!selector) { el.click(); return; }

  // Ask service worker to click in main world
  // The service worker uses chrome.scripting.executeScript with world: "MAIN"
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "click", selector }, (resp) => {
      // Report result back to agent via WebSocket for debugging
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "debug", msg: "click_response", selector, resp, error: chrome.runtime.lastError?.message }));
      }
    });
  } else {
    // chrome.runtime not available — report and fallback
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "debug", msg: "no_chrome_runtime" }));
    }
    el.click();
  }
}

function emojiButtonSelector(emoji: string): string {
  return `button[jsname="vnVdbf"][aria-label="${emoji}"]`;
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
  console.log("[OmniDeck] command:", command);
  switch (command) {
    case "toggle_mute": {
      const el = findElement(SELECTORS.mic);
      console.log("[OmniDeck] mic element:", el?.tagName, el?.getAttribute("jsname"));
      if (el) simulateClick(el);
      break;
    }

    case "toggle_video": {
      const el = findElement(SELECTORS.camera);
      console.log("[OmniDeck] camera element:", el?.tagName, el?.getAttribute("jsname"));
      if (el) simulateClick(el);
      break;
    }

    case "toggle_hand": {
      const el = findElement(SELECTORS.hand);
      console.log("[OmniDeck] hand element:", el?.tagName, el?.getAttribute("jsname"));
      if (el) simulateClick(el);
      break;
    }

    case "toggle_captions": {
      const el = findElement(SELECTORS.captions);
      if (el) simulateClick(el);
      break;
    }

    case "leave": {
      const confirmEl = document.querySelector<HTMLElement>(SELECTORS.leaveConfirm[0]);
      if (confirmEl) {
        simulateClick(confirmEl);
        break;
      }
      const leaveEl = findElement(SELECTORS.leave);
      if (leaveEl) simulateClick(leaveEl);
      setTimeout(() => {
        const btn = document.querySelector<HTMLElement>(SELECTORS.leaveConfirm[0]);
        if (btn) simulateClick(btn);
      }, 500);
      break;
    }

    case "toggle_chat": {
      const el = document.querySelector<HTMLElement>(SELECTORS.chatPanel[0]);
      if (el) simulateClick(el);
      break;
    }

    case "emoji_react":
      handleEmojiReact(params);
      break;

    case "get_state":
      readFullState();
      sendStateUpdate();
      break;
  }
}

function handleEmojiReact(params?: Record<string, unknown>) {
  const emoji = (params?.emoji as string) ?? "\u{1F44D}"; // default: thumbsup
  const selector = emojiButtonSelector(emoji);

  // Send to service worker — it handles opening the bar and clicking
  // the specific emoji all within one executeScript call in the main world
  chrome.runtime.sendMessage({
    type: "emoji_react",
    opener: SELECTORS.emojiPanelOpener[0],
    emoji: selector,
  });
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
