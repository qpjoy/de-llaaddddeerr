# electron-game

`electron-game` is the game-side marketplace workspace. It is intentionally self-contained for this branch so it can be merged back into `feat/electron_market` later without touching the current marketplace architecture.

## Discovery Model

The marketplace can discover games in the same spirit as `electron-plugin`:

1. Read curated entries from [`registry/games.json`](registry/games.json).
2. Inspect installed npm packages that contain:
   - `package.json#qpjoyGame.specVersion = 1`
   - `package.json#qpjoyGame.manifest`
   - package keywords including `qpjoy-electron-game`
3. During local development, scan `electron-game/games/*/package.json`.

Each package exposes enough metadata for the market to render a game card, install the package, and launch a playable Electron entry.

To fit the current `feat/electron_market` install path, a marketplace-installable game can also ship a compatible `qpjoyPlugin` manifest. The plugin entry exposes a `launch()` RPC method, while `qpjoyGame` carries game-specific metadata such as modes, scoring, and storage.

Local discovery is available as:

```bash
cd electron-game
npm run discover
```

## Current Game

[`@qpjoy/electron-game-suduku`](games/suduku) is the first sample game package.

It supports:

- `7x7` mode: row/column unique Latin-Sudoku.
- `9x9` mode: standard Sudoku with 3x3 boxes.
- Score only after completing a round.
- Faster completion receives a higher score.
- After the score time cap is exceeded, completed rounds receive the same minimum score.
- Local scores are stored in SQLite.
- If `QPJOY_GAME_POSTGRES_URL` or `DATABASE_URL` is available, unsynced local scores can be mirrored to Postgres and ranked.
- Player identity prefers marketplace user context. Without it, the game asks for a display name and appends a four-digit suffix.

## Local Play

```bash
cd electron-game/games/suduku
npm install
npm start
```

Optional direct Postgres sync:

```bash
QPJOY_GAME_POSTGRES_URL="postgres://user:pass@localhost:5432/qpjoy_game" npm start
```

The direct Postgres path is a branch-local bridge for the standalone game. A future marketplace/server integration can replace it with an API while preserving the local SQLite score contract.

## Branch Boundary

For this branch, all game-market code lives under `electron-game/`. No root package manager, app shell, or marketplace runtime files are changed.
