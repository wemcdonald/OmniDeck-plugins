// Service worker that handles click requests from the content script.
// Uses chrome.scripting.executeScript with world: "MAIN" to click Meet buttons.

function clickInTab(tabId: number, selector: string) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return "not_found";
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const o: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
      return "clicked";
    },
    args: [selector],
  });
}

function emojiReactInTab(tabId: number, openerSelector: string, emojiSelector: string) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (opener: string, emoji: string) => {
      // Open emoji bar if not already open
      const reactBtn = document.querySelector(opener) as HTMLElement | null;
      if (reactBtn && reactBtn.getAttribute("aria-pressed") !== "true") {
        reactBtn.click();
      }

      // Poll for the emoji button and click it
      let attempts = 0;
      const interval = setInterval(() => {
        const btn = document.querySelector(emoji) as HTMLElement | null;
        if (btn) {
          clearInterval(interval);
          btn.click();
        } else if (++attempts > 10) {
          clearInterval(interval);
        }
      }, 200);
    },
    args: [openerSelector, emojiSelector],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab?.id) return true;
  const tabId = sender.tab.id;

  if (msg.type === "click" && msg.selector) {
    clickInTab(tabId, msg.selector)
      .then((r) => sendResponse({ ok: true, result: r?.[0]?.result }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "emoji_react" && msg.opener && msg.emoji) {
    emojiReactInTab(tabId, msg.opener, msg.emoji)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return true;
});

// Keep service worker alive
chrome.alarms?.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener(() => {});
