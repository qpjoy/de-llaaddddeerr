-- Agent Studio project metadata management is intentionally additive to P1.
-- Keep migration 046 immutable for environments that already applied it.

ALTER TABLE control.agent_studio_agents
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
