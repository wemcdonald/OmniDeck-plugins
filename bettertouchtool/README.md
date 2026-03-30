# BetterTouchTool

Control [BetterTouchTool](https://folivora.ai/) from your OmniDeck. Execute named triggers and actions via BTT's built-in HTTP API.

**Platform:** macOS only

## Features

### Actions

- **Run BTT Trigger** — Execute a BetterTouchTool named trigger by name
- **Run BTT Action** — Execute a BetterTouchTool action by its identifier string

### State Providers

- **BTT Triggers** — Shows the number of available triggers, exposed as `{{trigger_count}}`

### Presets

- **BTT Trigger** — One-tap button to fire a named trigger

## Configuration

The agent connects to BTT's local HTTP server. Configure the port and shared secret in your agent config:

```yaml
plugins:
  bettertouchtool:
    port: 12345            # BTT webserver port (default: 12345)
    secret: "my_secret"    # shared secret (optional)
    poll_interval: "2s"    # how often to refresh trigger list (default: 2s)
```

Enable the BTT webserver in **BetterTouchTool Preferences > Advanced > Webserver**.

## Usage

```yaml
- pos: [0, 0]
  preset: bettertouchtool.btt_trigger
  params:
    name: "My Named Trigger"
```

## License

MIT
