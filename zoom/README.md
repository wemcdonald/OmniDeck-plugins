# Zoom

Control Zoom meetings from your OmniDeck. Toggle mute, camera, screen sharing, raise hand, send reactions, start/stop recording, and leave or end meetings.

**Platforms:** macOS, Windows, Linux

## Features

### Actions

- **Toggle Mute** — Mute or unmute your microphone
- **Toggle Video** — Turn your camera on or off
- **Share Screen** — Start or stop screen sharing
- **Raise Hand** — Raise or lower your virtual hand
- **React** — Open the emoji reactions panel
- **Record** — Start or stop local recording
- **Leave Meeting** — Leave the current meeting
- **End Meeting** — End the meeting for everyone (host only)

### State Providers

- **Meeting Status** — Whether Zoom is running, idle, or in a meeting (`{{status}}`, `{{in_meeting}}`)
- **Mute Status** — Microphone muted/unmuted with live icon and color (`{{mute_state}}`)
- **Video Status** — Camera on/off with live icon and color (`{{video_state}}`)
- **Share Status** — Screen sharing active/inactive (`{{share_state}}`)
- **Hand Status** — Hand raised/lowered (`{{hand_state}}`)
- **Recording Status** — Recording active/inactive (`{{recording_state}}`)

### Presets

- **Mute** — Toggle mic with live mute/unmute indicator
- **Video** — Toggle camera with live on/off indicator
- **Share Screen** — Toggle screen sharing with live indicator
- **Leave** — Leave the current meeting
- **End Meeting** — End meeting for all participants (host only)
- **Raise Hand** — Toggle hand raise with live indicator
- **React** — Open emoji reactions panel
- **Record** — Toggle recording with live indicator

## Setup

Enable **Global Shortcuts** in Zoom Settings > Keyboard Shortcuts for best results. The plugin sends keyboard shortcuts to Zoom without requiring the Zoom window to be focused.

### Platform details

| Platform | Detection | Control |
|----------|-----------|---------|
| **macOS** | AppleScript (menu bar inspection) | CGEvent keystrokes via Accessibility |
| **Windows** | PowerShell (process/window title) | SendKeys |
| **Linux** | pgrep + xdotool (window title) | xdotool key events |

## Usage

```yaml
- pos: [0, 0]
  preset: zoom.mute

- pos: [1, 0]
  preset: zoom.video

- pos: [2, 0]
  preset: zoom.share_screen

- pos: [3, 0]
  preset: zoom.raise_hand

- pos: [0, 1]
  preset: zoom.react

- pos: [1, 1]
  preset: zoom.record

- pos: [2, 1]
  preset: zoom.leave

- pos: [3, 1]
  preset: zoom.end
```

## Configuration

```yaml
plugins:
  zoom:
    poll_interval: "2s"    # how often to check meeting state (default: 2s)
```

## License

MIT
