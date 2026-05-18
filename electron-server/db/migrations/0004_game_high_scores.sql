-- Game high scores synced by marketplace games.

CREATE TABLE game_high_scores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               text NOT NULL,
  plugin_id             text NOT NULL,
  mode                  text NOT NULL,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_name           text NOT NULL,
  best_score            integer NOT NULL CHECK (best_score >= 0),
  best_elapsed_seconds  integer NOT NULL CHECK (best_elapsed_seconds >= 0),
  rounds                integer NOT NULL DEFAULT 1 CHECK (rounds >= 1),
  metadata              jsonb,
  completed_at          timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, mode, user_id)
);

CREATE INDEX game_high_scores_rank_idx
  ON game_high_scores (game_id, mode, best_score DESC, best_elapsed_seconds ASC, completed_at ASC);
