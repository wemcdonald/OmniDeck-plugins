// plugins/clock/hub.ts
// Hub-only plugin: renders analog and digital clocks on deck buttons.

import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const clockParams = z.object({
  mode: field(z.enum(["analog", "digital"]).default("analog"), { label: "Mode" }),
  timezone: field(z.string().optional(), { label: "Timezone", placeholder: "America/Los_Angeles" }),
  foreground: field(z.string().optional(), { label: "Foreground", fieldType: "color" as const }),
  background: field(z.string().optional(), { label: "Background", fieldType: "color" as const }),
  seconds_hand: field(z.boolean().default(true), { label: "Show Seconds" }),
});

function getTime(timezone?: string): Date {
  // Create a date and extract parts in the desired timezone
  return new Date();
}

function getTimeParts(timezone?: string) {
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const s = parseInt(parts.find((p) => p.type === "second")?.value ?? "0", 10);
  return { h, m, s, h12: h % 12 };
}

function formatTime(timezone?: string, showSeconds = true): string {
  const { h, m, s } = getTimeParts(timezone);
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  if (!showSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(s).padStart(2, "0")}`;
}

// ── Analog clock renderer ─────────────────────────────────────────────────

function renderAnalogClock(
  size: number,
  fg: string,
  bg: string,
  showSeconds: boolean,
  timezone?: string,
): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.44;

  // Background
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, r + size * 0.04, 0, TAU);
  ctx.fill();

  // Clock face outline
  ctx.strokeStyle = fg;
  ctx.lineWidth = Math.max(1, size * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();

  // Hour markers
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * DEG;
    const inner = i % 3 === 0 ? r * 0.75 : r * 0.85;
    ctx.strokeStyle = fg;
    ctx.lineWidth = i % 3 === 0 ? size * 0.03 : size * 0.015;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * r * 0.95, cy + Math.sin(angle) * r * 0.95);
    ctx.stroke();
  }

  const { h12, m, s } = getTimeParts(timezone);

  // Hour hand
  const hAngle = ((h12 + m / 60) * 30 - 90) * DEG;
  ctx.strokeStyle = fg;
  ctx.lineCap = "round";
  ctx.lineWidth = size * 0.05;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(hAngle) * r * 0.5, cy + Math.sin(hAngle) * r * 0.5);
  ctx.stroke();

  // Minute hand
  const mAngle = ((m + s / 60) * 6 - 90) * DEG;
  ctx.lineWidth = size * 0.03;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(mAngle) * r * 0.75, cy + Math.sin(mAngle) * r * 0.75);
  ctx.stroke();

  // Second hand
  if (showSeconds) {
    const sAngle = (s * 6 - 90) * DEG;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = size * 0.015;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sAngle) * r * 0.85, cy + Math.sin(sAngle) * r * 0.85);
    ctx.stroke();
  }

  // Center dot
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.03, 0, TAU);
  ctx.fill();

  return canvas.toBuffer("image/png");
}

// ── Digital clock renderer ────────────────────────────────────────────────

function renderDigitalClock(
  size: number,
  fg: string,
  bg: string,
  showSeconds: boolean,
  timezone?: string,
): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // Time text
  const timeStr = formatTime(timezone, showSeconds);
  const fontSize = showSeconds ? Math.round(size * 0.22) : Math.round(size * 0.30);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(timeStr, size / 2, size / 2);

  return canvas.toBuffer("image/png");
}

// ── Plugin ────────────────────────────────────────────────────────────────

export const clockPlugin: OmniDeckPlugin = {
  id: "clock",
  name: "Clock",
  version: "1.0.0",
  icon: "ms:schedule",

  async init(ctx: PluginContext) {
    // Tick every second to trigger re-renders
    let tick = 0;
    const timer = setInterval(() => {
      ctx.state.set("clock", "tick", ++tick);
    }, 1000);

    ctx.registerStateProvider({
      id: "display",
      name: "Clock Display",
      description: "Shows the current time as an analog or digital clock",
      icon: "ms:schedule",
      providesIcon: true,
      paramsSchema: clockParams,
      templateVariables: [
        { key: "time", label: "Current Time", example: "14:30:00" },
        { key: "time_short", label: "Time (no seconds)", example: "14:30" },
      ],
      resolve(params) {
        const p = clockParams.parse(params);
        const fg = p.foreground || "#ffffff";
        const bg = p.background || "#000000";
        const tz = p.timezone || undefined;
        const size = 144; // render at higher res, renderer will scale down

        const icon = p.mode === "digital"
          ? renderDigitalClock(size, fg, bg, p.seconds_hand, tz)
          : renderAnalogClock(size, fg, bg, p.seconds_hand, tz);

        return {
          state: { icon },
          variables: {
            time: formatTime(tz, true),
            time_short: formatTime(tz, false),
          },
        };
      },
    });

    // ── Presets ────────────────────────────────────────────────────────────

    ctx.registerPreset({
      id: "analog",
      name: "Analog Clock",
      description: "Analog clock face with hour, minute, and second hands",
      category: "Clock",
      icon: "ms:schedule",
      stateProvider: "display",
      defaults: {
        icon: "ms:schedule",
      },
    });

    ctx.registerPreset({
      id: "digital",
      name: "Digital Clock",
      description: "Digital time display",
      category: "Clock",
      icon: "ms:digital-clock",
      stateProvider: "display",
      defaults: {
        icon: "ms:schedule",
      },
    });

    ctx.setHealth({ status: "ok" });

    // Store cleanup for destroy
    (ctx as any)._clockTimer = timer;
  },

  async destroy() {
    // Timer cleanup is handled by the hub clearing intervals on destroy
  },
};
