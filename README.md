# OmniDeck Plugins

Community plugins for [OmniDeck](https://github.com/wemcdonald/OmniDeck).

## Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| [bettertouchtool](bettertouchtool/) | Agent (macOS) | Trigger BetterTouchTool named triggers from your deck |
| [clock](clock/) | Hub | Analog and digital clock display with configurable timezone and colors |
| [counter](counter/) | Hub | Tap to count up, long press to reset — customizable styling |
| [discord](discord/) | Hub + Agent | Mute, deafen, video, screenshare, voice channel shortcuts, per-user volume mixer |
| [google-meet](google-meet/) | Hub + Agent | Mute, camera, hand raise, captions, reactions, leave — requires companion Chrome extension |
| [monitor-control](monitor-control/) | Agent | Switch monitor inputs via DDC/CI on macOS, Windows, and Linux |
| [slack](slack/) | Hub + Agent | Unread counts, open channels/DMs, Do Not Disturb — multi-workspace |
| [spotify](spotify/) | Hub + Agent | Play/pause, shuffle, repeat, volume, album art, scrolling track info |
| [weather](weather/) | Hub | Real-time weather and multi-day forecast — powered by Open-Meteo, no API key needed |
| [zoom](zoom/) | Hub + Agent | Mute, camera, screen share, hand raise, reactions, recording, leave |

## Installation

Plugins in this repo are sourced automatically by OmniDeck. Install them from the **Plugins** page in the web UI — no manual file copying needed. See the [plugin install guide](https://github.com/wemcdonald/OmniDeck/blob/master/docs/plugin-install.md) for the full walkthrough.

If you want to install a plugin manually (e.g. a development build or a plugin not yet in the registry):

```bash
# Copy the plugin directory into your hub's plugins folder
cp -r slack /path/to/.omnideck/plugins/

# Then restart the hub (or use the web UI Plugins page to reload)
sudo systemctl restart omnideck-hub
```

The hub watches the `plugins/` directory and will detect, bundle, and distribute the plugin to connected agents automatically.

## Writing Plugins

See the [OmniDeck Plugin Guide](https://github.com/wemcdonald/OmniDeck/blob/master/docs/plugin-guide.md).
