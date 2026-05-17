create table if not exists electron_game_players (
  id text primary key,
  display_name text not null,
  source text not null,
  updated_at timestamptz not null default now()
);

create table if not exists electron_game_scores (
  id text primary key,
  game_id text not null,
  player_id text not null references electron_game_players(id),
  player_name text not null,
  mode text not null,
  elapsed_seconds integer not null,
  score integer not null,
  completed_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists electron_game_scores_game_mode_idx
  on electron_game_scores (game_id, mode);

create index if not exists electron_game_scores_player_idx
  on electron_game_scores (player_id);
