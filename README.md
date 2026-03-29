# OmniDeck Plugins

Community plugins for [OmniDeck](https://github.com/wemcdonald/OmniDeck).

## Plugins

| Plugin | Description |
|--------|-------------|
| [monitor-control](monitor-control/) | Switch monitor inputs via DDC/CI |

## Installation

Copy the plugin directory into your OmniDeck hub's `plugins/` folder:

```bash
cp -r monitor-control /path/to/OmniDeck/plugins/
```

The hub will automatically detect, bundle, and distribute the plugin to agents on the next restart.

## Writing Plugins

See the [OmniDeck Plugin Guide](https://github.com/wemcdonald/OmniDeck/blob/master/docs/plugin-guide.md).
