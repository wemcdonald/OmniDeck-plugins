// plugins/bettertouchtool/hub.ts

import { z } from "zod";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

export const betterTouchToolPlugin: OmniDeckPlugin = {
  id: "bettertouchtool",
  name: "BetterTouchTool",
  version: "0.1.0",
  icon: "ms:touch-app",

  async init(ctx: PluginContext) {
    const targetParam = {
      target: field(z.string().optional(), { label: "Target", fieldType: "agent" as const }),
    };

    // -- Action: run a BTT named trigger --
    ctx.registerAction({
      id: "run_trigger",
      name: "Run BTT Trigger",
      description: "Execute a BetterTouchTool named trigger",
      icon: "ms:touch-app",
      paramsSchema: z.object({
        ...targetParam,
        name: field(z.string(), { label: "Trigger Name" }),
      }),
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = (p.target as string | undefined) ?? actionCtx.focusedAgent;
        ctx.state.set("bettertouchtool", `pending:${target}:run_trigger`, {
          params,
          timestamp: Date.now(),
        });
      },
    });

    // -- Action: run a BTT action by identifier --
    ctx.registerAction({
      id: "run_action",
      name: "Run BTT Action",
      description: "Execute a BetterTouchTool action by identifier",
      icon: "ms:play-arrow",
      paramsSchema: z.object({
        ...targetParam,
        action: field(z.string(), { label: "Action Identifier" }),
      }),
      async execute(params, actionCtx) {
        const p = params as Record<string, unknown>;
        const target = (p.target as string | undefined) ?? actionCtx.focusedAgent;
        ctx.state.set("bettertouchtool", `pending:${target}:run_action`, {
          params,
          timestamp: Date.now(),
        });
      },
    });

    // -- State Provider: trigger count --
    ctx.registerStateProvider({
      id: "triggers",
      name: "BTT Triggers",
      description: "Number of available BetterTouchTool triggers",
      icon: "ms:touch-app",
      paramsSchema: z.object(targetParam),
      templateVariables: [
        { key: "trigger_count", label: "Trigger Count", example: "12" },
      ],
      resolve(params) {
        const p = params as Record<string, unknown>;
        const target = p.target as string | undefined;
        const triggers = target
          ? (ctx.state.get("bettertouchtool", `agent:${target}:triggers`) as unknown[] | undefined)
          : undefined;
        const count = triggers?.length ?? 0;
        return {
          state: { label: count > 0 ? `${count} triggers` : "..." },
          variables: { trigger_count: String(count) },
        };
      },
    });

    // -- Preset: BTT trigger button --
    ctx.registerPreset({
      id: "btt_trigger",
      name: "BTT Trigger",
      description: "Execute a BetterTouchTool named trigger",
      category: "Automation",
      icon: "ms:touch-app",
      action: "run_trigger",
      defaults: {
        icon: "ms:touch-app",
        label: "BTT",
      },
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
