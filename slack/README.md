# Slack

Slack integration for OmniDeck. Show unread counts, open channels and DMs with one press, and control Do Not Disturb — all from your deck.

**Supports multiple workspaces** with independent polling and rate limits.

## Setup

You need a Slack User Token (`xoxp-`) with these scopes:

`channels:read` `groups:read` `im:read` `mpim:read` `users:read` `dnd:read` `dnd:write` `users.profile:read` `users.profile:write` `team:read`

Create a Slack App at https://api.slack.com/apps, add the scopes under **OAuth & Permissions**, install to your workspace, and copy the **User OAuth Token**.

## Configuration

```yaml
# Single workspace:
plugins:
  slack:
    token: !secret slack_token

# Multiple workspaces:
plugins:
  slack:
    workspaces:
      work:
        token: !secret slack_work
      personal:
        token: !secret slack_personal
    poll_interval: "60s"  # default: 60s
```

## Features

### State Providers

- **Unread Count** — Total unread messages, aggregated across workspaces (`{{count}}`, `{{mentions}}`)
- **Channel Status** — Unread count for a specific channel (`{{name}}`, `{{unread}}`)
- **DM Status** — Unread count for a specific DM (`{{name}}`, `{{unread}}`)
- **DND Status** — Do Not Disturb state (`{{dnd_state}}`, `{{snooze_remaining}}`)

### Actions

- **Open Channel** — Opens a channel in the Slack desktop app
- **Open DM** — Opens a direct message in Slack
- **Toggle DND** — Pause or resume notifications
- **Set Status** — Set your status emoji and text

### Presets

- **Unread Messages** — Total unread count display
- **Channel** — Channel shortcut with unread badge (press to open)
- **Direct Message** — DM shortcut with unread badge (press to open)
- **Do Not Disturb** — Toggle DND on press

## Usage

```yaml
# Total unread (all workspaces)
- pos: [0, 0]
  preset: slack.unread

# Specific channel
- pos: [1, 0]
  preset: slack.channel
  params:
    channel: general
    workspace: work  # omit if single workspace

# DM shortcut
- pos: [2, 0]
  preset: slack.dm
  params:
    user: Jane Doe

# DND toggle (60 min default)
- pos: [3, 0]
  preset: slack.dnd
  params:
    duration: 30  # minutes
```

## Channel/User Lookup

Channels can be specified by name (with or without `#`) or Slack ID. Users can be specified by display name, username, or Slack ID.

## License

MIT
