# Clock

Display the current time on your OmniDeck. Supports analog clock face and digital display modes with customizable colors and time zones.

## Features

### State Providers

- **Clock Display** — Renders the current time as an analog or digital clock (`{{time}}`, `{{time_short}}`)

### Presets

- **Analog Clock** — Classic clock face with hour, minute, and second hands
- **Digital Clock** — Digital time display

### Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `mode` | `analog` or `digital` | `analog` |
| `timezone` | IANA timezone (e.g., `America/New_York`) | System local |
| `foreground` | Clock hands/text color | `#ffffff` |
| `background` | Clock face background color | `#000000` |
| `seconds_hand` | Show seconds hand/seconds | `true` |

## Usage

```yaml
- pos: [0, 0]
  preset: clock.analog

- pos: [1, 0]
  preset: clock.digital

- pos: [2, 0]
  preset: clock.analog
  params:
    timezone: "Asia/Tokyo"
    foreground: "#22c55e"
    background: "#0a0a0a"
```

## License

MIT
