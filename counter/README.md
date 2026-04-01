# Counter

Simple counter that increments on each press and resets on long press. Customizable color, size, and font.

## Usage

```yaml
- pos: [0, 0]
  preset: counter.counter

# Custom styling
- pos: [1, 0]
  preset: counter.counter
  params:
    id: my-counter
    color: "#22c55e"
    background: "#0a0a0a"
    font_size: large
    font: monospace

# Multiple independent counters
- pos: [2, 0]
  preset: counter.counter
  params:
    id: counter-a
- pos: [3, 0]
  preset: counter.counter
  params:
    id: counter-b
```

## Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `id` | Unique counter name (multiple buttons can share one) | `default` |
| `color` | Number color | `#ffffff` |
| `background` | Background color | `#000000` |
| `font_size` | `small`, `medium`, or `large` | `large` |
| `font` | `sans-serif`, `monospace`, or `serif` | `sans-serif` |

## License

MIT
