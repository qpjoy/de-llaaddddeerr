-- Make the startup rebuild an operator decision instead of a restart side effect.
--
-- The projector reconciles two very different things on startup: that the index,
-- template and aliases exist -- without which nothing can be served at all --
-- and that every canonical record has been replayed into it. The first is
-- milliseconds and mandatory. The second is hours on this corpus, holds the
-- global rebuild lock for its duration, and re-runs from the beginning on every
-- restart, so a crash loop can spend a day making no progress while search
-- serves whatever the last completed pass left behind.
--
-- Coupling them meant an ordinary deploy could not be separated from a full
-- re-index. Splitting them lets the projector come up, serve, and drain its
-- outbox immediately, while the expensive pass is started deliberately -- from
-- the console or the CLI -- when someone is watching.
--
-- Defaults to false: the safe default for a restart is to serve, not to embark
-- on hours of work nobody asked for. Correctness does not depend on this being
-- true, because the outbox is the durable record of every change and the
-- projector loop drains it either way.

CREATE TABLE IF NOT EXISTS control.search_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  startup_rebuild boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO control.search_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

-- Lets a running rebuild be asked to stop at its next batch boundary, rather
-- than only by killing the pod that owns it.
ALTER TABLE control.search_reindex_operations
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
