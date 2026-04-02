# Spotify Plugin for OmniDeck

Control Spotify playback from your Stream Deck — play/pause, shuffle, repeat, volume, album art, and scrolling track info.

> **Requires Spotify Premium.** All playback control endpoints require a Premium subscription. Reading playback state works on free accounts, but controlling it does not.

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in:
   - **App name**: anything (e.g. "OmniDeck")
   - **Redirect URI**: `http://127.0.0.1:28120/callback`
   - **Which API/SDKs**: select **Web API**
4. Click **Save**
5. Copy the **Client ID** from the app settings page

### 2. Configure in OmniDeck

1. Open the OmniDeck web UI
2. Go to **Plugins** → **Spotify**
3. Paste your **Client ID**
4. Optionally adjust:
   - **Poll Interval** — how often to check Spotify (default: 3000ms)
   - **Volume Step** — volume change per button press (default: 10%)

### 3. Connect

Add any Spotify preset to your deck (e.g. "Play / Pause") and press it. Your browser will open to authorize OmniDeck with Spotify. After granting access, the button will start showing live playback state.

You can also trigger the connect flow at any time using the **Connect to Spotify** action.

## Available Presets

| Preset | Description |
|--------|-------------|
| **Now Playing** | Album art (full bleed) with a progress bar. Tap to play/pause. |
| **Track Info** | Scrolling track name + artist. Tap to play/pause. |
| **Play / Pause** | Play/pause toggle with a contextual icon. |
| **Next Track** | Skip to next track. |
| **Previous Track** | Skip to previous track. |
| **Shuffle** | Toggle shuffle — green when on, gray when off. |
| **Repeat** | Cycle repeat mode: off → all → one. |
| **Volume Up** | Increase volume with a level indicator. |
| **Volume Down** | Decrease volume with a level indicator. |

## Visual States

Buttons automatically show contextual status:

- **Loading** — hourglass icon while connecting
- **Connect** — link icon when authorization is needed
- **Error** — red error icon with a short message (e.g. "Premium required")
- **No Device** — speaker icon when no Spotify device is active
- **Playing** — full-color album art / active icons
- **Paused** — dimmed album art / muted icons

## Template Variables

State providers expose variables for use in label templates:

| Variable | Example | Available on |
|----------|---------|-------------|
| `{{track}}` | Bohemian Rhapsody | Now Playing, Track Info |
| `{{artist}}` | Queen | Now Playing, Track Info |
| `{{album}}` | A Night at the Opera | Now Playing, Track Info |
| `{{volume}}` | 65 | Volume Level |

## How It Works

- The **agent** (running on your desktop) handles Spotify authentication (OAuth PKCE — no client secret needed), polls the Spotify API for playback state, downloads album art, and executes playback commands.
- The **hub** (running on your Pi / server) receives state updates from the agent and renders button visuals with album art, scrolling text, progress bars, and status icons.
- Tokens are stored locally on the agent machine (in its data directory) and refreshed automatically.

## Notes

- **No client secret required.** This plugin uses the PKCE authorization flow, which is recommended by Spotify for desktop/device apps.
- **Rate limits**: Spotify uses a rolling 30-second rate limit window. With default settings (~1 request every 3 seconds), you'll stay well within limits.
- **Album art** is downloaded once per track change (not every poll cycle) and cached in the state store.
- **Scrolling text** is driven by a 500ms tick timer. Track names and artist names longer than 10 characters scroll continuously.
- **Dev mode limits**: Spotify development mode allows up to 5 authorized users per app. Since each user creates their own app, this isn't a practical limitation.
