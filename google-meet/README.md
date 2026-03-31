# Google Meet

Control Google Meet calls from your OmniDeck. Toggle mute, camera, hand raise, captions, leave call, toggle chat, and send emoji reactions.

**Platforms:** macOS, Windows, Linux (any platform running Chrome/Chromium)

## How It Works

Google Meet runs in a browser, so this plugin uses a **companion Chrome extension** that communicates with the OmniDeck agent via a local WebSocket connection. The extension clicks Meet's UI controls and observes state changes in real time.

```
OmniDeck Hub ←→ Agent (WebSocket server on :2395) ←→ Chrome Extension ←→ Google Meet DOM
```

## Setup

### 1. Install the Chrome Extension

Download the extension from the plugin's settings page in the OmniDeck hub UI, or grab the `extension/` directory directly.

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory (or unzip the downloaded file and select it)

### 2. Join a Meet Call

Open Google Meet in Chrome and join a call. The extension automatically connects to the agent — your deck buttons will light up with live state.

## Features

### Actions

- **Toggle Mute** — Mute or unmute your microphone
- **Toggle Video** — Turn your camera on or off
- **Raise Hand** — Raise or lower your virtual hand
- **Toggle Captions** — Turn captions on or off
- **Leave Call** — Leave the current call
- **Toggle Chat** — Open or close the chat panel
- **Emoji React** — Send an emoji reaction

### State Providers

- **Connection Status** — Extension connected, in-call status (`{{status}}`, `{{in_call}}`)
- **Mute Status** — Microphone muted/unmuted with live icon and color (`{{mute_state}}`)
- **Video Status** — Camera on/off with live icon and color (`{{video_state}}`)
- **Hand Status** — Hand raised/lowered (`{{hand_state}}`)
- **Captions Status** — Captions on/off (`{{captions_state}}`)
- **Meeting Status** — Simplified status for action-only buttons (`{{status}}`)

### Presets

- **Mute** — Toggle mic with live mute/unmute indicator
- **Video** — Toggle camera with live on/off indicator
- **Raise Hand** — Toggle hand raise with live indicator
- **Captions** — Toggle captions with live indicator
- **Leave** — Leave the current call
- **Chat** — Toggle the chat panel
- **React** — Send an emoji reaction

## Usage

```yaml
- pos: [0, 0]
  preset: google-meet.mute

- pos: [1, 0]
  preset: google-meet.video

- pos: [2, 0]
  preset: google-meet.raise_hand

- pos: [3, 0]
  preset: google-meet.captions

- pos: [0, 1]
  preset: google-meet.chat

- pos: [1, 1]
  preset: google-meet.react

- pos: [2, 1]
  preset: google-meet.leave
```

## Configuration

```yaml
plugins:
  google-meet:
    ws_port: 2395    # WebSocket port for extension communication (default: 2395)
```

## Troubleshooting

- **Buttons show "Disconnected"** — Make sure the Chrome extension is installed and a Google Meet tab is open.
- **Extension can't connect** — Some ad blockers block WebSocket connections to `localhost`. Add `127.0.0.1:2395` to your ad blocker's allowlist.
- **Buttons don't update after a Meet UI change** — Google occasionally changes Meet's internal DOM structure. Check for an updated version of this plugin.

## Building the Extension

If you modify `extension/src/content.ts`, rebuild with:

```bash
cd extension
bun run build.ts
```

## License

MIT
