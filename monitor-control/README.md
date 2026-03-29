# Monitor Control

Switch monitor inputs via DDC/CI. Supports HDMI, DisplayPort, USB-C, and other inputs.

## Platform Requirements

| Platform | Tool | Install |
|----------|------|---------|
| **macOS** (Apple Silicon) | m1ddc | `brew install m1ddc` |
| **Windows** | Built-in | No install needed (uses dxva2.dll) |
| **Linux / Raspberry Pi** | ddcutil | See below |

### Linux / Raspberry Pi Setup

```bash
sudo apt install ddcutil i2c-tools
sudo usermod -aG i2c $USER
sudo modprobe i2c-dev
echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf
```

On Raspberry Pi, add to `/boot/config.txt`:
```
dtoverlay=vc4-kms-v3d
```

Ensure DDC/CI is enabled in your monitor's OSD settings.

## Usage

### Basic toggle button (cycles through configured inputs)

```yaml
- pos: [0, 2]
  preset: monitor-control.input_toggle
  target: Angelica.local
  params:
    monitor: ROG           # matches monitor name (substring, case-insensitive)
    inputs:
      15: { name: "Mac", icon: "ms:laptop-mac" }
      16: { name: "PC", icon: "ms:laptop-windows" }
```

### Set a specific input

```yaml
- pos: [1, 2]
  preset: monitor-control.input_select
  params:
    target: Angelica.local
    monitor: ROG
    input: 15
```

## Input Values (DDC/CI VCP 0x60)

| Value | Input |
|-------|-------|
| 15 | DisplayPort 1 |
| 16 | DisplayPort 2 |
| 17 | HDMI 1 |
| 18 | HDMI 2 |
| 27 | USB-C |

**Note:** Some monitors use non-standard values. Check your monitor's actual values with `m1ddc get input` (macOS), `ddcutil getvcp 0x60` (Linux), or by switching inputs manually and reading the value.

## Multi-Monitor Support

Use the `monitor` param to target a specific monitor by name:

```yaml
params:
  monitor: ROG        # matches "ROG XG27UQ"
  monitor: LG         # matches "LG Ultra HD"
  monitor: Dell       # matches "Dell U2723QE"
```

The name is matched as a case-insensitive substring against the monitor's model name.
