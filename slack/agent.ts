// plugins/slack/agent.ts
// Opens Slack deep links to bring specific channels/DMs into focus.

import type { OmniDeck } from "@omnideck/agent-sdk";

export default function init(omnideck: OmniDeck) {
  omnideck.onAction("open_channel", async (params) => {
    const { teamId, channelId } = params as { teamId: string; channelId: string };
    if (!teamId || !channelId) return { success: false, error: "Missing teamId or channelId" };

    const url = `slack://channel?team=${teamId}&id=${channelId}`;
    if (omnideck.platform === "darwin") {
      await omnideck.exec("open", [url]);
    } else if (omnideck.platform === "windows") {
      await omnideck.exec("cmd", ["/c", "start", "", url]);
    } else {
      await omnideck.exec("xdg-open", [url]);
    }
    return { success: true };
  });

  omnideck.onAction("open_dm", async (params) => {
    const { teamId, channelId, isDm } = params as { teamId: string; channelId: string; isDm?: boolean };
    if (!teamId || !channelId) return { success: false, error: "Missing teamId or channelId" };

    const url = isDm
      ? `slack://user?team=${teamId}&id=${channelId}`
      : `slack://channel?team=${teamId}&id=${channelId}`;

    if (omnideck.platform === "darwin") {
      await omnideck.exec("open", [url]);
    } else if (omnideck.platform === "windows") {
      await omnideck.exec("cmd", ["/c", "start", "", url]);
    } else {
      await omnideck.exec("xdg-open", [url]);
    }
    return { success: true };
  });
}
