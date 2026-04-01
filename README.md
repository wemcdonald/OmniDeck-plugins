# OmniDeck Plugins

Community plugins for [OmniDeck](https://github.com/wemcdonald/OmniDeck).

## Plugins

| Plugin | Description |
|--------|-------------|
| [bettertouchtool](bettertouchtool/) | BetterTouchTool integration for macOS |
| [clock](clock/) | Analog and digital clock display with configurable timezone and colors |
| [counter](counter/) | Tap to count up, long press to reset — customizable styling |
| [google-meet](google-meet/) | Control Google Meet calls — mute, video, hand raise, reactions, leave |
| [monitor-control](monitor-control/) | Switch monitor inputs via DDC/CI |
| [slack](slack/) | Unread counts, open channels/DMs, DND control — multi-workspace |
| [weather](weather/) | Real-time weather and multi-day forecast via Open-Meteo (no API key) |
| [zoom](zoom/) | Control Zoom meetings — mute, video, share, hand, reactions, recording |

## Installation

Copy the plugin directory into your OmniDeck hub's `plugins/` folder:

```bash
cp -r monitor-control /path/to/OmniDeck/plugins/
```

The hub will automatically detect, bundle, and distribute the plugin to agents on the next restart.

## Writing Plugins

See the [OmniDeck Plugin Guide](https://github.com/wemcdonald/OmniDeck/blob/master/docs/plugin-guide.md).
