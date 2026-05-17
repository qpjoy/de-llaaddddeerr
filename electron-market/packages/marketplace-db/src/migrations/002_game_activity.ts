import type { Migration } from '../Migrator';

const up = `
CREATE TABLE electron_game_players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE electron_game_scores (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  marketplace_entry_id TEXT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  score INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  synced_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (plugin_id) REFERENCES installed_plugins(id) ON DELETE CASCADE,
  FOREIGN KEY (marketplace_entry_id) REFERENCES marketplace_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (player_id) REFERENCES electron_game_players(id) ON DELETE CASCADE
);

CREATE INDEX electron_game_scores_game_mode_idx
  ON electron_game_scores(game_id, mode);
CREATE INDEX electron_game_scores_plugin_idx
  ON electron_game_scores(plugin_id);
CREATE INDEX electron_game_scores_player_idx
  ON electron_game_scores(player_id);
CREATE INDEX electron_game_scores_unsynced_idx
  ON electron_game_scores(synced_at)
  WHERE synced_at IS NULL;
`;

const down = `
DROP INDEX IF EXISTS electron_game_scores_unsynced_idx;
DROP INDEX IF EXISTS electron_game_scores_player_idx;
DROP INDEX IF EXISTS electron_game_scores_plugin_idx;
DROP INDEX IF EXISTS electron_game_scores_game_mode_idx;
DROP TABLE IF EXISTS electron_game_scores;
DROP TABLE IF EXISTS electron_game_players;
`;

const migration: Migration = {
  version: 2,
  name: 'game activity schema',
  up,
  down
};

export default migration;
