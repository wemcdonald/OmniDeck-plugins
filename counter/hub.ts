// plugins/counter/hub.ts

import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

const counterParams = z.object({
  id: field(z.string().default("default"), { label: "Counter ID", placeholder: "Unique name for this counter" }),
  color: field(z.string().default("#ffffff"), { label: "Number Color", fieldType: "color" as const }),
  background: field(z.string().default("#000000"), { label: "Background", fieldType: "color" as const }),
  font_size: field(z.enum(["small", "medium", "large"]).default("large"), { label: "Size" }),
  font: field(z.enum(["sans-serif", "monospace", "serif"]).default("sans-serif"), { label: "Font" }),
});

function renderCounter(size: number, count: number, color: string, bg: string, fontSize: string, font: string): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const countStr = String(count);
  const sizeMap = { small: 0.28, medium: 0.38, large: 0.50 };
  const scale = sizeMap[fontSize as keyof typeof sizeMap] ?? 0.50;
  // Shrink font for large numbers
  const digits = countStr.length;
  const adjusted = digits > 3 ? scale * (3 / digits) : scale;
  const px = Math.round(size * adjusted);

  ctx.font = `bold ${px}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(countStr, size / 2, size / 2);

  return canvas.toBuffer("image/png");
}

export const counterPlugin: OmniDeckPlugin = {
  id: "counter",
  name: "Counter",
  version: "1.0.0",
  icon: "ms:pin",

  async init(ctx: PluginContext) {
    // Store counts in plugin state so they persist across renders
    const counts = new Map<string, number>();

    function getCount(id: string): number {
      const stored = ctx.state.get("counter", `count:${id}`) as number | undefined;
      if (stored !== undefined) return stored;
      return counts.get(id) ?? 0;
    }

    function setCount(id: string, value: number) {
      counts.set(id, value);
      ctx.state.set("counter", `count:${id}`, value);
    }

    ctx.registerAction({
      id: "increment",
      name: "Increment",
      description: "Add one to the counter",
      icon: "ms:add",
      paramsSchema: counterParams,
      async execute(params) {
        const p = counterParams.parse(params);
        setCount(p.id, getCount(p.id) + 1);
      },
    });

    ctx.registerAction({
      id: "reset",
      name: "Reset",
      description: "Reset the counter to zero",
      icon: "ms:restart-alt",
      paramsSchema: z.object({
        id: field(z.string().default("default"), { label: "Counter ID" }),
      }),
      async execute(params) {
        const p = params as { id?: string };
        setCount(p.id ?? "default", 0);
      },
    });

    ctx.registerStateProvider({
      id: "display",
      name: "Counter Display",
      description: "Shows the current count",
      icon: "ms:pin",
      providesIcon: true,
      paramsSchema: counterParams,
      templateVariables: [
        { key: "count", label: "Count", example: "42" },
      ],
      resolve(params) {
        const p = counterParams.parse(params);
        const count = getCount(p.id);
        const icon = renderCounter(144, count, p.color, p.background, p.font_size, p.font);
        return {
          state: { icon, iconFullBleed: true },
          variables: { count: String(count) },
        };
      },
    });

    ctx.registerPreset({
      id: "counter",
      name: "Counter",
      description: "Tap to count up, long press to reset",
      category: "Utility",
      icon: "ms:pin",
      action: "increment",
      stateProvider: "display",
      defaults: { icon: "ms:pin" },
      longPressAction: "reset",
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
