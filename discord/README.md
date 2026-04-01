# Discord

Control Discord voice, video, and streaming from your OmniDeck. Uses Discord's local RPC API (same mechanism as the official Elgato Stream Deck plugin).

## Setup

1. Create a Discord app at https://discord.com/developers/applications
2. Under **OAuth2**, add `http://localhost` as a redirect URI
3. Copy the **Client ID** and **Client Secret**
4. On first connection, Discord will show a consent dialog — approve it

```yaml
plugins:
  discord:
    client_id: "YOUR_APP_CLIENT_ID"
    client_secret: !secret discord_client_secret
```

## Features

### Actions
- **Toggle Mute** — Mute/unmute microphone
- **Toggle Deafen** — Toggle audio deafen
- **Join Voice** — Join a specific voice channel
- **Leave Voice** — Leave the current voice channel
- **Toggle Video** — Camera on/off
- **Toggle Stream** — Screenshare on/off
- **Toggle PTT Mode** — Switch between Voice Activity and Push to Talk
- **Open Text Channel** — Jump to a text channel
- **User Mixer** — Open per-user volume controls (dynamic page)
- **Adjust User Volume** — Per-user volume up/down

### State Providers
- **Voice Status** — Channel name, connection state (`{{channel}}`, `{{status}}`)
- **Mute Status** — Mic mute state (`{{mute_state}}`)
- **Deafen Status** — Deafen state (`{{deafen_state}}`)
- **Video Status** — Camera state (`{{video_state}}`)
- **Stream Status** — Screenshare state (`{{stream_state}}`)
- **User Volume** — Per-user volume level (`{{level}}`, `{{username}}`)

### Presets
- `discord.mute` — Toggle mute with live status
- `discord.deafen` — Toggle deafen with live status
- `discord.voice_channel` — Join voice channel
- `discord.leave_voice` — Leave voice
- `discord.text_channel` — Open text channel
- `discord.video` — Toggle camera
- `discord.stream` — Toggle screenshare
- `discord.ptt_mode` — Toggle Push to Talk mode
- `discord.user_mixer` — Open per-user volume mixer

## Usage

```yaml
- pos: [0, 0]
  preset: discord.mute
- pos: [1, 0]
  preset: discord.deafen
- pos: [2, 0]
  preset: discord.voice_channel
  params:
    channel_id: "123456789012345678"
- pos: [3, 0]
  preset: discord.video
- pos: [4, 0]
  preset: discord.user_mixer
```

## User Mixer

Press the mixer button to see all users in your voice channel. Tap a user to open their volume controls with coarse (±20%) and fine (±5%) adjustment buttons. Press Back to return.

## Important Notes

- **Voice Settings Lock**: Only one RPC app can control Discord voice at a time. Settings revert if the agent disconnects.
- **RPC Scopes**: `rpc.*` scopes require Discord approval for >50 users. Personal use is fine.
- **Channel IDs**: Right-click a channel in Discord with Developer Mode enabled to copy its ID.

## License

MIT
