# QPJoy Game Spec v1

Games are marketplace packages that appear in the 游戏 board while reusing the current plugin installer/runtime.

## Package layout

```jsonc
{
  "name": "@qpjoy/electron-game-suduku",
  "version": "0.1.0",
  "qpjoyPlugin": {
    "specVersion": 1,
    "entry": "src/plugin.js",
    "manifest": "src/plugin.manifest.json"
  },
  "qpjoyGame": {
    "specVersion": 1,
    "entry": "src/plugin.js",
    "manifest": "src/game.manifest.json"
  }
}
```

`qpjoyGame` is the game metadata contract. `qpjoyPlugin` is required in v1 so the current desktop market can install, grant, activate, upgrade, and uninstall the game with the same trusted path as plugins.

## Game Manifest

Required fields:

| Field | Notes |
| --- | --- |
| `kind` | Must be `electron-game`. |
| `id` | Stable reverse-DNS id. Should match the plugin manifest id. |
| `name` | Human-readable game name. |
| `version` | Should match `package.json#version`. |
| `category` | Game category, such as `puzzle`. |
| `entry` | Renderer / standalone / plugin entry metadata. |

The server writes game entries into the same marketplace index with:

```json
{
  "category": "game:puzzle",
  "metadata": {
    "kind": "game",
    "installRuntime": "qpjoyPlugin",
    "launchRpc": "launch"
  }
}
```

The admin UI uses `metadata.kind = "game"` to render the entry in the 游戏 tab. After activation, the game plugin should expose `launch()` so the market can start a试玩 window.

## Local Data

Games should prefer the host-provided marketplace SQLite facade at `ctx.host.marketplaceDb`. That keeps game behavior queryable with marketplace state, for example joining `electron_game_scores` with `installed_plugins`, `marketplace_entries`, and `plugin_logs`.

Standalone development may fall back to a private SQLite file. Server-wide rankings should sync through `electron-server` APIs using the marketplace login session; when `electron-server` runs with `DATABASE_URL`, that high-score API is backed by Postgres.
