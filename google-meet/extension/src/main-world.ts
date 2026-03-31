// Runs in the MAIN world (same JS context as Google Meet).
// Polls for click commands from the content script via a DOM attribute.
// Uses a full pointer+mouse event sequence because Meet's jsaction framework
// requires it for some buttons (hand raise, leave, etc.).

setInterval(() => {
  const selector = document.documentElement.getAttribute("data-omnideck-click");
  if (!selector) return;
  document.documentElement.removeAttribute("data-omnideck-click");
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}, 50);
