-- Deployment installs choices only: no credentials, default Sequence, jobs or vectors.
-- Active model/dimensions remain protected by agent_provider_settings's persisted lock.
CREATE TABLE IF NOT EXISTS control.embedding_profiles (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  sort_order integer NOT NULL DEFAULT 0
);
INSERT INTO control.embedding_profiles(id, display_name, model, dimensions, sort_order)
VALUES
  ('mx-qwen3-512', '本机 Qwen3 Embedding · 512 维', 'Qwen/Qwen3-Embedding-0.6B', 512, 0),
  ('mx-qwen3-1024', '本机 Qwen3 Embedding · 1024 维', 'Qwen/Qwen3-Embedding-0.6B', 1024, 1)
ON CONFLICT (id) DO NOTHING;
