// plugins/slack/hub.ts
// Slack integration: unread counts, open channels/DMs, DND control.
// Polls the Slack Web API using user tokens (xoxp-). No bot token needed.
// Supports multiple workspaces with independent polling.

import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import { field, type OmniDeckPlugin, type PluginContext } from "@omnideck/plugin-schema";

// ── Slack API helpers ─────────────────────────────────────────────────────

const SLACK_API = "https://slack.com/api";

async function slackApi(method: string, token: string, params?: Record<string, unknown>): Promise<any> {
  const url = `${SLACK_API}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`);
  return data;
}

// ── Types ─────────────────────────────────────────────────────────────────

interface SlackUser {
  id: string;
  name: string;           // username
  displayName: string;    // real_name or display_name
  avatar72?: string;      // image_72 URL
  deleted: boolean;
  isBot: boolean;
}

interface SlackChannel {
  id: string;
  name: string;
  isIm: boolean;
  isMpim: boolean;
  isPrivate: boolean;
  userId?: string;         // for IMs: the other user
  unread: number;
  unreadDisplay: number;
  mentionCount: number;
}

interface DndInfo {
  snoozed: boolean;
  snoozeRemaining?: number; // seconds
  snoozeEndtime?: number;
}

// ── Workspace class ───────────────────────────────────────────────────────

class SlackWorkspace {
  readonly name: string;
  readonly token: string;
  teamId = "";
  teamName = "";
  userId = "";

  users = new Map<string, SlackUser>();
  channels = new Map<string, SlackChannel>();
  dnd: DndInfo = { snoozed: false };
  ready = false;

  private usersByName = new Map<string, string>();  // lowercase name → ID
  private channelsByName = new Map<string, string>(); // lowercase name → ID
  private imByUserId = new Map<string, string>();     // user ID → IM channel ID

  constructor(name: string, token: string) {
    this.name = name;
    this.token = token;
  }

  async init(): Promise<void> {
    const auth = await slackApi("auth.test", this.token);
    this.teamId = auth.team_id;
    this.teamName = auth.team;
    this.userId = auth.user_id;
    await this.refreshUsers();
    await this.refreshConversations();
    await this.refreshDnd();
    this.ready = true;
  }

  async refreshUsers(): Promise<void> {
    try {
      let cursor: string | undefined;
      const users: SlackUser[] = [];
      do {
        const data = await slackApi("users.list", this.token, {
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const m of data.members ?? []) {
          const u: SlackUser = {
            id: m.id,
            name: m.name,
            displayName: m.profile?.display_name || m.profile?.real_name || m.name,
            avatar72: m.profile?.image_72,
            deleted: m.deleted ?? false,
            isBot: m.is_bot ?? false,
          };
          users.push(u);
        }
        cursor = data.response_metadata?.next_cursor;
      } while (cursor);

      this.users.clear();
      this.usersByName.clear();
      for (const u of users) {
        this.users.set(u.id, u);
        this.usersByName.set(u.name.toLowerCase(), u.id);
        this.usersByName.set(u.displayName.toLowerCase(), u.id);
      }
    } catch {
      // Keep stale cache on error
    }
  }

  async refreshConversations(): Promise<void> {
    try {
      let cursor: string | undefined;
      const channels: SlackChannel[] = [];
      do {
        const data = await slackApi("conversations.list", this.token, {
          types: "public_channel,private_channel,im,mpim",
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const c of data.channels ?? []) {
          const ch: SlackChannel = {
            id: c.id,
            name: c.name ?? c.id,
            isIm: c.is_im ?? false,
            isMpim: c.is_mpim ?? false,
            isPrivate: c.is_private ?? false,
            userId: c.user,
            unread: c.unread_count ?? 0,
            unreadDisplay: c.unread_count_display ?? 0,
            mentionCount: c.mention_count ?? 0,
          };
          channels.push(ch);
        }
        cursor = data.response_metadata?.next_cursor;
      } while (cursor);

      this.channels.clear();
      this.channelsByName.clear();
      this.imByUserId.clear();
      for (const ch of channels) {
        this.channels.set(ch.id, ch);
        if (ch.name) this.channelsByName.set(ch.name.toLowerCase(), ch.id);
        if (ch.isIm && ch.userId) this.imByUserId.set(ch.userId, ch.id);
      }
    } catch {
      // Keep stale cache
    }
  }

  async refreshChannelInfo(channelId: string): Promise<void> {
    try {
      const data = await slackApi("conversations.info", this.token, {
        channel: channelId,
      });
      const c = data.channel;
      const existing = this.channels.get(channelId);
      if (existing) {
        existing.unread = c.unread_count ?? existing.unread;
        existing.unreadDisplay = c.unread_count_display ?? existing.unreadDisplay;
        existing.mentionCount = c.mention_count ?? existing.mentionCount;
      }
    } catch {
      // Ignore
    }
  }

  async refreshDnd(): Promise<void> {
    try {
      const data = await slackApi("dnd.info", this.token);
      this.dnd = {
        snoozed: data.snooze_enabled ?? false,
        snoozeRemaining: data.snooze_remaining,
        snoozeEndtime: data.snooze_endtime,
      };
    } catch {
      // Keep stale
    }
  }

  resolveChannelId(nameOrId: string): string | undefined {
    if (this.channels.has(nameOrId)) return nameOrId;
    const clean = nameOrId.replace(/^#/, "").toLowerCase();
    return this.channelsByName.get(clean);
  }

  resolveUserId(nameOrId: string): string | undefined {
    if (this.users.has(nameOrId)) return nameOrId;
    return this.usersByName.get(nameOrId.toLowerCase());
  }

  getImChannelForUser(userId: string): string | undefined {
    return this.imByUserId.get(userId);
  }

  getTotalUnread(): { count: number; mentions: number } {
    let count = 0;
    let mentions = 0;
    for (const ch of this.channels.values()) {
      count += ch.unreadDisplay;
      mentions += ch.mentionCount;
    }
    return { count, mentions };
  }
}

// ── Canvas renderers ──────────────────────────────────────────────────────

const SLACK_PURPLE = "#4A154B";
const SLACK_GREEN = "#2BAC76";

function renderUnreadButton(size: number, count: number, mentions: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = SLACK_PURPLE;
  ctx.fillRect(0, 0, size, size);

  // Unread count, large
  if (count > 0) {
    const countStr = count > 999 ? "999+" : String(count);
    const fontSize = count > 99 ? Math.round(size * 0.35) : Math.round(size * 0.45);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(countStr, size / 2, size * 0.45);
  } else {
    // Checkmark when caught up
    ctx.font = `${Math.round(size * 0.4)}px NotoColorEmoji, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✓", size / 2, size * 0.42);
  }

  // Label
  ctx.font = `bold ${Math.round(size * 0.14)}px sans-serif`;
  ctx.fillStyle = "#d4a0d5";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(count > 0 ? "unread" : "all clear", size / 2, size - size * 0.06);

  return canvas.toBuffer("image/png");
}

function renderChannelButton(size: number, name: string, unread: number, isPrivate: boolean): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1a1d21";
  ctx.fillRect(0, 0, size, size);

  // Channel prefix
  const prefix = isPrivate ? "🔒" : "#";
  const prefixSize = Math.round(size * 0.35);
  ctx.font = isPrivate
    ? `${prefixSize}px NotoColorEmoji, sans-serif`
    : `bold ${prefixSize}px sans-serif`;
  ctx.fillStyle = unread > 0 ? "#ffffff" : "#616061";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(prefix, size / 2, size * 0.35);

  // Channel name
  const nameSize = Math.round(size * 0.14);
  ctx.font = `${unread > 0 ? "bold " : ""}${nameSize}px sans-serif`;
  ctx.fillStyle = unread > 0 ? "#ffffff" : "#b0afb0";
  ctx.textBaseline = "bottom";
  const displayName = name.length > 12 ? name.slice(0, 11) + "…" : name;
  ctx.fillText(displayName, size / 2, size - size * 0.06);

  // Unread badge
  if (unread > 0) {
    const badgeStr = unread > 99 ? "99+" : String(unread);
    const badgeSize = Math.round(size * 0.16);
    const badgeWidth = Math.max(size * 0.2, badgeStr.length * badgeSize * 0.6 + size * 0.06);
    const badgeX = size - badgeWidth / 2 - size * 0.08;
    const badgeY = size * 0.08;

    ctx.fillStyle = "#e01e5a";
    ctx.beginPath();
    ctx.arc(badgeX, badgeY + badgeSize / 2, badgeWidth / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = `bold ${badgeSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeStr, badgeX, badgeY + badgeSize / 2);
  }

  return canvas.toBuffer("image/png");
}

function renderDmButton(size: number, displayName: string, unread: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1a1d21";
  ctx.fillRect(0, 0, size, size);

  // User initial circle
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const circleR = size * 0.22;
  const circleY = size * 0.38;

  // Color based on initials hash
  const colors = ["#e01e5a", "#36c5f0", "#2eb67d", "#ecb22e", "#6b4fbb"];
  let hash = 0;
  for (let i = 0; i < displayName.length; i++) hash = (hash * 31 + displayName.charCodeAt(i)) | 0;
  ctx.fillStyle = colors[Math.abs(hash) % colors.length];
  ctx.beginPath();
  ctx.arc(size / 2, circleY, circleR, 0, Math.PI * 2);
  ctx.fill();

  // Initials
  ctx.font = `bold ${Math.round(size * 0.22)}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, size / 2, circleY);

  // Display name
  const nameSize = Math.round(size * 0.13);
  ctx.font = `${unread > 0 ? "bold " : ""}${nameSize}px sans-serif`;
  ctx.fillStyle = unread > 0 ? "#ffffff" : "#b0afb0";
  ctx.textBaseline = "bottom";
  const short = displayName.length > 12 ? displayName.slice(0, 11) + "…" : displayName;
  ctx.fillText(short, size / 2, size - size * 0.06);

  // Unread badge
  if (unread > 0) {
    const badgeStr = unread > 99 ? "99+" : String(unread);
    const badgeSize = Math.round(size * 0.16);
    const badgeX = size - size * 0.18;
    const badgeY = size * 0.08;

    ctx.fillStyle = "#e01e5a";
    ctx.beginPath();
    ctx.arc(badgeX, badgeY + badgeSize / 2, Math.max(size * 0.1, badgeStr.length * badgeSize * 0.3 + size * 0.03), 0, Math.PI * 2);
    ctx.fill();

    ctx.font = `bold ${badgeSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeStr, badgeX, badgeY + badgeSize / 2);
  }

  return canvas.toBuffer("image/png");
}

// ── Schemas ───────────────────────────────────────────────────────────────

const targetParam = {
  target: field(z.string().optional(), { label: "Target", fieldType: "agent" as const }),
};

const workspaceParam = {
  workspace: field(z.string().optional(), { label: "Workspace", placeholder: "Omit for default/all" }),
};

const channelParams = z.object({
  ...targetParam,
  ...workspaceParam,
  channel: field(z.string(), { label: "Channel", placeholder: "#general or channel ID" }),
});

const dmParams = z.object({
  ...targetParam,
  ...workspaceParam,
  user: field(z.string(), { label: "User", placeholder: "Display name, username, or user ID" }),
});

const dndParams = z.object({
  ...workspaceParam,
  duration: field(z.number().default(60), { label: "Snooze Duration (minutes)" }),
});

const statusParams = z.object({
  ...workspaceParam,
  emoji: field(z.string().optional(), { label: "Status Emoji", placeholder: ":calendar:" }),
  text: field(z.string().optional(), { label: "Status Text", placeholder: "In a meeting" }),
  duration: field(z.number().default(0), { label: "Duration (minutes, 0=permanent)" }),
});

const unreadViewParams = z.object({ ...workspaceParam });
const channelViewParams = z.object({
  ...workspaceParam,
  channel: field(z.string(), { label: "Channel", placeholder: "#general" }),
});
const dmViewParams = z.object({
  ...workspaceParam,
  user: field(z.string(), { label: "User", placeholder: "Display name or username" }),
});
const dndViewParams = z.object({ ...workspaceParam });

// ── Config Schema ─────────────────────────────────────────────────────────

const slackConfigSchema = z.object({
  token: field(z.string().optional(), { label: "User Token", placeholder: "xoxp-..." }),
  poll_interval: field(z.string().default("60s").optional(), { label: "Poll Interval", placeholder: "60s" }),
});

// ── Plugin ────────────────────────────────────────────────────────────────

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m)$/);
  if (!match) return 60000;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return 60000;
}

export const slackPlugin: OmniDeckPlugin = {
  id: "slack",
  name: "Slack",
  version: "1.0.0",
  icon: "ms:chat",
  configSchema: slackConfigSchema,

  async init(ctx: PluginContext) {
    const config = ctx.config as Record<string, unknown>;
    const workspaces = new Map<string, SlackWorkspace>();

    // Parse workspace config — support both single-token and multi-workspace
    const wsConfig = config.workspaces as Record<string, { token: string }> | undefined;
    if (wsConfig) {
      for (const [name, ws] of Object.entries(wsConfig)) {
        if (ws.token) workspaces.set(name, new SlackWorkspace(name, ws.token));
      }
    } else if (config.token) {
      workspaces.set("default", new SlackWorkspace("default", config.token as string));
    }

    if (workspaces.size === 0) {
      ctx.setHealth({ status: "misconfigured", message: "No Slack token configured" });
      return;
    }

    // Initialize all workspaces
    for (const [name, ws] of workspaces) {
      try {
        await ws.init();
        ctx.log.info({ workspace: name, team: ws.teamName, channels: ws.channels.size, users: ws.users.size }, "Slack workspace connected");
      } catch (err) {
        ctx.log.error({ workspace: name, err: String(err) }, "Failed to connect to Slack workspace");
      }
    }

    const pollInterval = parseDuration((config.poll_interval as string) ?? "60s");

    // Get the first (or named) workspace
    function getWorkspace(name?: string): SlackWorkspace | undefined {
      if (name) return workspaces.get(name);
      return workspaces.values().next().value;
    }

    // ── Polling ─────────────────────────────────────────────────────────

    setInterval(async () => {
      for (const ws of workspaces.values()) {
        if (!ws.ready) continue;
        await ws.refreshConversations();
        await ws.refreshDnd();
      }
      ctx.state.set("slack", "tick", Date.now());
    }, pollInterval);

    // Refresh users less frequently
    setInterval(async () => {
      for (const ws of workspaces.values()) {
        if (!ws.ready) continue;
        await ws.refreshUsers();
      }
    }, 30 * 60 * 1000);

    // ── Helper: resolve target for agent actions ────────────────────────

    function resolveTarget(params: Record<string, unknown>, actionCtx: { focusedAgent?: string }) {
      return (params.target as string | undefined) ?? actionCtx.focusedAgent;
    }

    // ── Actions ─────────────────────────────────────────────────────────

    ctx.registerAction({
      id: "open_channel",
      name: "Open Channel",
      description: "Open a Slack channel in the desktop app",
      icon: "ms:tag",
      paramsSchema: channelParams,
      async execute(params, actionCtx) {
        const p = channelParams.parse(params);
        const ws = getWorkspace(p.workspace);
        if (!ws) return;
        const channelId = ws.resolveChannelId(p.channel);
        if (!channelId) return;
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("slack", `pending:${target}:open_channel`, {
          params: { teamId: ws.teamId, channelId },
          timestamp: Date.now(),
        });
      },
    });

    ctx.registerAction({
      id: "open_dm",
      name: "Open DM",
      description: "Open a direct message in the Slack desktop app",
      icon: "ms:person",
      paramsSchema: dmParams,
      async execute(params, actionCtx) {
        const p = dmParams.parse(params);
        const ws = getWorkspace(p.workspace);
        if (!ws) return;
        const userId = ws.resolveUserId(p.user);
        if (!userId) return;
        const imId = ws.getImChannelForUser(userId);
        const target = resolveTarget(p, actionCtx);
        ctx.state.set("slack", `pending:${target}:open_dm`, {
          params: { teamId: ws.teamId, channelId: imId ?? userId, isDm: !imId },
          timestamp: Date.now(),
        });
      },
    });

    ctx.registerAction({
      id: "toggle_dnd",
      name: "Toggle DND",
      description: "Pause or resume Slack notifications",
      icon: "ms:notifications-off",
      paramsSchema: dndParams,
      async execute(params) {
        const p = dndParams.parse(params);
        const ws = getWorkspace(p.workspace);
        if (!ws) return;
        try {
          if (ws.dnd.snoozed) {
            await slackApi("dnd.endSnooze", ws.token);
            ws.dnd = { snoozed: false };
          } else {
            const data = await slackApi("dnd.setSnooze", ws.token, { num_minutes: p.duration });
            ws.dnd = {
              snoozed: true,
              snoozeRemaining: data.snooze_remaining,
              snoozeEndtime: data.snooze_endtime,
            };
          }
          ctx.state.set("slack", "dnd_updated", Date.now());
        } catch (err) {
          ctx.log.error({ err: String(err) }, "DND toggle failed");
        }
      },
    });

    ctx.registerAction({
      id: "set_status",
      name: "Set Status",
      description: "Set your Slack status emoji and text",
      icon: "ms:mood",
      paramsSchema: statusParams,
      async execute(params) {
        const p = statusParams.parse(params);
        const ws = getWorkspace(p.workspace);
        if (!ws) return;
        const profile: Record<string, unknown> = {
          status_text: p.text ?? "",
          status_emoji: p.emoji ?? "",
          status_expiration: p.duration > 0 ? Math.floor(Date.now() / 1000) + p.duration * 60 : 0,
        };
        try {
          await slackApi("users.profile.set", ws.token, { profile });
          ctx.state.set("slack", "status_updated", Date.now());
        } catch (err) {
          ctx.log.error({ err: String(err) }, "Set status failed");
        }
      },
    });

    // ── State Providers ─────────────────────────────────────────────────

    ctx.registerStateProvider({
      id: "unread",
      name: "Unread Count",
      description: "Total unread messages across all channels",
      icon: "ms:chat",
      providesIcon: true,
      paramsSchema: unreadViewParams,
      templateVariables: [
        { key: "count", label: "Unread Count", example: "12" },
        { key: "mentions", label: "Mention Count", example: "3" },
      ],
      resolve(params) {
        const p = unreadViewParams.parse(params);
        let count = 0;
        let mentions = 0;

        if (p.workspace) {
          const ws = getWorkspace(p.workspace);
          if (ws?.ready) {
            const t = ws.getTotalUnread();
            count = t.count;
            mentions = t.mentions;
          }
        } else {
          for (const ws of workspaces.values()) {
            if (!ws.ready) continue;
            const t = ws.getTotalUnread();
            count += t.count;
            mentions += t.mentions;
          }
        }

        const icon = renderUnreadButton(144, count, mentions);
        return {
          state: {
            icon,
            iconFullBleed: true,
            badge: count > 0 ? count : undefined,
            badgeColor: mentions > 0 ? "#e01e5a" : undefined,
          },
          variables: {
            count: String(count),
            mentions: String(mentions),
          },
        };
      },
    });

    ctx.registerStateProvider({
      id: "channel",
      name: "Channel Status",
      description: "Unread count and status for a specific channel",
      icon: "ms:tag",
      providesIcon: true,
      paramsSchema: channelViewParams,
      templateVariables: [
        { key: "name", label: "Channel Name", example: "#general" },
        { key: "unread", label: "Unread Count", example: "5" },
      ],
      resolve(params) {
        const p = channelViewParams.parse(params);
        const ws = p.workspace ? getWorkspace(p.workspace) : getWorkspace();
        if (!ws?.ready) {
          return {
            state: { icon: "ms:tag", iconColor: "#6b7280" },
            variables: { name: p.channel, unread: "0" },
          };
        }

        const channelId = ws.resolveChannelId(p.channel);
        const ch = channelId ? ws.channels.get(channelId) : undefined;
        if (!ch) {
          return {
            state: { icon: "ms:tag", iconColor: "#616061", opacity: 0.5 },
            variables: { name: p.channel, unread: "0" },
          };
        }

        // Trigger refresh for this specific channel
        ws.refreshChannelInfo(ch.id).then(() => {
          ctx.state.set("slack", `ch:${ch.id}`, Date.now());
        });

        const icon = renderChannelButton(144, ch.name, ch.unreadDisplay, ch.isPrivate);
        return {
          state: {
            icon,
            iconFullBleed: true,
            badge: ch.unreadDisplay > 0 ? ch.unreadDisplay : undefined,
          },
          variables: {
            name: `#${ch.name}`,
            unread: String(ch.unreadDisplay),
          },
        };
      },
    });

    ctx.registerStateProvider({
      id: "dm",
      name: "DM Status",
      description: "Unread count for a direct message conversation",
      icon: "ms:person",
      providesIcon: true,
      paramsSchema: dmViewParams,
      templateVariables: [
        { key: "name", label: "User Name", example: "John Doe" },
        { key: "unread", label: "Unread Count", example: "2" },
      ],
      resolve(params) {
        const p = dmViewParams.parse(params);
        const ws = p.workspace ? getWorkspace(p.workspace) : getWorkspace();
        if (!ws?.ready) {
          return {
            state: { icon: "ms:person", iconColor: "#6b7280" },
            variables: { name: p.user, unread: "0" },
          };
        }

        const userId = ws.resolveUserId(p.user);
        const user = userId ? ws.users.get(userId) : undefined;
        const imId = userId ? ws.getImChannelForUser(userId) : undefined;
        const ch = imId ? ws.channels.get(imId) : undefined;
        const unread = ch?.unreadDisplay ?? 0;
        const displayName = user?.displayName ?? p.user;

        if (imId) {
          ws.refreshChannelInfo(imId).then(() => {
            ctx.state.set("slack", `dm:${imId}`, Date.now());
          });
        }

        const icon = renderDmButton(144, displayName, unread);
        return {
          state: {
            icon,
            iconFullBleed: true,
            badge: unread > 0 ? unread : undefined,
          },
          variables: {
            name: displayName,
            unread: String(unread),
          },
        };
      },
    });

    ctx.registerStateProvider({
      id: "dnd_status",
      name: "DND Status",
      description: "Do Not Disturb / snooze status",
      icon: "ms:notifications",
      providesIcon: true,
      paramsSchema: dndViewParams,
      templateVariables: [
        { key: "dnd_state", label: "DND State", example: "Snoozed" },
        { key: "snooze_remaining", label: "Remaining", example: "45m" },
      ],
      resolve(params) {
        const p = dndViewParams.parse(params);
        const ws = p.workspace ? getWorkspace(p.workspace) : getWorkspace();

        if (!ws?.ready) {
          return {
            state: { icon: "ms:notifications", iconColor: "#6b7280" },
            variables: { dnd_state: "", snooze_remaining: "" },
          };
        }

        if (ws.dnd.snoozed) {
          const remaining = ws.dnd.snoozeRemaining
            ? Math.max(0, Math.ceil(ws.dnd.snoozeRemaining / 60))
            : 0;
          const label = remaining > 0 ? `${remaining}m` : "Paused";
          return {
            state: {
              icon: "ms:notifications-off",
              iconColor: "#e01e5a",
              background: "#3b1015",
            },
            variables: { dnd_state: "Snoozed", snooze_remaining: label },
          };
        }

        return {
          state: { icon: "ms:notifications", iconColor: "#2BAC76" },
          variables: { dnd_state: "Active", snooze_remaining: "" },
        };
      },
    });

    // ── Presets ──────────────────────────────────────────────────────────

    ctx.registerPreset({
      id: "unread",
      name: "Unread Messages",
      description: "Total unread message count across all channels",
      category: "Slack",
      icon: "ms:chat",
      stateProvider: "unread",
      defaults: { icon: "ms:chat" },
    });

    ctx.registerPreset({
      id: "channel",
      name: "Channel",
      description: "Open a Slack channel and show unread count",
      category: "Slack",
      icon: "ms:tag",
      action: "open_channel",
      stateProvider: "channel",
      defaults: { icon: "ms:tag", label: "{{name}}" },
    });

    ctx.registerPreset({
      id: "dm",
      name: "Direct Message",
      description: "Open a DM and show unread count",
      category: "Slack",
      icon: "ms:person",
      action: "open_dm",
      stateProvider: "dm",
      defaults: { icon: "ms:person", label: "{{name}}" },
    });

    ctx.registerPreset({
      id: "dnd",
      name: "Do Not Disturb",
      description: "Toggle Slack notification snooze",
      category: "Slack",
      icon: "ms:notifications",
      action: "toggle_dnd",
      stateProvider: "dnd_status",
      defaults: { icon: "ms:notifications", label: "{{dnd_state}}" },
    });

    ctx.setHealth({ status: "ok" });
  },

  async destroy() {},
};
