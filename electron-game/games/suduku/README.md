# @qpjoy/electron-game-suduku

Suduku is a local-first Electron game package for the Qpjoy game marketplace.

It is published as a game package with both:

- `qpjoyGame`: game metadata for the marketplace game board.
- `qpjoyPlugin`: compatibility with the current plugin installer/runtime. The active plugin exposes `launch()` for试玩.

## Modes

- `7x7`: row/column unique Latin-Sudoku. Digits `1-7` must appear once in every row and column.
- `9x9`: standard Sudoku. Digits `1-9` must appear once in every row, column, and `3x3` box.

## Scoring

Scores are awarded only when a round is completed.

| Mode | Max score | Minimum completed score | Time cap |
| --- | ---: | ---: | ---: |
| `7x7` | 700 | 120 | 5 minutes |
| `9x9` | 1200 | 250 | 15 minutes |

The score linearly decreases between the max score and minimum completed score. Once elapsed time is greater than the cap, every completed round receives the minimum score.

## Player Identity

Identity resolution order:

1. Marketplace launch context from `QPJOY_GAME_CONTEXT`.
2. Marketplace user env vars `QPJOY_MARKET_USER_ID` and `QPJOY_MARKET_USER_NAME`.
3. Existing local SQLite player record.
4. Prompt before the first round. The entered name receives a four-digit suffix, such as `Joy#4821`.

## Storage

Local scores are stored in SQLite under Electron's `app.getPath("userData")`.

If `QPJOY_GAME_POSTGRES_URL` or `DATABASE_URL` is present, the game tries to sync unsynced local scores to Postgres and can display remote rankings. If Postgres is unavailable, play continues offline and scores remain queued locally.

## Development

```bash
npm install
npm start
```

Run syntax and registry checks from `electron-game/`:

```bash
npm run check
```
